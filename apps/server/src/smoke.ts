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
  const space = "Inbox";
  const payload = Buffer.from("hello from agent vault\n");
  const updatedPayload = Buffer.from("hello from agent vault v2\n");
  const filePath = "notes/hello.txt";

  const health = await fetch(`${started.url}/health`);
  assert(health.ok, "health endpoint failed");

  const unauthenticated = await fetch(`${started.url}/spaces/${space}/files`);
  assert(unauthenticated.status === 401, "list endpoint should require auth");

  const spaces = await fetch(`${started.url}/spaces`, { headers: auth });
  assert(spaces.ok, "spaces endpoint failed");
  const spacesJson = await expectJson(spaces);
  const spaceList = spacesJson.spaces as Array<{ name: string }> | undefined;
  assert(spaceList?.some((item) => item.name === "MacBook Shared"), "default spaces missing");

  const deviceCreate = await fetch(`${started.url}/devices`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      name: "macbook",
      scopes: [{ space, permissions: ["read", "write"] }],
    }),
  });
  assert(deviceCreate.status === 201, "device create failed");
  const deviceJson = await expectJson(deviceCreate);
  const macbookToken = deviceJson.token as string | undefined;
  const macbookDevice = deviceJson.device as { id?: string } | undefined;
  assert(macbookToken && macbookDevice?.id, "device token or id missing");
  const macbookAuth = { authorization: `Bearer ${macbookToken}` };

  const upload = await fetch(`${started.url}/spaces/${space}/file?path=${encodeURIComponent(filePath)}`, {
    method: "PUT",
    headers: { ...macbookAuth, "idempotency-key": "smoke-create" },
    body: payload,
  });
  assert(upload.status === 201, `upload failed with ${upload.status}`);
  const uploadJson = await expectJson(upload);
  const uploadedFile = uploadJson.file as { sha256?: string; size?: number; path?: string } | undefined;
  assert(uploadedFile?.path === filePath, "uploaded metadata path mismatch");
  assert(uploadedFile?.size === payload.byteLength, "uploaded metadata size mismatch");
  assert(typeof uploadedFile.sha256 === "string", "uploaded metadata hash missing");
  const baseHash = uploadedFile.sha256;

  const retryUpload = await fetch(`${started.url}/spaces/${space}/file?path=${encodeURIComponent(filePath)}`, {
    method: "PUT",
    headers: { ...macbookAuth, "idempotency-key": "smoke-create" },
    body: payload,
  });
  assert(retryUpload.status === 201, "idempotent retry should return original status");
  const retryJson = await expectJson(retryUpload);
  const retryFile = retryJson.file as { currentVersion?: number } | undefined;
  assert(retryFile?.currentVersion === 1, "idempotent retry should not create a second version");

  const deniedSpace = await fetch(`${started.url}/spaces/Archive/files`, { headers: macbookAuth });
  assert(deniedSpace.status === 403, "device should not read outside scoped space");

  const scopedSpaces = await fetch(`${started.url}/spaces`, { headers: macbookAuth });
  assert(scopedSpaces.ok, "scoped spaces endpoint failed");
  const scopedSpacesJson = await expectJson(scopedSpaces);
  const scopedSpaceList = scopedSpacesJson.spaces as Array<{ name: string; permissions: string[] }> | undefined;
  assert(scopedSpaceList?.length === 1, "device should only see scoped spaces");
  assert(scopedSpaceList?.[0]?.name === space, "scoped space name mismatch");
  assert(scopedSpaceList?.[0]?.permissions.includes("write"), "scoped space permissions missing");

  const deniedDelete = await fetch(`${started.url}/spaces/${space}/file?path=${encodeURIComponent(filePath)}`, {
    method: "DELETE",
    headers: macbookAuth,
  });
  assert(deniedDelete.status === 403, "device without delete scope should not delete");

  const rotate = await fetch(`${started.url}/devices/${macbookDevice.id}/rotate`, {
    method: "POST",
    headers: auth,
  });
  assert(rotate.ok, "device rotate failed");
  const rotateJson = await expectJson(rotate);
  const rotatedToken = rotateJson.token as string | undefined;
  assert(rotatedToken && rotatedToken !== macbookToken, "rotated token missing");
  const oldTokenCheck = await fetch(`${started.url}/spaces/${space}/files`, { headers: macbookAuth });
  assert(oldTokenCheck.status === 401, "old rotated token should be invalid");
  const rotatedAuth = { authorization: `Bearer ${rotatedToken}` };

  const update = await fetch(`${started.url}/spaces/${space}/file?path=${encodeURIComponent(filePath)}`, {
    method: "PUT",
    headers: { ...rotatedAuth, "idempotency-key": "smoke-update" },
    body: updatedPayload,
  });
  assert(update.status === 201, `update failed with ${update.status}`);
  const updateJson = await expectJson(update);
  const updatedFile = updateJson.file as { currentVersion?: number; size?: number } | undefined;
  assert(updatedFile?.currentVersion === 2, "update should create version 2");
  assert(updatedFile?.size === updatedPayload.byteLength, "updated metadata size mismatch");

  const list = await fetch(`${started.url}/spaces/${space}/files`, { headers: rotatedAuth });
  assert(list.ok, "list endpoint failed");
  const listJson = await expectJson(list);
  const files = listJson.files as Array<{ path: string }> | undefined;
  assert(files?.some((file) => file.path === filePath), "uploaded file missing from list");

  const download = await fetch(`${started.url}/spaces/${space}/file?path=${encodeURIComponent(filePath)}`, {
    headers: rotatedAuth,
  });
  assert(download.ok, "download endpoint failed");
  const downloaded = Buffer.from(await download.arrayBuffer());
  assert(downloaded.equals(updatedPayload), "downloaded bytes differ from latest uploaded bytes");

  const auditAfterUpdate = await fetch(`${started.url}/spaces/${space}/audit`, { headers: auth });
  assert(auditAfterUpdate.ok, "audit endpoint failed");
  const auditJson = await expectJson(auditAfterUpdate);
  const auditEvents = auditJson.events as Array<{ operation: string; path: string; version: number }> | undefined;
  assert(auditEvents?.some((event) => event.operation === "upload" && event.path === filePath && event.version === 1), "upload audit missing");
  assert(auditEvents?.some((event) => event.operation === "update" && event.path === filePath && event.version === 2), "update audit missing");

  const deleted = await fetch(`${started.url}/spaces/${space}/file?path=${encodeURIComponent(filePath)}`, {
    method: "DELETE",
    headers: auth,
  });
  assert(deleted.ok, "delete endpoint failed");

  const deletedDownload = await fetch(`${started.url}/spaces/${space}/file?path=${encodeURIComponent(filePath)}`, {
    headers: rotatedAuth,
  });
  assert(deletedDownload.status === 404, "deleted file should not download");

  const restore = await fetch(`${started.url}/spaces/${space}/file/restore?path=${encodeURIComponent(filePath)}&version=1`, {
    method: "POST",
    headers: auth,
  });
  assert(restore.ok, "restore endpoint failed");

  const restoredDownload = await fetch(`${started.url}/spaces/${space}/file?path=${encodeURIComponent(filePath)}`, {
    headers: rotatedAuth,
  });
  assert(restoredDownload.ok, "restored file should download");
  const restoredBytes = Buffer.from(await restoredDownload.arrayBuffer());
  assert(restoredBytes.equals(payload), "restored version bytes differ from version 1");

  const move = await fetch(
    `${started.url}/spaces/${space}/file/move?from=${encodeURIComponent(filePath)}&to=${encodeURIComponent("notes/moved.txt")}`,
    {
      method: "POST",
      headers: auth,
    },
  );
  assert(move.ok, "move endpoint failed");

  const changes = await fetch(`${started.url}/spaces/${space}/changes?since=0`, { headers: rotatedAuth });
  assert(changes.ok, "changes endpoint failed");
  const changesJson = await expectJson(changes);
  const changeEvents = changesJson.changes as Array<{ seq: number; operation: string; path: string; previousPath?: string | null }> | undefined;
  assert(changeEvents?.some((event) => event.operation === "create" && event.path === filePath), "create change missing");
  assert(changeEvents?.some((event) => event.operation === "update" && event.path === filePath), "update change missing");
  assert(changeEvents?.some((event) => event.operation === "delete" && event.path === filePath), "delete change missing");
  assert(changeEvents?.some((event) => event.operation === "restore" && event.path === filePath), "restore change missing");
  const moveEvent = changeEvents?.find((event) => event.operation === "move");
  assert(moveEvent?.path === "notes/moved.txt" && moveEvent.previousPath === filePath, "move change missing");
  const firstSeq = changeEvents?.[0]?.seq;
  assert(typeof firstSeq === "number", "change sequence missing");

  const continuation = await fetch(`${started.url}/spaces/${space}/changes?since=${firstSeq}`, { headers: rotatedAuth });
  assert(continuation.ok, "change continuation failed");
  const continuationJson = await expectJson(continuation);
  const continuedEvents = continuationJson.changes as Array<{ seq: number }> | undefined;
  assert(continuedEvents?.every((event) => event.seq > firstSeq), "change continuation returned old events");

  const traversal = await fetch(`${started.url}/spaces/${space}/file?path=${encodeURIComponent("../escape.txt")}`, {
    method: "PUT",
    headers: auth,
    body: Buffer.from("nope"),
  });
  assert(traversal.status === 400, "path traversal upload should be rejected");

  const authAudit = await fetch(`${started.url}/spaces/system/audit`, { headers: auth });
  assert(authAudit.ok, "system audit endpoint failed");
  const authAuditJson = await expectJson(authAudit);
  const authEvents = authAuditJson.events as Array<{ operation: string }> | undefined;
  assert(authEvents?.some((event) => event.operation === "auth_failed"), "auth failure audit missing");

  assert(baseHash, "base hash missing");
  const storedPath = path.join(tempRoot, "storage", "spaces", space, "notes", "moved.txt");
  const storedBytes = await readFile(storedPath);
  assert(storedBytes.equals(payload), "stored file bytes differ from uploaded bytes");
  await stat(path.join(tempRoot, "agent-vault.sqlite"));

  console.log("Agent Vault local tracer smoke passed.");
} finally {
  await started.close();
  await rm(tempRoot, { recursive: true, force: true });
}
