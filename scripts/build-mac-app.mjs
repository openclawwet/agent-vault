#!/usr/bin/env node
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(repoRoot, "apps/mac-sync/native");
const appRoot = path.join(nativeRoot, "build/Agent Vault.app");
const executable = path.join(appRoot, "Contents/MacOS/AgentVault");
const resourcesRoot = path.join(appRoot, "Contents/Resources");
const bundledClientRoot = path.join(resourcesRoot, "client");
const bundledBinRoot = path.join(resourcesRoot, "bin");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

if (process.platform !== "darwin") {
  console.warn("Skipping Agent Vault macOS app build on non-macOS host.");
  process.exit(0);
}

await rm(appRoot, { recursive: true, force: true });
await mkdir(path.join(appRoot, "Contents/MacOS"), { recursive: true });
await mkdir(resourcesRoot, { recursive: true });
await mkdir(bundledBinRoot, { recursive: true });

await cp(path.join(nativeRoot, "Info.plist"), path.join(appRoot, "Contents/Info.plist"));
await run("/usr/bin/swiftc", [
  "-O",
  "-framework",
  "Cocoa",
  "-framework",
  "WebKit",
  path.join(nativeRoot, "AgentVaultApp.swift"),
  "-o",
  executable,
]);

async function copyIfPresent(relativePath) {
  const from = path.join(repoRoot, relativePath);
  try {
    await stat(from);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  const to = path.join(bundledClientRoot, relativePath);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

for (const relativePath of [
  "package.json",
  "pnpm-workspace.yaml",
  "apps/mac-sync/package.json",
  "apps/mac-sync/dist",
  "packages/core/package.json",
  "packages/core/dist",
  "packages/sync/package.json",
  "packages/sync/dist",
]) {
  await copyIfPresent(relativePath);
}

await mkdir(path.join(bundledClientRoot, "apps/mac-sync/node_modules/@agent-vault"), { recursive: true });
await mkdir(path.join(bundledClientRoot, "packages/sync/node_modules/@agent-vault"), { recursive: true });
await run("ln", ["-sfn", "../../../../packages/core", path.join(bundledClientRoot, "apps/mac-sync/node_modules/@agent-vault/core")]);
await run("ln", ["-sfn", "../../../../packages/sync", path.join(bundledClientRoot, "apps/mac-sync/node_modules/@agent-vault/sync")]);
await run("ln", ["-sfn", "../../../core", path.join(bundledClientRoot, "packages/sync/node_modules/@agent-vault/core")]);

await writeFile(
  path.join(bundledBinRoot, "agent-vault-sync"),
  `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -P "$(dirname "\${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/../client" >/dev/null 2>&1 && pwd)"
NODE_BIN="\${AGENT_VAULT_NODE_BIN:-}"
if [[ -n "$NODE_BIN" && ! -x "$NODE_BIN" ]]; then
  NODE_BIN=""
fi
if [[ -z "$NODE_BIN" && -f "$HOME/.agent-vault/node-bin" ]]; then
  STORED_NODE_BIN="$(tr -d '\\r\\n' <"$HOME/.agent-vault/node-bin")"
  if [[ -x "$STORED_NODE_BIN" ]]; then
    NODE_BIN="$STORED_NODE_BIN"
  fi
fi
if [[ -z "$NODE_BIN" ]] && command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi
for candidate in \\
  /opt/homebrew/bin/node \\
  /usr/local/bin/node \\
  /usr/bin/node \\
  "$HOME"/.volta/bin/node \\
  "$HOME"/.nvm/versions/node/*/bin/node \\
  "$HOME"/.asdf/installs/nodejs/*/bin/node \\
  "$HOME"/.local/share/mise/installs/node/*/bin/node
do
  if [[ -z "$NODE_BIN" && -x "$candidate" ]]; then
    NODE_BIN="$candidate"
  fi
done
if [[ -n "$NODE_BIN" ]]; then
  export PATH="$(dirname "$NODE_BIN"):$PATH"
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "Agent Vault could not find Node.js from the macOS app. Re-run the Agent Vault installer once from Terminal so it can store the Node path, or install Node via Homebrew/Volta/NVM." >&2
  osascript -e 'display alert "Agent Vault needs Node.js" message "Install Node.js once, then reopen Agent Vault." as warning' >/dev/null 2>&1 || true
  exit 127
fi
exec "$NODE_BIN" "$ROOT_DIR/apps/mac-sync/dist/cli.js" "$@"
`,
  { mode: 0o755 },
);
await run("/bin/chmod", ["+x", path.join(bundledBinRoot, "agent-vault-sync")]);
await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appRoot]);

console.log(`Agent Vault macOS app written to ${appRoot}`);
