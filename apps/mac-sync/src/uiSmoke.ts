import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  const files = await fetch(`${startedVault.url}/spaces/MacBook%20Shared/files`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(files.ok, "vault file list failed");
  const filesJson = await expectJson(files);
  const listed = filesJson.files as Array<{ path: string }> | undefined;
  assert(listed?.some((file) => file.path === "Client Docs/brief.txt"), "shared file was not uploaded under prefix on add");

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

  const summary = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/summary`);
  assert(summary.ok, "summary failed");
  const summaryJson = await expectJson(summary);
  const activity = summaryJson.activity as unknown[] | undefined;
  assert(activity?.length, "activity log should include share work");

  console.log("Agent Vault desktop UI smoke passed.");
} finally {
  if (startedUi) await startedUi.close();
  await startedVault.close();
  await rm(tempRoot, { recursive: true, force: true });
}
