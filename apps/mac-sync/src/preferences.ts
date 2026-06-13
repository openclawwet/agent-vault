import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface AgentVaultPreferences {
  autoSyncEnabled: boolean;
}

export interface AgentVaultPreferencePatch {
  autoSyncEnabled?: boolean;
}

const DEFAULT_PREFERENCES: AgentVaultPreferences = {
  autoSyncEnabled: true,
};

export function defaultPreferencesPath(): string {
  return process.env.AGENT_VAULT_PREFERENCES ?? path.join(os.homedir(), ".agent-vault", "preferences.json");
}

export async function loadPreferences(preferencesPath = defaultPreferencesPath()): Promise<AgentVaultPreferences> {
  try {
    const body = await readFile(preferencesPath, "utf8");
    const parsed = JSON.parse(body) as Partial<AgentVaultPreferences>;
    return {
      autoSyncEnabled:
        typeof parsed.autoSyncEnabled === "boolean" ? parsed.autoSyncEnabled : DEFAULT_PREFERENCES.autoSyncEnabled,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return { ...DEFAULT_PREFERENCES };
  }
}

export async function savePreferences(
  preferences: AgentVaultPreferences,
  preferencesPath = defaultPreferencesPath(),
): Promise<void> {
  await mkdir(path.dirname(preferencesPath), { recursive: true });
  await writeFile(preferencesPath, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
}

export async function updatePreferences(patch: AgentVaultPreferencePatch): Promise<AgentVaultPreferences> {
  const current = await loadPreferences();
  const next: AgentVaultPreferences = {
    ...current,
    autoSyncEnabled:
      typeof patch.autoSyncEnabled === "boolean" ? patch.autoSyncEnabled : current.autoSyncEnabled,
  };
  await savePreferences(next);
  return next;
}
