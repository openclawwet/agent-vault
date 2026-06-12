import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChangeEventRecord, DeviceStatusRecord, SpaceAccessInfo, VaultFileRecord, VaultServerStatus } from "@agent-vault/core";
import type { MacSyncConfig } from "./config.js";
import { configWithShareIgnores, syncAllSources, summaryChanged } from "./autoSync.js";
import { readActivity, recordActivity } from "./activityLog.js";
import { scanLocal } from "./localState.js";
import { addShare, loadShareConfig, normalizeShareAccess, removeShare, updateShare, type ShareRecord } from "./shareConfig.js";
import { shareStatus, syncShare } from "./shareSync.js";
import { statusCommand } from "./syncCommands.js";
import { VaultClient } from "./vaultClient.js";

export interface DesktopUiOptions {
  host?: string;
  port?: number;
  open?: boolean;
}

export interface StartedDesktopUi {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

class UiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UiError";
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.byteLength,
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse): void {
  const payload = Buffer.from(renderHtml());
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": payload.byteLength,
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: unknown): void {
  const status = error instanceof UiError ? error.status : 500;
  const code = error instanceof UiError ? error.code : "internal_error";
  const message = error instanceof Error ? error.message : "Internal error.";
  sendJson(res, status, { error: { code, message } });
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
}

function segments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

async function readBody(req: IncomingMessage, maxBytes = 1024 * 1024 * 200): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        reject(new UiError(413, "payload_too_large", "Upload is too large for the desktop bridge."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, 1024 * 1024);
  if (!body.byteLength) return {};
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UiError(400, "invalid_json", "JSON body must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function openPath(targetPath: string): void {
  const child = spawn("open", [targetPath], { stdio: "ignore", detached: true });
  child.unref();
}

function chooseFolder(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Choose a folder to share with Agent Vault")'],
      (error, stdout) => {
        if (error) {
          reject(new UiError(400, "folder_choice_cancelled", "Folder selection was cancelled."));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function changedCount(actions: Awaited<ReturnType<typeof statusCommand>>["actions"]): number {
  return actions.filter((action) => action.kind !== "noop").length;
}

async function summarizeShare(config: MacSyncConfig, share: ShareRecord) {
  try {
    const [files, status] = await Promise.all([
      scanLocal(share.localDir, { ignoreNames: share.ignoreNames, ignorePathPrefixes: share.ignorePathPrefixes }),
      shareStatus(config, share),
    ]);
    const localSize = files.reduce((sum, file) => sum + file.size, 0);
    return {
      ...share,
      localFileCount: files.length,
      localSize,
      localTree: fileTree(files, "", 700),
      pendingActions: changedCount(status.actions),
      available: true,
    };
  } catch (error: unknown) {
    return {
      ...share,
      localFileCount: 0,
      localSize: 0,
      localTree: [],
      pendingActions: 0,
      available: false,
      error: error instanceof Error ? error.message : "Share is unavailable.",
    };
  }
}

function folderTree(files: VaultFileRecord[]): Array<{ path: string; count: number; size: number }> {
  const folders = new Map<string, { path: string; count: number; size: number }>();
  for (const file of files) {
    const parts = file.path.split("/");
    const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "/";
    const current = folders.get(folder) ?? { path: folder, count: 0, size: 0 };
    current.count += 1;
    current.size += file.size;
    folders.set(folder, current);
  }
  return [...folders.values()].sort((a, b) => a.path.localeCompare(b.path));
}

type TreeNodeKind = "folder" | "file";

interface TreeNode {
  name: string;
  path: string;
  kind: TreeNodeKind;
  count: number;
  size: number;
  truncated?: boolean;
  children?: TreeNode[];
}

interface TreeFile {
  path: string;
  size: number;
}

function fileTree(files: TreeFile[], prefix = "", maxNodes = 700): TreeNode[] {
  const root: TreeNode = { name: "root", path: "", kind: "folder", count: 0, size: 0, children: [] };
  let nodeCount = 0;
  const cleanPrefix = prefix.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const scoped = files
    .map((file) => {
      const cleanPath = file.path.replaceAll("\\", "/").replace(/^\/+/, "");
      if (cleanPrefix) {
        if (cleanPath === cleanPrefix) return undefined;
        if (!cleanPath.startsWith(`${cleanPrefix}/`)) return undefined;
        return { path: cleanPath.slice(cleanPrefix.length + 1), size: file.size };
      }
      return { path: cleanPath, size: file.size };
    })
    .filter((file): file is TreeFile => Boolean(file))
    .filter((file) => file.path && !file.path.endsWith("/.agent-vault-folder"))
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const file of scoped) {
    if (nodeCount >= maxNodes) {
      root.truncated = true;
      break;
    }
    const parts = file.path.split("/").filter(Boolean);
    let cursor = root;
    cursor.count += 1;
    cursor.size += file.size;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const isFile = index === parts.length - 1;
      cursor.children ??= [];
      let child = cursor.children.find((item) => item.name === part && item.kind === (isFile ? "file" : "folder"));
      if (!child) {
        const childPath = parts.slice(0, index + 1).join("/");
        child = {
          name: part,
          path: childPath,
          kind: isFile ? "file" : "folder",
          count: 0,
          size: 0,
          children: isFile ? undefined : [],
        };
        cursor.children.push(child);
        nodeCount += 1;
      }
      child.count += 1;
      child.size += file.size;
      cursor = child;
    }
  }

  function sortNodes(nodes: TreeNode[] = []): TreeNode[] {
    return nodes
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1))
      .map((node) => ({ ...node, children: node.children ? sortNodes(node.children) : undefined }));
  }

  return sortNodes(root.children);
}

function remoteSourcePrefix(filePath: string): { label: string; prefix: string; origin: string } | undefined {
  const parts = filePath.split("/").filter(Boolean);
  if (!parts.length) return undefined;
  if (parts[0] === "Mac Mini" && parts[1]) {
    return { label: parts[1], prefix: `${parts[0]}/${parts[1]}`, origin: "Mac Mini" };
  }
  return { label: parts[0], prefix: parts[0], origin: "Vault" };
}

function remoteSourcesForSpace(space: string, files: VaultFileRecord[]) {
  const groups = new Map<
    string,
    { id: string; kind: "remote"; label: string; space: string; remotePathPrefix: string; origin: string; remoteFileCount: number; remoteSize: number }
  >();

  for (const file of files) {
    const source = remoteSourcePrefix(file.path);
    if (!source) continue;
    const key = `${space}\0${source.prefix}`;
    const current =
      groups.get(key) ?? {
        id: `remote:${space}:${source.prefix}`,
        kind: "remote" as const,
        label: source.label,
        space,
        remotePathPrefix: source.prefix,
        origin: source.origin,
        remoteFileCount: 0,
        remoteSize: 0,
      };
    current.remoteFileCount += 1;
    current.remoteSize += file.size;
    groups.set(key, current);
  }

  return [...groups.values()].map((source) => ({
    ...source,
    access: "readonly",
    tree: fileTree(files, source.remotePathPrefix, 700),
  }));
}

function belongsToPrefix(filePath: string, prefix: string): boolean {
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}

