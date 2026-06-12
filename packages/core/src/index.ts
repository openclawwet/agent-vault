export const DEFAULT_SPACE = "Inbox";
export const DEFAULT_SPACES = ["Inbox", "MacBook Shared", "Agent Drafts", "Approvals", "Projects", "Archive"] as const;

export type VaultPermission = "read" | "write" | "delete" | "admin";

export interface SpaceInfo {
  name: string;
  createdAt: string;
}

export interface SpaceAccessInfo extends SpaceInfo {
  permissions: VaultPermission[];
}

export interface DeviceScopeRecord {
  space: string;
  permissions: VaultPermission[];
}

export interface DeviceRecord {
  id: string;
  name: string;
  scopes: DeviceScopeRecord[];
  createdAt: string;
  rotatedAt: string | null;
  disabledAt: string | null;
}

export type DevicePresenceStatus = "online" | "recent" | "offline";

export interface DevicePresenceRecord {
  deviceId: string;
  lastSeenAt: string;
  clientName: string | null;
  clientVersion: string | null;
  hostName: string | null;
}

export interface DeviceStatusRecord extends DeviceRecord {
  status: DevicePresenceStatus;
  lastSeenAt: string | null;
  clientName: string | null;
  clientVersion: string | null;
  hostName: string | null;
  current: boolean;
}

export interface VaultServerStatus {
  id: "server:mac-mini";
  name: string;
  role: "vault-server";
  status: "online";
  lastSeenAt: string;
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

export type AuditOperation = "upload" | "update" | "delete" | "restore" | "move" | "auth_failed";
export type ChangeOperation = "create" | "update" | "delete" | "restore" | "move";

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

export interface ChangeEventRecord {
  seq: number;
  space: string;
  operation: ChangeOperation;
  path: string;
  previousPath: string | null;
  version: number | null;
  hash: string | null;
  device: string;
  timestamp: string;
}

export interface UploadFileResult {
  file: VaultFileRecord;
}

export interface ListFilesResult {
  files: VaultFileRecord[];
}

export interface ListSpacesResult {
  spaces: SpaceAccessInfo[];
}

export interface CurrentDeviceResult {
  device: DeviceRecord;
  spaces: SpaceAccessInfo[];
}

export interface DeviceStatusResult {
  server: VaultServerStatus;
  devices: DeviceStatusRecord[];
  currentDeviceId: string;
  onlineWindowSeconds: number;
  recentWindowSeconds: number;
}

export interface HealthResult {
  ok: true;
  service: "agent-vault";
  storageRoot: string;
  dbPath: string;
}
