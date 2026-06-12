import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAgentVaultServer } from "@agent-vault/server";
import { initConfig } from "./config.js";
import { pullCommand, pushCommand, statusCommand } from "./syncCommands.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-vault-mac-sync-"));
const token = `sync-${randomBytes(16).toString("hex")}`;
const started = await startAgentVaultServer({
  host: "127.0.0.1",
  port: 0,
  homeDir: path.join(tempRoot, "server-home"),
  storageRoot: path.join(tempRoot, "storage"),
  dbPath: path.join(tempRoot, "agent-vault.sqlite"),
  token,
});

try {
  const localDir = path.join(tempRoot, "AgentVault");
  const { config } = await initConfig({
    serverUrl: started.url,
    token,
    localDir,
    space: "Inbox",
    configPath: path.join(tempRoot, "mac-sync.json"),
  });

  await writeFile(path.join(localDir, "hello.txt"), "hello from macbook\n");
  const pushed = await pushCommand(config);
  assert(pushed.pushed === 1, "first push should upload one file");

  await rm(path.join(localDir, "hello.txt"));
  const pulled = await pullCommand(config);
  assert(pulled.pulled === 1, "pull should restore missing local file");
  assert((await readFile(path.join(localDir, "hello.txt"), "utf8")) === "hello from macbook\n", "pulled file mismatch");

  await fetch(`${started.url}/spaces/Inbox/file?path=${encodeURIComponent("hello.txt")}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": "remote-edit" },
    body: Buffer.from("remote edit\n"),
  });
  await pullCommand(config);
  assert((await readFile(path.join(localDir, "hello.txt"), "utf8")) === "remote edit\n", "remote edit should pull");

  await writeFile(path.join(localDir, "hello.txt"), "local edit\n");
  await fetch(`${started.url}/spaces/Inbox/file?path=${encodeURIComponent("hello.txt")}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": "remote-parallel-edit" },
    body: Buffer.from("remote parallel edit\n"),
  });
  const status = await statusCommand(config);
  assert(status.actions.some((action) => action.kind === "conflict"), "parallel edit should be visible as conflict");

  console.log("Agent Vault mac-sync smoke passed.");
} finally {
  await started.close();
  await rm(tempRoot, { recursive: true, force: true });
}
