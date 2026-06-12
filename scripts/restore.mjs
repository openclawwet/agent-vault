#!/usr/bin/env node
import { cp, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { pathExists, resolveRuntimePaths, timestampId, verifyBackup } from "./lib/backup-core.mjs";

function usage() {
  return `Usage: pnpm restore --backup <dir> [--dry-run] [--force] [--home <dir>] [--storage-root <dir>] [--db <file>]

Restores storage/ and agent-vault.sqlite from an Agent Vault backup.
By default the restore refuses to overwrite existing targets. With --force,
existing targets are moved aside with a .before-restore-* suffix first.
The script never loads, restarts, or stops Agent Vault services.`;
}

function parseArgs(argv) {
  const args = { dryRun: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--force") {
      args.force = true;
      continue;
    }
    if (["--backup", "--home", "--storage-root", "--db"].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      args[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function assertReasonableTarget(targetPath, label) {
  const resolved = path.resolve(targetPath);
  if (resolved === "/" || resolved.length < 8) {
    throw new Error(`Refusing unsafe ${label} target: ${resolved}`);
  }
  return resolved;
}

async function assertWritableTarget(targetPath, label, force) {
  const exists = await pathExists(targetPath);
  if (exists && !force) {
    throw new Error(`${label} already exists: ${targetPath}. Re-run with --force to move it aside first.`);
  }
}

async function moveAsideIfExists(targetPath, stamp) {
  if (!(await pathExists(targetPath))) return null;
  const movedPath = `${targetPath}.before-restore-${stamp}`;
  if (await pathExists(movedPath)) {
    throw new Error(`Move-aside path already exists: ${movedPath}`);
  }
  await rename(targetPath, movedPath);
  return movedPath;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (!args.backup) {
  throw new Error("--backup is required.");
}

const backupDir = path.resolve(args.backup);
const storageBackupRoot = path.join(backupDir, "storage");
const dbBackupPath = path.join(backupDir, "agent-vault.sqlite");
const runtime = resolveRuntimePaths({
  homeDir: args.home,
  storageRoot: args["storage-root"],
  dbPath: args.db,
});

const targetStorageRoot = assertReasonableTarget(runtime.storageRoot, "storage");
const targetDbPath = assertReasonableTarget(runtime.dbPath, "database");
const targetDbWal = `${targetDbPath}-wal`;
const targetDbShm = `${targetDbPath}-shm`;
const stamp = timestampId();

const verification = await verifyBackup(backupDir);

await assertWritableTarget(targetStorageRoot, "Storage root", args.force);
await assertWritableTarget(targetDbPath, "Database", args.force);
await assertWritableTarget(targetDbWal, "Database WAL sidecar", args.force);
await assertWritableTarget(targetDbShm, "Database SHM sidecar", args.force);

const plan = {
  ok: true,
  dryRun: args.dryRun,
  backupDir,
  target: {
    storageRoot: targetStorageRoot,
    dbPath: targetDbPath,
  },
  force: args.force,
  verification,
  note: "dev-token is not restored. Use AGENT_VAULT_TOKEN or let the server create a fresh local token on next start.",
};

if (args.dryRun) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

const tempStorageRoot = path.join(path.dirname(targetStorageRoot), `.agent-vault-restore-storage-${stamp}`);
const tempDbPath = path.join(path.dirname(targetDbPath), `.agent-vault-restore-${stamp}.sqlite`);

await mkdir(path.dirname(targetStorageRoot), { recursive: true });
await mkdir(path.dirname(targetDbPath), { recursive: true });
await cp(storageBackupRoot, tempStorageRoot, { recursive: true, force: false, errorOnExist: true });
await cp(dbBackupPath, tempDbPath, { force: false, errorOnExist: true });

const movedAside = [];
for (const targetPath of [targetDbWal, targetDbShm, targetDbPath, targetStorageRoot]) {
  const movedPath = await moveAsideIfExists(targetPath, stamp);
  if (movedPath) movedAside.push({ from: targetPath, to: movedPath });
}

await rename(tempStorageRoot, targetStorageRoot);
await rename(tempDbPath, targetDbPath);

console.log(JSON.stringify({ ...plan, movedAside }, null, 2));
