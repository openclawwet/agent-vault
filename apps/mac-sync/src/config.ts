import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SPACE } from "@agent-vault/core";

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
