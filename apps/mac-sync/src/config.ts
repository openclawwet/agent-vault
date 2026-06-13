import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SPACE } from "@agent-vault/core";

const DEFAULT_SERVER_URL = "https://mac-mini-von-nils.tail8ca788.ts.net:8476";

export interface MacSyncConfig {
  serverUrl: string;
  token: string;
  deviceId: string;
  localDir: string;
  space: string;
  remotePathPrefix?: string;
  ignoreRemotePathPrefixes?: string[];
  localIgnoreNames?: string[];
  localIgnorePathPrefixes?: string[];
}

export interface InitConfigInput {
  serverUrl: string;
  token: string;
  localDir?: string;
  space?: string;
  configPath?: string;
}

export function defaultLocalDir(): string {
  return path.join(os.homedir(), "AgentVault");
}

export function defaultConfigPath(): string {
  return process.env.AGENT_VAULT_SYNC_CONFIG ?? path.join(os.homedir(), ".agent-vault", "mac-sync.json");
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<MacSyncConfig> {
  const body = await readFile(expandHome(configPath), "utf8");
  const parsed = JSON.parse(body) as MacSyncConfig;
  return {
    ...parsed,
    localDir: path.resolve(expandHome(parsed.localDir)),
    remotePathPrefix: parsed.remotePathPrefix?.trim() || undefined,
    ignoreRemotePathPrefixes: parsed.ignoreRemotePathPrefixes?.map((value) => value.trim()).filter(Boolean),
    localIgnoreNames: parsed.localIgnoreNames?.map((value) => value.trim()).filter(Boolean),
    localIgnorePathPrefixes: parsed.localIgnorePathPrefixes?.map((value) => value.trim()).filter(Boolean),
  };
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

async function bootstrapToken(serverUrl: string): Promise<string> {
  const explicit = process.env.AGENT_VAULT_TOKEN?.trim();
  if (explicit) return explicit;

  const tokenUrl = process.env.AGENT_VAULT_TOKEN_URL?.trim() || `${serverUrl}/install/macbook.token`;
  try {
    return await fetchText(tokenUrl);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Agent Vault is not configured yet and could not fetch a MacBook token from ${tokenUrl}: ${reason}`);
  }
}

export async function loadOrInitConfig(configPath = defaultConfigPath()): Promise<MacSyncConfig> {
  try {
    return await loadConfig(configPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || process.env.AGENT_VAULT_AUTO_INIT === "0") {
      throw error;
    }
  }

  const serverUrl = (process.env.AGENT_VAULT_SERVER_URL || DEFAULT_SERVER_URL).replace(/\/$/, "");
  const token = await bootstrapToken(serverUrl);
  if (!token) {
    throw new Error("Agent Vault is not configured yet and the MacBook token was empty.");
  }

  const initialized = await initConfig({
    serverUrl,
    token,
    localDir: process.env.AGENT_VAULT_SYNC_DIR,
    space: process.env.AGENT_VAULT_SYNC_SPACE ?? "MacBook Shared",
    configPath,
  });
  return initialized.config;
}

export async function initConfig(input: InitConfigInput): Promise<{ config: MacSyncConfig; configPath: string }> {
  const configPath = path.resolve(expandHome(input.configPath ?? defaultConfigPath()));
  const config: MacSyncConfig = {
    serverUrl: input.serverUrl.replace(/\/$/, ""),
    token: input.token,
    deviceId: randomUUID(),
    localDir: path.resolve(expandHome(input.localDir ?? defaultLocalDir())),
    space: input.space ?? DEFAULT_SPACE,
  };

  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(config.localDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { config, configPath };
}
