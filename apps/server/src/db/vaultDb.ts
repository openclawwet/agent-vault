import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SPACE,
  type AuditEventRecord,
  type AuditOperation,
  type SpaceInfo,
  type VaultFileRecord,
  type VaultFileVersionRecord,
} from "@agent-vault/core";

interface FileRow {
  id: string;
  space: string;
  path: string;
  size: number;
  sha256: string;
  storage_path: string;
  current_version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  file_id: string;
  version_number: number;
  size: number;
  sha256: string;
  storage_path: string;
  created_at: string;
}

interface AuditRow {
  id: string;
  device: string;
  space: string;
  operation: AuditOperation;
  path: string;
  version: number | null;
  hash: string | null;
  timestamp: string;
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
  version: number;
  versionStoragePath: string;
  device: string;
  operation: Extract<AuditOperation, "upload" | "update" | "restore">;
}

export interface AuditInput {
  device: string;
  space: string;
  operation: AuditOperation;
  path: string;
  version?: number | null;
  hash?: string | null;
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
    currentVersion: row.current_version,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: VersionRow): VaultFileVersionRecord {
  return {
    id: row.id,
    fileId: row.file_id,
    version: row.version_number,
    size: row.size,
    sha256: row.sha256,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  };
}

function mapAudit(row: AuditRow): AuditEventRecord {
  return {
    id: row.id,
    device: row.device,
    space: row.space,
    operation: row.operation,
    path: row.path,
    version: row.version,
    hash: row.hash,
    timestamp: row.timestamp,
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
        current_version INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(space, path),
        FOREIGN KEY(space) REFERENCES spaces(name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS file_versions (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(file_id, version_number),
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        device TEXT NOT NULL,
        space TEXT NOT NULL,
        operation TEXT NOT NULL,
        path TEXT NOT NULL,
        version INTEGER,
        hash TEXT,
        timestamp TEXT NOT NULL
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
        "SELECT id, space, path, size, sha256, storage_path, current_version, deleted_at, created_at, updated_at FROM files WHERE space = ? AND path = ?",
      )
      .get(space, filePath) as unknown as FileRow | undefined;
    return row ? mapFile(row) : undefined;
  }

  listFiles(space: string): VaultFileRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, space, path, size, sha256, storage_path, current_version, deleted_at, created_at, updated_at FROM files WHERE space = ? AND deleted_at IS NULL ORDER BY path",
      )
      .all(space) as unknown as FileRow[];
    return rows.map(mapFile);
  }

  listAudit(space: string): AuditEventRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, device, space, operation, path, version, hash, timestamp FROM audit_events WHERE space = ? ORDER BY timestamp, rowid",
      )
      .all(space) as unknown as AuditRow[];
    return rows.map(mapAudit);
  }

  getVersion(fileId: string, version: number): VaultFileVersionRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id, file_id, version_number, size, sha256, storage_path, created_at FROM file_versions WHERE file_id = ? AND version_number = ?",
      )
      .get(fileId, version) as unknown as VersionRow | undefined;
    return row ? mapVersion(row) : undefined;
  }

  getNextVersion(space: string, filePath: string): { fileId: string; version: number; operation: "upload" | "update" } {
    const existing = this.getFile(space, filePath);
    return {
      fileId: existing?.id ?? randomUUID(),
      version: (existing?.currentVersion ?? 0) + 1,
      operation: existing ? "update" : "upload",
    };
  }

  upsertFileVersion(input: UpsertFileInput): VaultFileRecord {
    this.ensureSpace(input.space);
    const existing = this.getFile(input.space, input.path);
    const createdAt = existing?.createdAt ?? nowIso();
    const updatedAt = nowIso();
    const id = existing?.id ?? input.id;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `
        INSERT INTO files (id, space, path, size, sha256, storage_path, current_version, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(space, path) DO UPDATE SET
          size = excluded.size,
          sha256 = excluded.sha256,
          storage_path = excluded.storage_path,
          current_version = excluded.current_version,
          deleted_at = NULL,
          updated_at = excluded.updated_at
      `,
        )
        .run(
          id,
          input.space,
          input.path,
          input.size,
          input.sha256,
          input.storagePath,
          input.version,
          createdAt,
          updatedAt,
        );

      this.db
        .prepare(
          `
        INSERT INTO file_versions (id, file_id, version_number, size, sha256, storage_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(randomUUID(), id, input.version, input.size, input.sha256, input.versionStoragePath, updatedAt);

      this.recordAuditEventInTransaction({
        device: input.device,
        space: input.space,
        operation: input.operation,
        path: input.path,
        version: input.version,
        hash: input.sha256,
      });

      this.db.exec("COMMIT");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const file = this.getFile(input.space, input.path);
    if (!file) {
      throw new Error("Failed to read file metadata after write.");
    }
    return file;
  }

  markDeleted(space: string, filePath: string, device: string): VaultFileRecord {
    const existing = this.getFile(space, filePath);
    if (!existing || existing.deletedAt) {
      throw new Error("File was not found.");
    }

    const deletedAt = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ?")
        .run(deletedAt, deletedAt, existing.id);
      this.recordAuditEventInTransaction({
        device,
        space,
        operation: "delete",
        path: filePath,
        version: existing.currentVersion,
        hash: existing.sha256,
      });
      this.db.exec("COMMIT");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const file = this.getFile(space, filePath);
    if (!file) {
      throw new Error("Failed to read file metadata after delete.");
    }
    return file;
  }

  restoreFile(space: string, filePath: string, version: number, device: string): VaultFileRecord {
    const existing = this.getFile(space, filePath);
    if (!existing) {
      throw new Error("File was not found.");
    }

    const restoredVersion = this.getVersion(existing.id, version);
    if (!restoredVersion) {
      throw new Error("Version was not found.");
    }

    const restoredAt = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE files SET size = ?, sha256 = ?, current_version = ?, deleted_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(restoredVersion.size, restoredVersion.sha256, restoredVersion.version, restoredAt, existing.id);
      this.recordAuditEventInTransaction({
        device,
        space,
        operation: "restore",
        path: filePath,
        version: restoredVersion.version,
        hash: restoredVersion.sha256,
      });
      this.db.exec("COMMIT");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const file = this.getFile(space, filePath);
    if (!file) {
      throw new Error("Failed to read file metadata after restore.");
    }
    return file;
  }

  recordAuditEvent(input: AuditInput): AuditEventRecord {
    const id = this.recordAuditEventInTransaction(input);
    const row = this.db
      .prepare(
        "SELECT id, device, space, operation, path, version, hash, timestamp FROM audit_events WHERE id = ?",
      )
      .get(id) as unknown as AuditRow | undefined;
    if (!row) {
      throw new Error("Failed to record audit event.");
    }
    return mapAudit(row);
  }

  private recordAuditEventInTransaction(input: AuditInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO audit_events (id, device, space, operation, path, version, hash, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.device,
        input.space,
        input.operation,
        input.path,
        input.version ?? null,
        input.hash ?? null,
        nowIso(),
      );
    return id;
  }
}
