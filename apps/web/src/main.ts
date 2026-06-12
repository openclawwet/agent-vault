import type { SpaceAccessInfo, VaultFileRecord, VaultPermission } from "@agent-vault/core";
import "./styles.css";
import { VaultClient, VaultClientError, type VaultSession } from "./vaultClient";

const SESSION_KEY = "agent-vault:web-session";

interface AppState {
  session?: VaultSession;
  client?: VaultClient;
  deviceName?: string;
  spaces: SpaceAccessInfo[];
  activeSpace: string;
  files: VaultFileRecord[];
  selectedFile?: VaultFileRecord;
  preview?: PreviewState;
  loading: boolean;
  uploading: boolean;
  uploadProgress: number;
  message?: string;
  error?: string;
  targetFolder: string;
}

interface PreviewState {
  path: string;
  kind: "image" | "pdf" | "text" | "download";
  url?: string;
  text?: string;
}

const state: AppState = {
  spaces: [],
  activeSpace: "Inbox",
  files: [],
  loading: false,
  uploading: false,
  uploadProgress: 0,
  targetFolder: defaultTargetFolder(),
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("App root missing.");
}
const appRoot = app;

function defaultTargetFolder(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `phone/${year}-${month}-${day}`;
}

function loadSession(): VaultSession | undefined {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<VaultSession>;
    if (parsed.serverUrl && parsed.token) {
      return {
        serverUrl: parsed.serverUrl,
        token: parsed.token,
      };
    }
  } catch {
    localStorage.removeItem(SESSION_KEY);
  }
  return undefined;
}

function defaultServerUrl(): string {
  return window.location.origin || "http://127.0.0.1:3474";
}

function saveSession(session: VaultSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  resetObjectUrls();
  state.session = undefined;
  state.client = undefined;
  state.deviceName = undefined;
  state.spaces = [];
  state.files = [];
  state.selectedFile = undefined;
  state.preview = undefined;
  state.error = undefined;
  state.message = undefined;
}

function resetObjectUrls(): void {
  if (state.preview?.url) {
    URL.revokeObjectURL(state.preview.url);
  }
}

function can(permission: VaultPermission, space = state.activeSpace): boolean {
  const active = state.spaces.find((item) => item.name === space);
  return Boolean(active?.permissions.includes("admin") || active?.permissions.includes(permission));
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fileKind(path: string): PreviewState["kind"] {
  const lowerPath = path.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(lowerPath)) return "image";
  if (/\.pdf$/.test(lowerPath)) return "pdf";
  if (/\.(txt|md|markdown|csv|json|xml|html|css|js|ts|tsx|jsx|log)$/.test(lowerPath)) return "text";
  return "download";
}

function safeTargetPath(folder: string, name: string): string {
  const cleanFolder = folder
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
  const cleanName = name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "upload.bin";
  return cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName;
}

