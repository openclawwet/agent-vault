#!/usr/bin/env node
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(repoRoot, "apps/mac-sync/native");
const appRoot = path.join(nativeRoot, "build/Agent Vault.app");
const executable = path.join(appRoot, "Contents/MacOS/AgentVault");

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
await mkdir(path.join(appRoot, "Contents/Resources"), { recursive: true });

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

console.log(`Agent Vault macOS app written to ${appRoot}`);
