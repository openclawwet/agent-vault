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
  assert((await page.text()).includes("Agent Vault"), "desktop UI HTML missing product name");

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

  const sync = await fetch(`${startedUi.url.replace(/\/desktop$/, "")}/api/shares/${share.id}/sync`, { method: "POST" });
  assert(sync.ok, "share sync failed");

  const files = await fetch(`${startedVault.url}/spaces/MacBook%20Shared/files`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(files.ok, "vault file list failed");
  const filesJson = await expectJson(files);
  const listed = filesJson.files as Array<{ path: string }> | undefined;
  assert(listed?.some((file) => file.path === "Client Docs/brief.txt"), "shared file was not uploaded under prefix");

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

