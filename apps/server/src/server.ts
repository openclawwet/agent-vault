import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_SPACE,
  type CurrentDeviceResult,
  type DeviceScopeRecord,
  type HealthResult,
  type ListSpacesResult,
  type SpaceAccessInfo,
  type VaultPermission,
} from "@agent-vault/core";
import { FileStorage, normalizeSpaceName, normalizeVaultPath, sha256Buffer, VaultStorageError } from "@agent-vault/storage";
import { extractBearerToken, tokenHash } from "./auth.js";
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

interface AuthContext {
  deviceId: string;
  deviceName: string;
  scopes: DeviceScopeRecord[];
}

export interface StartedAgentVaultServer {
  app: AgentVaultApp;
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,idempotency-key,x-agent-vault-token",
    "access-control-expose-headers": "etag,x-content-sha256,content-length,content-type",
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
  res.writeHead(status, {
    ...corsHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.byteLength,
  });
  res.end(payload);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, corsHeaders());
  res.end();
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

function recordAuthFailure(app: AgentVaultApp): void {
  try {
    app.db.recordAuditEvent({
      device: "unknown",
      space: "system",
      operation: "auth_failed",
      path: "authorization",
      version: null,
      hash: null,
    });
  } catch {
    // Auth failure auditing must not leak details or mask the 401 response.
  }
}

function requireAuth(req: IncomingMessage, app: AgentVaultApp): AuthContext {
  const token = extractBearerToken(req);
  if (!token) {
    recordAuthFailure(app);
    throw new HttpError(401, "unauthorized", "Missing or invalid Agent Vault token.");
  }

  const device = app.db.getDeviceByTokenHash(tokenHash(token));
  if (!device) {
    recordAuthFailure(app);
    throw new HttpError(401, "unauthorized", "Missing or invalid Agent Vault token.");
  }

  return {
    deviceId: device.id,
    deviceName: device.name,
    scopes: device.scopes,
  };
}

function queryPath(url: URL): string {
  const value = url.searchParams.get("path");
  if (!value) {
    throw new HttpError(400, "missing_path", "A file path query parameter is required.");
  }
  return normalizeVaultPath(value);
}

function namedQueryPath(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new HttpError(400, "missing_path", `A ${name} query parameter is required.`);
  }
  return normalizeVaultPath(value);
}

function hasPermission(auth: AuthContext, space: string, permission: VaultPermission): boolean {
  return auth.scopes.some((scope) => {
    if (scope.space !== space) {
      return false;
    }
    return scope.permissions.includes("admin") || scope.permissions.includes(permission);
  });
}

function permissionsFor(auth: AuthContext, space: string): VaultPermission[] | undefined {
  const permissions = new Set<VaultPermission>();

  for (const scope of auth.scopes) {
    if (scope.space !== space) {
      continue;
    }
    for (const permission of scope.permissions) {
      permissions.add(permission);
    }
  }

  if (!permissions.size) {
    return undefined;
  }

  return [...permissions];
}

function listAccessibleSpaces(app: AgentVaultApp, auth: AuthContext): SpaceAccessInfo[] {
  return app.db
    .listSpaces()
    .map((space) => {
      const permissions = permissionsFor(auth, space.name);
      return permissions
        ? {
            ...space,
            permissions,
          }
        : undefined;
    })
    .filter((space): space is SpaceAccessInfo => Boolean(space));
}

function requirePermission(auth: AuthContext, space: string, permission: VaultPermission): void {
  if (!hasPermission(auth, space, permission)) {
    throw new HttpError(403, "forbidden", "Device is not allowed to access this space.");
  }
}

