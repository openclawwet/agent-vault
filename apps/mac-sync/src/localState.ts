import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LocalFileEntry {
  path: string;
  hash: string;
  size: number;
}

export interface LocalScanOptions {
  ignoreNames?: readonly string[];
  ignorePathPrefixes?: readonly string[];
}

export interface SyncStateEntry {
  baseHash: string | null;
}

export interface SyncState {
  cursor: number;
  files: Record<string, SyncStateEntry>;
}

interface ScanCacheEntry {
  hash: string;
  mtimeMs: number;
  size: number;
}

interface ScanCache {
  files: Record<string, ScanCacheEntry>;
}

export function metadataDir(localDir: string): string {
  return path.join(localDir, ".agent-vault");
}

export function statePath(localDir: string): string {
  return path.join(metadataDir(localDir), "state.json");
}

function scanCachePath(localDir: string): string {
  return path.join(metadataDir(localDir), "scan-cache.json");
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

async function readScanCache(localDir: string): Promise<ScanCache> {
  try {
    const body = await readFile(scanCachePath(localDir), "utf8");
    const parsed = JSON.parse(body) as Partial<ScanCache>;
    return { files: parsed.files && typeof parsed.files === "object" ? parsed.files : {} };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return { files: {} };
  }
}

async function writeScanCache(localDir: string, cache: ScanCache): Promise<void> {
  await mkdir(metadataDir(localDir), { recursive: true });
  await writeFile(scanCachePath(localDir), `${JSON.stringify(cache)}\n`, { mode: 0o600 });
}

export async function hashFile(filePath: string): Promise<string> {
  const body = await readFile(filePath);
  return createHash("sha256").update(body).digest("hex");
}

function normalizedPrefix(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function isIgnored(relativePath: string, name: string, options: LocalScanOptions): boolean {
  const ignoredNames = new Set([".agent-vault", ...(options.ignoreNames ?? [])]);
  if (ignoredNames.has(name)) {
    return true;
  }

  const normalized = normalizedPrefix(relativePath);
  return (options.ignorePathPrefixes ?? [])
    .map(normalizedPrefix)
    .filter(Boolean)
    .some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export async function scanLocal(localDir: string, options: LocalScanOptions = {}): Promise<LocalFileEntry[]> {
  const root = path.resolve(localDir);
  const results: LocalFileEntry[] = [];
  const previousCache = await readScanCache(root);
  const nextCache: ScanCache = { files: {} };

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (isIgnored(relative, entry.name, options)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      let fileStat;
      try {
        fileStat = await stat(absolute);
      } catch {
        continue;
      }
      const cached = previousCache.files[relative];
      let hash: string;
      try {
        hash =
          cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs
            ? cached.hash
            : await hashFile(absolute);
      } catch {
        continue;
      }
      nextCache.files[relative] = { hash, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
      results.push({
        path: relative,
        hash,
        size: fileStat.size,
      });
    }
  }

  await mkdir(root, { recursive: true });
  await walk(root);
  await writeScanCache(root, nextCache);
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
