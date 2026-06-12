import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ActivityKind = "share_added" | "share_removed" | "share_updated" | "sync" | "drop_upload" | "file_download" | "error";

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  message: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export function defaultActivityLogPath(): string {
  return process.env.AGENT_VAULT_ACTIVITY_LOG ?? path.join(os.homedir(), ".agent-vault", "activity.jsonl");
}

export async function recordActivity(
  kind: ActivityKind,
  message: string,
  details?: Record<string, unknown>,
  logPath = defaultActivityLogPath(),
): Promise<ActivityEntry> {
  const entry: ActivityEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind,
    message,
    timestamp: new Date().toISOString(),
    details,
  };
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}

export async function readActivity(limit = 80, logPath = defaultActivityLogPath()): Promise<ActivityEntry[]> {
  try {
    const body = await readFile(logPath, "utf8");
    return body
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .map((line) => JSON.parse(line) as ActivityEntry);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return [];
  }
}
