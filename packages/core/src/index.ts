export const DEFAULT_SPACE = "default";

export interface SpaceInfo {
  name: string;
  createdAt: string;
}

export interface VaultFileRecord {
  id: string;
  space: string;
  path: string;
  size: number;
  sha256: string;
  storagePath: string;
  currentVersion: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VaultFileVersionRecord {
  id: string;
  fileId: string;
  version: number;
  size: number;
  sha256: string;
  storagePath: string;
  createdAt: string;
}

export type AuditOperation = "upload" | "update" | "delete" | "restore" | "auth_failed";

export interface AuditEventRecord {
  id: string;
  device: string;
  space: string;
  operation: AuditOperation;
  path: string;
  version: number | null;
  hash: string | null;
  timestamp: string;
}

export interface UploadFileResult {
  file: VaultFileRecord;
}

export interface ListFilesResult {
  files: VaultFileRecord[];
}

export interface ListSpacesResult {
  spaces: SpaceInfo[];
}

export interface HealthResult {
  ok: true;
  service: "agent-vault";
  storageRoot: string;
  dbPath: string;
}
