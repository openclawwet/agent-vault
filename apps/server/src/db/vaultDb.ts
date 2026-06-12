import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_SPACE, type SpaceInfo, type VaultFileRecord } from "@agent-vault/core";

interface FileRow {
  id: string;
  space: string;
  path: string;
  size: number;
  sha256: string;
  storage_path: string;
  created_at: string;
  updated_at: string;
}

interface SpaceRow {
  name: string;
  created_at: string;
}

export interface UpsertFileInput {
  id: string;
  space: string;
  path: string;
  size: number;
  sha256: string;
  storagePath: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapFile(row: FileRow): VaultFileRecord {
  return {
    id: row.id,
    space: row.space,
    path: row.path,
    size: row.size,
    sha256: row.sha256,
    storagePath: row.storage_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSpace(row: SpaceRow): SpaceInfo {
  return {
    name: row.name,
    createdAt: row.created_at,
  };
}

export class VaultDb {
  constructor(private readonly db: DatabaseSync) {}

  static open(dbPath: string): VaultDb {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    const vaultDb = new VaultDb(db);
    vaultDb.migrate();
    vaultDb.ensureSpace(DEFAULT_SPACE);
    return vaultDb;
  }

  migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS spaces (
        name TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        space TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(space, path),
        FOREIGN KEY(space) REFERENCES spaces(name) ON DELETE CASCADE
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  ensureSpace(name: string): SpaceInfo {
    const createdAt = nowIso();
    this.db.prepare("INSERT OR IGNORE INTO spaces (name, created_at) VALUES (?, ?)").run(name, createdAt);
    const row = this.db.prepare("SELECT name, created_at FROM spaces WHERE name = ?").get(name) as unknown as SpaceRow;
    return mapSpace(row);
  }

  listSpaces(): SpaceInfo[] {
    const rows = this.db.prepare("SELECT name, created_at FROM spaces ORDER BY name").all() as unknown as SpaceRow[];
    return rows.map(mapSpace);
  }

  getFile(space: string, filePath: string): VaultFileRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id, space, path, size, sha256, storage_path, created_at, updated_at FROM files WHERE space = ? AND path = ?",
      )
      .get(space, filePath) as unknown as FileRow | undefined;
    return row ? mapFile(row) : undefined;
  }

  listFiles(space: string): VaultFileRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, space, path, size, sha256, storage_path, created_at, updated_at FROM files WHERE space = ? ORDER BY path",
      )
      .all(space) as unknown as FileRow[];
    return rows.map(mapFile);
  }

  upsertFile(input: UpsertFileInput): VaultFileRecord {
    this.ensureSpace(input.space);
    const existing = this.getFile(input.space, input.path);
    const createdAt = existing?.createdAt ?? nowIso();
    const updatedAt = nowIso();
    const id = existing?.id ?? input.id;

    this.db
      .prepare(
        `
        INSERT INTO files (id, space, path, size, sha256, storage_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(space, path) DO UPDATE SET
          size = excluded.size,
          sha256 = excluded.sha256,
          storage_path = excluded.storage_path,
          updated_at = excluded.updated_at
      `,
      )
      .run(id, input.space, input.path, input.size, input.sha256, input.storagePath, createdAt, updatedAt);

    const file = this.getFile(input.space, input.path);
    if (!file) {
      throw new Error("Failed to read file metadata after write.");
    }
    return file;
  }
}
