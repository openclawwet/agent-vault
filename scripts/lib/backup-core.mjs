import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function pathExists(filePath) {
  return access(filePath, constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

export function resolveRuntimePaths(options = {}) {
  const homeDir = path.resolve(expandHome(options.homeDir ?? process.env.AGENT_VAULT_HOME ?? "~/.agent-vault"));
  const storageRoot = path.resolve(
    expandHome(options.storageRoot ?? process.env.AGENT_VAULT_STORAGE_ROOT ?? path.join(homeDir, "storage")),
  );
  const dbPath = path.resolve(
    expandHome(options.dbPath ?? process.env.AGENT_VAULT_DB ?? path.join(homeDir, "agent-vault.sqlite")),
  );

  return { homeDir, storageRoot, dbPath };
}

export function timestampId(date = new Date()) {
  return date.toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-").replace("Z", "Z");
}

export function sanitizeLabel(label) {
  return String(label ?? "manual")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "manual";
}

export function sqliteQuote(value) {
  return String(value).replaceAll("'", "''");
}

export function assertSafeRelativeStoragePath(value) {
  if (!value || typeof value !== "string" || value.length > 2048 || value.includes("\0")) {
    throw new Error(`Unsafe storage path in metadata: ${String(value)}`);
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Absolute storage path in metadata: ${value}`);
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Path traversal in metadata storage path: ${value}`);
  }
  return segments.join("/");
}

export function resolveStorageReference(storageRoot, storagePath) {
  const safePath = assertSafeRelativeStoragePath(storagePath);
  const absolutePath = path.resolve(storageRoot, ...safePath.split("/"));
  const root = path.resolve(storageRoot);
  const rootWithSeparator = `${root}${path.sep}`;
  if (absolutePath !== root && !absolutePath.startsWith(rootWithSeparator)) {
    throw new Error(`Storage path escapes root: ${storagePath}`);
  }
  return absolutePath;
}

export async function sha256File(filePath) {
  const body = await readFile(filePath);
  return createHash("sha256").update(body).digest("hex");
}

export async function collectStorageStats(storageRoot) {
  const root = path.resolve(storageRoot);
  const files = [];
  let totalBytes = 0;

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const fileStat = await stat(absolutePath);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      const sha256 = await sha256File(absolutePath);
      totalBytes += fileStat.size;
      files.push({ path: relativePath, size: fileStat.size, sha256 });
    }
  }

  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }

  return {
    fileCount: files.length,
    totalBytes,
    treeSha256: digest.digest("hex"),
    files,
  };
}

export async function createSqliteSnapshot(dbPath, snapshotPath) {
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA wal_checkpoint(FULL)");
    db.exec(`VACUUM INTO '${sqliteQuote(snapshotPath)}'`);
  } finally {
    db.close();
  }
}

export async function verifyBackup(backupDir) {
  const root = path.resolve(backupDir);
  const storageRoot = path.join(root, "storage");
  const dbPath = path.join(root, "agent-vault.sqlite");

  if (!(await pathExists(dbPath))) {
    throw new Error(`Backup SQLite file is missing: ${dbPath}`);
  }

  if (!(await pathExists(storageRoot))) {
    throw new Error(`Backup storage directory is missing: ${storageRoot}`);
  }

  const db = new DatabaseSync(dbPath);
  try {
    const activeFiles = db
      .prepare("SELECT storage_path, sha256 FROM files WHERE deleted_at IS NULL ORDER BY space, path")
      .all();
    const versions = db.prepare("SELECT storage_path, sha256 FROM file_versions ORDER BY file_id, version_number").all();

    for (const row of [...activeFiles, ...versions]) {
      const filePath = resolveStorageReference(storageRoot, row.storage_path);
      if (!(await pathExists(filePath))) {
        throw new Error(`Backup is missing referenced storage file: ${row.storage_path}`);
      }
      const actualHash = await sha256File(filePath);
      if (actualHash !== row.sha256) {
        throw new Error(`Backup hash mismatch for ${row.storage_path}`);
      }
    }

    const storage = await collectStorageStats(storageRoot);
    return {
      activeFileReferences: activeFiles.length,
      versionReferences: versions.length,
      storage,
    };
  } finally {
    db.close();
  }
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
