import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAgentVaultServer } from "@agent-vault/server";
import type { DeviceScopeRecord } from "@agent-vault/core";
import { initConfig } from "./config.js";
import { pullCommand, pushCommand } from "./syncCommands.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function createDevice(serverUrl: string, adminToken: string, name: string, scopes: DeviceScopeRecord[]): Promise<string> {
  const response = await fetch(`${serverUrl}/devices`, {
    method: "POST",
    headers: {
      ...auth(adminToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, scopes }),
  });
  assert(response.status === 201, `${name} device create failed with ${response.status}`);
  const body = await expectJson(response);
  assert(typeof body.token === "string", `${name} token missing`);
  return body.token;
}

async function upload(serverUrl: string, token: string, space: string, filePath: string, body: string, key: string): Promise<void> {
  const response = await fetch(`${serverUrl}/spaces/${encodeURIComponent(space)}/file?path=${encodeURIComponent(filePath)}`, {
    method: "PUT",
    headers: {
      ...auth(token),
      "idempotency-key": key,
    },
    body: Buffer.from(body),
  });
  assert(response.status === 201, `upload ${space}/${filePath} failed with ${response.status}`);
}

async function downloadText(serverUrl: string, token: string, space: string, filePath: string): Promise<string> {
  const response = await fetch(`${serverUrl}/spaces/${encodeURIComponent(space)}/file?path=${encodeURIComponent(filePath)}`, {
    headers: auth(token),
  });
  assert(response.ok, `download ${space}/${filePath} failed with ${response.status}`);
  return Buffer.from(await response.arrayBuffer()).toString("utf8");
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-vault-three-device-"));
const adminToken = `qa-${randomBytes(16).toString("hex")}`;
const started = await startAgentVaultServer({
  host: "127.0.0.1",
  port: 0,
  homeDir: path.join(tempRoot, "server-home"),
  storageRoot: path.join(tempRoot, "storage"),
  dbPath: path.join(tempRoot, "agent-vault.sqlite"),
  token: adminToken,
});

try {
  const macbookToken = await createDevice(started.url, adminToken, "macbook-qa", [
    { space: "MacBook Shared", permissions: ["read", "write", "delete"] },
  ]);
  const phoneToken = await createDevice(started.url, adminToken, "phone-qa", [
    { space: "Inbox", permissions: ["read", "write"] },
    { space: "Projects", permissions: ["read"] },
  ]);
  const agentDeskToken = await createDevice(started.url, adminToken, "agent-desk-qa", [
    { space: "Inbox", permissions: ["read"] },
    { space: "Agent Drafts", permissions: ["read"] },
    { space: "Approvals", permissions: ["read"] },
  ]);

  const localDir = path.join(tempRoot, "AgentVault");
  const { config } = await initConfig({
    serverUrl: started.url,
    token: macbookToken,
    localDir,
    space: "MacBook Shared",
    configPath: path.join(tempRoot, "mac-sync.json"),
  });

  await writeFile(path.join(localDir, "site-copy.txt"), "from macbook\n");
  const pushed = await pushCommand(config);
  assert(pushed.pushed === 1, "MacBook push should upload one file");

  await upload(started.url, adminToken, "MacBook Shared", "site-copy.txt", "edited on mac mini\n", "qa-mini-edit");
  const pulled = await pullCommand(config);
  assert(pulled.pulled === 1, "Mac Mini edit should pull back to MacBook folder");
  assert(
    (await readFile(path.join(localDir, "site-copy.txt"), "utf8")) === "edited on mac mini\n",
    "Mac Mini edit roundtrip mismatch",
  );

  await upload(started.url, phoneToken, "Inbox", "phone/note.txt", "from phone\n", "qa-phone-upload");
  const phoneDownload = await downloadText(started.url, phoneToken, "Inbox", "phone/note.txt");
  assert(phoneDownload === "from phone\n", "phone upload did not roundtrip");

  const archiveDenied = await fetch(`${started.url}/spaces/Archive/files`, { headers: auth(phoneToken) });
  assert(archiveDenied.status === 403, "phone token should not read Archive");

  const readOnlyWriteDenied = await fetch(
    `${started.url}/spaces/Inbox/file?path=${encodeURIComponent("agent-desk-write-denied.txt")}`,
    {
      method: "PUT",
      headers: { ...auth(agentDeskToken), "idempotency-key": "qa-agent-desk-denied" },
      body: Buffer.from("should not write"),
    },
  );
  assert(readOnlyWriteDenied.status === 403, "Agent Desk read-only token should not write");

  const agentDeskSpaces = await fetch(`${started.url}/spaces`, { headers: auth(agentDeskToken) });
  assert(agentDeskSpaces.ok, "Agent Desk spaces should be readable");
  const agentDeskSpacesJson = await expectJson(agentDeskSpaces);
  const visibleSpaces = (agentDeskSpacesJson.spaces as Array<{ name: string }> | undefined)?.map((space) => space.name) ?? [];
  assert(visibleSpaces.join(",") === "Agent Drafts,Approvals,Inbox", "Agent Desk visible spaces mismatch");

  const deleted = await fetch(`${started.url}/spaces/Inbox/file?path=${encodeURIComponent("phone/note.txt")}`, {
    method: "DELETE",
    headers: { ...auth(adminToken), "idempotency-key": "qa-trash" },
  });
  assert(deleted.ok, "trash delete failed");
  const deletedDownload = await fetch(`${started.url}/spaces/Inbox/file?path=${encodeURIComponent("phone/note.txt")}`, {
    headers: auth(phoneToken),
  });
  assert(deletedDownload.status === 404, "deleted phone upload should not download");
  const restored = await fetch(`${started.url}/spaces/Inbox/file/restore?path=${encodeURIComponent("phone/note.txt")}&version=1`, {
    method: "POST",
    headers: { ...auth(adminToken), "idempotency-key": "qa-restore" },
  });
  assert(restored.ok, "restore failed");
  assert((await downloadText(started.url, phoneToken, "Inbox", "phone/note.txt")) === "from phone\n", "restore bytes mismatch");

  await writeFile(path.join(localDir, "site-copy.txt"), "local parallel edit\n");
  await upload(started.url, adminToken, "MacBook Shared", "site-copy.txt", "remote parallel edit\n", "qa-parallel-edit");
  const conflictPull = await pullCommand(config);
  assert(conflictPull.conflicts === 1, "parallel edit should materialize a conflict");
  const conflictFiles = await readdir(path.join(localDir, ".agent-vault", "conflicts"));
  assert(conflictFiles.some((file) => file.endsWith("site-copy.txt.json")), "conflict review file missing");

  console.log("Agent Vault three-device QA smoke passed.");
} finally {
  await started.close();
  await rm(tempRoot, { recursive: true, force: true });
}