function requireAnyAdmin(auth: AuthContext): void {
  if (!auth.scopes.some((scope) => scope.permissions.includes("admin"))) {
    throw new HttpError(403, "forbidden", "Admin permission is required.");
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, 1024 * 1024);
  if (!body.byteLength) {
    return {};
  }
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_json", "JSON body must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function parseScopeInputs(value: unknown): DeviceScopeRecord[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "invalid_scopes", "At least one scope is required.");
  }

  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, "invalid_scope", "Scope must be an object.");
    }
    const scope = item as Record<string, unknown>;
    const space = normalizeSpaceName(String(scope.space ?? ""));
    const permissions = scope.permissions;
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new HttpError(400, "invalid_permissions", "Scope permissions are required.");
    }

    const allowed = new Set<VaultPermission>(["read", "write", "delete", "admin"]);
    const parsedPermissions = permissions.map((permission) => {
      const value = String(permission);
      if (!allowed.has(value as VaultPermission)) {
        throw new HttpError(400, "invalid_permission", "Unknown permission.");
      }
      return value as VaultPermission;
    });

    return {
      space,
      permissions: [...new Set(parsedPermissions)],
    };
  });
}

function generateDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

function idempotencyKey(req: IncomingMessage): string | undefined {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim() || undefined;
}

async function runIdempotentMutation(
  app: AgentVaultApp,
  req: IncomingMessage,
  method: string,
  space: string,
  mutationPath: string,
  mutate: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown }> {
  const key = idempotencyKey(req);
  if (!key) {
    return mutate();
  }

  const existing = app.db.getIdempotency(key);
  if (existing) {
    if (existing.method !== method || existing.space !== space || existing.path !== mutationPath) {
      throw new HttpError(409, "idempotency_key_conflict", "Idempotency key was already used for another mutation.");
    }
    return {
      status: existing.status,
      body: JSON.parse(existing.responseJson) as unknown,
    };
  }

  const result = await mutate();
  app.db.saveIdempotency({
    key,
    method,
    space,
    path: mutationPath,
    status: result.status,
    responseJson: JSON.stringify(result.body),
  });
  return result;
}

