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
  createdAt: string;
  updatedAt: string;
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
