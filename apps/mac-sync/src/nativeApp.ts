import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeAppOptions {
  appPath?: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function distRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function defaultNativeAppPaths(appPath?: string): string[] {
  const home = os.homedir();
  return [
    appPath,
    process.env.AGENT_VAULT_APP_PATH,
    path.join("/Applications", "Agent Vault.app"),
    path.join(home, "Applications", "Agent Vault.app"),
    path.join(distRoot(), "..", "native", "build", "Agent Vault.app"),
    path.join(process.cwd(), "apps", "mac-sync", "native", "build", "Agent Vault.app"),
  ].filter((value): value is string => Boolean(value));
}

export async function openNativeDesktopApp(options: NativeAppOptions = {}): Promise<string | undefined> {
  for (const candidate of defaultNativeAppPaths(options.appPath)) {
    if (!(await exists(candidate))) {
      continue;
    }

    const child = spawn("open", [candidate], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return candidate;
  }

  return undefined;
}
