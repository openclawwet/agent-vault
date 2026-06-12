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
  assert(html.includes("view-schema"), "desktop UI HTML missing schema view");
  assert(html.includes("dropSurface"), "desktop UI HTML missing global drop surface");
  assert(html.includes('id="devices"'), "desktop UI HTML missing devices section");
  assert(html.includes('id="flow"'), "desktop UI HTML missing flow section");
  assert(html.includes('id="folderBrowser"'), "desktop UI HTML missing Finder-style folder browser");
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
