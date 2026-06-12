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
    <link rel="icon" href="data:," />
    <style>
      :root {
        color-scheme: dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        background: #131417;
        color: #f4f2ee;
        --bg: #131417;
        --rail: rgba(35, 38, 45, 0.9);
        --tile: rgba(37, 39, 45, 0.9);
        --tile-deep: rgba(28, 30, 35, 0.94);
        --line: rgba(255, 255, 255, 0.07);
        --line-strong: rgba(255, 255, 255, 0.14);
        --muted: rgba(244, 242, 238, 0.58);
        --faint: rgba(244, 242, 238, 0.34);
        --accent: #7fd7df;
        --accent-soft: rgba(127, 215, 223, 0.12);
        --warm: #f2b98d;
        --warn: #f0c886;
        --danger: #ff9f90;
        --shadow: 0 0 0 1px rgba(255, 255, 255, 0.025),
          -9px 9px 9px -0.5px rgba(0, 0, 0, 0.04),
          -18px 18px 18px -1.5px rgba(0, 0, 0, 0.08),
          -37px 37px 37px -3px rgba(0, 0, 0, 0.16),
          -75px 75px 75px -6px rgba(0, 0, 0, 0.24),
          -150px 150px 150px -12px rgba(0, 0, 0, 0.48);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100svh;
        background:
          radial-gradient(circle at 72% 14%, rgba(255, 255, 255, 0.035), transparent 26%),
          linear-gradient(135deg, #151518 0%, #191a1f 56%, #101114 100%);
        overflow: hidden;
        -webkit-font-smoothing: antialiased;
      }
      button, input { font: inherit; }
      button { user-select: none; }
      .shell {
        min-height: 100svh;
        display: grid;
        grid-template-columns: 74px minmax(0, 1fr);
      }
      .rail {
        min-height: 100svh;
        display: grid;
        grid-template-rows: auto 1fr auto;
        justify-items: center;
        padding: 27px 0 22px;
        background: linear-gradient(180deg, rgba(42, 45, 53, 0.92), rgba(31, 34, 41, 0.98));
        border-right: 1px solid rgba(255, 255, 255, 0.055);
      }
      .mark {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 3px solid rgba(255, 255, 255, 0.82);
        box-shadow: inset 0 0 0 4px rgba(36, 39, 46, 0.96), 0 16px 32px rgba(0, 0, 0, 0.28);
      }
      .rail-stack {
        display: flex;
        flex-direction: column;
        gap: 16px;
        align-items: center;
      }
      .rail-button {
        width: 36px;
        height: 36px;
        border: 0;
        border-radius: 11px;
        display: grid;
        place-items: center;
        cursor: pointer;
        color: rgba(244, 242, 238, 0.62);
        background: transparent;
        transition: color 160ms ease, background 160ms ease, transform 160ms ease;
      }
      .rail-button:hover {
        color: rgba(244, 242, 238, 0.92);
        background: rgba(255, 255, 255, 0.06);
        transform: translateY(-1px);
      }
      .rail-button.active {
        color: #15161a;
        background: rgba(255, 255, 255, 0.92);
      }
      .mini-icon {
        position: relative;
        width: 17px;
        height: 17px;
        display: block;
      }
      .vault-icon {
        border-radius: 5px;
        border: 2px solid currentColor;
      }
      .vault-icon::after {
        content: "";
        position: absolute;
        left: 3px;
        right: 3px;
        bottom: 3px;
        height: 2px;
        background: currentColor;
        opacity: 0.72;
      }
      .refresh-icon::before,
      .refresh-icon::after {
        content: "";
        position: absolute;
        left: 1px;
        right: 1px;
        height: 2px;
        border-radius: 999px;
        background: currentColor;
      }
      .refresh-icon::before {
        top: 5px;
        transform: rotate(18deg);
      }
      .refresh-icon::after {
        bottom: 5px;
        transform: rotate(-18deg);
      }
      .rail-plus {
        position: fixed;
        left: 18px;
        bottom: 22px;
        width: 38px;
        height: 38px;
        border-radius: 11px;
        color: #15161a;
        background: rgba(255, 255, 255, 0.92);
        font-size: 28px;
        line-height: 1;
      }
      .workspace {
        min-width: 0;
        min-height: 100svh;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        padding: 48px 54px 38px 72px;
      }
      .topbar {
        min-width: 0;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 32px;
        padding-bottom: 36px;
      }
      .brand { min-width: 0; }
      h1 {
        margin: 0;
        font-size: 31px;
        line-height: 1.04;
        font-weight: 760;
        letter-spacing: 0;
      }
      .device-line {
        margin-top: 17px;
        max-width: min(720px, 54vw);
        color: var(--muted);
        font-size: 12px;
        font-weight: 560;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .subtle { color: var(--muted); }
      .actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .button {
        border: 0;
        min-height: 36px;
        padding: 0 13px;
        border-radius: 7px;
        color: rgba(244, 242, 238, 0.82);
        background: rgba(255, 255, 255, 0.055);
        cursor: pointer;
        transition: background 160ms ease, transform 160ms ease, color 160ms ease;
      }
      .button:hover {
        color: rgba(244, 242, 238, 0.96);
        background: rgba(255, 255, 255, 0.105);
        transform: translateY(-1px);
      }
      .button.primary {
        color: #15161a;
        background: rgba(244, 242, 238, 0.9);
      }
      .button.danger {
        color: rgba(244, 242, 238, 0.42);
        background: transparent;
      }
      .button.danger:hover { color: var(--danger); }
      .content {
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 312px;
        gap: 46px;
      }
      .stage {
        min-width: 0;
        min-height: 0;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: 30px;
        overflow: hidden;
      }
      .stage-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 18px;
      }
      .stage-head h2,
      .context-block h2 {
        margin: 0;
        font-size: 13px;
        line-height: 1;
        font-weight: 760;
        letter-spacing: 0;
      }
      .count-line {
        color: var(--faint);
        font-size: 12px;
        font-weight: 620;
      }
      .dropzone {
        min-height: 174px;
        display: grid;
        place-items: center;
        padding: 28px;
        text-align: center;
        color: rgba(244, 242, 238, 0.68);
        background: rgba(255, 255, 255, 0.018);
        border: 1px dashed rgba(255, 255, 255, 0.18);
        border-radius: 5px;
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
      }
      .dropzone:hover {
        transform: translateY(-2px);
        border-color: rgba(244, 242, 238, 0.28);
      }
      .dropzone.active {
        background: rgba(127, 215, 223, 0.08);
        border-color: rgba(127, 215, 223, 0.68);
      }
      .drop-label {
        font-size: 20px;
        line-height: 1.18;
        font-weight: 730;
      }
      .drop-note {
        margin-top: 9px;
        color: var(--faint);
        font-size: 12px;
      }
      .share-cloud {
        min-height: 0;
        overflow: auto;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(228px, 1fr));
        gap: 28px;
        align-content: start;
        padding: 5px 34px 60px 0;
      }
      .share-cloud .share:nth-child(3n + 2) { margin-top: 26px; }
      .share-cloud .share:nth-child(4n + 3) { margin-top: 10px; }
      .share {
        position: relative;
        min-height: 218px;
        display: grid;
        align-content: space-between;
        gap: 18px;
        padding: 28px 26px 22px;
        overflow: hidden;
        background: linear-gradient(152deg, rgba(43, 45, 52, 0.92), rgba(30, 32, 37, 0.94));
        border: 1px solid rgba(255, 255, 255, 0.038);
        border-radius: 4px;
        box-shadow: var(--shadow);
        animation: tileIn 300ms ease both;
        transition: transform 170ms ease, background 170ms ease, border-color 170ms ease;
      }
      .share:hover {
        transform: translateY(-3px);
        background: linear-gradient(152deg, rgba(49, 51, 58, 0.95), rgba(33, 35, 40, 0.96));
        border-color: rgba(255, 255, 255, 0.09);
      }
      .share::before {
        content: "";
        position: absolute;
        left: 0;
        top: 26px;
        width: 3px;
        height: 54px;
        background: var(--accent);
        opacity: 0.86;
      }
      .share::after {
        content: "";
        position: absolute;
        right: 22px;
        top: 25px;
        width: 68px;
        height: 51px;
        border-radius: 7px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.16) 0 7px, rgba(255, 255, 255, 0) 7px),
          linear-gradient(132deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.035));
        border: 1px solid rgba(255, 255, 255, 0.075);
        filter: drop-shadow(-18px 24px 28px rgba(0, 0, 0, 0.34));
        opacity: 0.6;
        pointer-events: none;
      }
      @keyframes tileIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .share-top,
      .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: start;
      }
      .share-top {
        display: block;
      }
      .label {
        font-weight: 740;
        overflow-wrap: anywhere;
      }
      .share .label {
        max-width: calc(100% - 78px);
        font-size: 19px;
        line-height: 1.23;
      }
      .path {
        margin-top: 9px;
        color: var(--faint);
        font-size: 11px;
        line-height: 1.45;
        overflow-wrap: anywhere;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip {
        border: 1px solid rgba(255, 255, 255, 0.06);
        background: rgba(255, 255, 255, 0.035);
        color: rgba(244, 242, 238, 0.55);
        padding: 5px 8px;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 650;
      }
      .chip.good { color: #9ee6b4; border-color: rgba(158, 230, 180, 0.18); }
      .chip.warn { color: var(--warn); border-color: rgba(255, 208, 138, 0.18); }
      .share-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .manual-add {
        width: min(620px, 100%);
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 9px;
      }
      input {
        min-width: 0;
        height: 39px;
        color: rgba(244, 242, 238, 0.84);
        background: rgba(255, 255, 255, 0.046);
        border: 1px solid rgba(255, 255, 255, 0.055);
        border-radius: 7px;
        padding: 0 12px;
        outline: none;
      }
      input:focus { border-color: rgba(127, 215, 223, 0.55); }
      .context {
        min-width: 0;
        min-height: 0;
        display: grid;
        grid-template-rows: minmax(0, 0.92fr) minmax(190px, 0.76fr);
        gap: 33px;
      }
      .context-block {
        min-height: 0;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        gap: 18px;
      }
      .context-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .context-body {
        min-height: 0;
        overflow: auto;
        display: grid;
        gap: 16px;
        align-content: start;
      }
      .space {
        display: grid;
        gap: 10px;
        padding-bottom: 18px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }
      .space:last-child { border-bottom: 0; }
      .folder,
      .change,
      .activity {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        align-items: baseline;
        padding: 4px 0;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        color: rgba(244, 242, 238, 0.54);
        overflow-wrap: anywhere;
      }
      .metric {
        color: rgba(244, 242, 238, 0.42);
        font-size: 11px;
        white-space: nowrap;
      }
      .empty {
        color: rgba(244, 242, 238, 0.42);
        font-size: 13px;
        padding: 16px 0;
      }
      .toast {
        position: fixed;
        right: 24px;
        bottom: 22px;
        max-width: min(420px, calc(100vw - 32px));
        background: rgba(28, 30, 35, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 7px;
        padding: 12px 15px;
        color: rgba(244, 242, 238, 0.9);
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.38);
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 180ms ease, transform 180ms ease;
      }
      .toast.show { opacity: 1; transform: translateY(0); }
      @media (max-width: 1100px) {
        body { overflow: auto; }
        .workspace { min-height: 100svh; padding: 36px 30px 30px; }
        .content { grid-template-columns: 1fr; }
        .context { grid-template-columns: 1fr; grid-template-rows: auto; }
      }
      @media (max-width: 740px) {
        .shell { grid-template-columns: 56px 1fr; }
        .rail { padding-top: 20px; }
        .rail-plus { left: 9px; }
        .topbar { flex-direction: column; }
        .actions,
        .manual-add { width: 100%; }
        .manual-add { grid-template-columns: 1fr; }
        .button { width: 100%; }
        .share-cloud { grid-template-columns: 1fr; padding-right: 0; }
        .share-cloud .share { margin-top: 0 !important; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <nav class="rail" aria-label="Agent Vault">
        <div class="mark" aria-hidden="true"></div>
        <div class="rail-stack">
          <button class="rail-button active" title="Vault" aria-label="Vault"><span class="mini-icon vault-icon" aria-hidden="true"></span></button>
          <button class="rail-button" id="refresh" title="Refresh" aria-label="Refresh"><span class="mini-icon refresh-icon" aria-hidden="true"></span></button>
        </div>
        <button class="rail-button rail-plus" id="chooseFolder" title="Add shared folder" aria-label="Add shared folder">+</button>
      </nav>
      <section class="workspace">
        <header class="topbar">
          <div class="brand">
            <h1>Agent Vault</h1>
            <div class="device-line" id="connection">Loading</div>
          </div>
          <div class="actions">
            <button class="button" id="openFolder">Open</button>
            <button class="button primary" id="syncAll">Sync</button>
          </div>
        </header>
        <div class="content">
          <section class="stage">
            <div class="stage-head">
              <h2>Shared folders</h2>
              <div class="count-line" id="shareCount">0 sources</div>
            </div>
            <div class="dropzone" id="dropzone">
              <div>
                <div class="drop-label">Drop files or folders</div>
                <div class="drop-note">Quick drops land in Desktop Drops.</div>
              </div>
            </div>
            <div class="share-cloud" id="shares"></div>
            <div class="manual-add">
              <input id="pathInput" placeholder="Paste a folder path" />
              <button class="button" id="addPath">Add</button>
            </div>
          </section>
          <aside class="context">
            <section class="context-block">
              <div class="context-head">
                <h2>Vault</h2>
                <span class="chip" id="pending">0 pending</span>
              </div>
              <div class="context-body" id="structure"></div>
            </section>
            <section class="context-block">
              <div class="context-head">
                <h2>Log</h2>
              </div>
              <div class="context-body" id="activity"></div>
            </section>
          </aside>
        </div>
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
      const fileLabel = (count) => count + " " + (count === 1 ? "file" : "files");
      const shortPath = (value) => {
        const text = String(value ?? "");
        const parts = text.split("/").filter(Boolean);
        if (parts.length <= 2) return text;
        return ".../" + parts.slice(-2).join("/");
      };
      const fmtTime = (value) => new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
      const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
      async function refresh() {
        state.summary = await api("/api/summary");
        render();
      }
      function render() {
        const summary = state.summary;
        let host = summary.serverUrl;
        try { host = new URL(summary.serverUrl).host; } catch {}
        $("connection").textContent = host + " / " + summary.defaultSpace;
        $("pending").textContent = summary.mainPendingActions + " pending";
        $("shareCount").textContent = summary.shares.length + (summary.shares.length === 1 ? " source" : " sources");
        $("shares").innerHTML = summary.shares.length ? summary.shares.map((share) =>
          '<article class="share">' +
            '<div class="share-top">' +
              '<div>' +
                '<div class="label">' + esc(share.label) + '</div>' +
                '<div class="path" title="' + esc(share.localDir) + '">' + esc(shortPath(share.localDir)) + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="chips">' +
              '<span class="chip ' + (share.available ? "good" : "warn") + '">' + (share.available ? fileLabel(share.localFileCount) : "offline") + '</span>' +
              '<span class="chip ' + (share.pendingActions ? "warn" : "good") + '">' + share.pendingActions + ' pending</span>' +
            '</div>' +
            '<div class="share-actions">' +
              '<button class="button" data-open="' + esc(share.localDir) + '">Open</button>' +
              '<button class="button primary" data-sync="' + esc(share.id) + '">Sync</button>' +
              '<button class="button danger" data-remove="' + esc(share.id) + '">Remove</button>' +
            '</div>' +
          '</article>'
        ).join("") : '<div class="empty">Press + or drop something here.</div>';
        const visibleSpaces = summary.remoteSpaces.filter((space) => space.fileCount > 0 || space.name === summary.defaultSpace).slice(0, 4);
        $("structure").innerHTML = visibleSpaces.length ? visibleSpaces.map((space) => {
          const folders = (space.folders.length ? space.folders : [{ path: "/", count: 0, size: 0 }]).slice(0, 4).map((folder) =>
            '<div class="folder">' +
              '<span class="mono">' + esc(folder.path) + '</span>' +
              '<span class="metric">' + folder.count + ' / ' + fmtSize(folder.size) + '</span>' +
            '</div>'
          ).join("");
          const changes = space.recentChanges.slice(0, 2).map((change) =>
            '<div class="change">' +
              '<span class="mono">' + esc(change.operation) + ' ' + esc(change.path) + '</span>' +
              '<span class="metric">' + esc(change.device) + '</span>' +
            '</div>'
          ).join("");
          return '<div class="space">' +
            '<div class="row">' +
              '<div>' +
                '<div class="label">' + esc(space.name) + '</div>' +
                '<div class="subtle">' + fileLabel(space.fileCount) + ' / ' + fmtSize(space.size) + '</div>' +
              '</div>' +
            '</div>' +
            folders +
            changes +
          '</div>';
        }).join("") : '<div class="empty">No vault files yet.</div>';
        $("activity").innerHTML = summary.activity.length ? summary.activity.slice(0, 12).map((entry) =>
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
