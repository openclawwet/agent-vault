import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ShareRecord {
  id: string;
  label: string;
  localDir: string;
  space: string;
  remotePathPrefix: string;
  access: ShareAccessMode;
  ignoreNames: string[];
  ignorePathPrefixes: string[];
  enabled: boolean;
  createdAt: string;
}

export type ShareAccessMode = "readwrite" | "readonly" | "writeonly";

export interface ShareConfig {
  shares: ShareRecord[];
}

export interface AddShareInput {
  localDir: string;
  label?: string;
  space: string;
  remotePathPrefix?: string;
  access?: ShareAccessMode;
  ignoreNames?: string[];
  ignorePathPrefixes?: string[];
}

export interface UpdateShareInput {
  access?: ShareAccessMode;
  enabled?: boolean;
  label?: string;
}

export const DEFAULT_SHARE_IGNORE_NAMES = [
  ".DS_Store",
  ".agent-vault",
  ".cache",
  ".git",
  ".next",
  ".playwright-cli",
  ".playwright-mcp",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
] as const;

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function defaultShareConfigPath(): string {
  return process.env.AGENT_VAULT_SHARES_CONFIG ?? path.join(os.homedir(), ".agent-vault", "shares.json");
}

export function safeVaultPrefix(value: string): string {
  const normalized = value
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/[^A-Za-z0-9._ -]/g, "-").replace(/\s+/g, " "))
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
  return normalized || "Shared Folder";
}

function defaultLabel(localDir: string): string {
  return path.basename(path.resolve(localDir)) || "Shared Folder";
}

export function normalizeShareAccess(value: unknown): ShareAccessMode {
  if (value === "readonly" || value === "writeonly" || value === "readwrite") {
    return value;
  }
  return "readwrite";
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => String(item ?? "").replaceAll("\\", "/").trim())
        .filter(Boolean)
        .filter((item) => !item.includes("\0") && item !== "." && item !== ".."),
    ),
  ];
}

export async function loadShareConfig(configPath = defaultShareConfigPath()): Promise<ShareConfig> {
  try {
    const body = await readFile(path.resolve(expandHome(configPath)), "utf8");
    const parsed = JSON.parse(body) as ShareConfig;
    return {
      shares: (parsed.shares ?? []).map((share) => ({
        ...share,
        localDir: path.resolve(expandHome(share.localDir)),
        remotePathPrefix: safeVaultPrefix(share.remotePathPrefix || share.label),
        access: normalizeShareAccess((share as Partial<ShareRecord>).access),
        ignoreNames: [
          ...new Set([...DEFAULT_SHARE_IGNORE_NAMES, ...normalizeList((share as Partial<ShareRecord>).ignoreNames)]),
        ],
        ignorePathPrefixes: normalizeList((share as Partial<ShareRecord>).ignorePathPrefixes),
        enabled: share.enabled !== false,
      })),
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return { shares: [] };
  }
}

export async function saveShareConfig(config: ShareConfig, configPath = defaultShareConfigPath()): Promise<void> {
  const target = path.resolve(expandHome(configPath));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export async function addShare(input: AddShareInput, configPath = defaultShareConfigPath()): Promise<ShareRecord> {
  const localDir = path.resolve(expandHome(input.localDir));
  const folderStat = await stat(localDir);
  if (!folderStat.isDirectory()) {
    throw new Error("Shared path must be a folder.");
  }

  const current = await loadShareConfig(configPath);
  const existing = current.shares.find((share) => share.localDir === localDir);
  if (existing) {
    return existing;
  }

  const label = (input.label?.trim() || defaultLabel(localDir)).slice(0, 80);
  const share: ShareRecord = {
    id: randomUUID(),
    label,
    localDir,
    space: input.space,
    remotePathPrefix: safeVaultPrefix(input.remotePathPrefix || label),
    access: normalizeShareAccess(input.access),
    ignoreNames: [...new Set([...DEFAULT_SHARE_IGNORE_NAMES, ...normalizeList(input.ignoreNames)])],
    ignorePathPrefixes: normalizeList(input.ignorePathPrefixes),
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  current.shares.push(share);
  await saveShareConfig(current, configPath);
  return share;
}

export async function updateShare(id: string, input: UpdateShareInput, configPath = defaultShareConfigPath()): Promise<ShareRecord> {
  const current = await loadShareConfig(configPath);
  const index = current.shares.findIndex((share) => share.id === id);
  if (index === -1) {
    throw new Error("Shared folder was not found.");
  }

  const share = current.shares[index]!;
  const next: ShareRecord = {
    ...share,
    access: input.access ? normalizeShareAccess(input.access) : share.access,
    enabled: typeof input.enabled === "boolean" ? input.enabled : share.enabled,
    label: typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 80) : share.label,
  };
  current.shares[index] = next;
  await saveShareConfig(current, configPath);
  return next;
}

export async function removeShare(id: string, configPath = defaultShareConfigPath()): Promise<boolean> {
  const current = await loadShareConfig(configPath);
  const next = current.shares.filter((share) => share.id !== id);
  if (next.length === current.shares.length) {
    return false;
  }
  await saveShareConfig({ shares: next }, configPath);
  return true;
}
