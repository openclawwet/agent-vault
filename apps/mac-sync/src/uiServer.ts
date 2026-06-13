import { execFile, spawn } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChangeEventRecord, DeviceStatusRecord, SpaceAccessInfo, VaultFileRecord, VaultServerStatus } from "@agent-vault/core";
import type { MacSyncConfig } from "./config.js";
import { configWithShareIgnores, syncAllSources, summaryChanged } from "./autoSync.js";
import { readActivity, recordActivity } from "./activityLog.js";
import type { LocalScanOptions } from "./localState.js";
import { loadPreferences, updatePreferences } from "./preferences.js";
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

function sendDownload(res: ServerResponse, body: Buffer, filePath: string): void {
  const filename = path.basename(filePath).replaceAll('"', "");
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": body.byteLength,
    "content-disposition": `attachment; filename="${filename || "agent-vault-file"}"`,
    "cache-control": "no-store",
  });
  res.end(body);
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

function revealPath(targetPath: string): void {
  const child = spawn("open", ["-R", targetPath], { stdio: "ignore", detached: true });
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

function normalizedLocalPrefix(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function isIgnoredForUi(relativePath: string, name: string, options: LocalScanOptions): boolean {
  const ignoredNames = new Set([".agent-vault", ...(options.ignoreNames ?? [])]);
  if (ignoredNames.has(name)) return true;

  const normalized = normalizedLocalPrefix(relativePath);
  return (options.ignorePathPrefixes ?? [])
    .map(normalizedLocalPrefix)
    .filter(Boolean)
    .some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

async function scanLocalForUi(localDir: string, options: LocalScanOptions = {}): Promise<TreeFile[]> {
  const root = path.resolve(localDir);
  const results: TreeFile[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (isIgnoredForUi(relative, entry.name, options)) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await stat(absolute);
      results.push({ path: relative, size: fileStat.size });
    }
  }

  await mkdir(root, { recursive: true });
  await walk(root);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function summarizeShareUncached(config: MacSyncConfig, share: ShareRecord, options: { checkPending?: boolean } = {}) {
  try {
    const files = await scanLocalForUi(share.localDir, { ignoreNames: share.ignoreNames, ignorePathPrefixes: share.ignorePathPrefixes });
    const status = options.checkPending ? await shareStatus(config, share) : { actions: [] };
    const localSize = files.reduce((sum, file) => sum + file.size, 0);
    return {
      ...share,
      localFileCount: files.length,
      localSize,
      localTree: fileTree(files, "", 700),
      pendingActions: changedCount(status.actions),
      pendingChecked: Boolean(options.checkPending),
      available: true,
    };
  } catch (error: unknown) {
    return {
      ...share,
      localFileCount: 0,
      localSize: 0,
      localTree: [],
      pendingActions: 0,
      pendingChecked: Boolean(options.checkPending),
      available: false,
      error: error instanceof Error ? error.message : "Share is unavailable.",
    };
  }
}

type ShareSummary = Awaited<ReturnType<typeof summarizeShareUncached>>;

const LOCAL_SUMMARY_TTL_MS = Number.parseInt(process.env.AGENT_VAULT_LOCAL_SUMMARY_TTL_MS ?? "120000", 10);
const localShareSummaryCache = new Map<string, { expiresAt: number; summary: ShareSummary }>();

function shareSummaryCacheKey(share: ShareRecord): string {
  return JSON.stringify({
    id: share.id,
    localDir: share.localDir,
    ignoreNames: share.ignoreNames,
    ignorePathPrefixes: share.ignorePathPrefixes,
    enabled: share.enabled,
    access: share.access,
  });
}

function cachedShareSummary(share: ShareRecord): ShareSummary | undefined {
  const cached = localShareSummaryCache.get(shareSummaryCacheKey(share));
  if (cached && cached.expiresAt > Date.now()) {
    return cached.summary;
  }
  return undefined;
}

function lightShareSummary(share: ShareRecord): ShareSummary {
  return (
    cachedShareSummary(share) ?? {
      ...share,
      localFileCount: 0,
      localSize: 0,
      localTree: [],
      pendingActions: 0,
      pendingChecked: false,
      available: true,
    }
  );
}

async function summarizeShare(config: MacSyncConfig, share: ShareRecord, options: { checkPending?: boolean; localDetail?: boolean } = {}) {
  if (options.localDetail === false) {
    return lightShareSummary(share);
  }

  const key = shareSummaryCacheKey(share);
  if (!options.checkPending) {
    const cached = localShareSummaryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.summary;
    }
  }

  const summary = await summarizeShareUncached(config, share, options);
  if (!options.checkPending) {
    localShareSummaryCache.set(key, { expiresAt: Date.now() + Math.max(10_000, LOCAL_SUMMARY_TTL_MS), summary });
  }
  return summary;
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
  version?: number;
  sha256?: string;
  updatedAt?: string;
  truncated?: boolean;
  children?: TreeNode[];
}

interface TreeFile {
  path: string;
  size: number;
  version?: number;
  currentVersion?: number;
  sha256?: string;
  updatedAt?: string;
  folderMarker?: boolean;
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
    .map((file) => {
      const isFolderMarker = file.path === ".agent-vault-folder" || file.path.endsWith("/.agent-vault-folder");
      if (!isFolderMarker) return file;
      return {
        path: file.path.replace(/\/?\.agent-vault-folder$/, ""),
        size: 0,
        folderMarker: true,
      };
    })
    .filter((file) => file.path)
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const file of scoped) {
    if (nodeCount >= maxNodes) {
      root.truncated = true;
      break;
    }
    const parts = file.path.split("/").filter(Boolean);
    let cursor = root;
    cursor.count += file.folderMarker ? 0 : 1;
    cursor.size += file.size;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const isFile = index === parts.length - 1 && !file.folderMarker;
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
          version: isFile ? (file.version ?? file.currentVersion) : undefined,
          sha256: isFile ? file.sha256 : undefined,
          updatedAt: isFile ? file.updatedAt : undefined,
          children: isFile ? undefined : [],
        };
        cursor.children.push(child);
        nodeCount += 1;
      }
      child.count += file.folderMarker ? 0 : 1;
      child.size += file.size;
      if (isFile) {
        child.version = file.version ?? file.currentVersion;
        child.sha256 = file.sha256;
        child.updatedAt = file.updatedAt;
      }
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

function safeOptionalRemotePath(value: string): string {
  const cleaned = value.replaceAll("\\", "/").trim();
  if (!cleaned) return "";
  const parts = cleaned
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new UiError(400, "invalid_path", "Vault path is invalid.");
  }
  return parts.join("/");
}

function immediateFolderEntries(files: TreeFile[], prefix = "", folder = "", maxEntries = 5000): TreeNode[] {
  const cleanPrefix = safeOptionalRemotePath(prefix);
  const cleanFolder = safeOptionalRemotePath(folder);
  const children = new Map<string, TreeNode>();

  for (const file of files) {
    const cleanPath = file.path.replaceAll("\\", "/").replace(/^\/+/, "");
    if (cleanPrefix) {
      if (cleanPath === cleanPrefix) continue;
      if (!cleanPath.startsWith(`${cleanPrefix}/`)) continue;
    }

    const sourcePath = cleanPrefix ? cleanPath.slice(cleanPrefix.length + 1) : cleanPath;
    if (cleanFolder) {
      if (sourcePath === cleanFolder) continue;
      if (!sourcePath.startsWith(`${cleanFolder}/`)) continue;
    }

    const folderPath = cleanFolder ? sourcePath.slice(cleanFolder.length + 1) : sourcePath;
    const parts = folderPath.split("/").filter(Boolean);
    if (!parts.length) continue;

    const isFolderMarker = parts[parts.length - 1] === ".agent-vault-folder";
    if (isFolderMarker && parts.length === 1) continue;

    const childName = parts[0]!;
    const isDirectFile = parts.length === 1 && !isFolderMarker;
    const kind: TreeNodeKind = isDirectFile ? "file" : "folder";
    const key = `${kind}\0${childName}`;
    const existing =
      children.get(key) ?? {
        name: childName,
        path: cleanFolder ? `${cleanFolder}/${childName}` : childName,
        kind,
        count: 0,
        size: 0,
        version: isDirectFile ? (file.version ?? file.currentVersion) : undefined,
        sha256: isDirectFile ? file.sha256 : undefined,
        updatedAt: isDirectFile ? file.updatedAt : undefined,
        children: kind === "folder" ? [] : undefined,
      };
    existing.count += isFolderMarker ? 0 : 1;
    existing.size += isFolderMarker ? 0 : file.size;
    if (isDirectFile) {
      existing.version = file.version ?? file.currentVersion;
      existing.sha256 = file.sha256;
      existing.updatedAt = file.updatedAt;
    }
    children.set(key, existing);

    if (children.size >= maxEntries) {
      existing.truncated = true;
      break;
    }
  }

  return [...children.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
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

interface RemoteSpaceSummary {
  name: string;
  permissions: SpaceAccessInfo["permissions"];
  fileCount: number;
  size: number;
  folders: ReturnType<typeof folderTree>;
  files: VaultFileRecord[];
  tree: TreeNode[];
  sources: ReturnType<typeof remoteSourcesForSpace>;
  recentChanges: Array<ChangeEventRecord & { space?: string }>;
  error?: string;
}

interface RemoteSnapshot {
  spaces: RemoteSpaceSummary[];
  remoteFiles: VaultFileRecord[];
  recentChanges: Array<ChangeEventRecord & { space: string }>;
  indexedAt: string;
}

let remoteSnapshot: RemoteSnapshot | null = null;
let remoteRefresh: Promise<RemoteSnapshot> | null = null;
const REMOTE_SNAPSHOT_TTL_MS = Number.parseInt(process.env.AGENT_VAULT_REMOTE_SNAPSHOT_TTL_MS ?? "300000", 10);

function placeholderRemoteSpaces(spaces: SpaceAccessInfo[]): RemoteSpaceSummary[] {
  return spaces.map((space) => ({
    name: space.name,
    permissions: space.permissions,
    fileCount: 0,
    size: 0,
    folders: [],
    files: [],
    tree: [],
    sources: [],
    recentChanges: [],
  }));
}

async function buildRemoteSnapshot(vault: VaultClient, spaces: SpaceAccessInfo[]): Promise<RemoteSnapshot> {
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
  return { spaces: remoteSpaces, remoteFiles, recentChanges, indexedAt: new Date().toISOString() };
}

function getRemoteSnapshot(
  vault: VaultClient,
  spaces: SpaceAccessInfo[],
  wait: boolean,
  refresh: boolean,
): RemoteSnapshot | Promise<RemoteSnapshot> | null {
  if (wait) {
    remoteRefresh ??= buildRemoteSnapshot(vault, spaces)
      .then((snapshot) => {
        remoteSnapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        remoteRefresh = null;
      });
    return remoteRefresh;
  }

  const snapshotAge = remoteSnapshot ? Date.now() - new Date(remoteSnapshot.indexedAt).getTime() : Number.POSITIVE_INFINITY;
  const stale = !remoteSnapshot || snapshotAge > REMOTE_SNAPSHOT_TTL_MS;
  if (refresh && stale && !remoteRefresh) {
    remoteRefresh = buildRemoteSnapshot(vault, spaces)
      .then((snapshot) => {
        remoteSnapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        remoteRefresh = null;
      });
  }

  return remoteSnapshot;
}

function clearSummaryCaches(): void {
  remoteSnapshot = null;
  localShareSummaryCache.clear();
}

async function buildSummary(
  config: MacSyncConfig,
  options: { waitForRemote?: boolean; refreshRemote?: boolean; checkPending?: boolean; localDetail?: boolean } = {},
) {
  const vault = new VaultClient(config.serverUrl, config.token);
  const shareConfig = await loadShareConfig();
  const preferences = await loadPreferences();
  const mainConfig = configWithShareIgnores(config, shareConfig.shares);
  const fallbackSpace: SpaceAccessInfo = {
    name: config.space,
    createdAt: new Date().toISOString(),
    permissions: [],
  };
  const [spacesResult, mainStatus, activity, deviceSummary, edits] = await Promise.all([
    vault.listSpaces().then(
      (spaces) => ({ spaces, error: null as string | null }),
      (error: unknown) => ({
        spaces: [fallbackSpace],
        error: error instanceof Error ? error.message : "Vault connection failed.",
      }),
    ),
    options.checkPending
      ? statusCommand(mainConfig).catch((error: unknown) => ({ actions: [], error: error instanceof Error ? error.message : "Status failed." }))
      : Promise.resolve({ actions: [] }),
    readActivity(),
    connectedDevices(vault).catch(() => ({
      server: fallbackServerStatus(),
      devices: [],
      currentDeviceId: "",
      presenceVisible: false,
      adminVisible: false,
    })),
    editStatus().catch(() => ({ sessions: [], openCount: 0, conflictCount: 0 })),
  ]);
  const spaces = spacesResult.spaces;
  const localShares = await Promise.all(
    shareConfig.shares.map((share) =>
      summarizeShare(config, share, { checkPending: options.checkPending, localDetail: options.localDetail }),
    ),
  );
  const snapshotResult = getRemoteSnapshot(vault, spaces, Boolean(options.waitForRemote), Boolean(options.refreshRemote));
  const snapshot = snapshotResult instanceof Promise ? await snapshotResult : snapshotResult;
  const remoteSpaces = snapshot?.spaces ?? placeholderRemoteSpaces(spaces);
  const remoteFiles = snapshot?.remoteFiles ?? [];
  const recentChanges = snapshot?.recentChanges ?? [];
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
    preferences,
    autoSyncEnabled: preferences.autoSyncEnabled,
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
    remoteIndexing: Boolean(remoteRefresh),
    remoteIndexedAt: snapshot?.indexedAt ?? null,
    flowStats: flowStats(recentChanges, remoteFiles),
    recentChanges,
    activity,
    edits,
  };
}

async function syncAll(config: MacSyncConfig) {
  const result = await syncAllSources(config);
  clearSummaryCaches();
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

function safeRemoteFilePath(value: string): string {
  const cleaned = value.replaceAll("\\", "/").trim();
  const parts = cleaned
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new UiError(400, "invalid_file_path", "File path is invalid.");
  }
  return parts.join("/");
}

function safeDownloadSpace(value: string): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.includes("/") || cleaned.includes("\\") || cleaned.includes("\0") || cleaned === "." || cleaned === "..") {
    throw new UiError(400, "invalid_space", "Vault space is invalid.");
  }
  return cleaned;
}

