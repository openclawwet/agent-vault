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
  };
}

export async function syncShare(base: MacSyncConfig, share: ShareRecord): Promise<ShareSyncResult> {
  const config = configForShare(base, share);
  const pushed = await pushCommand(config);
  const pulled = await pullCommand(config);
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
  return statusCommand(configForShare(base, share));
}

