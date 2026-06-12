import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { VaultFileRecord } from "@agent-vault/core";
import type { MacSyncConfig } from "./config.js";
import { readActivity, recordActivity } from "./activityLog.js";
import { scanLocal } from "./localState.js";
import { addShare, loadShareConfig, removeShare, type ShareRecord } from "./shareConfig.js";
import { shareStatus, syncShare } from "./shareSync.js";
import { pullCommand, pushCommand, statusCommand } from "./syncCommands.js";
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
    const [files, status] = await Promise.all([scanLocal(share.localDir), shareStatus(config, share)]);
    return {
      ...share,
      localFileCount: files.length,
      pendingActions: changedCount(status.actions),
      available: true,
    };
  } catch (error: unknown) {
    return {
      ...share,
      localFileCount: 0,
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

async function buildSummary(config: MacSyncConfig) {
  const vault = new VaultClient(config.serverUrl, config.token);
  const shareConfig = await loadShareConfig();
  const [spaces, mainStatus, activity] = await Promise.all([
    vault.listSpaces(),
    statusCommand(config).catch((error: unknown) => ({ actions: [], error: error instanceof Error ? error.message : "Status failed." })),
    readActivity(),
  ]);
  const shares = await Promise.all(shareConfig.shares.map((share) => summarizeShare(config, share)));
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
          recentChanges: [],
          error: error instanceof Error ? error.message : "Space failed.",
        };
      }
    }),
  );

  return {
    serverUrl: config.serverUrl,
    syncFolder: config.localDir,
    defaultSpace: config.space,
    mainPendingActions: "actions" in mainStatus ? changedCount(mainStatus.actions) : 0,
    mainStatusError: "error" in mainStatus ? mainStatus.error : null,
    shares,
    remoteSpaces,
    activity,
  };
}

