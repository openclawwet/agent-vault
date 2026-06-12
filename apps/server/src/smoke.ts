import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAgentVaultServer } from "./server.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectJson(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  return body;
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-vault-smoke-"));
const token = `smoke-${randomBytes(16).toString("hex")}`;
const started = await startAgentVaultServer({
  host: "127.0.0.1",
  port: 0,
  homeDir: tempRoot,
  storageRoot: path.join(tempRoot, "storage"),
  dbPath: path.join(tempRoot, "agent-vault.sqlite"),
  token,
});

try {
  const auth = { authorization: `Bearer ${token}` };
  const payload = Buffer.from("hello from agent vault\n");
  const updatedPayload = Buffer.from("hello from agent vault v2\n");
  const filePath = "notes/hello.txt";

  const health = await fetch(`${started.url}/health`);
  assert(health.ok, "health endpoint failed");

  const unauthenticated = await fetch(`${started.url}/spaces/default/files`);
  assert(unauthenticated.status === 401, "list endpoint should require auth");

  const upload = await fetch(`${started.url}/spaces/default/file?path=${encodeURIComponent(filePath)}`, {
    method: "PUT",
    headers: auth,
    body: payload,
  });
  assert(upload.status === 201, `upload failed with ${upload.status}`);
  const uploadJson = await expectJson(upload);
  const uploadedFile = uploadJson.file as { sha256?: string; size?: number; path?: string } | undefined;
  assert(uploadedFile?.path === filePath, "uploaded metadata path mismatch");
  assert(uploadedFile?.size === payload.byteLength, "uploaded metadata size mismatch");
  assert(typeof uploadedFile.sha256 === "string", "uploaded metadata hash missing");

  const update = await fetch(`${started.url}/spaces/default/file?path=${encodeURIComponent(filePath)}`, {
    method: "PUT",
    headers: auth,
    body: updatedPayload,
  });
  assert(update.status === 201, `update failed with ${update.status}`);
  const updateJson = await expectJson(update);
  const updatedFile = updateJson.file as { currentVersion?: number; size?: number } | undefined;
  assert(updatedFile?.currentVersion === 2, "update should create version 2");
  assert(updatedFile?.size === updatedPayload.byteLength, "updated metadata size mismatch");

  const list = await fetch(`${started.url}/spaces/default/files`, { headers: auth });
  assert(list.ok, "list endpoint failed");
  const listJson = await expectJson(list);
  const files = listJson.files as Array<{ path: string }> | undefined;
  assert(files?.some((file) => file.path === filePath), "uploaded file missing from list");

  const download = await fetch(`${started.url}/spaces/default/file?path=${encodeURIComponent(filePath)}`, {
    headers: auth,
  });
  assert(download.ok, "download endpoint failed");
  const downloaded = Buffer.from(await download.arrayBuffer());
  assert(downloaded.equals(updatedPayload), "downloaded bytes differ from latest uploaded bytes");

  const auditAfterUpdate = await fetch(`${started.url}/spaces/default/audit`, { headers: auth });
  assert(auditAfterUpdate.ok, "audit endpoint failed");
  const auditJson = await expectJson(auditAfterUpdate);
  const auditEvents = auditJson.events as Array<{ operation: string; path: string; version: number }> | undefined;
  assert(auditEvents?.some((event) => event.operation === "upload" && event.path === filePath && event.version === 1), "upload audit missing");
  assert(auditEvents?.some((event) => event.operation === "update" && event.path === filePath && event.version === 2), "update audit missing");

  const deleted = await fetch(`${started.url}/spaces/default/file?path=${encodeURIComponent(filePath)}`, {
    method: "DELETE",
    headers: auth,
  });
  assert(deleted.ok, "delete endpoint failed");

  const deletedDownload = await fetch(`${started.url}/spaces/default/file?path=${encodeURIComponent(filePath)}`, {
    headers: auth,
  });
  assert(deletedDownload.status === 404, "deleted file should not download");

  const restore = await fetch(`${started.url}/spaces/default/file/restore?path=${encodeURIComponent(filePath)}&version=1`, {
    method: "POST",
    headers: auth,
  });
  assert(restore.ok, "restore endpoint failed");

  const restoredDownload = await fetch(`${started.url}/spaces/default/file?path=${encodeURIComponent(filePath)}`, {
    headers: auth,
  });
  assert(restoredDownload.ok, "restored file should download");
  const restoredBytes = Buffer.from(await restoredDownload.arrayBuffer());
  assert(restoredBytes.equals(payload), "restored version bytes differ from version 1");

  const traversal = await fetch(`${started.url}/spaces/default/file?path=${encodeURIComponent("../escape.txt")}`, {
    method: "PUT",
    headers: auth,
    body: Buffer.from("nope"),
  });
  assert(traversal.status === 400, "path traversal upload should be rejected");

  const storedPath = path.join(tempRoot, "storage", "spaces", "default", "notes", "hello.txt");
  const storedBytes = await readFile(storedPath);
  assert(storedBytes.equals(payload), "stored file bytes differ from uploaded bytes");
  await stat(path.join(tempRoot, "agent-vault.sqlite"));

  console.log("Agent Vault local tracer smoke passed.");
} finally {
  await started.close();
  await rm(tempRoot, { recursive: true, force: true });
}
