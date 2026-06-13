import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface LoginAgentOptions {
  appPath?: string;
}

export function loginAgentPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.nilsthomsen.agent-vault.menu.plist");
}

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export async function installLoginAgent(options: LoginAgentOptions = {}): Promise<string> {
  const appPath = options.appPath ?? path.join(os.homedir(), "Applications", "Agent Vault.app");
  const target = loginAgentPath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nilsthomsen.agent-vault.menu</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>${escapePlist(appPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapePlist(path.join(os.homedir(), ".agent-vault", "logs", "menu.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(path.join(os.homedir(), ".agent-vault", "logs", "menu.err.log"))}</string>
</dict>
</plist>
`,
    { mode: 0o644 },
  );
  return target;
}

export async function uninstallLoginAgent(): Promise<string> {
  const target = loginAgentPath();
  await rm(target, { force: true });
  return target;
}
