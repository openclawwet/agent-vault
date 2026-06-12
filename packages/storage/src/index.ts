import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export class VaultStorageError extends Error {
  constructor(
    public readonly code: "invalid_space" | "invalid_path" | "outside_root",
    message: string,
  ) {
    super(message);
    this.name = "VaultStorageError";
  }
}

export interface StoredFileWrite {
  space: string;
  path: string;
  absolutePath: string;
  storagePath: string;
  versionStoragePath: string;
  size: number;
  sha256: string;
}

export interface FileStorageOptions {
  root: string;
}

const safeSpacePattern = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;

export function normalizeSpaceName(input: string): string {
  const space = input.trim();
  if (!safeSpacePattern.test(space)) {
    throw new VaultStorageError("invalid_space", "Invalid space name.");
  }
  return space;
}

export function normalizeVaultPath(input: string): string {
  const value = input.trim().replaceAll("\\", "/");
  if (!value || value.length > 1024 || value.includes("\0")) {
    throw new VaultStorageError("invalid_path", "Invalid file path.");
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new VaultStorageError("invalid_path", "Absolute paths are not allowed.");
  }

  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new VaultStorageError("invalid_path", "Path traversal is not allowed.");
  }

  return segments.join("/");
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export class FileStorage {
  public readonly root: string;

  constructor(options: FileStorageOptions) {
    this.root = path.resolve(options.root);
  }

  async writeVersionedFile(
    spaceInput: string,
    fileId: string,
    version: number,
    pathInput: string,
    body: Buffer,
  ): Promise<StoredFileWrite> {
    const space = normalizeSpaceName(spaceInput);
    const vaultPath = normalizeVaultPath(pathInput);
    const versionStoragePath = path.posix.join(
      ".versions",
      space,
      fileId,
      `v${version}`,
      path.posix.basename(vaultPath),
    );

    await this.writeStoragePath(versionStoragePath, body);
    const currentWrite = await this.writeCurrentFile(space, vaultPath, body);

    return {
      space,
      path: vaultPath,
      absolutePath: currentWrite.absolutePath,
      storagePath: currentWrite.storagePath,
      versionStoragePath,
      size: body.byteLength,
      sha256: sha256Buffer(body),
    };
  }

  async readFile(spaceInput: string, pathInput: string): Promise<Buffer> {
    const absolutePath = this.resolveSpacePath(spaceInput, pathInput);
    return readFile(absolutePath);
  }

  async readStoragePath(storagePath: string): Promise<Buffer> {
    return readFile(this.resolveStoragePath(storagePath));
  }

  async moveCurrentToTrash(spaceInput: string, pathInput: string, fileId: string, version: number): Promise<string> {
    const space = normalizeSpaceName(spaceInput);
    const vaultPath = normalizeVaultPath(pathInput);
    const source = this.resolveSpacePath(space, vaultPath);
    const trashPath = path.posix.join(
      ".trash",
      space,
      fileId,
      `${Date.now()}-v${version}-${path.posix.basename(vaultPath)}`,
    );
    const destination = this.resolveStoragePath(trashPath);

    await mkdir(path.dirname(destination), { recursive: true });
    await rename(source, destination);
    return trashPath;
  }

  async moveCurrentFile(spaceInput: string, fromInput: string, toInput: string): Promise<string> {
    const space = normalizeSpaceName(spaceInput);
    const fromPath = normalizeVaultPath(fromInput);
    const toPath = normalizeVaultPath(toInput);
    const source = this.resolveSpacePath(space, fromPath);
    const destination = this.resolveSpacePath(space, toPath);

    await mkdir(path.dirname(destination), { recursive: true });
    await rename(source, destination);
    return path.posix.join("spaces", space, toPath);
  }

  async restoreVersionToCurrent(versionStoragePath: string, spaceInput: string, pathInput: string): Promise<void> {
    const body = await this.readStoragePath(versionStoragePath);
    const space = normalizeSpaceName(spaceInput);
    const vaultPath = normalizeVaultPath(pathInput);
    await this.writeCurrentFile(space, vaultPath, body);
  }

  resolveSpacePath(spaceInput: string, pathInput: string): string {
    const space = normalizeSpaceName(spaceInput);
    const vaultPath = normalizeVaultPath(pathInput);
    const absolutePath = path.resolve(this.root, "spaces", space, ...vaultPath.split("/"));
    const rootWithSeparator = `${this.root}${path.sep}`;

    if (absolutePath !== this.root && !absolutePath.startsWith(rootWithSeparator)) {
      throw new VaultStorageError("outside_root", "Resolved path escapes the storage root.");
    }

    return absolutePath;
  }

  private async writeCurrentFile(
    space: string,
    vaultPath: string,
    body: Buffer,
  ): Promise<{ absolutePath: string; storagePath: string }> {
    const storagePath = path.posix.join("spaces", space, vaultPath);
    const absolutePath = this.resolveStoragePath(storagePath);
    await this.writeStoragePath(storagePath, body);
    return { absolutePath, storagePath };
  }

  private async writeStoragePath(storagePath: string, body: Buffer): Promise<void> {
    const absolutePath = this.resolveStoragePath(storagePath);
    const tempPath = `${absolutePath}.agent-vault-${process.pid}-${randomUUID()}.tmp`;

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(tempPath, body, { flag: "wx" });
    await rename(tempPath, absolutePath).catch(async (error: unknown) => {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    });
  }

  private resolveStoragePath(storagePath: string): string {
    const normalized = normalizeVaultPath(storagePath);
    const absolutePath = path.resolve(this.root, ...normalized.split("/"));
    const rootWithSeparator = `${this.root}${path.sep}`;

    if (absolutePath !== this.root && !absolutePath.startsWith(rootWithSeparator)) {
      throw new VaultStorageError("outside_root", "Resolved path escapes the storage root.");
    }

    return absolutePath;
  }
}
