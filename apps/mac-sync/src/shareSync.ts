import type { MacSyncConfig } from "./config.js";
import { pullCommand, pushCommand, statusCommand, type SyncSummary } from "./syncCommands.js";
import type { ShareRecord } from "./shareConfig.js";

export interface ShareSyncResult {
  shareId: string;
  label: string;
  summary: SyncSummary;
}

export function configForShare(base: MacSyncConfig, share: ShareRecord): MacSyncConfig {
  return {
    ...base,
    localDir: share.localDir,
    space: share.space,
    remotePathPrefix: share.remotePathPrefix,
    localIgnoreNames: share.ignoreNames,
    localIgnorePathPrefixes: share.ignorePathPrefixes,
  };
}

function emptySummary(): SyncSummary {
  return { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, scanned: 0 };
}

function canPush(share: ShareRecord): boolean {
  return share.access === "readwrite" || share.access === "readonly";
}

function canPull(share: ShareRecord): boolean {
  return share.access === "readwrite" || share.access === "writeonly";
}

export async function syncShare(base: MacSyncConfig, share: ShareRecord): Promise<ShareSyncResult> {
  const config = configForShare(base, share);
  const pushed = canPush(share) ? await pushCommand(config) : emptySummary();
  const pulled = canPull(share) ? await pullCommand(config) : emptySummary();
  return {
    shareId: share.id,
    label: share.label,
    summary: {
      pushed: pushed.pushed,
      pulled: pulled.pulled + pushed.pulled,
      deleted: pushed.deleted + pulled.deleted,
      conflicts: pushed.conflicts + pulled.conflicts,
      scanned: pushed.scanned,
    },
  };
}

export async function shareStatus(base: MacSyncConfig, share: ShareRecord) {
  const status = await statusCommand(configForShare(base, share));
  return {
    actions: status.actions.filter((action) => {
      if (share.access === "readwrite") return true;
      if (action.kind === "conflict") return true;
      if (share.access === "readonly") {
        return action.kind === "push" || (action.kind === "delete" && action.reason.includes("local"));
      }
      return action.kind === "pull" || action.kind === "restore" || (action.kind === "delete" && action.reason.includes("remote"));
    }),
  };
}