function messageFor(error: unknown): string {
  if (error instanceof VaultClientError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong.";
}

async function connect(session: VaultSession): Promise<void> {
  state.loading = true;
  state.error = undefined;
  state.message = undefined;
  render();

  try {
    const client = new VaultClient(session);
    await client.health();
    const me = await client.me();
    state.session = session;
    state.client = client;
    state.deviceName = me.device.name;
    state.spaces = me.spaces;
    state.activeSpace = me.spaces.some((space) => space.name === "Inbox") ? "Inbox" : me.spaces[0]?.name ?? "Inbox";
    saveSession(session);
    await refreshFiles({ keepMessage: false });
    state.message = `Connected as ${me.device.name}.`;
  } catch (error) {
    state.error = messageFor(error);
  } finally {
    state.loading = false;
    render();
  }
}

async function refreshFiles(options: { keepMessage?: boolean } = {}): Promise<void> {
  if (!state.client) return;
  state.loading = true;
  if (!options.keepMessage) {
    state.message = undefined;
  }
  state.error = undefined;
  render();

  try {
    const result = await state.client.listFiles(state.activeSpace);
    state.files = result.files;
    if (state.selectedFile) {
      state.selectedFile = state.files.find((file) => file.id === state.selectedFile?.id);
    }
    if (!state.selectedFile && state.files.length) {
      state.selectedFile = state.files[0];
    }
    if (state.selectedFile) {
      await loadPreview(state.selectedFile, { silent: true });
    } else {
      resetObjectUrls();
      state.preview = undefined;
    }
  } catch (error) {
    state.error = messageFor(error);
  } finally {
    state.loading = false;
    render();
  }
}

async function uploadSelectedFile(file: File): Promise<void> {
  if (!state.client || !can("write")) return;
  const targetPath = safeTargetPath(state.targetFolder, file.name);
  state.uploading = true;
  state.uploadProgress = 0;
  state.error = undefined;
  state.message = undefined;
  render();

  try {
    const result = await state.client.uploadFile(state.activeSpace, targetPath, file, (progress) => {
      state.uploadProgress = progress.percent;
      render();
    });
    state.message = `Uploaded to ${result.file.space}/${result.file.path}.`;
    state.selectedFile = result.file;
    await refreshFiles({ keepMessage: true });
  } catch (error) {
    state.error = messageFor(error);
  } finally {
    state.uploading = false;
    state.uploadProgress = 0;
    render();
  }
}

async function loadPreview(file: VaultFileRecord, options: { silent?: boolean } = {}): Promise<void> {
  if (!state.client) return;
  resetObjectUrls();
  state.selectedFile = file;
  state.preview = { path: file.path, kind: fileKind(file.path) };
  if (!options.silent) {
    state.loading = true;
    state.error = undefined;
    render();
  }

  try {
    const blob = await state.client.downloadFile(file);
    const kind = fileKind(file.path);
    if (kind === "text") {
      state.preview = {
        path: file.path,
        kind,
        text: await blob.text(),
      };
    } else {
      state.preview = {
        path: file.path,
        kind,
        url: URL.createObjectURL(blob),
      };
    }
  } catch (error) {
    state.error = messageFor(error);
  } finally {
    state.loading = false;
    render();
  }
}

async function downloadSelectedFile(): Promise<void> {
  if (!state.client || !state.selectedFile) return;
  state.error = undefined;
  try {
    const blob = await state.client.downloadFile(state.selectedFile);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName(state.selectedFile.path);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    state.error = messageFor(error);
    render();
  }
}

function renderLogin(): string {
  const saved = state.session ?? loadSession();
  return `
    <main class="login-shell">
      <section class="login-panel" aria-labelledby="login-title">
        <p class="eyebrow">Private device access</p>
        <h1 id="login-title">Agent Vault</h1>
        <p class="login-copy">Connect this phone with a scoped device token and send files into the private vault.</p>
        <form id="login-form" class="login-form">
          <label>
            Server URL
            <input id="server-url" name="serverUrl" type="url" required placeholder="${escapeHtml(defaultServerUrl())}" value="${escapeHtml(saved?.serverUrl ?? defaultServerUrl())}" />
          </label>
          <label>
            Device token
            <input id="device-token" name="token" type="password" autocomplete="current-password" required placeholder="Paste phone token" value="${escapeHtml(saved?.token ?? "")}" />
          </label>
          <button class="primary-action" type="submit" ${state.loading ? "disabled" : ""}>${state.loading ? "Connecting" : "Connect"}</button>
        </form>
        ${renderNotice()}
      </section>
    </main>
  `;
}

function renderNotice(): string {
  if (state.error) {
    return `<p class="notice error" role="alert">${escapeHtml(state.error)}</p>`;
  }
  if (state.message) {
    return `<p class="notice success">${escapeHtml(state.message)}</p>`;
  }
  return "";
}

function renderSpaceTabs(): string {
  return `
    <nav class="space-tabs" aria-label="Vault spaces">
      ${state.spaces
        .map(
          (space) => `
          <button class="space-tab ${space.name === state.activeSpace ? "active" : ""}" type="button" data-space="${escapeHtml(space.name)}">
            <span>${escapeHtml(space.name)}</span>
            <small>${escapeHtml(space.permissions.join("/"))}</small>
          </button>
        `,
        )
        .join("")}
    </nav>
  `;
}

function renderUpload(): string {
  const writable = can("write");
  return `
    <section class="upload-zone" aria-labelledby="upload-title">
      <div>
        <p class="eyebrow">Phone inbox</p>
        <h2 id="upload-title">Upload to ${escapeHtml(state.activeSpace)}</h2>
      </div>
      <form id="upload-form" class="upload-form">
        <label>
          Target folder
          <input id="target-folder" name="targetFolder" type="text" value="${escapeHtml(state.targetFolder)}" autocomplete="off" ${writable ? "" : "disabled"} />
        </label>
        <label class="file-picker ${writable ? "" : "disabled"}">
          <span>${writable ? "Choose photo, PDF or file" : "Read-only space"}</span>
          <input id="file-input" name="file" type="file" ${writable ? "" : "disabled"} />
        </label>
      </form>
      ${
        state.uploading
          ? `<div class="progress-track" aria-label="Upload progress"><span style="width: ${state.uploadProgress}%"></span></div>`
          : ""
      }
    </section>
  `;
}

function renderFileList(): string {
  const rows = state.files
    .map(
      (file) => `
        <button class="file-row ${state.selectedFile?.id === file.id ? "selected" : ""}" type="button" data-file-id="${escapeHtml(file.id)}">
          <span class="file-name">${escapeHtml(fileName(file.path))}</span>
          <span class="file-path">${escapeHtml(file.path)}</span>
          <span class="file-meta">${escapeHtml(formatBytes(file.size))} - v${file.currentVersion} - ${escapeHtml(formatDate(file.updatedAt))}</span>
        </button>
      `,
    )
    .join("");

  return `
    <section class="file-list" aria-labelledby="files-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">${state.files.length} files</p>
          <h2 id="files-title">${escapeHtml(state.activeSpace)}</h2>
        </div>
        <button id="refresh-files" class="quiet-action" type="button" ${state.loading ? "disabled" : ""}>Refresh</button>
      </div>
      <div class="file-rows">${rows || `<p class="empty-state">No files in this space yet.</p>`}</div>
    </section>
  `;
}

function renderPreview(): string {
  const file = state.selectedFile;
  if (!file) {
    return `
      <section class="preview-pane" aria-labelledby="preview-title">
        <h2 id="preview-title">Preview</h2>
        <p class="empty-state">Select or upload a file to preview it here.</p>
      </section>
    `;
  }

  let content = `<p class="empty-state">Preview is loading.</p>`;
  if (state.preview?.path === file.path) {
    if (state.preview.kind === "image" && state.preview.url) {
      content = `<img class="image-preview" src="${escapeHtml(state.preview.url)}" alt="${escapeHtml(fileName(file.path))} preview" />`;
    } else if (state.preview.kind === "pdf" && state.preview.url) {
      content = `<iframe class="pdf-preview" src="${escapeHtml(state.preview.url)}" title="${escapeHtml(fileName(file.path))} PDF preview"></iframe>`;
    } else if (state.preview.kind === "text") {
      content = `<pre class="text-preview">${escapeHtml(state.preview.text ?? "")}</pre>`;
    } else {
      content = `<p class="empty-state">This file can be downloaded from the vault.</p>`;
    }
  }

  return `
    <section class="preview-pane" aria-labelledby="preview-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">Preview</p>
          <h2 id="preview-title">${escapeHtml(fileName(file.path))}</h2>
        </div>
        <button id="download-file" class="quiet-action" type="button">Download</button>
      </div>
      <p class="file-path preview-path">${escapeHtml(file.path)}</p>
      <div class="preview-surface">${content}</div>
    </section>
  `;
}

function renderVault(): string {
  return `
    <main class="vault-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Agent Vault</p>
          <h1>${escapeHtml(state.activeSpace)}</h1>
        </div>
        <div class="device-pill">
          <span>${escapeHtml(state.deviceName ?? "phone")}</span>
          <button id="logout" type="button">Logout</button>
        </div>
      </header>
      ${renderSpaceTabs()}
      ${renderNotice()}
      <div class="workspace">
        <div class="left-rail">
          ${renderUpload()}
          ${renderFileList()}
        </div>
        ${renderPreview()}
      </div>
    </main>
  `;
}

function render(): void {
  appRoot.innerHTML = state.session && state.client ? renderVault() : renderLogin();
  bindEvents();
}

function bindEvents(): void {
  document.querySelector<HTMLFormElement>("#login-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    void connect({
      serverUrl: String(form.get("serverUrl") ?? "").trim(),
      token: String(form.get("token") ?? "").trim(),
    });
  });

  document.querySelector<HTMLButtonElement>("#logout")?.addEventListener("click", () => {
    clearSession();
    render();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-space]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextSpace = button.dataset.space;
      if (!nextSpace || nextSpace === state.activeSpace) return;
      state.activeSpace = nextSpace;
      state.selectedFile = undefined;
      state.preview = undefined;
      void refreshFiles();
    });
  });

  document.querySelector<HTMLInputElement>("#target-folder")?.addEventListener("input", (event) => {
    state.targetFolder = (event.currentTarget as HTMLInputElement).value;
  });

  document.querySelector<HTMLInputElement>("#file-input")?.addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      void uploadSelectedFile(file);
      input.value = "";
    }
  });

  document.querySelector<HTMLButtonElement>("#refresh-files")?.addEventListener("click", () => {
    void refreshFiles();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-file-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const file = state.files.find((item) => item.id === button.dataset.fileId);
      if (file) {
        void loadPreview(file);
      }
    });
  });

  document.querySelector<HTMLButtonElement>("#download-file")?.addEventListener("click", () => {
    void downloadSelectedFile();
  });
}

async function bootstrap(): Promise<void> {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }

  const session = loadSession();
  if (session) {
    await connect(session);
    return;
  }
  render();
}

void bootstrap();
