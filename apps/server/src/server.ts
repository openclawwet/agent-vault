import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { DEFAULT_SPACE, type HealthResult } from "@agent-vault/core";
import { FileStorage, normalizeSpaceName, normalizeVaultPath, sha256Buffer, VaultStorageError } from "@agent-vault/storage";
import { isAuthorized } from "./auth.js";
import { type AgentVaultConfigOverrides, resolveConfig, type AgentVaultConfig } from "./config.js";
import { VaultDb } from "./db/vaultDb.js";

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface AgentVaultApp {
  readonly config: AgentVaultConfig;
  readonly db: VaultDb;
  readonly storage: FileStorage;
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): void;
}

export interface StartedAgentVaultServer {
  app: AgentVaultApp;
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.byteLength,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message } });
    return;
  }

  if (error instanceof VaultStorageError) {
    sendJson(res, 400, { error: { code: error.code, message: error.message } });
    return;
  }

  const message = error instanceof Error ? error.message : "Internal server error.";
  sendJson(res, 500, { error: { code: "internal_error", message } });
}

function readBody(req: IncomingMessage, maxBytes = 1024 * 1024 * 100): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        reject(new HttpError(413, "payload_too_large", "Upload exceeds the local tracer limit."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
}

function routeSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

function requireAuth(req: IncomingMessage, config: AgentVaultConfig): void {
  if (!isAuthorized(req, config.token)) {
    throw new HttpError(401, "unauthorized", "Missing or invalid Agent Vault token.");
  }
}

function queryPath(url: URL): string {
  const value = url.searchParams.get("path");
  if (!value) {
    throw new HttpError(400, "missing_path", "A file path query parameter is required.");
  }
  return normalizeVaultPath(value);
}

function requestDevice(req: IncomingMessage): string {
  const header = req.headers["x-agent-vault-device"];
  const value = Array.isArray(header) ? header[0] : header;
  const device = value?.trim() || "local";
  return device.slice(0, 80);
}

async function handleRequest(app: AgentVaultApp, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = parseUrl(req);
  const segments = routeSegments(url);
  const method = req.method ?? "GET";

  if (method === "GET" && segments.length === 1 && segments[0] === "health") {
    const body: HealthResult = {
      ok: true,
      service: "agent-vault",
      storageRoot: app.config.storageRoot,
      dbPath: app.config.dbPath,
    };
    sendJson(res, 200, body);
    return;
  }

  requireAuth(req, app.config);

  if (method === "GET" && segments.length === 1 && segments[0] === "spaces") {
    sendJson(res, 200, { spaces: app.db.listSpaces() });
    return;
  }

  if (segments.length === 3 && segments[0] === "spaces" && segments[2] === "files" && method === "GET") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    app.db.ensureSpace(space);
    sendJson(res, 200, { files: app.db.listFiles(space) });
    return;
  }

  if (segments.length === 3 && segments[0] === "spaces" && segments[2] === "audit" && method === "GET") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    app.db.ensureSpace(space);
    sendJson(res, 200, { events: app.db.listAudit(space) });
    return;
  }

  if (segments.length === 3 && segments[0] === "spaces" && segments[2] === "file" && method === "PUT") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    const filePath = queryPath(url);
    const body = await readBody(req);
    const next = app.db.getNextVersion(space, filePath);
    const stored = await app.storage.writeVersionedFile(space, next.fileId, next.version, filePath, body);
    const file = app.db.upsertFileVersion({
      id: next.fileId,
      space: stored.space,
      path: stored.path,
      size: stored.size,
      sha256: stored.sha256,
      storagePath: stored.storagePath,
      version: next.version,
      versionStoragePath: stored.versionStoragePath,
      device: requestDevice(req),
      operation: next.operation,
    });
    sendJson(res, 201, { file });
    return;
  }

  if (segments.length === 3 && segments[0] === "spaces" && segments[2] === "file" && method === "GET") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    const filePath = queryPath(url);
    const file = app.db.getFile(space, filePath);
    if (!file || file.deletedAt) {
      throw new HttpError(404, "file_not_found", "File was not found.");
    }

    const body = await app.storage.readFile(space, file.path);
    const actualHash = sha256Buffer(body);
    if (actualHash !== file.sha256) {
      throw new HttpError(500, "integrity_mismatch", "Stored file hash does not match metadata.");
    }

    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": body.byteLength,
      "etag": `"sha256:${file.sha256}"`,
      "x-content-sha256": file.sha256,
    });
    res.end(body);
    return;
  }

  if (segments.length === 3 && segments[0] === "spaces" && segments[2] === "file" && method === "DELETE") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    const filePath = queryPath(url);
    const file = app.db.getFile(space, filePath);
    if (!file || file.deletedAt) {
      throw new HttpError(404, "file_not_found", "File was not found.");
    }

    const trashPath = await app.storage.moveCurrentToTrash(space, file.path, file.id, file.currentVersion);
    const deleted = app.db.markDeleted(space, file.path, requestDevice(req));
    sendJson(res, 200, { file: deleted, trashPath });
    return;
  }

  if (segments.length === 4 && segments[0] === "spaces" && segments[2] === "file" && segments[3] === "restore" && method === "POST") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    const filePath = queryPath(url);
    const existing = app.db.getFile(space, filePath);
    if (!existing) {
      throw new HttpError(404, "file_not_found", "File was not found.");
    }

    const version = Number.parseInt(url.searchParams.get("version") ?? String(existing.currentVersion), 10);
    if (!Number.isInteger(version) || version < 1) {
      throw new HttpError(400, "invalid_version", "Version must be a positive integer.");
    }

    const versionRecord = app.db.getVersion(existing.id, version);
    if (!versionRecord) {
      throw new HttpError(404, "version_not_found", "Version was not found.");
    }

    await app.storage.restoreVersionToCurrent(versionRecord.storagePath, space, filePath);
    const restored = app.db.restoreFile(space, filePath, version, requestDevice(req));
    sendJson(res, 200, { file: restored });
    return;
  }

  throw new HttpError(404, "not_found", "Endpoint was not found.");
}

export async function createAgentVaultApp(overrides: AgentVaultConfigOverrides = {}): Promise<AgentVaultApp> {
  const config = await resolveConfig(overrides);
  const db = VaultDb.open(config.dbPath);
  const storage = new FileStorage({ root: config.storageRoot });

  const app: AgentVaultApp = {
    config,
    db,
    storage,
    async handler(req, res) {
      try {
        await handleRequest(app, req, res);
      } catch (error: unknown) {
        sendError(res, error);
      }
    },
    close() {
      db.close();
    },
  };

  return app;
}

export async function startAgentVaultServer(
  overrides: AgentVaultConfigOverrides = {},
): Promise<StartedAgentVaultServer> {
  const app = await createAgentVaultApp(overrides);
  const server = createServer((req, res) => {
    void app.handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(app.config.port, app.config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : app.config.port;
  const url = `http://${app.config.host}:${port}`;

  return {
    app,
    server,
    url,
    port,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      app.close();
    },
  };
}

export function isMainModule(metaUrl: string): boolean {
  return Boolean(process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href);
}
