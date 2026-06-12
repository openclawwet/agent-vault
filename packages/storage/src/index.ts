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

  async writeFile(spaceInput: string, pathInput: string, body: Buffer): Promise<StoredFileWrite> {
    const space = normalizeSpaceName(spaceInput);
    const vaultPath = normalizeVaultPath(pathInput);
    const absolutePath = this.resolveSpacePath(space, vaultPath);
    const tempPath = `${absolutePath}.agent-vault-${process.pid}-${randomUUID()}.tmp`;

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(tempPath, body, { flag: "wx" });
    await rename(tempPath, absolutePath).catch(async (error: unknown) => {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    });

    return {
      space,
      path: vaultPath,
      absolutePath,
      storagePath: path.posix.join("spaces", space, vaultPath),
      size: body.byteLength,
      sha256: sha256Buffer(body),
    };
  }

  async readFile(spaceInput: string, pathInput: string): Promise<Buffer> {
    const absolutePath = this.resolveSpacePath(spaceInput, pathInput);
    return readFile(absolutePath);
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
}