function flowStats(changes: ChangeEventRecord[], files: VaultFileRecord[]) {
  const now = Date.now();
  const windows = [
    { key: "hour", label: "1h", ms: 60 * 60 * 1000 },
    { key: "day", label: "24h", ms: 24 * 60 * 60 * 1000 },
    { key: "week", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  ];
  const fileSizeBySpacePath = new Map(files.map((file) => [`${file.space}/${file.path}`, file.size]));

  return windows.map((window) => {
    const scoped = changes.filter((change) => now - new Date(change.timestamp).getTime() <= window.ms);
    return {
      key: window.key,
      label: window.label,
      events: scoped.length,
      bytes: scoped.reduce((sum, change) => sum + (fileSizeBySpacePath.get(`${change.space}/${change.path}`) ?? 0), 0),
    };
  });
}

function fallbackServerStatus(): VaultServerStatus {
  return {
    id: "server:mac-mini",
    name: "Mac Mini Vault Server",
    role: "vault-server",
    status: "online",
    lastSeenAt: new Date().toISOString(),
  };
}

function ensureCurrentDevice(
  devices: DeviceStatusRecord[],
  currentDeviceId: string,
  fallback: DeviceStatusRecord,
): DeviceStatusRecord[] {
  const normalized = devices.map((device) => ({
    ...device,
    current: device.current || device.id === currentDeviceId,
  }));
  if (normalized.some((device) => device.id === fallback.id)) return normalized;
  return [fallback, ...normalized];
}

async function connectedDevices(vault: VaultClient): Promise<{
  server: VaultServerStatus;
  devices: DeviceStatusRecord[];
  currentDeviceId: string;
  presenceVisible: boolean;
  adminVisible: boolean;
}> {
  const me = await vault.me();
  const self: DeviceStatusRecord = {
    ...me.device,
    status: "online",
    lastSeenAt: new Date().toISOString(),
    clientName: "mac-sync",
    clientVersion: null,
    hostName: null,
    current: true,
  };
  try {
    const status = await vault.deviceStatus();
    return {
      server: status.server,
      devices: ensureCurrentDevice(status.devices, status.currentDeviceId, self),
      currentDeviceId: status.currentDeviceId,
      presenceVisible: true,
      adminVisible: true,
    };
  } catch {
    // Older live Vault servers do not have presence yet. Still show the Mac Mini server,
    // because reaching /me already proves the server side is online.
  }

  try {
    return {
      server: fallbackServerStatus(),
      devices: ensureCurrentDevice(
        (await vault.listDevices()).map((device) => ({
          ...device,
          status: device.id === me.device.id ? "online" : "offline",
          lastSeenAt: device.id === me.device.id ? new Date().toISOString() : null,
          clientName: device.id === me.device.id ? "mac-sync" : null,
          clientVersion: null,
          hostName: null,
          current: device.id === me.device.id,
        })),
        me.device.id,
        self,
      ),
      currentDeviceId: me.device.id,
      presenceVisible: false,
      adminVisible: true,
    };
  } catch {
    return {
      server: fallbackServerStatus(),
      devices: [self],
      currentDeviceId: me.device.id,
      presenceVisible: false,
      adminVisible: false,
    };
  }
}

async function buildSummary(config: MacSyncConfig) {
  const vault = new VaultClient(config.serverUrl, config.token);
  const shareConfig = await loadShareConfig();
  const mainConfig = configWithShareIgnores(config, shareConfig.shares);
  const fallbackSpace: SpaceAccessInfo = {
    name: config.space,
    createdAt: new Date().toISOString(),
    permissions: [],
  };
  const [spacesResult, mainStatus, activity, deviceSummary] = await Promise.all([
    vault.listSpaces().then(
      (spaces) => ({ spaces, error: null as string | null }),
      (error: unknown) => ({
        spaces: [fallbackSpace],
        error: error instanceof Error ? error.message : "Vault connection failed.",
      }),
    ),
    statusCommand(mainConfig).catch((error: unknown) => ({ actions: [], error: error instanceof Error ? error.message : "Status failed." })),
    readActivity(),
    connectedDevices(vault).catch(() => ({
      server: fallbackServerStatus(),
      devices: [],
      currentDeviceId: "",
      presenceVisible: false,
      adminVisible: false,
    })),
  ]);
  const spaces = spacesResult.spaces;
  const localShares = await Promise.all(shareConfig.shares.map((share) => summarizeShare(config, share)));
  const remoteSpaces = await Promise.all(
    spaces.map(async (space) => {
      try {
        const [files, changes] = await Promise.all([vault.listFiles(space.name), vault.listChanges(space.name, 0)]);
        return {
          name: space.name,
          permissions: space.permissions,
          fileCount: files.length,
          size: files.reduce((sum, file) => sum + file.size, 0),
          folders: folderTree(files),
          files: files.slice(0, 200),
          tree: fileTree(files, "", 700),
          sources: remoteSourcesForSpace(space.name, files),
          recentChanges: changes.changes.slice(-40).reverse(),
        };
      } catch (error: unknown) {
        return {
          name: space.name,
          permissions: space.permissions,
          fileCount: 0,
          size: 0,
          folders: [],
          files: [],
          tree: [],
          sources: [],
          recentChanges: [],
          error: error instanceof Error ? error.message : "Space failed.",
        };
      }
    }),
  );
  const remoteFiles = remoteSpaces.flatMap((space) => space.files);
  const recentChanges = remoteSpaces
    .flatMap((space) => space.recentChanges.map((change) => ({ ...change, space: space.name })))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const shares = localShares.map((share) => {
    const remoteSpace = remoteSpaces.find((space) => space.name === share.space);
    const remoteShareFiles = remoteSpace?.files.filter((file) => belongsToPrefix(file.path, share.remotePathPrefix)) ?? [];
    const remoteSource = remoteSpace?.sources.find((source) => source.remotePathPrefix === share.remotePathPrefix);
    const lastRemoteChange = recentChanges.find(
      (change) => change.space === share.space && belongsToPrefix(change.path, share.remotePathPrefix),
    );
    return {
      kind: "local" as const,
      ...share,
      remoteFileCount: remoteSource?.remoteFileCount ?? remoteShareFiles.length,
      remoteSize: remoteSource?.remoteSize ?? remoteShareFiles.reduce((sum, file) => sum + file.size, 0),
      remoteTree: remoteSource?.tree ?? fileTree(remoteShareFiles, share.remotePathPrefix, 700),
      lastRemoteChange: lastRemoteChange?.timestamp ?? null,
    };
  });
  const localSourceKeys = new Set(shares.map((share) => `${share.space}\0${share.remotePathPrefix}`));
  const remoteSources = remoteSpaces
    .flatMap((space) => space.sources)
    .filter((source) => !localSourceKeys.has(`${source.space}\0${source.remotePathPrefix}`))
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    serverUrl: config.serverUrl,
    syncFolder: config.localDir,
    defaultSpace: config.space,
    mainPendingActions: "actions" in mainStatus ? changedCount(mainStatus.actions) : 0,
    mainStatusError: "error" in mainStatus ? mainStatus.error : null,
    shares,
    remoteSources,
    remoteSpaces,
    devices: deviceSummary.devices,
    server: deviceSummary.server,
    currentDeviceId: deviceSummary.currentDeviceId,
    devicesPresenceVisible: deviceSummary.presenceVisible,
    devicesAdminVisible: deviceSummary.adminVisible,
    connectionError: spacesResult.error,
    flowStats: flowStats(recentChanges, remoteFiles),
    recentChanges,
    activity,
  };
}

async function syncAll(config: MacSyncConfig) {
  const result = await syncAllSources(config);
  await recordActivity("sync", "Synced Agent Vault desktop sources", {
    main: result.main,
    total: result.total,
    shares: result.shares.map((share) => ({ label: share.label, summary: share.summary })),
  });
  return result;
}

function safeRelativeFolder(value: string): string {
  const cleaned = value.replaceAll("\\", "/").trim();
  const parts = cleaned
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new UiError(400, "invalid_folder_name", "Folder name is invalid.");
  }
  return parts.join("/");
}

