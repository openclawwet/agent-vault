import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LocalFileEntry {
  path: string;
  hash: string;
  size: number;
}

export interface SyncStateEntry {
  baseHash: string | null;
}

export interface SyncState {
  cursor: number;
  files: Record<string, SyncStateEntry>;
}

export function metadataDir(localDir: string): string {
  return path.join(localDir, ".agent-vault");
}

export function statePath(localDir: string): string {
  return path.join(metadataDir(localDir), "state.json");
}

export async function readState(localDir: string): Promise<SyncState> {
  try {
    const body = await readFile(statePath(localDir), "utf8");
    return JSON.parse(body) as SyncState;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
    return { cursor: 0, files: {} };
  }
}

export async function writeState(localDir: string, state: SyncState): Promise<void> {
  await mkdir(metadataDir(localDir), { recursive: true });
  await writeFile(statePath(localDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export async function hashFile(filePath: string): Promise<string> {
  const body = await readFile(filePath);
  return createHash("sha256").update(body).digest("hex");
}

export async function scanLocal(localDir: string): Promise<LocalFileEntry[]> {
  const root = path.resolve(localDir);
  const results: LocalFileEntry[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".agent-vault") {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const fileStat = await stat(absolute);
      results.push({
        path: relative,
        hash: await hashFile(absolute),
        size: fileStat.size,
      });
    }
  }

  await mkdir(root, { recursive: true });
  await walk(root);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export async function writeLocalFile(localDir: string, relativePath: string, body: Buffer): Promise<void> {
  const target = path.join(localDir, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
}

export async function moveLocalToTrash(localDir: string, relativePath: string): Promise<string> {
  const source = path.join(localDir, ...relativePath.split("/"));
  const trashPath = path.join(metadataDir(localDir), "trash", `${Date.now()}-${relativePath.replaceAll("/", "__")}`);
  await mkdir(path.dirname(trashPath), { recursive: true });
  await rename(source, trashPath);
  return trashPath;
}

export async function writeConflictReview(localDir: string, relativePath: string, details: unknown): Promise<string> {
  const conflictPath = path.join(
    metadataDir(localDir),
    "conflicts",
    `${Date.now()}-${relativePath.replaceAll("/", "__")}.json`,
  );
  await mkdir(path.dirname(conflictPath), { recursive: true });
  await writeFile(conflictPath, `${JSON.stringify(details, null, 2)}\n`);
  return conflictPath;
}
