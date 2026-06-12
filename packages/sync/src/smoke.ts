import { planSync } from "./index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const parallel = planSync({
  local: [{ path: "draft.md", hash: "local-new", baseHash: "base" }],
  remote: [{ path: "draft.md", hash: "remote-new" }],
});
assert(parallel[0]?.kind === "conflict", "parallel edits should conflict");

const retryNoop = planSync({
  local: [{ path: "same.md", hash: "same", baseHash: "same" }],
  remote: [{ path: "same.md", hash: "same" }],
});
assert(retryNoop[0]?.kind === "noop", "same hashes should be noop");

const deleteVsUpdate = planSync({
  local: [{ path: "delete.md", hash: null, baseHash: "base", deleted: true }],
  remote: [{ path: "delete.md", hash: "remote-new" }],
});
assert(deleteVsUpdate[0]?.kind === "conflict", "delete versus update should conflict");

const remoteRestore = planSync({
  local: [{ path: "restore.md", hash: null, baseHash: null, deleted: true }],
  remote: [{ path: "restore.md", hash: "old" }],
});
assert(remoteRestore[0]?.kind === "restore", "remote restore should materialize locally");

console.log("Agent Vault sync plan smoke passed.");
