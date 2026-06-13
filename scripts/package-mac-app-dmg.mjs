#!/usr/bin/env node
import { cp, mkdir, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.join(repoRoot, "apps/mac-sync/native/build/Agent Vault.app");
const sourceOutput = path.join(repoRoot, "apps/web/public/install/Agent-Vault.dmg");
const liveOutput = path.join(repoRoot, "apps/web/dist/install/Agent-Vault.dmg");

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
  console.warn("Skipping Agent Vault DMG build on non-macOS host.");
  process.exit(0);
}

await stat(appRoot);

const stagingRoot = path.join(os.tmpdir(), `agent-vault-dmg-${Date.now()}`);
try {
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await cp(appRoot, path.join(stagingRoot, "Agent Vault.app"), { recursive: true });
  await symlink("/Applications", path.join(stagingRoot, "Applications"));

  await mkdir(path.dirname(sourceOutput), { recursive: true });
  await rm(sourceOutput, { force: true });
  await run("/usr/bin/hdiutil", [
    "create",
    "-volname",
    "Agent Vault",
    "-srcfolder",
    stagingRoot,
    "-ov",
    "-format",
    "UDZO",
    sourceOutput,
  ]);

  try {
    await mkdir(path.dirname(liveOutput), { recursive: true });
    await cp(sourceOutput, liveOutput);
  } catch (error) {
    if (error instanceof Error) {
      console.warn(`Skipped live DMG copy: ${error.message}`);
    }
  }

  console.log(`Agent Vault DMG written to ${sourceOutput}`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
