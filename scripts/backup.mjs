#!/usr/bin/env node
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  createSqliteSnapshot,
  pathExists,
  resolveRuntimePaths,
  sanitizeLabel,
  timestampId,
  verifyBackup,
  writeJson,
} from "./lib/backup-core.mjs";

function usage() {
  return `Usage: pnpm backup [--out <dir>] [--label <name>] [--home <dir>] [--storage-root <dir>] [--db <file>]

Creates an Agent Vault backup with:
  storage/              recursive copy of the vault storage root
  agent-vault.sqlite    SQLite snapshot made with VACUUM INTO
  manifest.json         non-secret metadata and consistency stats

The script does not copy dev-token or print secrets.`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (["--out", "--label", "--home", "--storage-root", "--db"].includes(arg)) {
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

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const runtime = resolveRuntimePaths({
  homeDir: args.home,
  storageRoot: args["storage-root"],
  dbPath: args.db,
});

if (!(await pathExists(runtime.dbPath))) {
  throw new Error(`Agent Vault database was not found: ${runtime.dbPath}`);
}

const label = sanitizeLabel(args.label);
const backupRoot = path.resolve(args.out ?? path.join(runtime.homeDir, "backups"));
const backupDir = path.join(backupRoot, `agent-vault-${timestampId()}-${label}`);
const storageBackupRoot = path.join(backupDir, "storage");
const dbBackupPath = path.join(backupDir, "agent-vault.sqlite");

if (await pathExists(backupDir)) {
  throw new Error(`Backup directory already exists: ${backupDir}`);
}

try {
  await mkdir(backupDir, { recursive: true });
  await createSqliteSnapshot(runtime.dbPath, dbBackupPath);

  if (await pathExists(runtime.storageRoot)) {
    await cp(runtime.storageRoot, storageBackupRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  } else {
    await mkdir(storageBackupRoot, { recursive: true });
  }

  const verification = await verifyBackup(backupDir);
  const manifest = {
    schema: 1,
    createdAt: new Date().toISOString(),
    label,
    source: {
      homeDir: runtime.homeDir,
      storageRoot: runtime.storageRoot,
      dbPath: runtime.dbPath,
    },
    files: {
      storage: "storage",
      sqlite: "agent-vault.sqlite",
    },
    verification,
    notes: [
      "No dev-token or plaintext device token is included.",
      "Restore onto an empty target or use --force to move existing targets aside first.",
    ],
  };

  await writeJson(path.join(backupDir, "manifest.json"), manifest);
  console.log(JSON.stringify({ ok: true, backupDir, verification }, null, 2));
} catch (error) {
  await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  throw error;
}