async function handleRequest(app: AgentVaultApp, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = parseUrl(req);
  const segments = routeSegments(url);
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    sendNoContent(res);
    return;
  }

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

  const auth = requireAuth(req, app);

  if (method === "GET" && segments.length === 1 && segments[0] === "spaces") {
    const body: ListSpacesResult = { spaces: listAccessibleSpaces(app, auth) };
    sendJson(res, 200, body);
    return;
  }

  if (method === "GET" && segments.length === 1 && segments[0] === "me") {
    const device = app.db.getDeviceById(auth.deviceId);
    if (!device) {
      throw new HttpError(401, "unauthorized", "Device is no longer available.");
    }
    const body: CurrentDeviceResult = {
      device,
      spaces: listAccessibleSpaces(app, auth),
    };
    sendJson(res, 200, body);
    return;
  }

  if (method === "GET" && segments.length === 1 && segments[0] === "devices") {
    requireAnyAdmin(auth);
    sendJson(res, 200, { devices: app.db.listDevices() });
    return;
  }

  if (method === "POST" && segments.length === 1 && segments[0] === "devices") {
    requireAnyAdmin(auth);
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/.test(name)) {
      throw new HttpError(400, "invalid_device_name", "Device name is invalid.");
    }
    const scopes = parseScopeInputs(body.scopes);
    const token = generateDeviceToken();
    const device = app.db.createDevice({
      name,
      tokenHash: tokenHash(token),
      scopes,
    });
    sendJson(res, 201, { device, token });
    return;
  }

  if (method === "POST" && segments.length === 3 && segments[0] === "devices" && segments[2] === "rotate") {
    requireAnyAdmin(auth);
    const token = generateDeviceToken();
    const device = app.db.rotateDeviceToken(segments[1] ?? "", tokenHash(token));
    sendJson(res, 200, { device, token });
    return;
  }

  if (segments.length === 3 && segments[0] === "spaces" && segments[2] === "files" && method === "GET") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    requirePermission(auth, space, "read");
    app.db.ensureSpace(space);
    sendJson(res, 200, { files: app.db.listFiles(space) });
    return;
  }

  if (segments.length === 3 && segments[0] === "spaces" && segments[2] === "changes" && method === "GET") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    requirePermission(auth, space, "read");
    const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
    if (!Number.isInteger(since) || since < 0) {
      throw new HttpError(400, "invalid_cursor", "Change cursor must be a non-negative integer.");
    }
    sendJson(res, 200, app.db.listChanges(space, since));
    return;
  }

  if (segments.length === 3 && segments[0] === "spaces" && segments[2] === "audit" && method === "GET") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    if (space === "system") {
      requireAnyAdmin(auth);
    } else {
      requirePermission(auth, space, "admin");
      app.db.ensureSpace(space);
    }
    sendJson(res, 200, { events: app.db.listAudit(space) });
    return;
  }

  if (segments.length === 3 && segments[0] === "spaces" && segments[2] === "file" && method === "PUT") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    requirePermission(auth, space, "write");
    const filePath = queryPath(url);
    const body = await readBody(req);
    const result = await runIdempotentMutation(app, req, method, space, filePath, async () => {
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
        device: auth.deviceName,
        operation: next.operation,
      });
      return { status: 201, body: { file } };
    });
    sendJson(res, result.status, result.body);
    return;
  }

  if (segments.length === 3 && segments[0] === "spaces" && segments[2] === "file" && method === "GET") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    requirePermission(auth, space, "read");
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
      ...corsHeaders(),
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
    requirePermission(auth, space, "delete");
    const filePath = queryPath(url);
    const file = app.db.getFile(space, filePath);
    if (!file || file.deletedAt) {
      throw new HttpError(404, "file_not_found", "File was not found.");
    }

    const result = await runIdempotentMutation(app, req, method, space, filePath, async () => {
      const trashPath = await app.storage.moveCurrentToTrash(space, file.path, file.id, file.currentVersion);
      const deleted = app.db.markDeleted(space, file.path, auth.deviceName);
      return { status: 200, body: { file: deleted, trashPath } };
    });
    sendJson(res, result.status, result.body);
    return;
  }

  if (segments.length === 4 && segments[0] === "spaces" && segments[2] === "file" && segments[3] === "restore" && method === "POST") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    requirePermission(auth, space, "write");
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

    const result = await runIdempotentMutation(app, req, method, space, `${filePath}@v${version}`, async () => {
      await app.storage.restoreVersionToCurrent(versionRecord.storagePath, space, filePath);
      const restored = app.db.restoreFile(space, filePath, version, auth.deviceName);
      return { status: 200, body: { file: restored } };
    });
    sendJson(res, result.status, result.body);
    return;
  }

  if (segments.length === 4 && segments[0] === "spaces" && segments[2] === "file" && segments[3] === "move" && method === "POST") {
    const space = normalizeSpaceName(segments[1] ?? DEFAULT_SPACE);
    requirePermission(auth, space, "write");
    const fromPath = namedQueryPath(url, "from");
    const toPath = namedQueryPath(url, "to");
    const file = app.db.getFile(space, fromPath);
    if (!file || file.deletedAt) {
      throw new HttpError(404, "file_not_found", "File was not found.");
    }
    const target = app.db.getFile(space, toPath);
    if (target && !target.deletedAt) {
      throw new HttpError(409, "target_exists", "Target file already exists.");
    }

    const result = await runIdempotentMutation(app, req, method, space, `${fromPath}->${toPath}`, async () => {
      const storagePath = await app.storage.moveCurrentFile(space, fromPath, toPath);
      const moved = app.db.moveFile(space, fromPath, toPath, storagePath, auth.deviceName);
      return { status: 200, body: { file: moved } };
    });
    sendJson(res, result.status, result.body);
    return;
  }

  throw new HttpError(404, "not_found", "Endpoint was not found.");
}

export async function createAgentVaultApp(overrides: AgentVaultConfigOverrides = {}): Promise<AgentVaultApp> {
  const config = await resolveConfig(overrides);
  const db = VaultDb.open(config.dbPath);
  db.ensureBootstrapDevice(tokenHash(config.token));
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