async function createFolderMarker(config: MacSyncConfig, share: ShareRecord, folderName: string) {
  const folder = safeRelativeFolder(folderName);
  const targetDir = path.join(share.localDir, ...folder.split("/"));
  const markerPath = path.join(targetDir, ".agent-vault-folder");
  await mkdir(targetDir, { recursive: true });
  await writeFile(markerPath, `Agent Vault folder marker\n${new Date().toISOString()}\n`, { flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const synced = await syncShare(config, share);
  await recordActivity("sync", `Created shared folder ${share.label}/${folder}`, {
    share: share.label,
    folder,
    summary: synced.summary,
  });
  return { folder, marker: ".agent-vault-folder", synced };
}

async function ingestLocalPath(config: MacSyncConfig, inputPath: string) {
  const localPath = path.resolve(inputPath);
  const localStat = await stat(localPath);
  if (localStat.isDirectory()) {
    const share = await addShare({
      localDir: localPath,
      space: config.space,
      access: "readwrite",
    });
    const initialSync = await syncShare(config, share);
    await recordActivity("share_added", `Dropped shared folder ${share.label}`, {
      localDir: share.localDir,
      space: share.space,
      remotePathPrefix: share.remotePathPrefix,
      initialSync: initialSync.summary,
    });
    return { kind: "share", share, initialSync };
  }

  if (!localStat.isFile()) {
    throw new UiError(400, "unsupported_drop_path", "Dropped path must be a file or folder.");
  }

  const body = await readFile(localPath);
  const filePath = `Desktop Drops/${path.basename(localPath)}`;
  const uploaded = await new VaultClient(config.serverUrl, config.token).upload(
    config.space,
    filePath,
    body,
    `${config.deviceId}:${config.space}:native-drop:${filePath}:${randomUUID()}`,
  );
  await recordActivity("drop_upload", `Uploaded drop ${filePath}`, { space: config.space, path: filePath, size: body.byteLength });
  return { kind: "file", file: uploaded };
}

function startUiAutoSync(config: MacSyncConfig): () => void {
  let running = false;
  let closed = false;
  const intervalMs = Number.parseInt(process.env.AGENT_VAULT_UI_AUTOSYNC_MS ?? "20000", 10);

  async function run(reason: string): Promise<void> {
    if (running || closed) return;
    running = true;
    try {
      const result = await syncAllSources(config);
      if (summaryChanged(result.total)) {
        await recordActivity("sync", `Auto-synced Agent Vault sources (${reason})`, {
          total: result.total,
          shares: result.shares.map((share) => ({ label: share.label, summary: share.summary })),
        });
      }
    } catch (error: unknown) {
      await recordActivity("error", "Auto-sync failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void run("ui"), Math.max(5000, intervalMs));
  void run("ui startup");
  return () => {
    closed = true;
    clearInterval(timer);
  };
}

async function handleApi(config: MacSyncConfig, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  const route = segments(url);

  if (method === "GET" && route.join("/") === "api/summary") {
    sendJson(res, 200, await buildSummary(config));
    return;
  }

  if (method === "POST" && route.join("/") === "api/sync") {
    sendJson(res, 200, await syncAll(config));
    return;
  }

  if (method === "GET" && route.join("/") === "api/choose-folder") {
    sendJson(res, 200, { path: await chooseFolder() });
    return;
  }

  if (method === "POST" && route.join("/") === "api/open-main-folder") {
    openPath(config.localDir);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && route.join("/") === "api/open-folder") {
    const body = await readJson(req);
    const folderPath = String(body.path ?? "");
    if (!folderPath) {
      throw new UiError(400, "missing_path", "Folder path is required.");
    }
    openPath(folderPath);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && route.join("/") === "api/shares") {
    const body = await readJson(req);
    const folderPath = String(body.path ?? body.localDir ?? "").trim();
    if (!folderPath) {
      throw new UiError(400, "missing_path", "Folder path is required.");
    }
    const share = await addShare({
      localDir: folderPath,
      label: typeof body.label === "string" ? body.label : undefined,
      space: typeof body.space === "string" ? body.space : config.space,
      remotePathPrefix: typeof body.remotePathPrefix === "string" ? body.remotePathPrefix : undefined,
      access: normalizeShareAccess(body.access),
      ignoreNames: Array.isArray(body.ignoreNames) ? body.ignoreNames.map((item) => String(item)) : undefined,
      ignorePathPrefixes: Array.isArray(body.ignorePathPrefixes) ? body.ignorePathPrefixes.map((item) => String(item)) : undefined,
    });
    const initialSync = await syncShare(config, share);
    await recordActivity("share_added", `Added shared folder ${share.label}`, {
      localDir: share.localDir,
      space: share.space,
      remotePathPrefix: share.remotePathPrefix,
      initialSync: initialSync.summary,
    });
    sendJson(res, 201, { share, initialSync });
    return;
  }

  if (method === "PATCH" && route.length === 3 && route[0] === "api" && route[1] === "shares") {
    const body = await readJson(req);
    const share = await updateShare(route[2] ?? "", {
      access: typeof body.access === "string" ? normalizeShareAccess(body.access) : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      label: typeof body.label === "string" ? body.label : undefined,
    });
    await recordActivity("share_updated", `Updated shared folder ${share.label}`, {
      id: share.id,
      access: share.access,
      enabled: share.enabled,
    });
    sendJson(res, 200, { share });
    return;
  }

  if (method === "DELETE" && route.length === 3 && route[0] === "api" && route[1] === "shares") {
    const removed = await removeShare(route[2] ?? "");
    if (!removed) {
      throw new UiError(404, "share_not_found", "Shared folder was not found.");
    }
    await recordActivity("share_removed", "Removed shared folder", { id: route[2] });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && route.length === 4 && route[0] === "api" && route[1] === "shares" && route[3] === "sync") {
    const shareConfig = await loadShareConfig();
    const share = shareConfig.shares.find((item) => item.id === route[2]);
    if (!share) {
      throw new UiError(404, "share_not_found", "Shared folder was not found.");
    }
    const result = await syncShare(config, share);
    await recordActivity("sync", `Synced shared folder ${share.label}`, {
      label: share.label,
      summary: result.summary,
    });
    sendJson(res, 200, result);
    return;
  }

  if (method === "POST" && route.length === 4 && route[0] === "api" && route[1] === "shares" && route[3] === "folders") {
    const shareConfig = await loadShareConfig();
    const share = shareConfig.shares.find((item) => item.id === route[2]);
    if (!share) {
      throw new UiError(404, "share_not_found", "Shared folder was not found.");
    }
    const body = await readJson(req);
    const folderName = String(body.name ?? body.path ?? "").trim();
    if (!folderName) {
      throw new UiError(400, "missing_folder_name", "Folder name is required.");
    }
    sendJson(res, 201, await createFolderMarker(config, share, folderName));
    return;
  }

  if (method === "POST" && route.join("/") === "api/drop") {
    const space = url.searchParams.get("space") || config.space;
    const filePath = url.searchParams.get("path") || `${new Date().toISOString()}-drop.bin`;
    const body = await readBody(req);
    const uploaded = await new VaultClient(config.serverUrl, config.token).upload(
      space,
      filePath,
      body,
      `${config.deviceId}:${space}:desktop-drop:${filePath}:${randomUUID()}`,
    );
    await recordActivity("drop_upload", `Uploaded drop ${filePath}`, { space, path: filePath, size: body.byteLength });
    sendJson(res, 201, { file: uploaded });
    return;
  }

  if (method === "POST" && route.join("/") === "api/ingest-paths") {
    const body = await readJson(req);
    const paths = Array.isArray(body.paths) ? body.paths.map((item) => String(item)).filter(Boolean) : [];
    if (!paths.length) {
      throw new UiError(400, "missing_paths", "At least one local path is required.");
    }
    const results = [];
    for (const localPath of paths) {
      results.push(await ingestLocalPath(config, localPath));
    }
    sendJson(res, 201, { results });
    return;
  }

  throw new UiError(404, "not_found", "Desktop UI endpoint was not found.");
}

async function handleRequest(config: MacSyncConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = parseUrl(req);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/desktop")) {
    sendHtml(res);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    await handleApi(config, req, res, url);
    return;
  }
  throw new UiError(404, "not_found", "Desktop UI route was not found.");
}

function openBrowser(url: string): void {
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.unref();
}

export async function startDesktopUi(config: MacSyncConfig, options: DesktopUiOptions = {}): Promise<StartedDesktopUi> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4786;
  let stopAutoSync: () => void = () => {};
  const server = createServer((req, res) => {
    void handleRequest(config, req, res).catch((error) => sendError(res, error));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}/desktop`;
  stopAutoSync = startUiAutoSync(config);
  if (options.open !== false) {
    openBrowser(url);
  }

  return {
    url,
    port: actualPort,
    server,
    close() {
      stopAutoSync();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function renderHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent Vault Desktop</title>
    <link rel="icon" href="data:," />
    <style>
      :root {
        color-scheme: dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        background: transparent;
        color: #ede6da;
        --bg: rgba(34, 33, 30, 0.78);
        --panel: rgba(55, 54, 50, 0.44);
        --panel-deep: rgba(22, 22, 20, 0.66);
        --line: rgba(237, 230, 218, 0.078);
        --line-strong: rgba(237, 230, 218, 0.15);
        --text: #ede6da;
        --muted: rgba(237, 230, 218, 0.61);
        --faint: rgba(237, 230, 218, 0.36);
        --ghost: rgba(237, 230, 218, 0.19);
        --accent: #d0c2aa;
        --accent-soft: rgba(208, 194, 170, 0.11);
        --warn: #d7bc86;
        --ok: #b4c8a2;
        --danger: #c38f82;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100svh;
        background: transparent;
        overflow: hidden;
        -webkit-font-smoothing: antialiased;
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        background: rgba(34, 33, 30, 0.78);
        backdrop-filter: blur(26px) saturate(1.08);
        -webkit-backdrop-filter: blur(26px) saturate(1.08);
      }
      body.dragging::after {
        content: "Drop to Agent Vault";
        position: fixed;
        left: 50%;
        bottom: 31px;
        z-index: 20;
        transform: translateX(-50%);
        color: rgba(237, 230, 218, 0.82);
        background: rgba(58, 56, 52, 0.58);
        border: 1px solid rgba(237, 230, 218, 0.12);
        border-radius: 999px;
        padding: 8px 12px;
        font-size: 11px;
        font-weight: 520;
        backdrop-filter: blur(22px);
        -webkit-backdrop-filter: blur(22px);
      }
      button,
      input { font: inherit; }
      button {
        user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      ::selection {
        background: rgba(237, 230, 218, 0.18);
      }
      .shell {
        position: relative;
        min-height: 100svh;
        padding: 21px 34px 31px 93px;
        background: transparent;
      }
      .topline {
        position: relative;
        z-index: 5;
        height: 34px;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        border-bottom: 1px solid rgba(237, 230, 218, 0.08);
      }
      .add-button,
      .icon-button,
      .text-button,
      .schema-tool {
        border: 1px solid transparent;
        color: rgba(237, 230, 218, 0.66);
        background: transparent;
        cursor: pointer;
        transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 140ms ease;
      }
      .add-button {
        width: 29px;
        height: 29px;
        border-radius: 9px;
        display: grid;
        place-items: center;
        color: rgba(237, 230, 218, 0.88);
        background: rgba(237, 230, 218, 0.08);
        border-color: rgba(237, 230, 218, 0.12);
        font-size: 19px;
        line-height: 1;
      }
      .pathline {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        color: rgba(237, 230, 218, 0.61);
        font-size: 11px;
        font-weight: 520;
        white-space: nowrap;
        overflow: hidden;
      }
      .pathline strong {
        color: rgba(237, 230, 218, 0.82);
        font-weight: 560;
      }
      .pathline span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .top-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
      }
      .text-button {
        min-height: 27px;
        padding: 0 9px;
        border-radius: 8px;
        font-size: 11px;
        font-weight: 540;
        color: rgba(237, 230, 218, 0.55);
      }
      .text-button:hover,
      .icon-button:hover,
      .schema-tool:hover,
      .add-button:hover {
        color: rgba(237, 230, 218, 0.9);
        background: rgba(237, 230, 218, 0.055);
        border-color: rgba(237, 230, 218, 0.1);
      }
      .text-button.primary {
        color: rgba(237, 230, 218, 0.84);
        background: rgba(237, 230, 218, 0.09);
        border-color: rgba(237, 230, 218, 0.11);
      }
      .nav-float {
        position: fixed;
        left: 25px;
        top: 66px;
        z-index: 8;
        display: grid;
        gap: 9px;
      }
      .icon-button {
        width: 34px;
        height: 34px;
        border: 0;
        border-radius: 10px;
        display: grid;
        place-items: center;
      }
      .icon-button.active {
        color: rgba(237, 230, 218, 0.92);
        background: rgba(237, 230, 218, 0.08);
        border: 1px solid rgba(237, 230, 218, 0.095);
      }
      .mini-icon {
        position: relative;
        width: 16px;
        height: 16px;
        display: block;
      }
      .vault-icon {
        border-radius: 4px;
        border: 1.5px solid currentColor;
      }
      .vault-icon::after {
        content: "";
        position: absolute;
        left: 3px;
        right: 3px;
        bottom: 4px;
        height: 1.5px;
        background: currentColor;
        opacity: 0.72;
      }
      .schema-icon::before,
      .schema-icon::after {
        content: "";
        position: absolute;
        border: 1.5px solid currentColor;
        border-radius: 4px;
      }
      .schema-icon::before {
        left: 0;
        top: 1px;
        width: 7px;
        height: 7px;
      }
      .schema-icon::after {
        right: 0;
        bottom: 1px;
        width: 7px;
        height: 7px;
      }
      .workspace {
        position: relative;
        z-index: 2;
        min-width: 0;
        height: calc(100svh - 86px);
        margin-top: 21px;
      }
      .view {
        height: 100%;
        min-height: 0;
        display: none;
      }
      .view.active {
        display: flex;
      }
      .vault-view {
        gap: clamp(26px, 4.6vw, 72px);
      }
      .stage {
        position: relative;
        flex: 1 1 auto;
        min-width: 0;
        height: 100%;
        padding: 42px 0 72px;
      }
      .micro-kicker,
      .side-title,
      .schema-title {
        margin: 0;
        color: rgba(237, 230, 218, 0.82);
        font-size: 11px;
        line-height: 1;
        font-weight: 560;
        letter-spacing: 0;
      }
      .stage-meta {
        margin-top: 9px;
        color: var(--faint);
        font-size: 11px;
        font-weight: 480;
      }
      .source-field {
        position: relative;
        height: calc(100% - 76px);
        min-height: 390px;
        margin-top: 31px;
        overflow: hidden;
      }
      .source-cluster {
        position: relative;
        height: 100%;
      }
      .source {
        position: absolute;
        width: min(290px, 42vw);
        min-height: 96px;
        padding-left: 74px;
        border-radius: 12px;
        cursor: pointer;
        animation: sourceIn 260ms ease both;
      }
      .source:nth-child(6n + 1) { left: 2%; top: 4%; }
      .source:nth-child(6n + 2) { left: 36%; top: 16%; }
      .source:nth-child(6n + 3) { left: 16%; top: 42%; }
      .source:nth-child(6n + 4) { left: 58%; top: 47%; }
      .source:nth-child(6n + 5) { left: 4%; top: 70%; }
      .source:nth-child(6n + 6) { left: 44%; top: 74%; }
      @keyframes sourceIn {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .folder-mark {
        position: absolute;
        left: 0;
        top: 2px;
        width: 52px;
        height: 38px;
        border-radius: 6px;
        border: 1px solid rgba(237, 230, 218, 0.14);
        background: rgba(237, 230, 218, 0.055);
        box-shadow: 0 22px 50px rgba(0, 0, 0, 0.22);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
      }
      .source.selected .folder-mark {
        border-color: rgba(237, 230, 218, 0.28);
        background: rgba(237, 230, 218, 0.09);
      }
      .source.selected .source-title {
        color: #f4ecdf;
      }
      .folder-mark::before {
        content: "";
        position: absolute;
        left: 6px;
        top: -7px;
        width: 22px;
        height: 9px;
        border: 1px solid rgba(237, 230, 218, 0.12);
        border-bottom: 0;
        border-radius: 5px 5px 0 0;
        background: rgba(237, 230, 218, 0.045);
      }
      .source-title {
        max-width: 210px;
        color: rgba(237, 230, 218, 0.9);
        font-size: 17px;
        line-height: 1.13;
        font-weight: 580;
        overflow-wrap: anywhere;
      }
      .source-path {
        margin-top: 7px;
        max-width: 240px;
        color: var(--faint);
        font-size: 11px;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .source-line {
        margin-top: 12px;
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
        color: rgba(237, 230, 218, 0.45);
        font-size: 11px;
      }
      .access-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 18px;
        padding: 0 7px;
        border: 1px solid rgba(237, 230, 218, 0.09);
        border-radius: 999px;
        font-size: 10px;
        color: rgba(237, 230, 218, 0.58);
      }
      .access-chip::before {
        content: "";
        width: 4px;
        height: 4px;
        border-radius: 999px;
        background: var(--accent);
      }
      .access-chip.readonly::before { background: var(--ok); }
      .access-chip.writeonly::before { background: var(--warn); }
      .access-chip.readwrite::before { background: var(--accent); }
      .tiny-icon {
        display: inline-block;
        width: 12px;
        height: 12px;
        margin-right: 4px;
        vertical-align: -2px;
        color: currentColor;
      }
      .tiny-icon svg {
        width: 12px;
        height: 12px;
        stroke: currentColor;
        stroke-width: 1.45;
        fill: none;
      }
      .source-action {
        border: 0;
        padding: 0;
        color: rgba(237, 230, 218, 0.44);
        background: transparent;
        cursor: pointer;
        font-size: 11px;
        font-weight: 520;
      }
      .source-action:hover {
        color: rgba(237, 230, 218, 0.82);
      }
      .source-action.danger:hover {
        color: var(--danger);
      }
      .source.empty {
        left: 12%;
        top: 23%;
        width: min(420px, 70vw);
        padding-left: 0;
        color: rgba(237, 230, 218, 0.42);
        font-size: 14px;
        line-height: 1.45;
      }
      .paste-path {
        position: absolute;
        left: 0;
        bottom: 0;
        width: min(540px, 88%);
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
      }
      input {
        height: 28px;
        min-width: 0;
        color: rgba(237, 230, 218, 0.76);
        background: transparent;
        border: 0;
        border-bottom: 1px solid rgba(237, 230, 218, 0.11);
        border-radius: 0;
        padding: 0 2px;
        outline: none;
        font-size: 11px;
      }
      input::placeholder {
        color: rgba(237, 230, 218, 0.3);
      }
      input:focus {
        border-bottom-color: rgba(237, 230, 218, 0.25);
      }
      .quiet-submit {
        border: 0;
        padding: 0 2px;
        color: rgba(237, 230, 218, 0.47);
        background: transparent;
        cursor: pointer;
        font-size: 12px;
      }
      .quiet-submit:hover {
        color: rgba(237, 230, 218, 0.84);
      }
      .side {
        flex: 0 0 330px;
        min-height: 0;
        display: block;
        padding: 42px 0 25px;
        position: relative;
      }
      .system-sections {
        height: 100%;
        min-height: 0;
        display: grid;
        grid-template-rows: auto auto minmax(0, 0.82fr) minmax(0, 0.92fr);
        gap: 24px;
      }
      .inspector-switch {
        position: absolute;
        right: 0;
        top: 1px;
        z-index: 4;
        display: inline-flex;
        gap: 4px;
        padding: 3px;
        border: 1px solid rgba(237, 230, 218, 0.08);
        border-radius: 999px;
        background: rgba(55, 54, 50, 0.28);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
      }
      .switch-button {
        height: 22px;
        border: 0;
        border-radius: 999px;
        padding: 0 8px;
        color: rgba(237, 230, 218, 0.44);
        background: transparent;
        font-size: 10.5px;
        cursor: pointer;
      }
      .switch-button.active {
        color: rgba(237, 230, 218, 0.82);
        background: rgba(237, 230, 218, 0.075);
      }
      .side-section {
        min-height: 0;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        gap: 17px;
        overflow: hidden;
        border: 1px solid rgba(237, 230, 218, 0.072);
        border-radius: 13px;
        background: rgba(55, 54, 50, 0.42);
        padding: 15px 14px;
        backdrop-filter: blur(22px) saturate(1.04);
        -webkit-backdrop-filter: blur(22px) saturate(1.04);
      }
      .tree-section {
        height: 100%;
        min-height: 0;
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr);
        gap: 18px;
        overflow: hidden;
        padding-top: 45px;
      }
      .selected-source-head {
        display: grid;
        gap: 8px;
      }
      .selected-source-title {
        margin: 0;
        color: rgba(237, 230, 218, 0.9);
        font-size: 18px;
        line-height: 1.1;
        font-weight: 570;
        overflow-wrap: anywhere;
      }
      .selected-source-meta {
        color: var(--faint);
        font-size: 11px;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .access-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
      }
      .access-button {
        min-height: 24px;
        border: 1px solid rgba(237, 230, 218, 0.08);
        border-radius: 999px;
        padding: 0 8px;
        color: rgba(237, 230, 218, 0.46);
        background: transparent;
        font-size: 10.5px;
        cursor: pointer;
      }
      .access-button.active {
        color: rgba(237, 230, 218, 0.84);
        background: rgba(237, 230, 218, 0.075);
      }
      .tree-list {
        min-height: 0;
        overflow: auto;
        padding-right: 6px;
      }
      .tree-list details {
        margin: 0;
        padding-left: 13px;
        border-left: 1px solid rgba(237, 230, 218, 0.055);
      }
      .tree-list summary {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
        min-height: 25px;
        color: rgba(237, 230, 218, 0.68);
        font-size: 11.5px;
        cursor: pointer;
        list-style: none;
      }
      .tree-list summary::-webkit-details-marker {
        display: none;
      }
      .tree-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
        min-height: 24px;
        padding-left: 13px;
        color: rgba(237, 230, 218, 0.52);
        font-size: 11px;
      }
      .tree-name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tree-metric {
        color: var(--faint);
        font-size: 10px;
        white-space: nowrap;
      }
      .side-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .side-body {
        min-height: 0;
        overflow: auto;
        padding-right: 5px;
      }
      .space,
      .activity,
      .device,
      .stat-row {
        padding: 0 0 18px;
      }
      .space + .space,
      .activity + .activity,
      .device + .device,
      .stat-row + .stat-row {
        border-top: 1px solid var(--line);
        padding-top: 18px;
      }
      .space-title {
        color: rgba(237, 230, 218, 0.84);
        font-size: 16px;
        line-height: 1.15;
        font-weight: 560;
      }
      .subtle {
        color: var(--faint);
        font-size: 11px;
      }
      .folder,
      .change,
      .device,
      .stat-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: baseline;
        padding-top: 10px;
      }
      .mono {
        min-width: 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 10.5px;
        color: rgba(237, 230, 218, 0.48);
        overflow-wrap: anywhere;
      }
      .metric {
        color: var(--faint);
        font-size: 10.5px;
        white-space: nowrap;
      }
      .activity-message {
        color: rgba(237, 230, 218, 0.64);
        font-size: 12px;
        line-height: 1.35;
      }
      .activity-meta {
        margin-top: 5px;
        color: var(--faint);
        font-size: 10.5px;
      }
      .device-name,
      .stat-label {
        color: rgba(237, 230, 218, 0.68);
        font-size: 12px;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .server-device .device-name {
        color: rgba(237, 230, 218, 0.84);
      }
      .device-status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .status-dot {
        width: 5px;
        height: 5px;
        border-radius: 999px;
        background: rgba(237, 230, 218, 0.28);
      }
      .status-dot.online {
        background: var(--ok);
      }
      .status-dot.recent {
        background: var(--warn);
      }
      .device-meta,
      .stat-meta {
        color: var(--faint);
        font-size: 10.5px;
        text-align: right;
        white-space: nowrap;
      }
      .change-op {
        color: rgba(237, 230, 218, 0.58);
      }
      .empty-note {
        color: var(--faint);
        font-size: 12px;
        line-height: 1.45;
      }
      .status-pill {
        color: rgba(237, 230, 218, 0.4);
        font-size: 10.5px;
        border: 1px solid rgba(237, 230, 218, 0.09);
        border-radius: 999px;
        padding: 3px 7px;
      }
      .schema-view {
        flex-direction: column;
        gap: 17px;
        padding-top: 31px;
      }
      .schema-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
      }
      .schema-help {
        color: var(--faint);
        font-size: 11px;
      }
      .schema-tools {
        display: flex;
        gap: 5px;
        align-items: center;
      }
      .schema-tool {
        height: 26px;
        min-width: 26px;
        border-radius: 8px;
        padding: 0 8px;
        font-size: 11px;
      }
      .schema-viewport {
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
        cursor: grab;
        border: 1px solid rgba(237, 230, 218, 0.07);
        border-radius: 13px;
        background-color: rgba(28, 27, 25, 0.52);
        background-image:
          linear-gradient(rgba(237, 230, 218, 0.035) 1px, transparent 1px),
          linear-gradient(90deg, rgba(237, 230, 218, 0.035) 1px, transparent 1px);
        background-size: 44px 44px;
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
      }
      .schema-viewport:active {
        cursor: grabbing;
      }
      .schema-world {
        position: absolute;
        left: 0;
        top: 0;
        width: 980px;
        height: 610px;
        transform-origin: 0 0;
      }
      .schema-lines {
        position: absolute;
        inset: 0;
        width: 980px;
        height: 610px;
        pointer-events: none;
      }
      .schema-line {
        stroke: rgba(237, 230, 218, 0.18);
        stroke-width: 1;
        fill: none;
      }
      .schema-node {
        position: absolute;
        width: 188px;
        min-height: 86px;
        padding: 13px 14px 12px;
        border: 1px solid rgba(237, 230, 218, 0.12);
        border-radius: 10px;
        background: rgba(55, 54, 50, 0.5);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
      }
      .schema-node.source-node {
        border-color: rgba(208, 194, 170, 0.18);
      }
      .node-kind {
        color: rgba(237, 230, 218, 0.36);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }
      .node-title {
        margin-top: 8px;
        color: rgba(237, 230, 218, 0.86);
        font-size: 14px;
        line-height: 1.2;
        font-weight: 560;
        overflow-wrap: anywhere;
      }
      .node-meta {
        margin-top: 7px;
        color: var(--faint);
        font-size: 10.5px;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .toast {
        position: fixed;
        right: 25px;
        bottom: 24px;
        z-index: 30;
        max-width: min(390px, calc(100vw - 50px));
        color: rgba(237, 230, 218, 0.84);
        background: rgba(58, 56, 52, 0.58);
        border: 1px solid rgba(237, 230, 218, 0.12);
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 11px;
        backdrop-filter: blur(22px);
        -webkit-backdrop-filter: blur(22px);
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 160ms ease, transform 160ms ease;
      }
      .toast.show {
        opacity: 1;
        transform: translateY(0);
      }
      .hidden {
        display: none !important;
      }
      @media (max-width: 1080px) {
        body { overflow: auto; }
        .shell {
          min-height: 100svh;
          padding: 18px 24px 28px 78px;
        }
        .workspace {
          height: auto;
          min-height: calc(100svh - 78px);
        }
        .vault-view {
          flex-direction: column;
        }
        .side {
          flex-basis: auto;
        }
        .system-sections {
          grid-template-columns: 1fr 1fr;
          grid-template-rows: minmax(260px, auto);
        }
        .source-field {
          min-height: 520px;
        }
        .source {
          width: min(290px, 72vw);
        }
      }
      @media (max-width: 760px) {
        .shell {
          padding: 16px 16px 24px 62px;
        }
        .nav-float {
          left: 15px;
        }
        .top-actions {
          display: none;
        }
        .side {
        }
        .system-sections {
          grid-template-columns: 1fr;
        }
        .source:nth-child(n) {
          position: relative;
          left: auto;
          top: auto;
          margin: 0 0 34px;
        }
        .source-field {
          height: auto;
          min-height: 0;
          overflow: visible;
        }
        .schema-head {
          align-items: flex-start;
          flex-direction: column;
        }
        .schema-viewport {
          min-height: 520px;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="topline">
        <button class="add-button" id="chooseFolder" title="Add shared folder" aria-label="Add shared folder">+</button>
        <div class="pathline">
          <strong>Agent Vault</strong>
          <span>/</span>
          <span id="connection">loading</span>
        </div>
        <div class="top-actions">
          <button class="text-button" id="refresh">refresh</button>
          <button class="text-button primary" id="syncAll">sync</button>
        </div>
      </header>
      <nav class="nav-float" aria-label="Agent Vault views">
        <button class="icon-button active" data-view="vault" title="Vault" aria-label="Vault"><span class="mini-icon vault-icon" aria-hidden="true"></span></button>
        <button class="icon-button" data-view="schema" title="Schema" aria-label="Schema"><span class="mini-icon schema-icon" aria-hidden="true"></span></button>
      </nav>
      <section class="workspace" aria-live="polite">
        <section class="view vault-view active" id="view-vault">
          <section class="stage">
            <p class="micro-kicker">shared sources</p>
            <div class="stage-meta" id="shareCount">0 sources</div>
            <div class="source-field" id="dropSurface">
              <div class="source-cluster" id="shares"></div>
            </div>
            <form class="paste-path" id="pathForm">
              <input id="pathInput" placeholder="paste a local folder path" />
              <button class="quiet-submit" type="submit">add</button>
            </form>
          </section>
          <aside class="side">
            <div class="inspector-switch hidden" id="inspectorSwitch">
              <button class="switch-button active" data-side-mode="tree">tree</button>
              <button class="switch-button" data-side-mode="system">system</button>
            </div>
            <section class="tree-section hidden" id="treeSection">
              <div class="selected-source-head" id="selectedSource"></div>
              <div class="access-controls" id="accessControls"></div>
              <div class="tree-list" id="treeList"></div>
            </section>
            <div class="system-sections" id="systemSections">
              <section class="side-section">
                <div class="side-head">
                  <h2 class="side-title">devices</h2>
                  <span class="status-pill" id="deviceScope">local</span>
                </div>
                <div class="side-body" id="devices"></div>
              </section>
              <section class="side-section">
                <div class="side-head">
                  <h2 class="side-title">flow</h2>
                  <span class="status-pill" id="pending">0 pending</span>
                </div>
                <div class="side-body" id="flow"></div>
              </section>
              <section class="side-section">
                <div class="side-head">
                  <h2 class="side-title">structure</h2>
                </div>
                <div class="side-body" id="structure"></div>
              </section>
              <section class="side-section">
                <div class="side-head">
                  <h2 class="side-title">log</h2>
                </div>
                <div class="side-body" id="activity"></div>
              </section>
            </div>
          </aside>
        </section>
        <section class="view schema-view" id="view-schema">
          <header class="schema-head">
            <div>
              <h2 class="schema-title">schema</h2>
              <div class="schema-help">drag the field, scroll to zoom</div>
            </div>
            <div class="schema-tools">
              <button class="schema-tool" id="zoomOut">-</button>
              <button class="schema-tool" id="zoomReset">100%</button>
              <button class="schema-tool" id="zoomIn">+</button>
            </div>
          </header>
          <div class="schema-viewport" id="schemaViewport">
            <div class="schema-world" id="schemaWorld">
              <svg class="schema-lines" id="schemaLines" viewBox="0 0 980 610" aria-hidden="true"></svg>
              <div id="schemaNodes"></div>
            </div>
          </div>
        </section>
      </section>
    </main>
    <div class="toast" id="toast"></div>
    <script>
      const state = {
        summary: null,
        view: "vault",
        selectedSourceId: null,
        sideMode: "system",
        schema: { scale: 1, x: 80, y: 48, dragging: false, startX: 0, startY: 0, originX: 0, originY: 0, hasUserMoved: false },
        dragDepth: 0
      };
      const $ = (id) => document.getElementById(id);
      const toast = (message) => {
        const node = $("toast");
        node.textContent = message;
        node.classList.add("show");
        clearTimeout(window.__toastTimer);
        window.__toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
      };
      const api = async (url, options = {}) => {
        const response = await fetch(url, options);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error?.message || "Request failed");
        return body;
      };
      const fmtSize = (bytes) => {
        if (!bytes) return "0 B";
        const units = ["B", "KB", "MB", "GB"];
        let value = bytes;
        let index = 0;
        while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
        return value.toFixed(value >= 10 || index === 0 ? 0 : 1) + " " + units[index];
      };
      const fileLabel = (count) => count + " " + (count === 1 ? "file" : "files");
      const statusLabel = (status) => status === "online" ? "online" : status === "recent" ? "recent" : "offline";
      const scopeLabel = (device) => {
        const scopes = device.scopes || [];
        if (!scopes.length) return "no spaces";
        return scopes.map((scope) => scope.space + " " + (scope.permissions || []).join("")).join(" / ");
      };
      const accessLabel = (access) => access === "readonly" ? "read only" : access === "writeonly" ? "write only" : "read + write";
      const accessHint = (access) => access === "readonly"
        ? "Mac Mini reads this folder into Vault"
        : access === "writeonly"
          ? "Vault writes into this folder"
          : "Bidirectional sync";
      const iconSvg = (name) => {
        if (name === "open") return '<span class="tiny-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 5.5h9v7h-9z"/><path d="M5 5.5V3.8h3l1.2 1.7"/></svg></span>';
        if (name === "folder") return '<span class="tiny-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2.7 5.4h10.6v7.1H2.7z"/><path d="M3.8 5.4V3.8h3l1.1 1.6"/></svg></span>';
        if (name === "sync") return '<span class="tiny-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M12.5 5.2A4.7 4.7 0 0 0 4 3.9"/><path d="M4 2.2v1.7h1.7"/><path d="M3.5 10.8a4.7 4.7 0 0 0 8.5 1.3"/><path d="M12 13.8v-1.7h-1.7"/></svg></span>';
        if (name === "remove") return '<span class="tiny-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></span>';
        return "";
      };
      const shortPath = (value) => {
        const text = String(value ?? "");
        const parts = text.split("/").filter(Boolean);
        if (parts.length <= 2) return text;
        return ".../" + parts.slice(-2).join("/");
      };
      const fmtTime = (value) => new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
      const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
      const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
      const schemaDefaults = () => window.innerWidth < 760
        ? { scale: 0.72, x: 8, y: 46 }
        : { scale: 1, x: 80, y: 48 };

      const allSources = () => {
        const summary = state.summary;
        if (!summary) return [];
        return [
          ...summary.shares.map((share) => ({ ...share, sourceKind: "local", sourceId: "local:" + share.id })),
          ...(summary.remoteSources || []).map((source) => ({ ...source, sourceKind: "remote", sourceId: source.id }))
        ];
      };

      const selectedSource = () => allSources().find((source) => source.sourceId === state.selectedSourceId) || null;

      async function refresh() {
        state.summary = await api("/api/summary");
        if (state.selectedSourceId && !allSources().some((source) => source.sourceId === state.selectedSourceId)) {
          state.selectedSourceId = null;
          state.sideMode = "system";
        }
        render();
      }

      function setView(view) {
        state.view = view;
        document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
        $("view-vault").classList.toggle("active", view === "vault");
        $("view-schema").classList.toggle("active", view === "schema");
        if (view === "schema") renderSchema();
      }

      function render() {
        const summary = state.summary;
        const totalPending = summary.mainPendingActions + summary.shares.reduce((sum, share) => sum + share.pendingActions, 0);
        const serverName = summary.server?.name || "Mac Mini Vault Server";
        const serverStatus = summary.server?.status || "online";
        $("connection").textContent = serverName + " / " + summary.defaultSpace + " / autosync";
        $("pending").textContent = totalPending + " pending";
        $("deviceScope").textContent = summary.devicesPresenceVisible ? "presence" : "local";
        const sources = allSources();
        $("shareCount").textContent = sources.length + (sources.length === 1 ? " source" : " sources") + " / autosync on";
        $("shares").innerHTML = sources.length ? sources.map((source) => {
          const isLocal = source.sourceKind === "local";
          const selected = source.sourceId === state.selectedSourceId;
          const pathText = isLocal ? source.localDir : source.origin + " / " + source.remotePathPrefix;
          const localText = isLocal
            ? (source.available ? fileLabel(source.localFileCount) + " / " + fmtSize(source.localSize) : "offline")
            : "remote";
          const pendingText = isLocal ? (source.pendingActions ? source.pendingActions + " pending" : "synced") : "readable";
          const actions = isLocal
            ? '<button class="source-action" data-open="' + esc(source.localDir) + '">' + iconSvg("open") + 'open</button>' +
              '<button class="source-action" data-folder="' + esc(source.id) + '">' + iconSvg("folder") + 'folder</button>' +
              '<button class="source-action" data-sync="' + esc(source.id) + '">' + iconSvg("sync") + 'sync</button>' +
              '<button class="source-action danger" data-remove="' + esc(source.id) + '">' + iconSvg("remove") + 'remove</button>'
            : '<button class="source-action" data-select-source="' + esc(source.sourceId) + '">' + iconSvg("folder") + 'tree</button>';
          return '<article class="source ' + (selected ? "selected" : "") + '" data-select-source="' + esc(source.sourceId) + '">' +
            '<span class="folder-mark" aria-hidden="true"></span>' +
            '<div class="source-title">' + esc(source.label) + '</div>' +
            '<div class="source-path" title="' + esc(pathText) + '">' + esc(shortPath(pathText)) + '</div>' +
            '<div class="source-line">' +
              '<span class="access-chip ' + esc(source.access) + '" title="' + esc(accessHint(source.access)) + '">' + esc(accessLabel(source.access)) + '</span>' +
              '<span>' + localText + '</span>' +
              '<span>/</span>' +
              '<span>' + source.remoteFileCount + ' remote / ' + fmtSize(source.remoteSize) + '</span>' +
              '<span>/</span>' +
              '<span>' + pendingText + '</span>' +
              '<span>/</span>' +
              actions +
            '</div>' +
          '</article>';
        }).join("") : '<div class="source empty">Press + to add a folder. Drop files or folders anywhere in this window for quick uploads.</div>';
        const serverRow = '<div class="device server-device">' +
          '<div class="device-name"><span class="device-status"><span class="status-dot ' + esc(serverStatus) + '"></span>' + esc(serverName) + '</span></div>' +
          '<div class="device-meta">server</div>' +
        '</div>';
        const deviceRows = summary.devices.length ? summary.devices.slice(0, 6).map((device) => {
          const scopeCount = (device.scopes || []).length;
          const isCurrent = device.current || device.id === summary.currentDeviceId;
          const status = statusLabel(device.status);
          return '<div class="device">' +
            '<div>' +
              '<div class="device-name"><span class="device-status"><span class="status-dot ' + esc(device.status) + '"></span>' + esc(device.name) + (isCurrent ? ' / current' : '') + '</span></div>' +
              '<div class="subtle">' + esc(scopeLabel(device)) + '</div>' +
            '</div>' +
            '<div class="device-meta">' + status + '<br />' + scopeCount + ' spaces</div>' +
          '</div>';
        }).join("") : '<div class="empty-note">' + (summary.connectionError ? 'Client status is reconnecting.' : 'No client data.') + '</div>';
        $("devices").innerHTML = serverRow + deviceRows;
        $("flow").innerHTML = summary.flowStats.map((stat) =>
          '<div class="stat-row">' +
            '<div class="stat-label">' + esc(stat.label) + '</div>' +
            '<div class="stat-meta">' + stat.events + ' events / ' + fmtSize(stat.bytes) + '</div>' +
          '</div>'
        ).join("");
        const visibleSpaces = summary.remoteSpaces.filter((space) => space.fileCount > 0 || space.name === summary.defaultSpace).slice(0, 4);
        $("structure").innerHTML = visibleSpaces.length ? visibleSpaces.map((space) => {
          const folders = (space.folders.length ? space.folders : [{ path: "/", count: 0, size: 0 }]).slice(0, 5).map((folder) =>
            '<div class="folder">' +
              '<span class="mono">' + esc(folder.path) + '</span>' +
              '<span class="metric">' + folder.count + ' / ' + fmtSize(folder.size) + '</span>' +
            '</div>'
          ).join("");
          return '<div class="space">' +
            '<div class="space-title">' + esc(space.name) + '</div>' +
            '<div class="subtle">' + fileLabel(space.fileCount) + ' / ' + fmtSize(space.size) + '</div>' +
            folders +
          '</div>';
        }).join("") : '<div class="empty-note">No vault files yet.</div>';
        const remoteLog = summary.recentChanges.slice(0, 12).map((change) =>
          '<div class="activity">' +
            '<div class="activity-message"><span class="change-op">' + esc(change.operation) + '</span> ' + esc(change.path) + '</div>' +
            '<div class="activity-meta">' + esc(change.space) + ' / ' + esc(change.device) + ' / ' + fmtTime(change.timestamp) + '</div>' +
          '</div>'
        );
        const localLog = summary.activity.slice(0, Math.max(0, 12 - remoteLog.length)).map((entry) =>
          '<div class="activity">' +
            '<div class="activity-message">' + esc(entry.message) + '</div>' +
            '<div class="activity-meta">' + esc(entry.kind) + ' / ' + fmtTime(entry.timestamp) + '</div>' +
          '</div>'
        );
        $("activity").innerHTML = remoteLog.concat(localLog).join("") || '<div class="empty-note">No activity yet.</div>';
        renderInspector();
        renderSchema();
      }

      function renderTreeNodes(nodes, depth = 0) {
        if (!nodes?.length) return '<div class="empty-note">No files in this source yet.</div>';
        return nodes.map((node) => {
          const metric = node.kind === "folder" ? node.count + " / " + fmtSize(node.size) : fmtSize(node.size);
          if (node.kind === "folder") {
            const open = depth < 1 ? " open" : "";
            return '<details' + open + '>' +
              '<summary><span class="tree-name">' + esc(node.name) + '</span><span class="tree-metric">' + metric + '</span></summary>' +
              renderTreeNodes(node.children || [], depth + 1) +
            '</details>';
          }
          return '<div class="tree-row"><span class="tree-name">' + esc(node.name) + '</span><span class="tree-metric">' + metric + '</span></div>';
        }).join("");
      }

      function renderInspector() {
        const source = selectedSource();
        const showTree = Boolean(source && state.sideMode === "tree");
        $("inspectorSwitch").classList.toggle("hidden", !source);
        $("treeSection").classList.toggle("hidden", !showTree);
        $("systemSections").classList.toggle("hidden", showTree);
        document.querySelectorAll("[data-side-mode]").forEach((button) => button.classList.toggle("active", button.dataset.sideMode === state.sideMode));
        if (!source) return;

        const isLocal = source.sourceKind === "local";
        const pathText = isLocal ? source.localDir : source.origin + " / " + source.remotePathPrefix;
        const tree = isLocal ? (source.remoteTree?.length ? source.remoteTree : source.localTree) : source.tree;
        $("selectedSource").innerHTML =
          '<h2 class="selected-source-title">' + esc(source.label) + '</h2>' +
          '<div class="selected-source-meta">' + esc(pathText) + '</div>' +
          '<div class="selected-source-meta">' + esc(fileLabel(source.remoteFileCount)) + ' / ' + esc(fmtSize(source.remoteSize)) + ' / ' + esc(accessLabel(source.access)) + '</div>';
        $("accessControls").innerHTML = isLocal ? [
          ["readonly", "read"],
          ["writeonly", "write"],
          ["readwrite", "both"]
        ].map(([mode, label]) =>
          '<button class="access-button ' + (source.access === mode ? "active" : "") + '" data-access="' + mode + '" data-share-id="' + esc(source.id) + '">' + label + '</button>'
        ).join("") : '<span class="access-chip readonly">read only</span>';
        $("treeList").innerHTML = renderTreeNodes(tree || []);
      }

      function renderOffline(message) {
        $("connection").textContent = "Mac Mini Vault Server / reconnecting";
        $("pending").textContent = "0 pending";
        $("deviceScope").textContent = "local";
        $("shareCount").textContent = "status unavailable";
        $("shares").innerHTML = '<div class="source empty">Agent Vault is reconnecting. Shared folders stay configured locally.</div>';
        $("devices").innerHTML =
          '<div class="device server-device">' +
            '<div class="device-name"><span class="device-status"><span class="status-dot recent"></span>Mac Mini Vault Server</span></div>' +
            '<div class="device-meta">server</div>' +
          '</div>' +
          '<div class="empty-note">' + esc(message || "Status unavailable.") + '</div>';
        $("flow").innerHTML = "";
        $("structure").innerHTML = '<div class="empty-note">Waiting for Vault status.</div>';
        $("activity").innerHTML = '<div class="empty-note">No live log while reconnecting.</div>';
        $("inspectorSwitch").classList.add("hidden");
        $("treeSection").classList.add("hidden");
        $("systemSections").classList.remove("hidden");
      }

      function schemaNode(id, kind, title, meta, x, y, extra = "") {
        return '<div class="schema-node ' + extra + '" id="' + esc(id) + '" style="left:' + x + 'px;top:' + y + 'px">' +
          '<div class="node-kind">' + esc(kind) + '</div>' +
          '<div class="node-title">' + esc(title) + '</div>' +
          '<div class="node-meta">' + esc(meta) + '</div>' +
        '</div>';
      }

      function renderSchema() {
        if (!state.summary) return;
        const summary = state.summary;
        const defaultSpace = summary.remoteSpaces.find((space) => space.name === summary.defaultSpace) || summary.remoteSpaces[0];
        const shares = summary.shares.slice(0, 5);
        const nodeHtml = [];
        const lines = [];
        const currentDevice = summary.devices.find((device) => device.current || device.id === summary.currentDeviceId);
        nodeHtml.push(schemaNode("node-device", "device", currentDevice?.name || "This Mac", summary.syncFolder, 76, 230));
        nodeHtml.push(schemaNode("node-server", "server", summary.server.name, "private Tailnet Vault", 360, 230));
        nodeHtml.push(schemaNode("node-space", "vault space", summary.defaultSpace, defaultSpace ? fileLabel(defaultSpace.fileCount) + " / " + fmtSize(defaultSpace.size) : "0 files", 590, 230));
        nodeHtml.push(schemaNode("node-drops", "quick drop", "Desktop Drops", "window-wide drop target", 718, 92));
        nodeHtml.push(schemaNode("node-log", "audit", "Activity Log", summary.recentChanges.length + " remote events", 718, 374));
        lines.push('<path class="schema-line" d="M264 273 C314 273 320 273 360 273" />');
        lines.push('<path class="schema-line" d="M548 273 C566 273 572 273 590 273" />');
        lines.push('<path class="schema-line" d="M778 252 C790 202 766 150 718 135" />');
        lines.push('<path class="schema-line" d="M778 294 C798 324 770 382 718 418" />');
        shares.forEach((share, index) => {
          const x = index % 2 === 0 ? 74 : 190;
          const y = 38 + index * 90;
          const id = "node-share-" + index;
          nodeHtml.push(schemaNode(id, "source", share.label, shortPath(share.localDir), x, y, "source-node"));
          const startX = x + 188;
          const startY = y + 43;
          lines.push('<path class="schema-line" d="M' + startX + ' ' + startY + ' C316 ' + startY + ' 324 273 360 273" />');
        });
        $("schemaLines").innerHTML = lines.join("");
        $("schemaNodes").innerHTML = nodeHtml.join("");
        if (!state.schema.hasUserMoved) {
          Object.assign(state.schema, schemaDefaults());
        }
        updateSchemaTransform();
      }

      function updateSchemaTransform() {
        const value = "translate(" + state.schema.x + "px, " + state.schema.y + "px) scale(" + state.schema.scale + ")";
        $("schemaWorld").style.transform = value;
        $("zoomReset").textContent = Math.round(state.schema.scale * 100) + "%";
      }

      async function addPath(path) {
        await api("/api/shares", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path })
        });
        toast("Shared folder added");
        await refresh();
      }
      async function uploadFile(file, relativePath) {
        const target = "Desktop Drops/" + relativePath.replace(/^\/+/, "");
        await api("/api/drop?space=" + encodeURIComponent(state.summary.defaultSpace) + "&path=" + encodeURIComponent(target), {
          method: "POST",
          body: file
        });
      }
      function droppedLocalPaths(event) {
        const uriList = event.dataTransfer?.getData("text/uri-list") || "";
        return uriList
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"))
          .map((line) => {
            try {
              const url = new URL(line);
              return url.protocol === "file:" ? decodeURIComponent(url.pathname) : "";
            } catch {
              return "";
            }
          })
          .filter(Boolean);
      }
      async function walkEntry(entry, prefix = "") {
        if (entry.isFile) {
          return new Promise((resolve, reject) => entry.file((file) => resolve([{ file, path: prefix + file.name }]), reject));
        }
        if (!entry.isDirectory) return [];
        const reader = entry.createReader();
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        const nested = await Promise.all(batch.map((item) => walkEntry(item, prefix + entry.name + "/")));
        return nested.flat();
      }
      async function handleDrop(event) {
        event.preventDefault();
        event.stopPropagation();
        state.dragDepth = 0;
        document.body.classList.remove("dragging");
        if (!state.summary) await refresh();
        const localPaths = droppedLocalPaths(event);
        if (localPaths.length) {
          toast("Adding dropped paths");
          await api("/api/ingest-paths", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paths: localPaths })
          });
          await refresh();
          toast("Drop complete");
          return;
        }
        const items = [...(event.dataTransfer?.items || [])];
        let files = [];
        for (const item of items) {
          const entry = item.webkitGetAsEntry?.();
          if (entry) files.push(...await walkEntry(entry));
          else {
            const file = item.getAsFile?.();
            if (file) files.push({ file, path: file.name });
          }
        }
        if (!files.length) return;
        toast("Uploading " + files.length + " files");
        for (const item of files) {
          await uploadFile(item.file, item.path);
        }
        await refresh();
        toast("Drop upload complete");
      }

      $("syncAll").addEventListener("click", async () => {
        toast("Sync running");
        await api("/api/sync", { method: "POST" });
        await refresh();
        toast("Sync complete");
      });
      $("refresh").addEventListener("click", refresh);
      $("pathForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const value = $("pathInput").value.trim();
        if (value) {
          await addPath(value);
          $("pathInput").value = "";
        }
      });
      $("chooseFolder").addEventListener("click", async () => {
        const choice = await api("/api/choose-folder");
        if (choice.path) await addPath(choice.path);
      });
      document.querySelectorAll("[data-view]").forEach((button) => {
        button.addEventListener("click", () => setView(button.dataset.view));
      });
      document.querySelectorAll("[data-side-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          state.sideMode = button.dataset.sideMode;
          renderInspector();
        });
      });
      document.addEventListener("click", async (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const sourceNode = target?.closest?.("[data-select-source]");
        const selectedId = target?.dataset?.selectSource || sourceNode?.dataset?.selectSource;
        if (selectedId) {
          state.selectedSourceId = selectedId;
          state.sideMode = "tree";
          render();
        }
        const accessMode = target?.dataset?.access;
        const accessShareId = target?.dataset?.shareId;
        const removeId = target?.dataset?.remove;
        const syncId = target?.dataset?.sync;
        const openFolder = target?.dataset?.open;
        const folderId = target?.dataset?.folder;
        if (accessMode && accessShareId) {
          await api("/api/shares/" + encodeURIComponent(accessShareId), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ access: accessMode })
          });
          await refresh();
          toast("Permission updated");
        }
        if (removeId) {
          await api("/api/shares/" + encodeURIComponent(removeId), { method: "DELETE" });
          if (state.selectedSourceId === "local:" + removeId) {
            state.selectedSourceId = null;
            state.sideMode = "system";
          }
          await refresh();
        }
        if (folderId) {
          const name = window.prompt("Folder name");
          if (name?.trim()) {
            toast("Creating folder");
            await api("/api/shares/" + encodeURIComponent(folderId) + "/folders", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name })
            });
            await refresh();
            toast("Folder created");
          }
        }
        if (syncId) {
          toast("Folder sync running");
          await api("/api/shares/" + encodeURIComponent(syncId) + "/sync", { method: "POST" });
          await refresh();
          toast("Folder sync complete");
        }
        if (openFolder) {
          await api("/api/open-folder", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: openFolder })
          });
        }
      });

      document.addEventListener("dragenter", (event) => {
        event.preventDefault();
        state.dragDepth += 1;
        document.body.classList.add("dragging");
      });
      document.addEventListener("dragover", (event) => {
        event.preventDefault();
      });
      document.addEventListener("dragleave", () => {
        state.dragDepth = Math.max(0, state.dragDepth - 1);
        if (state.dragDepth === 0) document.body.classList.remove("dragging");
      });
      document.addEventListener("drop", handleDrop);
      window.__agentVaultNativeRefresh = async (message) => {
        await refresh();
        toast(message || "Updated");
      };

      $("zoomIn").addEventListener("click", () => {
        state.schema.hasUserMoved = true;
        state.schema.scale = clamp(state.schema.scale + 0.12, 0.45, 1.8);
        updateSchemaTransform();
      });
      $("zoomOut").addEventListener("click", () => {
        state.schema.hasUserMoved = true;
        state.schema.scale = clamp(state.schema.scale - 0.12, 0.45, 1.8);
        updateSchemaTransform();
      });
      $("zoomReset").addEventListener("click", () => {
        state.schema = { ...state.schema, ...schemaDefaults(), hasUserMoved: false };
        updateSchemaTransform();
      });
      $("schemaViewport").addEventListener("wheel", (event) => {
        event.preventDefault();
        state.schema.hasUserMoved = true;
        const previous = state.schema.scale;
        const next = clamp(previous + (event.deltaY > 0 ? -0.08 : 0.08), 0.45, 1.8);
        const rect = $("schemaViewport").getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        state.schema.x = pointerX - ((pointerX - state.schema.x) / previous) * next;
        state.schema.y = pointerY - ((pointerY - state.schema.y) / previous) * next;
        state.schema.scale = next;
        updateSchemaTransform();
      }, { passive: false });
      $("schemaViewport").addEventListener("pointerdown", (event) => {
        state.schema.hasUserMoved = true;
        state.schema.dragging = true;
        state.schema.startX = event.clientX;
        state.schema.startY = event.clientY;
        state.schema.originX = state.schema.x;
        state.schema.originY = state.schema.y;
        $("schemaViewport").setPointerCapture(event.pointerId);
      });
      $("schemaViewport").addEventListener("pointermove", (event) => {
        if (!state.schema.dragging) return;
        state.schema.x = state.schema.originX + event.clientX - state.schema.startX;
        state.schema.y = state.schema.originY + event.clientY - state.schema.startY;
        updateSchemaTransform();
      });
      $("schemaViewport").addEventListener("pointerup", () => {
        state.schema.dragging = false;
      });
      $("schemaViewport").addEventListener("pointercancel", () => {
        state.schema.dragging = false;
      });

      refresh().catch((error) => {
        renderOffline(error.message);
        toast(error.message);
      });
    </script>
  </body>
</html>`;
}
