export type SyncActionKind = "push" | "pull" | "delete" | "restore" | "conflict" | "noop";

export interface LocalSyncEntry {
  path: string;
  hash: string | null;
  baseHash: string | null;
  deleted?: boolean;
}

export interface RemoteSyncEntry {
  path: string;
  hash: string | null;
  deleted?: boolean;
  version?: number | null;
  seq?: number;
}

export interface SyncAction {
  kind: SyncActionKind;
  path: string;
  reason: string;
  localHash: string | null;
  remoteHash: string | null;
  baseHash: string | null;
}

export interface PlanSyncInput {
  local: LocalSyncEntry[];
  remote: RemoteSyncEntry[];
}

function stateKey(entry: { path: string }): string {
  return entry.path;
}

function isChangedFromBase(hash: string | null, deleted: boolean, baseHash: string | null): boolean {
  if (deleted) {
    return baseHash !== null;
  }
  return hash !== baseHash;
}

function sameState(local: LocalSyncEntry | undefined, remote: RemoteSyncEntry | undefined): boolean {
  return Boolean(local && remote && Boolean(local.deleted) === Boolean(remote.deleted) && local.hash === remote.hash);
}

export function planSync(input: PlanSyncInput): SyncAction[] {
  const localByPath = new Map(input.local.map((entry) => [stateKey(entry), entry]));
  const remoteByPath = new Map(input.remote.map((entry) => [stateKey(entry), entry]));
  const paths = [...new Set([...localByPath.keys(), ...remoteByPath.keys()])].sort();

  return paths.map((pathName) => {
    const local = localByPath.get(pathName);
    const remote = remoteByPath.get(pathName);
    const baseHash = local?.baseHash ?? null;
    const localDeleted = Boolean(local?.deleted);
    const remoteDeleted = Boolean(remote?.deleted);
    const localHash = localDeleted ? null : (local?.hash ?? null);
    const remoteHash = remoteDeleted ? null : (remote?.hash ?? null);
    const localChanged = local ? isChangedFromBase(localHash, localDeleted, baseHash) : false;
    const remoteChanged = remote ? isChangedFromBase(remoteHash, remoteDeleted, baseHash) : false;

    if (sameState(local, remote)) {
      return {
        kind: "noop",
        path: pathName,
        reason: "local and remote already match",
        localHash,
        remoteHash,
        baseHash,
      };
    }

    if (localChanged && remoteChanged) {
      return {
        kind: "conflict",
        path: pathName,
        reason: "local and remote both changed from the base hash",
        localHash,
        remoteHash,
        baseHash,
      };
    }

    if (localChanged) {
      return {
        kind: localDeleted ? "delete" : "push",
        path: pathName,
        reason: localDeleted ? "local delete should be sent to remote" : "local content should be pushed",
        localHash,
        remoteHash,
        baseHash,
      };
    }

    if (remoteChanged) {
      return {
        kind: remoteDeleted ? "delete" : localDeleted ? "restore" : "pull",
        path: pathName,
        reason: remoteDeleted
          ? "remote delete should be applied locally"
          : localDeleted
            ? "remote restored content should be materialized locally"
            : "remote content should be pulled",
        localHash,
        remoteHash,
        baseHash,
      };
    }

    if (!local && remote && !remoteDeleted) {
      return {
        kind: "pull",
        path: pathName,
        reason: "remote file is missing locally",
        localHash,
        remoteHash,
        baseHash,
      };
    }

    if (local && !remote && !localDeleted) {
      return {
        kind: "push",
        path: pathName,
        reason: "local file is missing remotely",
        localHash,
        remoteHash,
        baseHash,
      };
    }

    return {
      kind: "noop",
      path: pathName,
      reason: "no sync action needed",
      localHash,
      remoteHash,
      baseHash,
    };
  });
}
