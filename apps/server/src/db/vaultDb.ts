import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SPACE,
  DEFAULT_SPACES,
  type AuditEventRecord,
  type AuditOperation,
  type DeviceRecord,
  type DeviceScopeRecord,
  type SpaceInfo,
  type VaultFileRecord,
  type VaultFileVersionRecord,
  type VaultPermission,
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

interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: string;
  rotated_at: string | null;
  disabled_at: string | null;
}

interface DeviceScopeRow {
  device_id: string;
  space: string;
  can_read: number;
  can_write: number;
  can_delete: number;
  can_admin: number;
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

export interface DeviceScopeInput {
  space: string;
  permissions: VaultPermission[];
}

export interface CreateDeviceInput {
  name: string;
  tokenHash: string;
  scopes: DeviceScopeInput[];
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

function permissionsFromScopeRow(row: DeviceScopeRow): VaultPermission[] {
  const permissions: VaultPermission[] = [];
  if (row.can_read) permissions.push("read");
  if (row.can_write) permissions.push("write");
  if (row.can_delete) permissions.push("delete");
  if (row.can_admin) permissions.push("admin");
  return permissions;
}

function mapDevice(row: DeviceRow, scopes: DeviceScopeRecord[]): DeviceRecord {
  return {
    id: row.id,
    name: row.name,
    scopes,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    disabledAt: row.disabled_at,
  };
}

export class VaultDb {
  constructor(private readonly db: DatabaseSync) {}

  static open(dbPath: string): VaultDb {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    const vaultDb = new VaultDb(db);
    vaultDb.migrate();
    vaultDb.ensureDefaultSpaces();
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

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        rotated_at TEXT,
        disabled_at TEXT
      );

      CREATE TABLE IF NOT EXISTS device_scopes (
        device_id TEXT NOT NULL,
        space TEXT NOT NULL,
        can_read INTEGER NOT NULL DEFAULT 0,
        can_write INTEGER NOT NULL DEFAULT 0,
        can_delete INTEGER NOT NULL DEFAULT 0,
        can_admin INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(device_id, space),
        FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE,
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

  ensureDefaultSpaces(): void {
    for (const space of DEFAULT_SPACES) {
      this.ensureSpace(space);
    }
    this.ensureSpace(DEFAULT_SPACE);
  }

  ensureBootstrapDevice(tokenHashValue: string): DeviceRecord {
    const existing = this.getDeviceByName("local-admin");
    const scopes = DEFAULT_SPACES.map((space) => ({
      space,
      permissions: ["read", "write", "delete", "admin"] satisfies VaultPermission[],
    }));

    if (!existing) {
      return this.createDevice({
        name: "local-admin",
        tokenHash: tokenHashValue,
        scopes,
      });
    }

    this.db.prepare("UPDATE devices SET token_hash = ?, rotated_at = ? WHERE id = ?").run(tokenHashValue, nowIso(), existing.id);
    this.replaceDeviceScopes(existing.id, scopes);
    return this.getDeviceByName("local-admin") ?? existing;
  }

  listSpaces(): SpaceInfo[] {
    const rows = this.db.prepare("SELECT name, created_at FROM spaces ORDER BY name").all() as unknown as SpaceRow[];
    return rows.map(mapSpace);
  }

  getDeviceByTokenHash(hash: string): DeviceRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id, name, token_hash, created_at, rotated_at, disabled_at FROM devices WHERE token_hash = ? AND disabled_at IS NULL",
      )
      .get(hash) as unknown as DeviceRow | undefined;
    return row ? this.mapDeviceWithScopes(row) : undefined;
  }

  getDeviceByName(name: string): DeviceRecord | undefined {
    const row = this.db
      .prepare("SELECT id, name, token_hash, created_at, rotated_at, disabled_at FROM devices WHERE name = ?")
      .get(name) as unknown as DeviceRow | undefined;
    return row ? this.mapDeviceWithScopes(row) : undefined;
  }

  getDeviceById(id: string): DeviceRecord | undefined {
    const row = this.db
      .prepare("SELECT id, name, token_hash, created_at, rotated_at, disabled_at FROM devices WHERE id = ?")
      .get(id) as unknown as DeviceRow | undefined;
    return row ? this.mapDeviceWithScopes(row) : undefined;
  }

  listDevices(): DeviceRecord[] {
    const rows = this.db
      .prepare("SELECT id, name, token_hash, created_at, rotated_at, disabled_at FROM devices ORDER BY name")
      .all() as unknown as DeviceRow[];
    return rows.map((row) => this.mapDeviceWithScopes(row));
  }

  createDevice(input: CreateDeviceInput): DeviceRecord {
    const id = randomUUID();
    const createdAt = nowIso();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
        .run(id, input.name, input.tokenHash, createdAt);
      this.replaceDeviceScopes(id, input.scopes);
      this.db.exec("COMMIT");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const device = this.getDeviceById(id);
    if (!device) {
      throw new Error("Failed to read device after create.");
    }
    return device;
  }

  rotateDeviceToken(id: string, tokenHashValue: string): DeviceRecord {
    const rotatedAt = nowIso();
    this.db.prepare("UPDATE devices SET token_hash = ?, rotated_at = ? WHERE id = ?").run(tokenHashValue, rotatedAt, id);
    const device = this.getDeviceById(id);
    if (!device) {
      throw new Error("Device was not found.");
    }
    return device;
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

  private mapDeviceWithScopes(row: DeviceRow): DeviceRecord {
    const scopeRows = this.db
      .prepare(
        "SELECT device_id, space, can_read, can_write, can_delete, can_admin FROM device_scopes WHERE device_id = ? ORDER BY space",
      )
      .all(row.id) as unknown as DeviceScopeRow[];
    return mapDevice(
      row,
      scopeRows.map((scopeRow) => ({
        space: scopeRow.space,
        permissions: permissionsFromScopeRow(scopeRow),
      })),
    );
  }

  private replaceDeviceScopes(deviceId: string, scopes: DeviceScopeInput[]): void {
    this.db.prepare("DELETE FROM device_scopes WHERE device_id = ?").run(deviceId);
    const insert = this.db.prepare(
      `
      INSERT INTO device_scopes (device_id, space, can_read, can_write, can_delete, can_admin)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    );

    for (const scope of scopes) {
      this.ensureSpace(scope.space);
      const permissions = new Set(scope.permissions);
      insert.run(
        deviceId,
        scope.space,
        permissions.has("read") ? 1 : 0,
        permissions.has("write") ? 1 : 0,
        permissions.has("delete") ? 1 : 0,
        permissions.has("admin") ? 1 : 0,
      );
    }
  }
}