function downloadRoot(): string {
  return process.env.AGENT_VAULT_DOWNLOAD_DIR ?? path.join(os.homedir(), ".agent-vault", "downloads");
}

function editRoot(): string {
  return process.env.AGENT_VAULT_EDIT_DIR ?? path.join(os.homedir(), ".agent-vault", "edits");
}

function editSessionPath(): string {
  return path.join(editRoot(), "sessions.json");
}

function editConflictRoot(): string {
  return path.join(editRoot(), "conflicts");
}

function sha256BufferLocal(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

interface EditSession {
  id: string;
  space: string;
  path: string;
  targetPath: string;
  baseHash: string;
  currentVersion: number | null;
  status: "open" | "synced" | "conflict";
  openedAt: string;
  updatedAt: string;
  conflictPath?: string;
  conflictReason?: string;
}

async function readEditSessions(): Promise<EditSession[]> {
  try {
    const body = await readFile(editSessionPath(), "utf8");
    const parsed = JSON.parse(body) as { sessions?: EditSession[] };
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return [];
  }
}

async function writeEditSessions(sessions: EditSession[]): Promise<void> {
  const target = editSessionPath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ sessions }, null, 2)}\n`, { mode: 0o600 });
}

function editableTargetPath(space: string, filePath: string): string {
  return path.join(editRoot(), "files", space, ...filePath.split("/"));
}

function conflictTargetPath(space: string, filePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = path.basename(filePath);
  const folder = path.dirname(filePath);
  const safeFolder = folder === "." ? "" : folder;
  return path.join(editConflictRoot(), space, ...safeFolder.split("/").filter(Boolean), `${stamp}-${fileName}`);
}

async function editStatus() {
  const sessions = await readEditSessions();
  const visible = sessions
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 12);
  return {
    sessions: visible,
    openCount: sessions.filter((session) => session.status !== "synced").length,
    conflictCount: sessions.filter((session) => session.status === "conflict").length,
  };
}

async function downloadRemoteFile(config: MacSyncConfig, input: Record<string, unknown>) {
  const space = safeDownloadSpace(String(input.space ?? config.space));
  const filePath = safeRemoteFilePath(String(input.path ?? ""));
  const body = await new VaultClient(config.serverUrl, config.token).download(space, filePath);
  const targetPath = path.join(downloadRoot(), space, ...filePath.split("/"));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, body);
  if (input.open === true) {
    openPath(targetPath);
  } else if (input.reveal !== false) {
    revealPath(targetPath);
  }
  await recordActivity("file_download", `Downloaded ${filePath}`, {
    space,
    path: filePath,
    size: body.byteLength,
    targetPath,
  });
  return { space, path: filePath, size: body.byteLength, targetPath };
}

async function openEditableRemoteFile(config: MacSyncConfig, input: Record<string, unknown>) {
  const space = safeDownloadSpace(String(input.space ?? config.space));
  const filePath = safeRemoteFilePath(String(input.path ?? ""));
  const vault = new VaultClient(config.serverUrl, config.token);
  const [body, files] = await Promise.all([vault.download(space, filePath), vault.listFiles(space)]);
  const current = files.find((file) => file.path === filePath);
  const baseHash = current?.sha256 ?? sha256BufferLocal(body);
  const targetPath = editableTargetPath(space, filePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, body);

  const sessions = (await readEditSessions()).filter((session) => !(session.space === space && session.path === filePath));
  const now = new Date().toISOString();
  const session: EditSession = {
    id: randomUUID(),
    space,
    path: filePath,
    targetPath,
    baseHash,
    currentVersion: current?.currentVersion ?? null,
    status: "open",
    openedAt: now,
    updatedAt: now,
  };
  sessions.push(session);
  await writeEditSessions(sessions);
  openPath(targetPath);
  await recordActivity("file_edit", `Opened editable copy ${filePath}`, {
    space,
    path: filePath,
    targetPath,
    baseHash,
    currentVersion: session.currentVersion,
  });
  return session;
}

async function writeBackEditedFiles(config: MacSyncConfig, input: Record<string, unknown> = {}) {
  const requestedId = typeof input.id === "string" ? input.id : "";
  const requestedPath = typeof input.path === "string" ? input.path : "";
  const sessions = await readEditSessions();
  const nextSessions: EditSession[] = [];
  const vault = new VaultClient(config.serverUrl, config.token);
  const results: Array<{ id: string; path: string; status: string; reason?: string }> = [];

  for (const session of sessions) {
    const isRequested = requestedId ? session.id === requestedId : requestedPath ? session.path === requestedPath : true;
    if (!isRequested) {
      nextSessions.push(session);
      continue;
    }

    try {
      const body = await readFile(session.targetPath);
      const localHash = sha256BufferLocal(body);
      if (localHash === session.baseHash) {
        nextSessions.push({ ...session, status: session.status === "conflict" ? "conflict" : "synced", updatedAt: new Date().toISOString() });
        results.push({ id: session.id, path: session.path, status: "unchanged" });
        continue;
      }

      const remote = (await vault.listFiles(session.space)).find((file) => file.path === session.path);
      if (remote && remote.sha256 !== session.baseHash) {
        const conflictPath = conflictTargetPath(session.space, session.path);
        await mkdir(path.dirname(conflictPath), { recursive: true });
        await writeFile(conflictPath, body);
        const conflictSession: EditSession = {
          ...session,
          status: "conflict",
          updatedAt: new Date().toISOString(),
          conflictPath,
          conflictReason: "Remote changed before writeback.",
        };
        nextSessions.push(conflictSession);
        results.push({ id: session.id, path: session.path, status: "conflict", reason: conflictSession.conflictReason });
        await recordActivity("conflict", `Writeback conflict ${session.path}`, {
          space: session.space,
          path: session.path,
          conflictPath,
          baseHash: session.baseHash,
          remoteHash: remote.sha256,
          localHash,
        });
        continue;
      }

      const uploaded = await vault.upload(
        session.space,
        session.path,
        body,
        `${config.deviceId}:${session.space}:edit-writeback:${session.path}:${localHash}`,
      );
      const updated: EditSession = {
        ...session,
        baseHash: uploaded.sha256,
        currentVersion: uploaded.currentVersion,
        status: "synced",
        updatedAt: new Date().toISOString(),
        conflictPath: undefined,
        conflictReason: undefined,
      };
      nextSessions.push(updated);
      results.push({ id: session.id, path: session.path, status: "uploaded" });
      clearSummaryCaches();
      await recordActivity("file_writeback", `Wrote back edited file ${session.path}`, {
        space: session.space,
        path: session.path,
        size: uploaded.size,
        version: uploaded.currentVersion,
      });
    } catch (error: unknown) {
      nextSessions.push({
        ...session,
        status: "conflict",
        updatedAt: new Date().toISOString(),
        conflictReason: error instanceof Error ? error.message : "Writeback failed.",
      });
      results.push({
        id: session.id,
        path: session.path,
        status: "error",
        reason: error instanceof Error ? error.message : "Writeback failed.",
      });
      await recordActivity("error", `Writeback failed ${session.path}`, {
        space: session.space,
        path: session.path,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  await writeEditSessions(nextSessions);
  return {
    results,
    uploaded: results.filter((result) => result.status === "uploaded").length,
    conflicts: results.filter((result) => result.status === "conflict" || result.status === "error").length,
  };
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
  clearSummaryCaches();
  await recordActivity("sync", `Created shared folder ${share.label}/${folder}`, {
    share: share.label,
    folder,
    summary: synced.summary,
  });
  return { folder, marker: ".agent-vault-folder", synced };
}

interface DropTarget {
  space?: string;
  pathPrefix?: string;
}

function dropTargetFromInput(value: unknown, config: MacSyncConfig): { space: string; pathPrefix: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { space: config.space, pathPrefix: "Desktop Drops" };
  }
  const target = value as DropTarget;
  return {
    space: safeDownloadSpace(String(target.space ?? config.space)),
    pathPrefix: safeOptionalRemotePath(String(target.pathPrefix ?? "Desktop Drops")) || "Desktop Drops",
  };
}

async function uploadLocalFileToVault(config: MacSyncConfig, localPath: string, target: { space: string; pathPrefix: string }) {
  const body = await readFile(localPath);
  const filePath = safeRemoteFilePath(`${target.pathPrefix}/${path.basename(localPath)}`);
  const uploaded = await new VaultClient(config.serverUrl, config.token).upload(
    target.space,
    filePath,
    body,
    `${config.deviceId}:${target.space}:native-drop:${filePath}:${sha256BufferLocal(body)}`,
  );
  clearSummaryCaches();
  await recordActivity("drop_upload", `Uploaded drop ${filePath}`, { space: target.space, path: filePath, size: body.byteLength });
  return { kind: "file", target, file: uploaded };
}

async function ingestLocalPath(config: MacSyncConfig, inputPath: string, target: { space: string; pathPrefix: string }) {
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
    return { kind: "share", target: { space: share.space, pathPrefix: share.remotePathPrefix }, share, initialSync };
  }

  if (!localStat.isFile()) {
    throw new UiError(400, "unsupported_drop_path", "Dropped path must be a file or folder.");
  }

  return uploadLocalFileToVault(config, localPath, target);
}

function startUiAutoSync(config: MacSyncConfig): () => void {
  let running = false;
  let queued = false;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let watcherRefreshTimer: NodeJS.Timeout | undefined;
  let watchers: FSWatcher[] = [];
  let watchedKeys = "";
  const debounceMs = Math.max(750, Number.parseInt(process.env.AGENT_VAULT_UI_AUTOSYNC_DEBOUNCE_MS ?? "2500", 10));

  async function run(reason: string): Promise<void> {
    if (closed) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const preferences = await loadPreferences();
      if (!preferences.autoSyncEnabled) {
        return;
      }
      const result = await syncAllSources(config);
      if (summaryChanged(result.total)) {
        clearSummaryCaches();
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
      if (queued && !closed) {
        queued = false;
        schedule("queued");
      }
    }
  }

  function schedule(reason: string): void {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(reason), debounceMs);
  }

  async function exists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async function refreshWatchers(): Promise<void> {
    const shareConfig = await loadShareConfig();
    const dirs = [config.localDir, ...shareConfig.shares.filter((share) => share.enabled).map((share) => share.localDir)];
    const uniqueDirs = [...new Set(dirs)].sort();
    const nextKeys = uniqueDirs.join("\n");
    if (nextKeys === watchedKeys) {
      return;
    }

    for (const watcher of watchers) {
      watcher.close();
    }
    watchers = [];
    watchedKeys = nextKeys;

    for (const dir of uniqueDirs) {
      if (!(await exists(dir))) {
        continue;
      }
      try {
        watchers.push(watch(dir, { recursive: true }, () => schedule("local change")));
      } catch (error: unknown) {
        await recordActivity("error", "Could not watch Agent Vault source", {
          folder: dir,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  void refreshWatchers();
  watcherRefreshTimer = setInterval(() => {
    void refreshWatchers();
  }, 60_000);

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (watcherRefreshTimer) clearInterval(watcherRefreshTimer);
    for (const watcher of watchers) {
      watcher.close();
    }
  };
}

async function handleApi(config: MacSyncConfig, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  const route = segments(url);

  if (method === "GET" && route.join("/") === "api/summary") {
    sendJson(
      res,
      200,
      await buildSummary(config, {
        waitForRemote: url.searchParams.get("full") === "1",
        refreshRemote: url.searchParams.get("remote") === "1" || url.searchParams.get("full") === "1",
        checkPending: url.searchParams.get("pending") === "1",
        localDetail: url.searchParams.get("light") !== "1",
      }),
    );
    return;
  }

  if (method === "GET" && route.join("/") === "api/preferences") {
    sendJson(res, 200, { preferences: await loadPreferences() });
    return;
  }

  if (method === "PATCH" && route.join("/") === "api/preferences") {
    const body = await readJson(req);
    const preferences = await updatePreferences({
      autoSyncEnabled: typeof body.autoSyncEnabled === "boolean" ? body.autoSyncEnabled : undefined,
    });
    await recordActivity("settings", preferences.autoSyncEnabled ? "Auto-sync enabled" : "Auto-sync disabled", {
      autoSyncEnabled: preferences.autoSyncEnabled,
    });
    sendJson(res, 200, { preferences });
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

  if (method === "POST" && route.join("/") === "api/download-remote") {
    const body = await readJson(req);
    sendJson(res, 200, { download: await downloadRemoteFile(config, body) });
    return;
  }

  if (method === "POST" && route.join("/") === "api/edit-remote") {
    const body = await readJson(req);
    sendJson(res, 200, { edit: await openEditableRemoteFile(config, body) });
    return;
  }

  if (method === "POST" && route.join("/") === "api/writeback-edits") {
    const body = await readJson(req);
    sendJson(res, 200, { writeback: await writeBackEditedFiles(config, body) });
    return;
  }

  if (method === "GET" && route.join("/") === "api/versions") {
    const space = safeDownloadSpace(String(url.searchParams.get("space") ?? config.space));
    const filePath = safeRemoteFilePath(String(url.searchParams.get("path") ?? ""));
    const versions = await new VaultClient(config.serverUrl, config.token).listVersions(space, filePath);
    sendJson(res, 200, versions);
    return;
  }

  if (method === "GET" && route.join("/") === "api/folder-entries") {
    const space = safeDownloadSpace(String(url.searchParams.get("space") ?? config.space));
    const prefix = safeOptionalRemotePath(String(url.searchParams.get("prefix") ?? ""));
    const folder = safeOptionalRemotePath(String(url.searchParams.get("folder") ?? ""));
    const files = await new VaultClient(config.serverUrl, config.token).listFiles(space);
    sendJson(res, 200, {
      space,
      prefix,
      folder,
      entries: immediateFolderEntries(files, prefix, folder),
      indexedAt: new Date().toISOString(),
    });
    return;
  }

  if (method === "GET" && route.join("/") === "api/raw-download") {
    const space = safeDownloadSpace(String(url.searchParams.get("space") ?? config.space));
    const filePath = safeRemoteFilePath(String(url.searchParams.get("path") ?? ""));
    const body = await new VaultClient(config.serverUrl, config.token).download(space, filePath);
    sendDownload(res, body, filePath);
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
    clearSummaryCaches();
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
    clearSummaryCaches();
    sendJson(res, 200, { share });
    return;
  }

  if (method === "DELETE" && route.length === 3 && route[0] === "api" && route[1] === "shares") {
    const removed = await removeShare(route[2] ?? "");
    if (!removed) {
      throw new UiError(404, "share_not_found", "Shared folder was not found.");
    }
    await recordActivity("share_removed", "Removed shared folder", { id: route[2] });
    clearSummaryCaches();
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
    clearSummaryCaches();
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
    const space = safeDownloadSpace(url.searchParams.get("space") || config.space);
    const filePath = safeRemoteFilePath(url.searchParams.get("path") || `${new Date().toISOString()}-drop.bin`);
    const body = await readBody(req);
    const uploaded = await new VaultClient(config.serverUrl, config.token).upload(
      space,
      filePath,
      body,
      `${config.deviceId}:${space}:desktop-drop:${filePath}:${randomUUID()}`,
    );
    clearSummaryCaches();
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
    const target = dropTargetFromInput(body.target, config);
    const results = [];
    for (const localPath of paths) {
      results.push(await ingestLocalPath(config, localPath, target));
    }
    clearSummaryCaches();
    sendJson(res, 201, { target, results });
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
        padding: 21px 34px 31px;
        background: transparent;
      }
      .topline {
        position: relative;
        z-index: 5;
        height: 34px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        border-bottom: 1px solid rgba(237, 230, 218, 0.08);
        -webkit-app-region: drag;
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
        -webkit-app-region: no-drag;
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
      .text-button.active {
        color: rgba(237, 230, 218, 0.82);
        border-color: rgba(237, 230, 218, 0.09);
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
        color: rgba(237, 230, 218, 0.96);
        background: transparent;
        border-color: transparent;
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
        gap: 0;
      }
      .stage {
        position: relative;
        flex: 1 1 auto;
        min-width: 0;
        height: 100%;
        padding: 20px 0 62px;
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
      .file-workspace {
        position: relative;
        height: 100%;
        min-height: 390px;
        margin-top: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 236px;
        gap: 22px;
        overflow: hidden;
      }
      .source-field {
        min-height: 0;
        overflow: auto;
        padding: 4px 10px 20px 0;
      }
      .source-cluster {
        position: relative;
        min-height: 100%;
        display: grid;
        align-content: start;
        gap: 18px;
      }
      .source {
        position: relative;
        left: auto !important;
        top: auto !important;
        width: min(290px, 100%);
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
        width: min(420px, 70vw);
        padding-left: 0;
        color: rgba(237, 230, 218, 0.42);
        font-size: 14px;
        line-height: 1.45;
      }
      .folder-browser {
        min-width: 0;
        min-height: 0;
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr);
        gap: 16px;
        border: 0;
        border-radius: 0;
        background: transparent;
        padding: 2px 0 0;
        overflow: hidden;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
      .folder-browser__head {
        min-width: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 14px;
        align-items: start;
      }
      .folder-browser__title {
        margin: 0;
        color: rgba(237, 230, 218, 0.91);
        font-size: 20px;
        line-height: 1.08;
        font-weight: 580;
        overflow-wrap: anywhere;
      }
      .folder-browser__meta {
        margin-top: 6px;
        color: var(--faint);
        font-size: 11px;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .folder-browser__tools,
      .view-toggle,
      .device-toggle,
      .folder-browser__crumbs {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .folder-browser__tools {
        justify-content: flex-end;
      }
      .view-toggle {
        padding: 3px;
        border: 1px solid rgba(237, 230, 218, 0.08);
        border-radius: 999px;
        background: rgba(22, 22, 20, 0.22);
      }
      .device-toggle {
        max-width: min(430px, 48vw);
        min-width: 0;
        overflow: auto hidden;
        padding: 3px;
        border: 1px solid rgba(237, 230, 218, 0.08);
        border-radius: 999px;
        background: rgba(22, 22, 20, 0.18);
      }
      .view-toggle button,
      .device-toggle button,
      .crumb-button,
      .up-button,
      .folder-create-button,
      .details-toggle {
        border: 0;
        color: rgba(237, 230, 218, 0.48);
        background: transparent;
        cursor: pointer;
        transition: color 140ms ease, background 140ms ease;
      }
      .view-toggle button {
        width: 25px;
        height: 22px;
        border-radius: 999px;
        display: grid;
        place-items: center;
        padding: 0;
      }
      .device-toggle button,
      .details-toggle {
        min-height: 22px;
        border-radius: 999px;
        padding: 0 9px;
        font-size: 10.5px;
        white-space: nowrap;
      }
      .view-toggle button.active,
      .device-toggle button.active,
      .details-toggle.active {
        color: rgba(237, 230, 218, 0.88);
        background: rgba(237, 230, 218, 0.08);
      }
      .view-toggle button:hover,
      .device-toggle button:hover,
      .crumb-button:hover,
      .up-button:hover,
      .folder-create-button:hover,
      .details-toggle:hover {
        color: rgba(237, 230, 218, 0.84);
      }
      .view-glyph {
        width: 13px;
        height: 13px;
        display: block;
        position: relative;
      }
      .view-glyph.grid {
        background:
          linear-gradient(currentColor 0 0) 0 0 / 5px 5px,
          linear-gradient(currentColor 0 0) 8px 0 / 5px 5px,
          linear-gradient(currentColor 0 0) 0 8px / 5px 5px,
          linear-gradient(currentColor 0 0) 8px 8px / 5px 5px;
        background-repeat: no-repeat;
        opacity: 0.86;
      }
      .view-glyph.large {
        border: 1.5px solid currentColor;
        border-radius: 3px;
      }
      .view-glyph.large::after {
        content: "";
        position: absolute;
        left: 2px;
        right: 2px;
        bottom: 2px;
        height: 1.5px;
        background: currentColor;
        opacity: 0.75;
      }
      .view-glyph.list::before,
      .view-glyph.list::after,
      .view-glyph.list {
        border-top: 1.5px solid currentColor;
      }
      .view-glyph.list::before,
      .view-glyph.list::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
      }
      .view-glyph.list::before { top: 5px; }
      .view-glyph.list::after { top: 10px; }
      .folder-browser__crumbs {
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        color: var(--faint);
        font-size: 11px;
      }
      .folder-browser__path-icon {
        width: 18px;
        height: 14px;
        flex: 0 0 auto;
        border: 1px solid rgba(237, 230, 218, 0.18);
        border-radius: 4px;
        background: rgba(237, 230, 218, 0.07);
        position: relative;
      }
      .folder-browser__path-icon::before {
        content: "";
        position: absolute;
        left: 3px;
        top: -4px;
        width: 8px;
        height: 5px;
        border: 1px solid rgba(237, 230, 218, 0.15);
        border-bottom: 0;
        border-radius: 3px 3px 0 0;
        background: rgba(237, 230, 218, 0.06);
      }
      .crumb-button,
      .up-button,
      .folder-create-button {
        min-height: 22px;
        padding: 0 5px;
        border-radius: 7px;
        font-size: 11px;
      }
      .folder-create-button:disabled,
      .up-button:disabled {
        color: rgba(237, 230, 218, 0.2);
        cursor: default;
      }
      .crumb-sep {
        color: rgba(237, 230, 218, 0.25);
      }
      .folder-items {
        min-height: 0;
        overflow: auto;
        padding: 2px 4px 12px 0;
      }
      .folder-items.grid,
      .folder-items.large {
        display: grid;
        align-content: start;
        justify-content: start;
        grid-template-columns: repeat(auto-fill, minmax(118px, 142px));
        gap: 18px 22px;
      }
      .folder-items.large {
        grid-template-columns: repeat(auto-fill, minmax(162px, 184px));
        gap: 22px 28px;
      }
      .folder-items.list {
        display: grid;
        align-content: start;
        gap: 2px;
      }
      .folder-item {
        min-width: 0;
        border: 1px solid transparent;
        color: rgba(237, 230, 218, 0.72);
        background: transparent;
        cursor: default;
        transition: color 140ms ease, background 140ms ease, border-color 140ms ease, transform 140ms ease;
      }
      .folder-item.grid,
      .folder-item.large {
        min-height: 126px;
        display: grid;
        grid-template-rows: auto minmax(0, auto) auto auto;
        justify-items: center;
        gap: 9px;
        border-radius: 10px;
        padding: 13px 9px 10px;
        text-align: center;
      }
      .folder-item.large {
        min-height: 166px;
        padding-top: 18px;
      }
      .folder-item.list {
        min-height: 34px;
        display: grid;
        grid-template-columns: 28px minmax(0, 1fr) auto auto auto;
        gap: 10px;
        align-items: center;
        border-radius: 8px;
        padding: 4px 8px;
      }
      .folder-item:hover,
      .folder-item.selected {
        color: rgba(237, 230, 218, 0.9);
        background: rgba(237, 230, 218, 0.036);
        border-color: transparent;
      }
      .folder-item.source {
        cursor: pointer;
      }
      .folder-item.source[data-source-device="mac-mini"] {
        border-color: transparent;
      }
      .folder-item.source[data-source-device="macbook"] {
        border-color: transparent;
      }
      .folder-item.source[data-source-device="vault"] {
        border-color: transparent;
      }
      .folder-item:active {
        transform: translateY(1px);
      }
      .file-icon {
        width: 44px;
        height: 48px;
        position: relative;
        display: block;
        color: rgba(237, 230, 218, 0.75);
      }
      .folder-item.large .file-icon {
        width: 68px;
        height: 72px;
      }
      .folder-item.list .file-icon {
        width: 20px;
        height: 22px;
      }
      .file-icon::before,
      .file-icon::after {
        content: "";
        position: absolute;
      }
      .file-icon.folder::before {
        left: 2px;
        right: 2px;
        bottom: 5px;
        height: 31px;
        border: 1.5px solid rgba(237, 230, 218, 0.2);
        border-radius: 7px;
        background: rgba(237, 230, 218, 0.095);
      }
      .file-icon.folder::after {
        left: 7px;
        top: 7px;
        width: 22px;
        height: 9px;
        border: 1.5px solid rgba(237, 230, 218, 0.16);
        border-bottom: 0;
        border-radius: 5px 5px 0 0;
        background: rgba(237, 230, 218, 0.075);
      }
      .folder-item.source[data-source-device="mac-mini"] .file-icon.folder {
        color: rgba(166, 194, 224, 0.86);
      }
      .folder-item.source[data-source-device="macbook"] .file-icon.folder {
        color: rgba(208, 194, 170, 0.9);
      }
      .folder-item.source[data-source-device="vault"] .file-icon.folder {
        color: rgba(180, 200, 162, 0.86);
      }
      .file-icon.file::before {
        inset: 3px 7px 4px 8px;
        border: 1.5px solid rgba(237, 230, 218, 0.22);
        border-radius: 5px;
        background: rgba(237, 230, 218, 0.06);
      }
      .file-icon.file::after {
        right: 7px;
        top: 3px;
        width: 12px;
        height: 12px;
        clip-path: polygon(0 0, 100% 100%, 0 100%);
        background: rgba(237, 230, 218, 0.16);
      }
      .file-icon.image::before { background: rgba(180, 200, 162, 0.11); }
      .file-icon.svg::before { background: rgba(166, 194, 224, 0.12); }
      .file-icon.pdf::before { background: rgba(195, 143, 130, 0.12); }
      .file-icon.text::before { background: rgba(208, 194, 170, 0.12); }
      .file-icon.code::before {
        background:
          linear-gradient(90deg, transparent 0 9px, rgba(237, 230, 218, 0.16) 9px 10px, transparent 10px 100%),
          rgba(166, 194, 224, 0.09);
      }
      .file-icon.table::before {
        background:
          linear-gradient(rgba(237, 230, 218, 0.13) 0 0) 12px 17px / 19px 1px no-repeat,
          linear-gradient(rgba(237, 230, 218, 0.13) 0 0) 12px 24px / 19px 1px no-repeat,
          linear-gradient(90deg, rgba(237, 230, 218, 0.11) 0 1px, transparent 1px 7px) 12px 13px / 7px 18px repeat-x,
          rgba(180, 200, 162, 0.1);
      }
      .file-icon.archive::before { background: rgba(215, 188, 134, 0.1); }
      .file-icon.video::before,
      .file-icon.audio::before { background: rgba(215, 188, 134, 0.11); }
      .file-icon::before,
      .file-icon::after {
        content: none !important;
        display: none !important;
      }
      .file-icon svg {
        width: 100%;
        height: 100%;
        display: block;
        overflow: visible;
      }
      .file-icon .icon-outline,
      .file-icon .icon-glyph,
      .file-icon .icon-fold,
      .file-icon .icon-folder-line {
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        vector-effect: non-scaling-stroke;
      }
      .file-icon .icon-outline {
        stroke-width: 1.55;
        opacity: 0.82;
      }
      .file-icon .icon-glyph {
        stroke-width: 1.8;
        opacity: 0.88;
      }
      .file-icon .icon-fold,
      .file-icon .icon-folder-line {
        stroke-width: 1.4;
        opacity: 0.42;
      }
      .file-icon .icon-page,
      .file-icon .icon-folder-body,
      .file-icon .icon-folder-tab {
        fill: currentColor;
      }
      .file-icon .icon-page,
      .file-icon .icon-folder-body {
        opacity: 0.115;
      }
      .file-icon .icon-folder-tab {
        opacity: 0.18;
      }
      .file-icon .icon-accent {
        fill: currentColor;
        opacity: 0.22;
      }
      .file-icon.file {
        color: rgba(218, 211, 199, 0.78);
      }
      .file-icon.image {
        color: rgba(180, 200, 162, 0.92);
      }
      .file-icon.svg {
        color: rgba(166, 194, 224, 0.92);
      }
      .file-icon.pdf {
        color: rgba(211, 142, 124, 0.92);
      }
      .file-icon.text {
        color: rgba(208, 194, 170, 0.92);
      }
      .file-icon.code {
        color: rgba(154, 188, 224, 0.92);
      }
      .file-icon.table {
        color: rgba(163, 198, 162, 0.92);
      }
      .file-icon.archive {
        color: rgba(215, 188, 134, 0.92);
      }
      .file-icon.video,
      .file-icon.audio {
        color: rgba(209, 169, 130, 0.92);
      }
      .file-icon .file-ext {
        position: absolute;
        left: 50%;
        bottom: 10px;
        transform: translateX(-50%);
        max-width: 31px;
        color: rgba(237, 230, 218, 0.7);
        font-size: 8px;
        line-height: 1;
        font-weight: 680;
        letter-spacing: 0;
        text-transform: uppercase;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .file-ext {
        position: absolute;
        left: 50%;
        bottom: 10px;
        transform: translateX(-50%);
        max-width: 31px;
        color: rgba(237, 230, 218, 0.54);
        font-size: 8px;
        line-height: 1;
        font-weight: 620;
        text-transform: uppercase;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .folder-item.list .file-ext {
        display: none;
      }
      .folder-item__name {
        width: 100%;
        min-width: 0;
        color: inherit;
        font-size: 11.5px;
        line-height: 1.24;
        overflow-wrap: anywhere;
      }
      .folder-item.grid .folder-item__name,
      .folder-item.large .folder-item__name {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .folder-item.list .folder-item__name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-align: left;
      }
      .folder-item__meta,
      .folder-item__kind {
        color: var(--faint);
        font-size: 10.5px;
        white-space: nowrap;
      }
      .folder-item__kind {
        text-transform: lowercase;
      }
      .folder-item__device {
        color: rgba(237, 230, 218, 0.42);
        font-size: 10.5px;
        white-space: nowrap;
      }
      .folder-item__actions {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        opacity: 0;
        transition: opacity 140ms ease;
      }
      .folder-item:hover .folder-item__actions,
      .folder-item:focus-within .folder-item__actions,
      .folder-item.selected .folder-item__actions {
        opacity: 1;
      }
      .folder-item__action {
        width: 23px;
        height: 21px;
        border: 1px solid rgba(237, 230, 218, 0.075);
        border-radius: 7px;
        display: inline-grid;
        place-items: center;
        padding: 0;
        color: rgba(237, 230, 218, 0.42);
        background: rgba(22, 22, 20, 0.18);
        cursor: pointer;
      }
      .folder-item__action:hover {
        color: rgba(237, 230, 218, 0.86);
        background: rgba(237, 230, 218, 0.065);
      }
      .folder-item__action .tiny-icon {
        margin: 0;
        vertical-align: 0;
      }
      .folder-item.list .folder-item__actions {
        opacity: 1;
      }
      .folder-items:not(.show-details) .folder-item__kind,
      .folder-items:not(.show-details) .folder-item__meta,
      .folder-items:not(.show-details) .folder-item__device,
      .folder-items:not(.show-details) .folder-item__actions {
        display: none;
      }
      .folder-items:not(.show-details) .folder-item.grid,
      .folder-items:not(.show-details) .folder-item.large {
        grid-template-rows: auto minmax(0, auto);
      }
      .folder-items:not(.show-details) .folder-item.list {
        grid-template-columns: 28px minmax(0, 1fr);
      }
      .vault-sidebar {
        min-width: 0;
        min-height: 0;
        display: grid;
        align-content: start;
        gap: 20px;
        overflow: auto;
        padding: 4px 0 18px;
        border-left: 1px solid rgba(237, 230, 218, 0.065);
        padding-left: 18px;
      }
      .vault-sidebar__section {
        min-width: 0;
        display: grid;
        gap: 10px;
      }
      .vault-sidebar__title {
        margin: 0;
        color: rgba(237, 230, 218, 0.55);
        font-size: 10.5px;
        line-height: 1;
        font-weight: 560;
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }
      .vault-sidebar__status {
        display: grid;
        gap: 7px;
      }
      .vault-sidebar__status span {
        color: rgba(237, 230, 218, 0.62);
        font-size: 11px;
        line-height: 1.3;
      }
      .folder-empty {
        min-height: 100%;
        display: grid;
        place-items: center;
        color: var(--faint);
        font-size: 12px;
        text-align: center;
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
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      .schema-node.dragging {
        z-index: 4;
        cursor: grabbing;
        border-color: rgba(237, 230, 218, 0.23);
        background: rgba(65, 63, 58, 0.66);
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
          padding: 18px 24px 28px;
        }
        .workspace {
          height: auto;
          min-height: calc(100svh - 78px);
        }
        .vault-view {
          flex-direction: column;
        }
        .system-sections {
          grid-template-columns: 1fr 1fr;
          grid-template-rows: minmax(260px, auto);
        }
        .file-workspace {
          grid-template-columns: minmax(0, 1fr);
          min-height: 520px;
        }
        .vault-sidebar {
          border-left: 0;
          border-top: 1px solid rgba(237, 230, 218, 0.065);
          padding: 18px 0 0;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .source {
          width: 100%;
        }
      }
      @media (max-width: 760px) {
        .shell {
          padding: 16px;
        }
        .top-actions {
          display: none;
        }
        .system-sections {
          grid-template-columns: 1fr;
        }
        .file-workspace {
          height: auto;
          min-height: 0;
          grid-template-columns: 1fr;
          overflow: visible;
        }
        .vault-sidebar {
          grid-template-columns: 1fr;
        }
        .source-field {
          height: auto;
          min-height: 0;
          overflow: visible;
        }
        .folder-browser {
          min-height: 430px;
        }
        .folder-browser__head {
          grid-template-columns: 1fr;
        }
        .folder-browser__tools {
          justify-content: flex-start;
          flex-wrap: wrap;
        }
        .device-toggle {
          max-width: 100%;
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
        <div class="pathline">
          <strong>Agent Vault</strong>
          <span>/</span>
          <span id="connection">loading</span>
        </div>
        <div class="top-actions">
          <button class="icon-button active" type="button" data-view="vault" title="Files" aria-label="Files"><span class="mini-icon vault-icon" aria-hidden="true"></span></button>
          <button class="icon-button" type="button" data-view="schema" title="Schema" aria-label="Schema"><span class="mini-icon schema-icon" aria-hidden="true"></span></button>
          <button class="add-button" id="chooseFolder" title="Add shared folder" aria-label="Add shared folder">+</button>
          <button class="text-button" id="refresh">refresh</button>
          <button class="text-button" id="saveEdits">save edits</button>
          <button class="text-button" id="autoSyncToggle" type="button" aria-pressed="true">auto on</button>
          <button class="text-button primary" id="syncAll">sync</button>
        </div>
      </header>
      <section class="workspace" aria-live="polite">
        <section class="view vault-view active" id="view-vault">
          <section class="stage">
            <div class="file-workspace" id="dropSurface">
              <section class="folder-browser" id="folderBrowser" aria-label="Folder contents">
                <div class="folder-browser__head">
                  <div>
                    <h2 class="folder-browser__title" id="folderTitle">Geteilte Ordner</h2>
                    <div class="folder-browser__meta" id="folderMeta">Agent Vault / Geteilte Ordner</div>
                  </div>
                  <div class="folder-browser__tools">
                    <div class="device-toggle" aria-label="Device filter">
                      <button type="button" data-device-filter="all" class="active">Alle</button>
                      <button type="button" data-device-filter="macbook">MacBook</button>
                      <button type="button" data-device-filter="mac-mini">Mac Mini</button>
                      <button type="button" data-device-filter="vault">Vault</button>
                    </div>
                    <button class="folder-create-button" id="folderNew" type="button">new folder</button>
                    <button class="up-button" id="folderUp" type="button">up</button>
                    <button class="details-toggle" id="detailsToggle" type="button" data-detail-toggle="true">details</button>
                    <div class="view-toggle" aria-label="View mode">
                      <button type="button" data-view-mode="grid" class="active" title="Icon view" aria-label="Icon view"><span class="view-glyph grid" aria-hidden="true"></span></button>
                      <button type="button" data-view-mode="large" title="Large icon view" aria-label="Large icon view"><span class="view-glyph large" aria-hidden="true"></span></button>
                      <button type="button" data-view-mode="list" title="List view" aria-label="List view"><span class="view-glyph list" aria-hidden="true"></span></button>
                    </div>
                  </div>
                </div>
                <div class="folder-browser__crumbs" id="folderCrumbs"></div>
                <div class="folder-items grid" id="folderItems"></div>
              </section>
              <aside class="vault-sidebar" id="vaultSidebar" aria-label="Connected devices">
                <section class="vault-sidebar__section">
                  <h3 class="vault-sidebar__title">Geräte</h3>
                  <div id="devices"></div>
                </section>
                <section class="vault-sidebar__section">
                  <h3 class="vault-sidebar__title">Geteilt</h3>
                  <div class="vault-sidebar__status">
                    <span id="shareCount">0 shared folders</span>
                    <span id="pending">0 pending</span>
                    <span id="deviceScope">local</span>
                  </div>
                  <div id="flow"></div>
                </section>
                <section class="vault-sidebar__section">
                  <h3 class="vault-sidebar__title">Edits</h3>
                  <div id="edits"></div>
                </section>
                <div id="structure" class="hidden"></div>
                <div id="activity" class="hidden"></div>
              </aside>
            </div>
            <form class="paste-path" id="pathForm">
              <input id="pathInput" placeholder="paste a local folder path" />
              <button class="quiet-submit" type="submit">add</button>
            </form>
          </section>
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
              <button class="schema-tool" id="layoutReset">layout</button>
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
        paused: false,
        view: "vault",
        selectedSourceId: null,
        viewMode: "grid",
        deviceFilter: "all",
        showDetails: false,
        folderBySource: {},
        folderEntriesByKey: {},
        folderLoadingByKey: {},
        selectedEntryKey: null,
        schema: {
          scale: 1,
          x: 80,
          y: 48,
          dragging: false,
          startX: 0,
          startY: 0,
          originX: 0,
          originY: 0,
          hasUserMoved: false,
          nodePositions: (() => {
            try { return JSON.parse(localStorage.getItem("agentVault.schema.nodePositions") || "{}"); }
            catch { return {}; }
          })(),
          nodeDrag: null,
          layoutNodes: [],
          layoutEdges: []
        },
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
        if (scopes.length <= 2) return scopes.map((scope) => scope.space).join(" / ");
        return scopes.length + " spaces";
      };
      const accessLabel = (access) => access === "readonly" ? "read only" : access === "writeonly" ? "write only" : "read + write";
      const accessHint = (access) => access === "readonly"
        ? "Mac Mini reads this folder into Vault"
        : access === "writeonly"
          ? "Vault writes into this folder"
          : "Bidirectional sync";
      const spacePermissions = (spaceName) => {
        const space = state.summary?.remoteSpaces?.find((item) => item.name === spaceName);
        return space?.permissions || [];
      };
      const sourceCanReceive = (source) => {
        if (!source) return false;
        if (source.sourceKind === "local") return source.access === "readwrite" || source.access === "writeonly";
        return source.access !== "readonly" && spacePermissions(source.space || "").includes("write");
      };
      const sourceCanEdit = (source) => {
        if (!source) return false;
        if (source.sourceKind === "local") return source.access === "readwrite" || source.access === "readonly";
        return sourceCanReceive(source);
      };
      const iconSvg = (name) => {
        if (name === "open") return '<span class="tiny-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 5.5h9v7h-9z"/><path d="M5 5.5V3.8h3l1.2 1.7"/></svg></span>';
        if (name === "folder") return '<span class="tiny-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2.7 5.4h10.6v7.1H2.7z"/><path d="M3.8 5.4V3.8h3l1.1 1.6"/></svg></span>';
        if (name === "sync") return '<span class="tiny-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M12.5 5.2A4.7 4.7 0 0 0 4 3.9"/><path d="M4 2.2v1.7h1.7"/><path d="M3.5 10.8a4.7 4.7 0 0 0 8.5 1.3"/><path d="M12 13.8v-1.7h-1.7"/></svg></span>';
        if (name === "remove") return '<span class="tiny-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></span>';
        if (name === "download") return '<span class="tiny-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 3.2v7.1"/><path d="M5.2 7.6 8 10.4l2.8-2.8"/><path d="M3.6 12.8h8.8"/></svg></span>';
        if (name === "edit") return '<span class="tiny-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 11.8 4.4 9l5.9-5.9 2.6 2.6L7 11.6z"/><path d="M8.9 4.5l2.6 2.6"/><path d="M3.5 13h8.8"/></svg></span>';
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
      const treeFingerprint = (nodes) => (nodes || []).map((node) =>
        [node.kind, node.name, node.path, node.count || 0, node.size || 0, treeFingerprint(node.children || [])].join(":")
      ).join("|");
      const cloneTreeNode = (node) => ({
        ...node,
        children: node.children ? node.children.map(cloneTreeNode) : undefined
      });
      const mergeTreeNodes = (primary = [], secondary = []) => {
        const merged = new Map();
        for (const node of secondary) merged.set(node.kind + "\\0" + node.path, cloneTreeNode(node));
        for (const node of primary) {
          const key = node.kind + "\\0" + node.path;
          const current = merged.get(key);
          if (!current) {
            merged.set(key, cloneTreeNode(node));
            continue;
          }
          merged.set(key, {
            ...current,
            ...node,
            count: Math.max(current.count || 0, node.count || 0),
            size: Math.max(current.size || 0, node.size || 0),
            children: mergeTreeNodes(node.children || [], current.children || [])
          });
        }
        return [...merged.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
      };

      const allSources = () => {
        const summary = state.summary;
        if (!summary) return [];
        return [
          ...summary.shares.map((share) => ({
            ...share,
            sourceKind: "local",
            sourceId: "local:" + share.id,
            deviceKind: "macbook",
            deviceLabel: "MacBook"
          })),
          ...(summary.remoteSources || []).map((source) => ({
            ...source,
            sourceKind: "remote",
            sourceId: source.id,
            deviceKind: source.origin === "Mac Mini" ? "mac-mini" : "vault",
            deviceLabel: source.origin || "Vault"
          }))
        ];
      };

      const visibleSources = () => {
        const sources = allSources();
        return state.deviceFilter === "all" ? sources : sources.filter((source) => source.deviceKind === state.deviceFilter);
      };
      const selectedSource = () => allSources().find((source) => source.sourceId === state.selectedSourceId) || null;
      const sourceVisible = (source) => Boolean(source && (state.deviceFilter === "all" || source.deviceKind === state.deviceFilter));
      const sourceTree = (source) => {
        if (!source) return [];
        if (source.sourceKind === "local") return mergeTreeNodes(source.localTree || [], source.remoteTree || []);
        return source.tree || [];
      };
      const currentFolder = (source) => source ? (state.folderBySource[source.sourceId] || "") : "";
      const setCurrentFolder = (source, folderPath) => {
        if (!source) return;
        const clean = String(folderPath || "").replace(/^\/+|\/+$/g, "");
        state.folderBySource[source.sourceId] = clean;
        state.selectedEntryKey = null;
      };
      const findTreeNode = (nodes, nodePath) => {
        const clean = String(nodePath || "").replace(/^\/+|\/+$/g, "");
        if (!clean) return null;
        const stack = [...(nodes || [])];
        while (stack.length) {
          const node = stack.shift();
          if (node.path === clean) return node;
          if (node.children?.length) stack.push(...node.children);
        }
        return null;
      };
      const folderEntries = (source) => {
        const tree = sourceTree(source);
        const folder = currentFolder(source);
        if (!folder) return tree;
        const node = findTreeNode(tree, folder);
        return node?.kind === "folder" ? node.children || [] : tree;
      };
      const folderListingKey = (source, folder) => source.sourceId + "::" + String(folder || "");
      const folderEntriesUrl = (source, folder) =>
        "/api/folder-entries?space=" + encodeURIComponent(source.space || "") +
        "&prefix=" + encodeURIComponent(source.remotePathPrefix || "") +
        "&folder=" + encodeURIComponent(folder || "");
      async function loadFolderEntries(source, folder) {
        if (!source) return;
        const key = folderListingKey(source, folder);
        if (state.folderEntriesByKey[key] || state.folderLoadingByKey[key]) return;
        state.folderLoadingByKey[key] = true;
        try {
          const listing = await api(folderEntriesUrl(source, folder));
          state.folderEntriesByKey[key] = listing.entries || [];
        } catch {
          state.folderEntriesByKey[key] = null;
        } finally {
          delete state.folderLoadingByKey[key];
          const currentSource = selectedSource();
          if (currentSource && folderListingKey(currentSource, currentFolder(currentSource)) === key) {
            renderFolderBrowser();
          }
        }
      }
      const parentFolder = (folderPath) => {
        const parts = String(folderPath || "").split("/").filter(Boolean);
        parts.pop();
        return parts.join("/");
      };
      const fileNameOf = (filePath) => String(filePath || "").split("/").filter(Boolean).pop() || "";
      const extensionOf = (name) => {
        const base = fileNameOf(name);
        const index = base.lastIndexOf(".");
        if (index <= 0 || index === base.length - 1) return "";
        return base.slice(index + 1).toLowerCase();
      };
      const fileKind = (node) => {
        if (node.kind === "folder") return "folder";
        const extension = extensionOf(node.name);
        if (extension === "svg") return "svg";
        if (["png", "jpg", "jpeg", "gif", "webp", "heic"].includes(extension)) return "image";
        if (extension === "pdf") return "pdf";
        if (["ts", "tsx", "js", "jsx", "css", "html", "xml", "yml", "yaml", "json", "mjs", "cjs", "swift", "py", "rb", "go", "rs"].includes(extension)) return "code";
        if (["csv", "tsv", "xlsx", "xls", "numbers"].includes(extension)) return "table";
        if (["zip", "tar", "gz", "tgz", "rar", "7z"].includes(extension)) return "archive";
        if (["md", "markdown", "txt", "log"].includes(extension)) return "text";
        if (["mp4", "mov", "webm"].includes(extension)) return "video";
        if (["mp3", "wav", "m4a", "ogg", "aac"].includes(extension)) return "audio";
        return "file";
      };
      const kindLabel = (node) => {
        if (node.kind === "folder") return "folder";
        const extension = extensionOf(node.name);
        return extension || "file";
      };
      const localPathForNode = (source, nodePath) => {
        const root = String(source?.localDir || "").replace(/\/+$/g, "");
        const clean = String(nodePath || "").replace(/^\/+/g, "");
        return clean ? root + "/" + clean : root;
      };
      const fileUrlForLocalPath = (value) => "file://" + encodeURI(String(value || ""));
      const rawDownloadUrl = (space, filePath) =>
        window.location.origin + "/api/raw-download?space=" + encodeURIComponent(space || "") + "&path=" + encodeURIComponent(filePath || "");
      const clearFolderListings = () => {
        state.folderEntriesByKey = {};
        state.folderLoadingByKey = {};
      };
      const summarySourceKey = () => JSON.stringify(allSources().map((source) => ({
        id: source.sourceId,
        label: source.label,
        device: source.deviceKind,
        files: source.remoteFileCount || source.localFileCount || 0,
        size: source.remoteSize || source.localSize || 0,
        tree: treeFingerprint(sourceTree(source))
      })));
      const browserStateKey = () => {
        const source = selectedSource();
        return JSON.stringify({
          source: source?.sourceId || "",
          folder: source ? currentFolder(source) : "",
          deviceFilter: state.deviceFilter,
          viewMode: state.viewMode,
          showDetails: state.showDetails,
          sources: summarySourceKey()
        });
      };
      const mimeTypeForExtension = (extension) => {
        if (["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"].includes(extension)) return "image/" + (extension === "jpg" ? "jpeg" : extension);
        if (extension === "pdf") return "application/pdf";
        if (["md", "txt", "csv", "html", "css"].includes(extension)) return "text/plain";
        if (["json"].includes(extension)) return "application/json";
        if (["mp4", "mov", "webm"].includes(extension)) return "video/" + (extension === "mov" ? "quicktime" : extension);
        if (["mp3", "wav", "m4a", "ogg", "aac"].includes(extension)) return "audio/" + (extension === "m4a" ? "mp4" : extension);
        return "application/octet-stream";
      };

      async function refresh(options = {}) {
        if (state.paused && options.silent) return;
        const previousSourceKey = state.summary ? summarySourceKey() : "";
        const previousBrowserKey = state.summary ? browserStateKey() : "";
        const params = new URLSearchParams();
        if (options.full) params.set("full", "1");
        if (options.refreshRemote) params.set("remote", "1");
        state.summary = await api("/api/summary" + (params.size ? "?" + params.toString() : ""));
        if (previousSourceKey && previousSourceKey !== summarySourceKey()) {
          clearFolderListings();
        }
        if (state.selectedSourceId && !allSources().some((source) => source.sourceId === state.selectedSourceId)) {
          state.selectedSourceId = null;
        }
        if (state.selectedSourceId && !sourceVisible(selectedSource())) {
          state.selectedSourceId = null;
        }
        const skipBrowser = Boolean(options.silent && previousBrowserKey && previousBrowserKey === browserStateKey());
        render({ skipBrowser });
      }

      window.__agentVaultSetPaused = (paused) => {
        state.paused = Boolean(paused);
        if (!state.paused) {
          refresh({ silent: true }).catch((error) => renderOffline(error.message));
        }
      };

      document.addEventListener("visibilitychange", () => {
        state.paused = document.hidden;
      });

      function setView(view) {
        state.view = view;
        document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
        $("view-vault").classList.toggle("active", view === "vault");
        $("view-schema").classList.toggle("active", view === "schema");
        if (view === "schema") renderSchema();
      }

      function render(options = {}) {
        const summary = state.summary;
        const totalPending = summary.mainPendingActions + summary.shares.reduce((sum, share) => sum + share.pendingActions, 0);
        const serverName = summary.server?.name || "Mac Mini Vault Server";
        const serverStatus = summary.server?.status || "online";
        const autoText = summary.autoSyncEnabled ? "auto events on" : "manual sync";
        $("connection").textContent = serverName + " / " + summary.defaultSpace + " / " + autoText;
        $("pending").textContent = summary.remoteIndexing ? "indexing" : totalPending + " pending";
        $("deviceScope").textContent = summary.devicesPresenceVisible ? "presence" : "local";
        const sources = allSources();
        const visible = visibleSources();
        $("shareCount").textContent = sources.length + (sources.length === 1 ? " shared folder" : " shared folders") + (summary.remoteIndexing ? " / indexing vault" : " / " + autoText) + (visible.length !== sources.length ? " / filtered " + visible.length : "");
        $("autoSyncToggle").textContent = summary.autoSyncEnabled ? "auto on" : "auto off";
        $("autoSyncToggle").classList.toggle("active", Boolean(summary.autoSyncEnabled));
        $("autoSyncToggle").setAttribute("aria-pressed", summary.autoSyncEnabled ? "true" : "false");
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
        const editSessions = summary.edits?.sessions || [];
        $("edits").innerHTML = editSessions.length
          ? editSessions.slice(0, 5).map((session) =>
              '<div class="activity">' +
                '<div class="activity-message">' + esc(fileNameOf(session.path)) + '</div>' +
                '<div class="activity-meta">' + esc(session.status) + ' / v' + esc(session.currentVersion || "-") + ' / ' + esc(shortPath(session.path)) + '</div>' +
              '</div>'
            ).join("")
          : '<div class="empty-note">No open edit copies.</div>';
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
        if (!options.skipBrowser) renderFolderBrowser();
        renderInspector();
        if (state.view === "schema" || !options.skipBrowser) renderSchema();
      }

      function renderCrumbs(source, folder) {
        let html = '<span class="folder-browser__path-icon" aria-hidden="true"></span><button class="crumb-button" type="button" data-vault-root="true">Agent Vault</button>';
        if (!source) {
          html += '<span class="crumb-sep">/</span><button class="crumb-button" type="button" data-vault-root="true">Geteilte Ordner</button>';
          return html;
        }
        html += '<span class="crumb-sep">/</span><button class="crumb-button" type="button" data-device-root="' + esc(source.deviceKind) + '">' + esc(source.deviceLabel) + '</button>';
        const parts = String(folder || "").split("/").filter(Boolean);
        html += '<span class="crumb-sep">/</span><button class="crumb-button" type="button" data-folder-path="">' + esc(source.label) + '</button>';
        let cursor = "";
        for (const part of parts) {
          cursor = cursor ? cursor + "/" + part : part;
          html += '<span class="crumb-sep">/</span><button class="crumb-button" type="button" data-folder-path="' + esc(cursor) + '">' + esc(part) + '</button>';
        }
        return html;
      }

      function sourcePathLabel(source, folder = "") {
        if (!source) return "Agent Vault / Geteilte Ordner";
        return ["Agent Vault", source.deviceLabel, source.label, ...String(folder || "").split("/").filter(Boolean)].join(" / ");
      }

      function sourceDetail(source) {
        const isLocal = source.sourceKind === "local";
        const pathText = isLocal ? source.localDir : source.origin + " / " + source.remotePathPrefix;
        const localText = isLocal
          ? (source.available ? fileLabel(source.localFileCount) + " / " + fmtSize(source.localSize) : "offline")
          : "remote";
        const pendingText = isLocal ? (source.pendingActions ? source.pendingActions + " pending" : "synced") : "readable";
        return esc(source.deviceLabel) + " / " + esc(shortPath(pathText)) + " / " + localText + " / " + source.remoteFileCount + " remote / " + fmtSize(source.remoteSize) + " / " + (source.pendingChecked === false ? "sync check deferred" : pendingText);
      }

      function renderSourceActions(source) {
        if (source.sourceKind !== "local") return "";
        return '<span class="folder-item__actions">' +
          '<button class="folder-item__action" data-open="' + esc(source.localDir) + '" title="Open local folder">' + iconSvg("open") + '</button>' +
          '<button class="folder-item__action" data-folder="' + esc(source.id) + '" title="New folder">' + iconSvg("folder") + '</button>' +
          '<button class="folder-item__action" data-sync="' + esc(source.id) + '" title="Sync">' + iconSvg("sync") + '</button>' +
          '<button class="folder-item__action" data-remove="' + esc(source.id) + '" title="Remove">' + iconSvg("remove") + '</button>' +
        '</span>';
      }

      function renderSourceItem(source) {
        const key = "source::" + source.sourceId;
        const selected = state.selectedEntryKey === key;
        return '<div class="folder-item source ' + esc(state.viewMode) + (selected ? " selected" : "") + '" role="button" tabindex="0" draggable="false" data-entry-key="' + esc(key) + '" data-entry-kind="source" data-source-id="' + esc(source.sourceId) + '" data-source-device="' + esc(source.deviceKind) + '" title="' + esc(source.label) + '">' +
          renderFileIcon("folder", "") +
          '<span class="folder-item__name">' + esc(source.label) + '</span>' +
          '<span class="folder-item__device">' + esc(source.deviceLabel) + '</span>' +
          '<span class="folder-item__meta">' + sourceDetail(source) + '</span>' +
          renderSourceActions(source) +
        '</div>';
      }

      function renderFileIcon(kind, extension) {
        if (kind === "folder") {
          return '<span class="file-icon folder" aria-hidden="true">' +
            '<svg viewBox="0 0 64 56" role="img" focusable="false">' +
              '<path class="icon-folder-tab" d="M10.5 18.5c0-3.3 2.7-6 6-6h10.3c2.1 0 3.7.8 5.1 2.3l3 3.4h12.6c3.6 0 6.5 2.9 6.5 6.5v2.4H10.5v-8.6Z"/>' +
              '<path class="icon-folder-body" d="M7.5 25.2h49.1v20.1c0 4.1-3.4 7.4-7.5 7.4H14.9c-4.1 0-7.4-3.3-7.4-7.4V25.2Z"/>' +
              '<path class="icon-outline" fill="none" d="M10.5 25.2v-6.7c0-3.3 2.7-6 6-6h10.3c2.1 0 3.7.8 5.1 2.3l3 3.4h12.6c3.6 0 6.5 2.9 6.5 6.5v20.6c0 4.1-3.4 7.4-7.5 7.4H14.9c-4.1 0-7.4-3.3-7.4-7.4V25.2h49.1"/>' +
              '<path class="icon-folder-line" fill="none" d="M14.4 30.6h35.2"/>' +
            '</svg>' +
          '</span>';
        }
        const label = extension ? extension.slice(0, 4) : "file";
        const glyphs = {
          image: '<circle class="icon-accent" cx="44" cy="22" r="4.2"/><path class="icon-glyph" fill="none" d="M19 40.5l8.4-9.2 6.7 6.8 4.8-5.1 7.7 7.5"/>',
          svg: '<path class="icon-glyph" fill="none" d="M22 34.5 16.8 29l5.2-5.5M42 23.5l5.2 5.5-5.2 5.5M29 37l6-16"/><circle class="icon-accent" cx="32" cy="29" r="2.8"/>',
          pdf: '<path class="icon-glyph" fill="none" d="M19 36.5h26M19 29.5h26M19 22.5h18"/><text x="21" y="45" fill="currentColor" opacity=".76" font-size="8" font-family="-apple-system, BlinkMacSystemFont, SF Pro Text, sans-serif" font-weight="700">PDF</text>',
          text: '<path class="icon-glyph" fill="none" d="M19 23h25M19 30h22M19 37h25M19 44h16"/>',
          code: '<path class="icon-glyph" fill="none" d="m25 24-7 7 7 7M39 24l7 7-7 7M34.5 21.5l-5 19"/>',
          table: '<path class="icon-glyph" fill="none" d="M18 22.5h28v22H18zM18 29.5h28M18 36.5h28M27.5 22.5v22M37 22.5v22"/>',
          archive: '<path class="icon-glyph" fill="none" d="M29 20.5v24M34.5 20.5v4M34.5 28.5v4M34.5 36.5v4M24 44.5h16"/>',
          video: '<path class="icon-glyph" fill="none" d="M18 24.5h24v17H18z"/><path class="icon-accent" d="m29 28.5 9 4.5-9 4.5v-9Z"/>',
          audio: '<path class="icon-glyph" fill="none" d="M27 39V22l14-3v16"/><circle class="icon-accent" cx="23.5" cy="40.5" r="5"/><circle class="icon-accent" cx="37.5" cy="36.5" r="5"/>',
          file: '<path class="icon-glyph" fill="none" d="M19 31h18M19 38h22"/>'
        };
        return '<span class="file-icon file ' + esc(kind) + '" aria-hidden="true">' +
          '<svg viewBox="0 0 64 56" role="img" focusable="false">' +
            '<path class="icon-page" d="M17 5.5h22.8L50 15.7v31.1c0 3.2-2.6 5.7-5.7 5.7H17c-3.2 0-5.7-2.5-5.7-5.7V11.2c0-3.2 2.5-5.7 5.7-5.7Z"/>' +
            '<path class="icon-outline" fill="none" d="M17 5.5h22.8L50 15.7v31.1c0 3.2-2.6 5.7-5.7 5.7H17c-3.2 0-5.7-2.5-5.7-5.7V11.2c0-3.2 2.5-5.7 5.7-5.7Z"/>' +
            '<path class="icon-fold" fill="none" d="M39.8 6v8.3c0 1.2 1 2.2 2.2 2.2h7.6"/>' +
            (glyphs[kind] || glyphs.file) +
          '</svg>' +
          '<span class="file-ext">' + esc(label) + '</span>' +
        '</span>';
      }

      function renderEntryActions(node, source) {
        if (node.kind === "folder") {
          return '<span class="folder-item__actions" aria-hidden="true"></span>';
        }
        return '<span class="folder-item__actions">' +
          '<button class="folder-item__action" type="button" data-file-action="open" title="Open">' + iconSvg("open") + '</button>' +
          (sourceCanEdit(source) ? '<button class="folder-item__action" type="button" data-file-action="edit" title="Edit and write back">' + iconSvg("edit") + '</button>' : '') +
          '<button class="folder-item__action" type="button" data-file-action="download" title="Download">' + iconSvg("download") + '</button>' +
        '</span>';
      }

      function renderFolderBrowser() {
        const source = selectedSource();
        document.querySelectorAll("[data-view-mode]").forEach((button) => button.classList.toggle("active", button.dataset.viewMode === state.viewMode));
        document.querySelectorAll("[data-device-filter]").forEach((button) => button.classList.toggle("active", button.dataset.deviceFilter === state.deviceFilter));
        $("detailsToggle").classList.toggle("active", state.showDetails);
        $("folderItems").className = "folder-items " + state.viewMode + (state.showDetails ? " show-details" : "");
        if (!source) {
          const sources = visibleSources();
          $("folderTitle").textContent = "Geteilte Ordner";
          $("folderMeta").textContent = sourcePathLabel(null);
          $("folderCrumbs").innerHTML = renderCrumbs(null, "");
          $("folderItems").innerHTML = sources.length
            ? sources.map((item) => renderSourceItem(item)).join("")
            : '<div class="folder-empty">Keine geteilten Ordner für diesen Filter.</div>';
          $("folderUp").disabled = true;
          $("folderNew").disabled = true;
          return;
        }

        const folder = currentFolder(source);
        const listingKey = folderListingKey(source, folder);
        const shouldUseRemoteListing = source.sourceKind !== "local";
        const lazyEntries = shouldUseRemoteListing ? state.folderEntriesByKey[listingKey] : undefined;
        if (shouldUseRemoteListing && lazyEntries === undefined && !state.folderLoadingByKey[listingKey]) {
          void loadFolderEntries(source, folder);
        }
        const entries = (Array.isArray(lazyEntries) ? lazyEntries : folderEntries(source)).slice().sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
        const folderLabel = folder ? fileNameOf(folder) : source.label;
        const loading = Boolean(state.folderLoadingByKey[listingKey]);
        $("folderTitle").textContent = folderLabel;
        $("folderMeta").textContent = sourcePathLabel(source, folder) + (state.showDetails ? " / " + entries.length + " items" + (loading ? " / loading full folder" : "") : "");
        $("folderCrumbs").innerHTML = renderCrumbs(source, folder);
        $("folderUp").disabled = false;
        $("folderNew").disabled = source.sourceKind !== "local";
        $("folderItems").innerHTML = entries.length
          ? entries.map((node) => {
              const kind = fileKind(node);
              const extension = extensionOf(node.name);
              const remotePath = source ? remotePathForNode(source, node.path) : node.path;
              const hasLocalFile = source.sourceKind === "local" && findTreeNode(source.localTree || [], node.path)?.kind === "file";
              const localPath = hasLocalFile ? localPathForNode(source, node.path) : "";
              const downloadUrl = node.kind === "file" ? rawDownloadUrl(source.space || "", remotePath) : "";
              const mime = node.kind === "file" ? mimeTypeForExtension(extension) : "";
              const key = source.sourceId + "::" + node.path;
              const selected = state.selectedEntryKey === key;
              const metric = node.kind === "folder" ? node.count + " items" : fmtSize(node.size) + (node.version ? " / v" + node.version : "");
              const openPath = node.kind === "folder" ? node.path : "";
              return '<div class="folder-item ' + esc(state.viewMode) + (selected ? " selected" : "") + '" role="button" tabindex="0" draggable="true" data-entry-key="' + esc(key) + '" data-entry-kind="' + esc(node.kind) + '" data-entry-path="' + esc(node.path) + '" data-folder-open="' + esc(openPath) + '" data-file-name="' + esc(node.name) + '" data-file-mime="' + esc(mime) + '" data-file-version="' + esc(node.version || "") + '" data-file-hash="' + esc(node.sha256 || "") + '" data-file-updated="' + esc(node.updatedAt || "") + '" data-file-download-space="' + esc(source.space || "") + '" data-file-download-path="' + esc(remotePath) + '" data-raw-download-url="' + esc(downloadUrl) + '" data-local-open="' + esc(localPath) + '" title="' + esc(node.name) + '">' +
                renderFileIcon(kind, extension) +
                '<span class="folder-item__name">' + esc(node.name) + '</span>' +
                '<span class="folder-item__kind">' + esc(kindLabel(node)) + '</span>' +
                '<span class="folder-item__meta">' + esc(metric) + '</span>' +
                renderEntryActions(node, source) +
              '</div>';
            }).join("")
          : '<div class="folder-empty">' + (loading ? "Loading folder..." : "This folder is empty.") + '</div>';
      }

      async function activateFolderEntry(entryNode, action = "open") {
        if (entryNode.dataset.entryKind === "source") {
          const sourceId = entryNode.dataset.sourceId || "";
          const source = allSources().find((item) => item.sourceId === sourceId);
          if (!source) return;
          state.selectedSourceId = sourceId;
          setCurrentFolder(source, "");
          renderFolderBrowser();
          return;
        }

        const source = selectedSource();
        if (!source || !entryNode?.dataset?.entryKind) return;
        if (entryNode.dataset.entryKind === "folder") {
          setCurrentFolder(source, entryNode.dataset.entryPath || "");
          renderFolderBrowser();
          return;
        }

        const localPath = entryNode.dataset.localOpen || "";
        const shouldEdit = action === "edit" || (action === "open" && sourceCanEdit(source) && !localPath);
        if (localPath && (action === "open" || action === "edit")) {
          await api("/api/open-folder", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: localPath })
          });
          toast("Opened " + shortPath(localPath));
          return;
        }

        const remotePath = entryNode.dataset.fileDownloadPath || "";
        if (!remotePath) return;
        if (shouldEdit) {
          toast("Opening editable copy");
          const result = await api("/api/edit-remote", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              space: entryNode.dataset.fileDownloadSpace,
              path: remotePath
            })
          });
          await refresh();
          toast("Editing " + shortPath(result.edit?.targetPath || remotePath));
          return;
        }

        toast(action === "open" ? "Opening file copy" : "Downloading file");
        const result = await api("/api/download-remote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            space: entryNode.dataset.fileDownloadSpace,
            path: remotePath,
            open: action === "open",
            reveal: action !== "open"
          })
        });
        await refresh();
        toast((action === "open" ? "Opened " : "Downloaded ") + shortPath(result.download?.targetPath || remotePath));
      }

      function remotePathForNode(source, nodePath) {
        const prefix = String(source?.remotePathPrefix || "").replace(/^\/+|\/+$/g, "");
        const cleanPath = String(nodePath || "").replace(/^\/+/, "");
        if (!cleanPath) return prefix;
        return prefix ? prefix + "/" + cleanPath : cleanPath;
      }

      function renderInspector() {
        return;
      }

      function renderOffline(message) {
        $("connection").textContent = "Mac Mini Vault Server / reconnecting";
        $("pending").textContent = "0 pending";
        $("deviceScope").textContent = "local";
        $("shareCount").textContent = "status unavailable";
        $("devices").innerHTML =
          '<div class="device server-device">' +
            '<div class="device-name"><span class="device-status"><span class="status-dot recent"></span>Mac Mini Vault Server</span></div>' +
            '<div class="device-meta">server</div>' +
          '</div>' +
          '<div class="empty-note">' + esc(message || "Status unavailable.") + '</div>';
        $("flow").innerHTML = "";
        $("edits").innerHTML = '<div class="empty-note">No edit status while reconnecting.</div>';
        $("structure").innerHTML = '<div class="empty-note">Waiting for Vault status.</div>';
        $("activity").innerHTML = '<div class="empty-note">No live log while reconnecting.</div>';
        $("folderTitle").textContent = "Geteilte Ordner";
        $("folderMeta").textContent = "Agent Vault / reconnecting";
        $("folderCrumbs").innerHTML = renderCrumbs(null, "");
        $("folderItems").innerHTML = '<div class="folder-empty">' + esc(message || "Status unavailable.") + '</div>';
      }

      const schemaNodeSize = { width: 188, height: 86 };
      function schemaNodePosition(id, x, y) {
        const stored = state.schema.nodePositions?.[id];
        if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) return stored;
        return { x, y };
      }
      function schemaNodeCenter(node) {
        const position = schemaNodePosition(node.id, node.x, node.y);
        return {
          x: position.x + schemaNodeSize.width / 2,
          y: position.y + schemaNodeSize.height / 2
        };
      }
      function schemaCurve(fromId, toId) {
        const nodes = new Map((state.schema.layoutNodes || []).map((node) => [node.id, node]));
        const from = nodes.get(fromId);
        const to = nodes.get(toId);
        if (!from || !to) return "";
        const start = schemaNodeCenter(from);
        const end = schemaNodeCenter(to);
        const bend = Math.max(38, Math.abs(end.x - start.x) * 0.42);
        return '<path class="schema-line" d="M' + start.x.toFixed(1) + ' ' + start.y.toFixed(1) + ' C' + (start.x + bend).toFixed(1) + ' ' + start.y.toFixed(1) + ' ' + (end.x - bend).toFixed(1) + ' ' + end.y.toFixed(1) + ' ' + end.x.toFixed(1) + ' ' + end.y.toFixed(1) + '" />';
      }
      function renderSchemaLines() {
        $("schemaLines").innerHTML = (state.schema.layoutEdges || []).map((edge) => schemaCurve(edge[0], edge[1])).join("");
      }
      function saveSchemaNodePositions() {
        try { localStorage.setItem("agentVault.schema.nodePositions", JSON.stringify(state.schema.nodePositions || {})); }
        catch {}
      }
      function schemaNode(id, kind, title, meta, x, y, extra = "") {
        const position = schemaNodePosition(id, x, y);
        return '<div class="schema-node ' + extra + '" id="' + esc(id) + '" data-schema-node="' + esc(id) + '" data-default-x="' + x + '" data-default-y="' + y + '" style="left:' + position.x + 'px;top:' + position.y + 'px">' +
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
        const layoutNodes = [];
        const layoutEdges = [];
        const currentDevice = summary.devices.find((device) => device.current || device.id === summary.currentDeviceId);
        const addNode = (id, kind, title, meta, x, y, extra = "") => {
          layoutNodes.push({ id, x, y });
          nodeHtml.push(schemaNode(id, kind, title, meta, x, y, extra));
        };
        addNode("node-device", "device", currentDevice?.name || "This Mac", summary.syncFolder, 74, 244);
        addNode("node-server", "server", summary.server.name, "private Tailnet Vault", 344, 244);
        addNode("node-space", "vault space", summary.defaultSpace, defaultSpace ? fileLabel(defaultSpace.fileCount) + " / " + fmtSize(defaultSpace.size) : "0 files", 596, 244);
        addNode("node-drops", "quick drop", "Desktop Drops", "window-wide drop target", 734, 82);
        addNode("node-log", "audit", "Activity Log", summary.recentChanges.length + " remote events", 734, 406);
        layoutEdges.push(["node-device", "node-server"]);
        layoutEdges.push(["node-server", "node-space"]);
        layoutEdges.push(["node-space", "node-drops"]);
        layoutEdges.push(["node-space", "node-log"]);
        shares.forEach((share, index) => {
          const x = index % 2 === 0 ? 58 : 188;
          const y = 36 + index * 84;
          const id = "node-share-" + index;
          addNode(id, "source", share.label, shortPath(share.localDir), x, y, "source-node");
          layoutEdges.push([id, "node-server"]);
        });
        state.schema.layoutNodes = layoutNodes;
        state.schema.layoutEdges = layoutEdges;
        renderSchemaLines();
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
        clearFolderListings();
        toast("Shared folder added");
        await refresh({ refreshRemote: true });
      }
      function currentUploadTarget() {
        const source = selectedSource();
        if (source && sourceCanReceive(source)) {
          return {
            space: source.space || state.summary.defaultSpace,
            pathPrefix: remotePathForNode(source, currentFolder(source)),
            writable: true
          };
        }
        return {
          space: state.summary.defaultSpace,
          pathPrefix: "Desktop Drops",
          writable: true,
          fallback: true
        };
      }
      window.__agentVaultCurrentDropTarget = currentUploadTarget;
      function matchingSourceForTarget(target) {
        if (!target) return null;
        const space = String(target.space || state.summary?.defaultSpace || "");
        const prefix = String(target.pathPrefix || "").replace(/^\/+|\/+$/g, "");
        const candidates = allSources()
          .filter((source) => String(source.space || "") === space)
          .filter((source) => {
            const sourcePrefix = String(source.remotePathPrefix || "").replace(/^\/+|\/+$/g, "");
            return sourcePrefix && (prefix === sourcePrefix || prefix.startsWith(sourcePrefix + "/"));
          })
          .sort((a, b) => String(b.remotePathPrefix || "").length - String(a.remotePathPrefix || "").length);
        return candidates[0] || null;
      }
      function selectDropTarget(target) {
        const source = matchingSourceForTarget(target);
        if (!source) return false;
        const prefix = String(source.remotePathPrefix || "").replace(/^\/+|\/+$/g, "");
        const targetPrefix = String(target.pathPrefix || "").replace(/^\/+|\/+$/g, "");
        const folder = targetPrefix === prefix ? "" : targetPrefix.slice(prefix.length + 1);
        state.deviceFilter = source.deviceKind || "all";
        state.selectedSourceId = source.sourceId;
        setCurrentFolder(source, folder);
        return true;
      }
      async function refreshAfterDrop(target) {
        await refresh({ refreshRemote: true, full: true });
        if (selectDropTarget(target)) renderFolderBrowser();
      }
      async function uploadFile(file, relativePath) {
        const target = currentUploadTarget();
        const base = String(target.pathPrefix || "Desktop Drops").replace(/^\/+|\/+$/g, "");
        const cleanRelative = String(relativePath || file.name || "drop.bin").replace(/^\/+/, "");
        const filePath = (base ? base + "/" : "") + cleanRelative;
        await api("/api/drop?space=" + encodeURIComponent(target.space) + "&path=" + encodeURIComponent(filePath), {
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
          const target = currentUploadTarget();
          const result = await api("/api/ingest-paths", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paths: localPaths, target })
          });
          clearFolderListings();
          await refreshAfterDrop(result.target || target);
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
        clearFolderListings();
        await refreshAfterDrop(currentUploadTarget());
        toast("Drop upload complete");
      }

      $("syncAll").addEventListener("click", async () => {
        toast("Sync running");
        await api("/api/sync", { method: "POST" });
        clearFolderListings();
        await refresh({ refreshRemote: true });
        toast("Sync complete");
      });
      $("saveEdits").addEventListener("click", async () => {
        toast("Saving edits");
        const result = await api("/api/writeback-edits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
        clearFolderListings();
        await refresh({ refreshRemote: true });
        const writeback = result.writeback || {};
        toast((writeback.uploaded || 0) + " saved / " + (writeback.conflicts || 0) + " conflicts");
      });
      $("autoSyncToggle").addEventListener("click", async () => {
        const next = !Boolean(state.summary?.autoSyncEnabled);
        const result = await api("/api/preferences", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ autoSyncEnabled: next })
        });
        state.summary = { ...state.summary, preferences: result.preferences, autoSyncEnabled: result.preferences.autoSyncEnabled };
        render();
        toast(result.preferences.autoSyncEnabled ? "Auto-sync on" : "Manual sync only");
      });
      $("refresh").addEventListener("click", () => refresh({ refreshRemote: true }));
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
      document.querySelectorAll("[data-view-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          state.viewMode = button.dataset.viewMode || "grid";
          renderFolderBrowser();
        });
      });
      document.querySelectorAll("[data-device-filter]").forEach((button) => {
        button.addEventListener("click", () => {
          state.deviceFilter = button.dataset.deviceFilter || "all";
          state.selectedSourceId = null;
          state.selectedEntryKey = null;
          renderFolderBrowser();
        });
      });
      $("detailsToggle").addEventListener("click", () => {
        state.showDetails = !state.showDetails;
        renderFolderBrowser();
      });
      $("folderUp").addEventListener("click", () => {
        const source = selectedSource();
        if (!source) return;
        if (!currentFolder(source)) {
          state.selectedSourceId = null;
          state.selectedEntryKey = null;
        } else {
          setCurrentFolder(source, parentFolder(currentFolder(source)));
        }
        renderFolderBrowser();
        renderInspector();
      });
      $("folderNew").addEventListener("click", async () => {
        const source = selectedSource();
        if (!source || source.sourceKind !== "local") return;
        const name = window.prompt("Folder name");
        if (!name?.trim()) return;
        const folder = currentFolder(source);
        const path = folder ? folder + "/" + name.trim() : name.trim();
        toast("Creating folder");
        await api("/api/shares/" + encodeURIComponent(source.id) + "/folders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path })
        });
        clearFolderListings();
        await refresh({ refreshRemote: true });
        setCurrentFolder(selectedSource(), folder);
        toast("Folder created");
      });
      document.addEventListener("click", async (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const crumbNode = target?.closest?.("[data-folder-path]");
        if (crumbNode?.dataset) {
          const source = selectedSource();
          if (source) {
            setCurrentFolder(source, crumbNode.dataset.folderPath || "");
            renderFolderBrowser();
            renderInspector();
          }
          return;
        }
        const vaultRootNode = target?.closest?.("[data-vault-root]");
        if (vaultRootNode) {
          state.selectedSourceId = null;
          state.selectedEntryKey = null;
          renderFolderBrowser();
          return;
        }
        const deviceRootNode = target?.closest?.("[data-device-root]");
        if (deviceRootNode?.dataset?.deviceRoot) {
          state.deviceFilter = deviceRootNode.dataset.deviceRoot;
          state.selectedSourceId = null;
          state.selectedEntryKey = null;
          renderFolderBrowser();
          return;
        }
        const fileActionNode = target?.closest?.("[data-file-action]");
        if (fileActionNode?.dataset?.fileAction) {
          event.preventDefault();
          event.stopPropagation();
          const entryNode = fileActionNode.closest(".folder-item");
          if (entryNode) await activateFolderEntry(entryNode, fileActionNode.dataset.fileAction);
          return;
        }
        const entryNode = target?.closest?.(".folder-item");
        if (entryNode?.dataset?.entryKey) {
          state.selectedEntryKey = entryNode.dataset.entryKey;
          document.querySelectorAll(".folder-item.selected").forEach((item) => item.classList.remove("selected"));
          entryNode.classList.add("selected");
          return;
        }
        const downloadNode = target?.closest?.("[data-download-path]");
        if (downloadNode?.dataset?.downloadPath) {
          event.preventDefault();
          event.stopPropagation();
          toast("Downloading file");
          const result = await api("/api/download-remote", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              space: downloadNode.dataset.downloadSpace,
              path: downloadNode.dataset.downloadPath
            })
          });
          await refresh({ refreshRemote: true });
          toast("Downloaded " + shortPath(result.download?.targetPath || downloadNode.dataset.downloadPath));
          return;
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
          await refresh({ refreshRemote: true });
          toast("Permission updated");
        }
        if (removeId) {
          await api("/api/shares/" + encodeURIComponent(removeId), { method: "DELETE" });
          clearFolderListings();
          if (state.selectedSourceId === "local:" + removeId) {
            state.selectedSourceId = null;
          }
          await refresh({ refreshRemote: true });
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
            clearFolderListings();
            await refresh({ refreshRemote: true });
            toast("Folder created");
          }
        }
        if (syncId) {
          toast("Folder sync running");
          await api("/api/shares/" + encodeURIComponent(syncId) + "/sync", { method: "POST" });
          clearFolderListings();
          await refresh({ refreshRemote: true });
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
      document.addEventListener("dblclick", async (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const entryNode = target?.closest?.(".folder-item");
        if (!entryNode?.dataset?.entryKind) return;
        event.preventDefault();
        event.stopPropagation();
        await activateFolderEntry(entryNode, "open");
      });
      document.addEventListener("keydown", async (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const entryNode = target?.closest?.(".folder-item");
        if (!entryNode?.dataset?.entryKind) return;
        if (event.key === "Enter") {
          event.preventDefault();
          await activateFolderEntry(entryNode, "open");
        }
        if (event.key === "Backspace") {
          const source = selectedSource();
          if (!source) return;
          event.preventDefault();
          if (!currentFolder(source)) {
            state.selectedSourceId = null;
            state.selectedEntryKey = null;
          } else {
            setCurrentFolder(source, parentFolder(currentFolder(source)));
          }
          renderFolderBrowser();
        }
      });
      document.addEventListener("dragstart", (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const entryNode = target?.closest?.(".folder-item");
        if (!entryNode?.dataset?.entryPath) return;
        const source = selectedSource();
        const label = source ? (source.label + "/" + entryNode.dataset.entryPath) : entryNode.dataset.entryPath;
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer?.setData("text/plain", label);
        if (entryNode.dataset.entryKind === "file") {
          if (entryNode.dataset.rawDownloadUrl) {
            const mime = entryNode.dataset.fileMime || "application/octet-stream";
            const name = entryNode.dataset.fileName || "agent-vault-file";
            event.dataTransfer?.setData("DownloadURL", mime + ":" + name + ":" + entryNode.dataset.rawDownloadUrl);
            event.dataTransfer?.setData("text/uri-list", entryNode.dataset.rawDownloadUrl);
          }
        }
      });

      document.addEventListener("dragenter", (event) => {
        event.preventDefault();
        state.dragDepth += 1;
        document.body.classList.add("dragging");
      });
      document.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      });
      document.addEventListener("dragleave", () => {
        state.dragDepth = Math.max(0, state.dragDepth - 1);
        if (state.dragDepth === 0) document.body.classList.remove("dragging");
      });
      document.addEventListener("drop", handleDrop);
      window.__agentVaultNativeDropState = (active) => {
        if (active) {
          document.body.classList.add("dragging");
        } else {
          state.dragDepth = 0;
          document.body.classList.remove("dragging");
        }
      };
      window.__agentVaultNativeDropStarted = (count) => {
        state.dragDepth = 0;
        document.body.classList.remove("dragging");
        toast("Uploading " + (Number(count) || 1) + " dropped item" + ((Number(count) || 1) === 1 ? "" : "s"));
      };
      window.__agentVaultNativeDropComplete = async (result) => {
        clearFolderListings();
        const target = result?.target || result?.results?.find?.((item) => item?.target)?.target || currentUploadTarget();
        await refreshAfterDrop(target);
        toast("Drop complete");
      };
      window.__agentVaultNativeDropFailed = (message) => {
        state.dragDepth = 0;
        document.body.classList.remove("dragging");
        toast(message || "Drop failed");
      };
      window.__agentVaultNativeRefresh = async (message) => {
        await refresh({ refreshRemote: true });
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
      $("layoutReset").addEventListener("click", () => {
        state.schema.nodePositions = {};
        saveSchemaNodePositions();
        renderSchema();
      });
      $("schemaNodes").addEventListener("pointerdown", (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const node = target?.closest?.("[data-schema-node]");
        if (!node?.dataset?.schemaNode) return;
        event.preventDefault();
        event.stopPropagation();
        const id = node.dataset.schemaNode;
        const defaultX = Number(node.dataset.defaultX || 0);
        const defaultY = Number(node.dataset.defaultY || 0);
        const position = schemaNodePosition(id, defaultX, defaultY);
        state.schema.hasUserMoved = true;
        state.schema.nodeDrag = {
          id,
          node,
          startX: event.clientX,
          startY: event.clientY,
          originX: position.x,
          originY: position.y
        };
        node.classList.add("dragging");
        node.setPointerCapture(event.pointerId);
      });
      $("schemaNodes").addEventListener("pointermove", (event) => {
        const drag = state.schema.nodeDrag;
        if (!drag) return;
        const node = drag.node;
        if (!(node instanceof HTMLElement)) return;
        const next = {
          x: drag.originX + (event.clientX - drag.startX) / state.schema.scale,
          y: drag.originY + (event.clientY - drag.startY) / state.schema.scale
        };
        state.schema.nodePositions[drag.id] = next;
        node.style.left = next.x + "px";
        node.style.top = next.y + "px";
        renderSchemaLines();
      });
      const endSchemaNodeDrag = () => {
        if (!state.schema.nodeDrag) return;
        document.querySelectorAll(".schema-node.dragging").forEach((node) => node.classList.remove("dragging"));
        state.schema.nodeDrag = null;
        saveSchemaNodePositions();
      };
      $("schemaNodes").addEventListener("pointerup", endSchemaNodeDrag);
      $("schemaNodes").addEventListener("pointercancel", endSchemaNodeDrag);
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
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target?.closest?.("[data-schema-node]")) return;
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

      refresh({ refreshRemote: true }).catch((error) => {
        renderOffline(error.message);
        toast(error.message);
      });
      window.setInterval(() => {
        if (state.paused) return;
        refresh({ silent: true }).catch((error) => renderOffline(error.message));
      }, 30000);
    </script>
  </body>
</html>`;
}
