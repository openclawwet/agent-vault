import { readFile } from "node:fs/promises";
import path from "node:path";
import { planSync } from "@agent-vault/sync";
import type { MacSyncConfig } from "./config.js";
import {
  moveLocalToTrash,
  readState,
  scanLocal,
  writeConflictReview,
  writeLocalFile,
  writeState,
  type LocalFileEntry,
  type SyncState,
} from "./localState.js";
import { VaultClient } from "./vaultClient.js";

export interface SyncSummary {
  pushed: number;
  pulled: number;
  deleted: number;
  conflicts: number;
  scanned: number;
}

function client(config: MacSyncConfig): VaultClient {
  return new VaultClient(config.serverUrl, config.token);
}

function byPath<T extends { path: string }>(entries: T[]): Map<string, T> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function idempotencyKey(config: MacSyncConfig, operation: string, filePath: string, hash?: string): string {
  return `${config.deviceId}:${config.space}:${operation}:${filePath}:${hash ?? "none"}`;
}

async function conflict(localDir: string, filePath: string, details: unknown): Promise<void> {
  await writeConflictReview(localDir, filePath, details);
}

export async function scanCommand(config: MacSyncConfig): Promise<LocalFileEntry[]> {
  return scanLocal(config.localDir);
}

export async function statusCommand(config: MacSyncConfig): Promise<{ actions: ReturnType<typeof planSync> }> {
  const local = await scanLocal(config.localDir);
  const state = await readState(config.localDir);
  const remote = await client(config).listFiles(config.space);
  const actions = planSync({
    local: local.map((entry) => ({
      path: entry.path,
      hash: entry.hash,
      baseHash: state.files[entry.path]?.baseHash ?? null,
    })),
    remote: remote.map((entry) => ({
      path: entry.path,
      hash: entry.sha256,
      version: entry.currentVersion,
    })),
  });
  return { actions };
}

export async function pushCommand(config: MacSyncConfig): Promise<SyncSummary> {
  const vault = client(config);
  const local = await scanLocal(config.localDir);
  const localMap = byPath(local);
  const remote = await vault.listFiles(config.space);
  const remoteMap = byPath(remote);
  const state = await readState(config.localDir);
  const summary: SyncSummary = { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, scanned: local.length };

  for (const [filePath, known] of Object.entries(state.files)) {
    if (localMap.has(filePath)) {
      continue;
    }
    const remoteFile = remoteMap.get(filePath);
    if (!remoteFile) {
      delete state.files[filePath];
      continue;
    }
    if (remoteFile.sha256 !== known.baseHash) {
      summary.conflicts += 1;
      await conflict(config.localDir, filePath, {
        kind: "delete-vs-remote-update",
        localDeleted: true,
        remoteHash: remoteFile.sha256,
        baseHash: known.baseHash,
      });
      continue;
    }
    await vault.delete(config.space, filePath, idempotencyKey(config, "delete", filePath, known.baseHash ?? undefined));
    delete state.files[filePath];
    summary.deleted += 1;
  }

  for (const entry of local) {
    const remoteFile = remoteMap.get(entry.path);
    const baseHash = state.files[entry.path]?.baseHash ?? null;
    const remoteChanged = remoteFile && remoteFile.sha256 !== baseHash;
    const localChanged = entry.hash !== baseHash;

    if (remoteChanged && localChanged && remoteFile.sha256 !== entry.hash) {
      summary.conflicts += 1;
      await conflict(config.localDir, entry.path, {
        kind: "parallel-edit",
        localHash: entry.hash,
        remoteHash: remoteFile.sha256,
        baseHash,
      });
      continue;
    }

    if (!remoteFile || remoteFile.sha256 !== entry.hash) {
      const body = await readFile(path.join(config.localDir, ...entry.path.split("/")));
      const uploaded = await vault.upload(config.space, entry.path, body, idempotencyKey(config, "upload", entry.path, entry.hash));
      state.files[entry.path] = { baseHash: uploaded.sha256 };
      summary.pushed += 1;
    }
  }

  await writeState(config.localDir, state);
  return summary;
}

export async function pullCommand(config: MacSyncConfig): Promise<SyncSummary> {
  const vault = client(config);
  const local = await scanLocal(config.localDir);
  const localMap = byPath(local);
  const remote = await vault.listFiles(config.space);
  const remoteMap = byPath(remote);
  const state = await readState(config.localDir);
  const summary: SyncSummary = { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, scanned: local.length };

  for (const remoteFile of remote) {
    const localFile = localMap.get(remoteFile.path);
    const baseHash = state.files[remoteFile.path]?.baseHash ?? null;
    const localChanged = localFile && localFile.hash !== baseHash;

    if (localChanged && localFile.hash !== remoteFile.sha256) {
      summary.conflicts += 1;
      await conflict(config.localDir, remoteFile.path, {
        kind: "parallel-edit",
        localHash: localFile.hash,
        remoteHash: remoteFile.sha256,
        baseHash,
      });
      continue;
    }

    if (!localFile || localFile.hash !== remoteFile.sha256) {
      const body = await vault.download(config.space, remoteFile.path);
      await writeLocalFile(config.localDir, remoteFile.path, body);
      state.files[remoteFile.path] = { baseHash: remoteFile.sha256 };
      summary.pulled += 1;
    }
  }

  for (const [filePath, known] of Object.entries(state.files)) {
    if (remoteMap.has(filePath)) {
      continue;
    }
    const localFile = localMap.get(filePath);
    if (localFile && localFile.hash === known.baseHash) {
      await moveLocalToTrash(config.localDir, filePath);
      summary.deleted += 1;
    }
    delete state.files[filePath];
  }

  await writeState(config.localDir, state);
  return summary;
}

export async function watchCommand(config: MacSyncConfig): Promise<void> {
  let running = false;
  let queued = false;

  async function runOnce(): Promise<void> {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await pushCommand(config);
      await pullCommand(config);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        setTimeout(() => void runOnce(), 250);
      }
    }
  }

  const fs = await import("node:fs");
  const watcher = fs.watch(config.localDir, { recursive: true }, () => {
    setTimeout(() => void runOnce(), 250);
  });

  process.once("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });

  await runOnce();
}