async function syncAll(config: MacSyncConfig) {
  const pushed = await pushCommand(config);
  const pulled = await pullCommand(config);
  const shareConfig = await loadShareConfig();
  const shares = [];
  for (const share of shareConfig.shares.filter((item) => item.enabled)) {
    shares.push(await syncShare(config, share));
  }
  await recordActivity("sync", "Synced Agent Vault desktop sources", {
    main: {
      pushed: pushed.pushed,
      pulled: pulled.pulled,
      deleted: pushed.deleted + pulled.deleted,
      conflicts: pushed.conflicts + pulled.conflicts,
    },
    shares: shares.map((share) => ({ label: share.label, summary: share.summary })),
  });
  return { main: { pushed, pulled }, shares };
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
    });
    await recordActivity("share_added", `Added shared folder ${share.label}`, {
      localDir: share.localDir,
      space: share.space,
      remotePathPrefix: share.remotePathPrefix,
    });
    sendJson(res, 201, { share });
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
  if (options.open !== false) {
    openBrowser(url);
  }

  return {
    url,
    port: actualPort,
    server,
    close() {
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
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #101312;
        color: #eef3ee;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100svh;
        background:
          linear-gradient(120deg, rgba(29, 47, 44, 0.8), rgba(16, 19, 18, 0.96) 44%, rgba(44, 39, 29, 0.92));
      }
      button, input, select { font: inherit; }
      .shell {
        min-height: 100svh;
        padding: 22px;
        display: grid;
        grid-template-rows: auto 1fr;
        gap: 18px;
      }
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      .brand {
        display: flex;
        align-items: baseline;
        gap: 12px;
      }
      h1 {
        margin: 0;
        font-size: clamp(28px, 5vw, 48px);
        line-height: 0.95;
        letter-spacing: 0;
      }
      .subtle { color: #9ba9a2; }
      .actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
      .button {
        border: 1px solid rgba(255, 255, 255, 0.14);
        color: #eef3ee;
        background: rgba(255, 255, 255, 0.08);
        min-height: 40px;
        padding: 0 14px;
        border-radius: 8px;
        cursor: pointer;
        transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
      }
      .button:hover { background: rgba(255, 255, 255, 0.13); border-color: rgba(255, 255, 255, 0.24); transform: translateY(-1px); }
      .button.primary { background: #9be4bf; color: #082018; border-color: transparent; }
      .button.danger { color: #ffd9cf; }
      .grid {
        display: grid;
        grid-template-columns: minmax(280px, 0.86fr) minmax(340px, 1.32fr) minmax(280px, 0.82fr);
        gap: 16px;
        min-height: 0;
      }
      .panel, .share, .dropzone {
        background: rgba(18, 24, 22, 0.56);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 18px 70px rgba(0, 0, 0, 0.22);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        border-radius: 8px;
      }
      .panel {
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .panel-head {
        padding: 16px 16px 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }
      .panel h2 { margin: 0; font-size: 14px; letter-spacing: 0; }
      .panel-body { padding: 14px; overflow: auto; display: grid; gap: 12px; align-content: start; }
      .input-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
      input, select {
        min-width: 0;
        color: #eef3ee;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        padding: 10px 11px;
        outline: none;
      }
      input:focus, select:focus { border-color: #9be4bf; }
      .dropzone {
        min-height: 132px;
        border-style: dashed;
        display: grid;
        place-items: center;
        text-align: center;
        color: #c8d4ce;
        padding: 18px;
        transition: background 160ms ease, border-color 160ms ease;
      }
      .dropzone.active { background: rgba(155, 228, 191, 0.12); border-color: rgba(155, 228, 191, 0.6); }
      .share {
        padding: 12px;
        display: grid;
        gap: 10px;
      }
      .share-top, .row {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: center;
      }
      .label { font-weight: 650; overflow-wrap: anywhere; }
      .path { color: #9ba9a2; font-size: 12px; overflow-wrap: anywhere; }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip {
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.06);
        color: #c8d4ce;
        padding: 4px 7px;
        border-radius: 999px;
        font-size: 12px;
      }
      .chip.good { color: #bff4d8; border-color: rgba(155, 228, 191, 0.28); }
      .chip.warn { color: #ffdca8; border-color: rgba(255, 207, 137, 0.35); }
      .space { display: grid; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
      .space:last-child { border-bottom: 0; }
      .folder, .change, .activity {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        padding: 8px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }
      .folder:last-child, .change:last-child, .activity:last-child { border-bottom: 0; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #c8d4ce; overflow-wrap: anywhere; }
      .metric { color: #eef3ee; font-size: 12px; }
      .empty { color: #9ba9a2; padding: 12px 0; }
      .toast {
        position: fixed;
        right: 22px;
        bottom: 22px;
        max-width: min(420px, calc(100vw - 44px));
        background: rgba(10, 12, 11, 0.84);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        padding: 12px 14px;
        color: #eef3ee;
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 180ms ease, transform 180ms ease;
      }
      .toast.show { opacity: 1; transform: translateY(0); }
      @media (max-width: 1060px) {
        .grid { grid-template-columns: 1fr; }
        .panel { min-height: 360px; }
      }
      @media (max-width: 640px) {
        .shell { padding: 14px; }
        .topbar { align-items: flex-start; flex-direction: column; }
        .actions, .input-row { width: 100%; }
        .input-row { grid-template-columns: 1fr; }
        .button { width: 100%; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="topbar">
        <div class="brand">
          <h1>Agent Vault</h1>
          <div class="subtle" id="connection">Loading</div>
        </div>
        <div class="actions">
          <button class="button" id="openFolder">Open folder</button>
          <button class="button primary" id="syncAll">Sync all</button>
        </div>
      </header>
      <section class="grid">
        <aside class="panel">
          <div class="panel-head">
            <h2>Shared folders</h2>
            <button class="button" id="chooseFolder">+</button>
          </div>
          <div class="panel-body">
            <div class="input-row">
              <input id="pathInput" placeholder="/Users/nils/Projects/site" />
              <button class="button" id="addPath">Add</button>
            </div>
            <div class="dropzone" id="dropzone">
              <div>
                <div class="label">Drop files or folders</div>
                <div class="subtle">Uploads land in MacBook Shared / Desktop Drops</div>
              </div>
            </div>
            <div id="shares"></div>
          </div>
        </aside>
        <section class="panel">
          <div class="panel-head">
            <h2>Vault structure</h2>
            <span class="chip" id="pending">0 pending</span>
          </div>
          <div class="panel-body" id="structure"></div>
        </section>
        <aside class="panel">
          <div class="panel-head">
            <h2>Activity log</h2>
            <button class="button" id="refresh">Refresh</button>
          </div>
          <div class="panel-body" id="activity"></div>
        </aside>
      </section>
    </main>
    <div class="toast" id="toast"></div>
    <script>
      const state = { summary: null };
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
      const fmtTime = (value) => new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
      const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
      async function refresh() {
        state.summary = await api("/api/summary");
        render();
      }
      function render() {
        const summary = state.summary;
        $("connection").textContent = summary.serverUrl + " -> " + summary.defaultSpace;
        $("pending").textContent = summary.mainPendingActions + " pending";
        $("shares").innerHTML = summary.shares.length ? summary.shares.map((share) =>
          '<div class="share">' +
            '<div class="share-top">' +
              '<div>' +
                '<div class="label">' + esc(share.label) + '</div>' +
                '<div class="path">' + esc(share.localDir) + '</div>' +
              '</div>' +
              '<button class="button danger" data-remove="' + esc(share.id) + '">Remove</button>' +
            '</div>' +
            '<div class="chips">' +
              '<span class="chip">' + esc(share.space) + '</span>' +
              '<span class="chip">' + esc(share.remotePathPrefix) + '</span>' +
              '<span class="chip ' + (share.available ? "good" : "warn") + '">' + (share.available ? share.localFileCount + " files" : "offline") + '</span>' +
              '<span class="chip ' + (share.pendingActions ? "warn" : "good") + '">' + share.pendingActions + ' pending</span>' +
            '</div>' +
            '<div class="row">' +
              '<button class="button" data-open="' + esc(share.localDir) + '">Open</button>' +
              '<button class="button primary" data-sync="' + esc(share.id) + '">Sync</button>' +
            '</div>' +
          '</div>'
        ).join("") : '<div class="empty">No shared folders yet.</div>';
        $("structure").innerHTML = summary.remoteSpaces.map((space) => {
          const folders = (space.folders.length ? space.folders : [{ path: "/", count: 0, size: 0 }]).slice(0, 8).map((folder) =>
            '<div class="folder">' +
              '<span class="mono">' + esc(folder.path) + '</span>' +
              '<span class="metric">' + folder.count + ' / ' + fmtSize(folder.size) + '</span>' +
            '</div>'
          ).join("");
          const changes = space.recentChanges.slice(0, 6).map((change) =>
            '<div class="change">' +
              '<span class="mono">' + esc(change.operation) + ' ' + esc(change.path) + '</span>' +
              '<span class="metric">' + esc(change.device) + '</span>' +
            '</div>'
          ).join("");
          return '<div class="space">' +
            '<div class="row">' +
              '<div>' +
                '<div class="label">' + esc(space.name) + '</div>' +
                '<div class="subtle">' + space.fileCount + ' files / ' + fmtSize(space.size) + '</div>' +
              '</div>' +
              '<span class="chip">' + esc(space.permissions.join(", ")) + '</span>' +
            '</div>' +
            folders +
            changes +
          '</div>';
        }).join("");
        $("activity").innerHTML = summary.activity.length ? summary.activity.map((entry) =>
          '<div class="activity">' +
            '<span>' +
              '<div>' + esc(entry.message) + '</div>' +
              '<div class="subtle">' + esc(entry.kind) + '</div>' +
            '</span>' +
            '<span class="metric">' + fmtTime(entry.timestamp) + '</span>' +
          '</div>'
        ).join("") : '<div class="empty">No activity yet.</div>';
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
      $("syncAll").addEventListener("click", async () => {
        toast("Sync running");
        await api("/api/sync", { method: "POST" });
        await refresh();
        toast("Sync complete");
      });
      $("refresh").addEventListener("click", refresh);
      $("openFolder").addEventListener("click", () => api("/api/open-main-folder", { method: "POST" }));
      $("addPath").addEventListener("click", async () => {
        const value = $("pathInput").value.trim();
        if (value) await addPath(value);
      });
      $("chooseFolder").addEventListener("click", async () => {
        const choice = await api("/api/choose-folder");
        if (choice.path) await addPath(choice.path);
      });
      document.addEventListener("click", async (event) => {
        const removeId = event.target?.dataset?.remove;
        const syncId = event.target?.dataset?.sync;
        const openFolder = event.target?.dataset?.open;
        if (removeId) {
          await api("/api/shares/" + encodeURIComponent(removeId), { method: "DELETE" });
          await refresh();
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
      const dropzone = $("dropzone");
      ["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.add("active");
      }));
      ["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, () => dropzone.classList.remove("active")));
      dropzone.addEventListener("drop", async (event) => {
        event.preventDefault();
        const items = [...event.dataTransfer.items];
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
      });
      refresh().catch((error) => toast(error.message));
    </script>
  </body>
</html>`;
}
