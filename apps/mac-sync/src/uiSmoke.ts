import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAgentVaultServer } from "@agent-vault/server";
import { initConfig } from "./config.js";
import { startDesktopUi } from "./uiServer.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-vault-ui-"));
process.env.AGENT_VAULT_SHARES_CONFIG = path.join(tempRoot, "shares.json");
process.env.AGENT_VAULT_ACTIVITY_LOG = path.join(tempRoot, "activity.jsonl");
process.env.AGENT_VAULT_DOWNLOAD_DIR = path.join(tempRoot, "downloads");
process.env.AGENT_VAULT_EDIT_DIR = path.join(tempRoot, "edits");
process.env.AGENT_VAULT_PREFERENCES = path.join(tempRoot, "preferences.json");

const token = `ui-${randomBytes(16).toString("hex")}`;
const startedVault = await startAgentVaultServer({
  host: "127.0.0.1",
  port: 0,
  homeDir: path.join(tempRoot, "server-home"),
  storageRoot: path.join(tempRoot, "storage"),
  dbPath: path.join(tempRoot, "agent-vault.sqlite"),
  token,
});

let startedUi: Awaited<ReturnType<typeof startDesktopUi>> | undefined;

try {
  const localDir = path.join(tempRoot, "AgentVault");
  const sharedDir = path.join(tempRoot, "Client Docs");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(sharedDir, { recursive: true });
  await writeFile(path.join(sharedDir, "brief.txt"), "client brief\n");

  const { config } = await initConfig({
    serverUrl: startedVault.url,
    token,
    localDir,
    space: "MacBook Shared",
    configPath: path.join(tempRoot, "mac-sync.json"),
  });

  startedUi = await startDesktopUi(config, { port: 0, open: false });
  const page = await fetch(startedUi.url);
  assert(page.ok, "desktop UI page failed");
  const html = await page.text();
  assert(html.includes("Agent Vault"), "desktop UI HTML missing product name");
  assert(html.includes("dropSurface"), "desktop UI HTML missing global drop surface");
  assert(html.includes('id="devices"'), "desktop UI HTML missing devices section");
  assert(html.includes('id="flow"'), "desktop UI HTML missing flow section");
  assert(html.includes('class="vault-sidebar"'), "desktop UI HTML missing connected device sidebar");
  assert(html.includes('id="folderBrowser"'), "desktop UI HTML missing Finder-style folder browser");
  assert(html.includes('data-view="schema"'), "desktop UI HTML missing schema view switch");
  assert(html.includes('data-view-mode="grid"'), "desktop UI HTML missing icon view mode");
  assert(html.includes('data-view-mode="large"'), "desktop UI HTML missing large icon view mode");
  assert(html.includes('data-view-mode="list"'), "desktop UI HTML missing list view mode");
  assert(html.includes('data-device-filter="macbook"'), "desktop UI HTML missing MacBook filter");
  assert(html.includes('data-device-filter="mac-mini"'), "desktop UI HTML missing Mac Mini filter");
  assert(html.includes('data-detail-toggle="true"'), "desktop UI HTML missing details toggle");
  assert(html.includes('id="folderNew"'), "desktop UI HTML missing in-folder create action");
  assert(html.includes("/api/folder-entries"), "desktop UI HTML missing lazy folder entries endpoint");
  assert(html.includes('data-file-action="open"'), "desktop UI HTML missing file open action");
  assert(html.includes('data-file-action="download"'), "desktop UI HTML missing file download action");
  assert(html.includes("activateFolderEntry"), "desktop UI HTML missing Finder-style entry activation");
  assert(html.includes('data-source-device'), "desktop UI HTML missing source device marking");
  assert(html.includes("data-download-path"), "desktop UI HTML missing file download action");
  assert(html.includes("DownloadURL"), "desktop UI HTML missing drag-out download payload");
  assert(html.includes('id="saveEdits"'), "desktop UI HTML missing edit writeback action");
  assert(html.includes('id="autoSyncToggle"'), "desktop UI HTML missing auto-sync toggle");
  assert(html.includes("/api/edit-remote"), "desktop UI HTML missing editable remote file flow");
  assert(html.includes("/api/writeback-edits"), "desktop UI HTML missing writeback flow");
  assert(html.includes("/api/preferences"), "desktop UI HTML missing preferences flow");
  assert(html.includes("__agentVaultCurrentDropTarget"), "desktop UI HTML missing contextual drop target");
  assert(html.includes('effectAllowed = "copy"'), "desktop UI HTML missing copy-safe drag-out");
  assert(!html.includes('run("startup")'), "desktop UI should not schedule startup sync");
  assert(!html.includes("remote poll"), "desktop UI should not schedule remote poll sync");
  assert(html.includes("agentVault.schema.nodePositions"), "desktop UI HTML missing draggable schema persistence");
  assert(html.includes('id="layoutReset"'), "desktop UI HTML missing schema layout reset");
  assert(html.includes("refresh({ silent: true })"), "desktop UI HTML missing quiet auto-refresh");
  assert(!html.includes("nav-float"), "desktop UI should not render a left view rail");
  assert(!html.includes("shared sources"), "desktop UI should not render a separate source headline above the grid");
  assert(!html.includes('id="treeSection"'), "desktop UI should not render a separate tree inspector");
  assert(!html.includes('data-side-mode'), "desktop UI should not render a tree/system switch");
  assert(!html.includes('id="shares"'), "desktop UI should not render a separate source column");
  assert(!html.includes('class="side"'), "desktop UI should not render a side panel beside the Finder grid");
  assert(!html.includes('id="openFolder"'), "desktop UI should not render the old top open button");
  assert(!html.includes("dropzone"), "desktop UI should not render the old dropzone");

  const addShare = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: sharedDir,
      label: "Client Docs",
      space: "MacBook Shared",
      remotePathPrefix: "Client Docs",
    }),
  });
  assert(addShare.status === 201, `share create failed with ${addShare.status}`);
  const shareJson = await expectJson(addShare);
  const share = shareJson.share as { id?: string } | undefined;
  assert(share?.id, "share id missing");

  const disableAutoSync = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/preferences`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autoSyncEnabled: false }),
  });
  assert(disableAutoSync.status === 200, `auto-sync preference update failed with ${disableAutoSync.status}`);
  const disabledJson = await expectJson(disableAutoSync);
  const disabledPreferences = disabledJson.preferences as { autoSyncEnabled?: boolean } | undefined;
  assert(disabledPreferences?.autoSyncEnabled === false, "auto-sync preference was not disabled");

  const enableAutoSync = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/preferences`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autoSyncEnabled: true }),
  });
  assert(enableAutoSync.status === 200, `auto-sync preference re-enable failed with ${enableAutoSync.status}`);

  const updateShare = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/shares/${share.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access: "readonly" }),
  });
  assert(updateShare.status === 200, `share permission update failed with ${updateShare.status}`);
  const updatedShareJson = await expectJson(updateShare);
  const updatedShare = updatedShareJson.share as { access?: string } | undefined;
  assert(updatedShare?.access === "readonly", "share permission was not updated");

  const files = await fetch(`${startedVault.url}/spaces/MacBook%20Shared/files`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(files.ok, "vault file list failed");
  const filesJson = await expectJson(files);
  const listed = filesJson.files as Array<{ path: string }> | undefined;
  assert(listed?.some((file) => file.path === "Client Docs/brief.txt"), "shared file was not uploaded under prefix on add");

  const download = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/download-remote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ space: "MacBook Shared", path: "Client Docs/brief.txt", reveal: false }),
  });
  assert(download.status === 200, `remote file download failed with ${download.status}`);
  const downloadJson = await expectJson(download);
  const downloaded = downloadJson.download as { targetPath?: string; size?: number } | undefined;
  assert(downloaded?.targetPath, "download target path missing");
  assert(downloaded.size === "client brief\n".length, "downloaded size mismatch");
  assert((await readFile(downloaded.targetPath, "utf8")) === "client brief\n", "downloaded file content mismatch");

  const folderEntries = await fetch(
    `${startedUi.url.replace(/\/desktop$/, "")}/api/folder-entries?space=MacBook%20Shared&prefix=Client%20Docs&folder=`,
  );
  assert(folderEntries.status === 200, `folder entries failed with ${folderEntries.status}`);
  const folderEntriesJson = await expectJson(folderEntries);
  const entries = folderEntriesJson.entries as Array<{ name?: string; kind?: string; size?: number }> | undefined;
  assert(entries?.some((entry) => entry.name === "brief.txt" && entry.kind === "file"), "folder entries should include shared file");

  const folder = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/shares/${share.id}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Research Notes" }),
  });
  assert(folder.status === 201, `shared folder marker failed with ${folder.status}`);
  const markerFiles = await fetch(`${startedVault.url}/spaces/MacBook%20Shared/files`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const markerJson = await expectJson(markerFiles);
  const markerListed = markerJson.files as Array<{ path: string }> | undefined;
  assert(
    markerListed?.some((file) => file.path === "Client Docs/Research Notes/.agent-vault-folder"),
    "shared empty folder marker was not uploaded",
  );

  const droppedFile = path.join(tempRoot, "drop-note.txt");
  await writeFile(droppedFile, "targeted native drop\n");
  const targetedIngest = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/ingest-paths`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: [droppedFile], target: { space: "MacBook Shared", pathPrefix: "Client Docs/Research Notes" } }),
  });
  assert(targetedIngest.status === 201, `targeted file ingest failed with ${targetedIngest.status}`);
  const targetedFiles = await fetch(`${startedVault.url}/spaces/MacBook%20Shared/files`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const targetedJson = await expectJson(targetedFiles);
  const targetedListed = targetedJson.files as Array<{ path: string }> | undefined;
  assert(
    targetedListed?.some((file) => file.path === "Client Docs/Research Notes/drop-note.txt"),
    "targeted dropped file was not uploaded into the open folder path",
  );

  const edit = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/edit-remote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ space: "MacBook Shared", path: "Client Docs/brief.txt" }),
  });
  assert(edit.status === 200, `edit remote failed with ${edit.status}`);
  const editJson = await expectJson(edit);
  const editSession = editJson.edit as { targetPath?: string } | undefined;
  assert(editSession?.targetPath, "editable target path missing");
  await writeFile(editSession.targetPath, "edited client brief\n");
  const writeback = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/writeback-edits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert(writeback.status === 200, `writeback failed with ${writeback.status}`);
  const writebackJson = await expectJson(writeback);
  const writebackResult = writebackJson.writeback as { uploaded?: number; conflicts?: number } | undefined;
  assert(writebackResult?.uploaded === 1 && writebackResult.conflicts === 0, "writeback should upload edited copy without conflict");
  const editedDownload = await fetch(`${startedVault.url}/spaces/MacBook%20Shared/file?path=${encodeURIComponent("Client Docs/brief.txt")}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert((await editedDownload.text()) === "edited client brief\n", "edited remote file content mismatch");

  const versions = await fetch(
    `${startedVault.url}/spaces/MacBook%20Shared/file/versions?path=${encodeURIComponent("Client Docs/brief.txt")}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert(versions.status === 200, `versions failed with ${versions.status}`);
  const versionsJson = await expectJson(versions);
  const versionRows = versionsJson.versions as Array<{ version?: number }> | undefined;
  assert((versionRows?.length ?? 0) >= 2, "version history should include edited writeback");

  const conflictEdit = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/edit-remote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ space: "MacBook Shared", path: "Client Docs/brief.txt" }),
  });
  const conflictJson = await expectJson(conflictEdit);
  const conflictSession = conflictJson.edit as { targetPath?: string } | undefined;
  assert(conflictSession?.targetPath, "conflict edit target path missing");
  await writeFile(conflictSession.targetPath, "local conflict edit\n");
  const remoteUpdate = await fetch(`${startedVault.url}/spaces/MacBook%20Shared/file?path=${encodeURIComponent("Client Docs/brief.txt")}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": "ui-smoke-remote-conflict-update",
    },
    body: "remote parallel edit\n",
  });
  assert(remoteUpdate.status === 201, `remote parallel update failed with ${remoteUpdate.status}`);
  const conflictWriteback = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/writeback-edits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert(conflictWriteback.status === 200, `conflict writeback failed with ${conflictWriteback.status}`);
  const conflictWritebackJson = await expectJson(conflictWriteback);
  const conflictResult = conflictWritebackJson.writeback as { conflicts?: number } | undefined;
  assert((conflictResult?.conflicts ?? 0) >= 1, "parallel edit should create a writeback conflict");

  const droppedDir = path.join(tempRoot, "Dropped Docs");
  await mkdir(droppedDir, { recursive: true });
  await writeFile(path.join(droppedDir, "drop.txt"), "native folder drop\n");
  const ingest = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/ingest-paths`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: [droppedDir] }),
  });
  assert(ingest.status === 201, `native path ingest failed with ${ingest.status}`);

  const summary = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/summary?full=1&pending=1`);
  assert(summary.ok, "summary failed");
  const summaryJson = await expectJson(summary);
  const activity = summaryJson.activity as unknown[] | undefined;
  const server = summaryJson.server as { name?: string; status?: string } | undefined;
  const devices = summaryJson.devices as Array<{ name?: string; status?: string }> | undefined;
  assert(server?.name === "Mac Mini Vault Server" && server.status === "online", "summary should include Mac Mini server presence");
  assert(devices?.some((device) => device.status === "online"), "summary should include online device presence");
  assert(activity?.length, "activity log should include share work");
  const shares = summaryJson.shares as Array<{ label?: string; access?: string; remoteTree?: unknown[] }> | undefined;
  const autoSyncEnabled = summaryJson.autoSyncEnabled as boolean | undefined;
  assert(autoSyncEnabled === true, "summary should expose enabled event-driven auto-sync");
  assert(shares?.some((item) => item.label === "Client Docs" && item.access === "readonly"), "summary should include updated share access");
  assert(shares?.some((item) => item.label === "Dropped Docs"), "summary should include natively dropped folder share");
  assert(shares?.some((item) => Array.isArray(item.remoteTree)), "summary should include tree data");
  const clientDocsTree = shares?.find((item) => item.label === "Client Docs")?.remoteTree as Array<{ name?: string; kind?: string }> | undefined;
  assert(
    clientDocsTree?.some((node) => node.name === "Research Notes" && node.kind === "folder"),
    "empty shared folder marker should render as a folder node",
  );

  console.log("Agent Vault desktop UI smoke passed.");
} finally {
  if (startedUi) await startedUi.close();
  await startedVault.close();
  await rm(tempRoot, { recursive: true, force: true });
}
