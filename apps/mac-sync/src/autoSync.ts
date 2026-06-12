import { watch, type FSWatcher } from "node:fs";
import { access } from "node:fs/promises";
import type { MacSyncConfig } from "./config.js";
import { recordActivity } from "./activityLog.js";
import { loadShareConfig, type ShareRecord } from "./shareConfig.js";
import { syncShare, type ShareSyncResult } from "./shareSync.js";
import { pullCommand, pushCommand, type SyncSummary } from "./syncCommands.js";

export interface AllSourcesSyncResult {
  main: {
    pushed: SyncSummary;
    pulled: SyncSummary;
  };
  shares: ShareSyncResult[];
  total: SyncSummary;
}

export interface WatchAllSourcesOptions {
  debounceMs?: number;
  pollMs?: number;
  onSync?: (result: AllSourcesSyncResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export function addSummary(total: SyncSummary, next: SyncSummary): SyncSummary {
  return {
    pushed: total.pushed + next.pushed,
    pulled: total.pulled + next.pulled,
    deleted: total.deleted + next.deleted,
    conflicts: total.conflicts + next.conflicts,
    scanned: total.scanned + next.scanned,
  };
}

export function summaryChanged(summary: SyncSummary): boolean {
  return summary.pushed > 0 || summary.pulled > 0 || summary.deleted > 0 || summary.conflicts > 0;
}

export function configWithShareIgnores(config: MacSyncConfig, shares: ShareRecord[]): MacSyncConfig {
  const prefixes = shares
    .filter((share) => share.enabled && share.space === config.space)
    .map((share) => share.remotePathPrefix)
    .filter(Boolean);
  return {
    ...config,
    ignoreRemotePathPrefixes: [...new Set([...(config.ignoreRemotePathPrefixes ?? []), ...prefixes])],
  };
}

export async function syncAllSources(config: MacSyncConfig): Promise<AllSourcesSyncResult> {
  const shareConfig = await loadShareConfig();
  const mainConfig = configWithShareIgnores(config, shareConfig.shares);
  const pushed = await pushCommand(mainConfig);
  const pulled = await pullCommand(mainConfig);
  const shares: ShareSyncResult[] = [];
  let total = addSummary(pushed, pulled);

  for (const share of shareConfig.shares.filter((item) => item.enabled)) {
    const result = await syncShare(config, share);
    shares.push(result);
    total = addSummary(total, result.summary);
  }

  return { main: { pushed, pulled }, shares, total };
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function watchAllSources(config: MacSyncConfig, options: WatchAllSourcesOptions = {}): Promise<void> {
  const debounceMs = options.debounceMs ?? 550;
  const pollMs = options.pollMs ?? 20_000;
  let running = false;
  let queued = false;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let watchers: FSWatcher[] = [];
  let watchedKeys = "";

  async function runOnce(reason: string): Promise<void> {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const result = await syncAllSources(config);
      if (summaryChanged(result.total)) {
        await recordActivity("sync", `Auto-synced Agent Vault sources (${reason})`, {
          total: result.total,
          shares: result.shares.map((share) => ({ label: share.label, summary: share.summary })),
        });
      }
      await options.onSync?.(result);
    } catch (error: unknown) {
      await recordActivity("error", "Auto-sync failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
      await options.onError?.(error);
    } finally {
      running = false;
      if (queued && !closed) {
        queued = false;
        schedule("queued");
      }
    }
  }

  function schedule(reason: string): void {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void runOnce(reason), debounceMs);
  }

  async function refreshWatchers(): Promise<void> {
    const shareConfig = await loadShareConfig();
    const dirs = [config.localDir, ...shareConfig.shares.filter((share) => share.enabled).map((share) => share.localDir)];
    const nextKeys = [...new Set(dirs)].sort().join("\n");
    if (nextKeys === watchedKeys) {
      return;
    }
    for (const watcher of watchers) {
      watcher.close();
    }
    watchers = [];
    watchedKeys = nextKeys;

    for (const dir of [...new Set(dirs)]) {
      if (!(await exists(dir))) {
        continue;
      }
      try {
        const watcher = watch(dir, { recursive: true }, () => schedule("file change"));
        watchers.push(watcher);
      } catch (error: unknown) {
        await recordActivity("error", "Could not watch shared folder", {
          folder: dir,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  await refreshWatchers();
  await runOnce("startup");
  pollTimer = setInterval(() => {
    void refreshWatchers().then(() => runOnce("poll"));
  }, pollMs);

  await new Promise<void>((resolve) => {
    const stop = () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      for (const watcher of watchers) {
        watcher.close();
      }
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
