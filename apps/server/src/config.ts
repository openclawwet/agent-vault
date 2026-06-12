import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface AgentVaultConfig {
  host: string;
  port: number;
  homeDir: string;
  storageRoot: string;
  dbPath: string;
  token: string;
}

export interface AgentVaultConfigOverrides {
  host?: string;
  port?: number;
  homeDir?: string;
  storageRoot?: string;
  dbPath?: string;
  token?: string;
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

async function ensureLocalToken(homeDir: string): Promise<string> {
  const tokenPath = path.join(homeDir, "dev-token");

  try {
    return (await readFile(tokenPath, "utf8")).trim();
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(homeDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
  return token;
}

function parsePort(input: string | undefined): number {
  if (!input) {
    return 3474;
  }

  const port = Number.parseInt(input, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("AGENT_VAULT_PORT must be a valid TCP port.");
  }
  return port;
}

export async function resolveConfig(overrides: AgentVaultConfigOverrides = {}): Promise<AgentVaultConfig> {
  const homeDir = path.resolve(
    expandHome(overrides.homeDir ?? process.env.AGENT_VAULT_HOME ?? "~/.agent-vault"),
  );
  const storageRoot = path.resolve(
    expandHome(overrides.storageRoot ?? process.env.AGENT_VAULT_STORAGE_ROOT ?? path.join(homeDir, "storage")),
  );
  const dbPath = path.resolve(
    expandHome(overrides.dbPath ?? process.env.AGENT_VAULT_DB ?? path.join(homeDir, "agent-vault.sqlite")),
  );
  const token = overrides.token ?? process.env.AGENT_VAULT_TOKEN ?? (await ensureLocalToken(homeDir));

  if (!token.trim()) {
    throw new Error("Agent Vault token must not be empty.");
  }

  return {
    host: overrides.host ?? process.env.AGENT_VAULT_HOST ?? "127.0.0.1",
    port: overrides.port ?? parsePort(process.env.AGENT_VAULT_PORT),
    homeDir,
    storageRoot,
    dbPath,
    token,
  };
}
