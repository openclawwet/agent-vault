#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-vault-client-package-"));
const packageRoot = path.join(tempRoot, "agent-vault-client");
const sourceOutput = path.join(repoRoot, "apps/web/public/install/agent-vault-macbook-client.tar.gz");
const liveOutput = path.join(repoRoot, "apps/web/dist/install/agent-vault-macbook-client.tar.gz");
const sourceInstaller = path.join(repoRoot, "apps/web/public/install/macbook.sh");
const liveInstaller = path.join(repoRoot, "apps/web/dist/install/macbook.sh");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
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

async function copyRequired(relativePath) {
  const from = path.join(repoRoot, relativePath);
  const to = path.join(packageRoot, relativePath);
  await stat(from);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

try {
  await mkdir(packageRoot, { recursive: true });
  for (const relativePath of [
    "package.json",
    "pnpm-workspace.yaml",
    "apps/mac-sync/package.json",
    "apps/mac-sync/dist",
    "apps/mac-sync/native/build/Agent Vault.app",
    "packages/core/package.json",
    "packages/core/dist",
    "packages/sync/package.json",
    "packages/sync/dist",
  ]) {
    await copyRequired(relativePath);
  }

  await mkdir(path.dirname(sourceOutput), { recursive: true });
  await run("tar", ["-czf", sourceOutput, "-C", tempRoot, "agent-vault-client"]);

  try {
    await mkdir(path.dirname(liveOutput), { recursive: true });
    await cp(sourceOutput, liveOutput);
    await cp(sourceInstaller, liveInstaller);
  } catch (error) {
    if (error instanceof Error) {
      console.warn(`Skipped live dist package copy: ${error.message}`);
    }
  }

  console.log(`MacBook client package written to ${sourceOutput}`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
