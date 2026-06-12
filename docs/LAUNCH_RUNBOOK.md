# Agent Vault Launch Runbook

Agent Vault V1 runs as a private Mac Mini service. MacBook sync and phone access use device tokens and scoped spaces; Tailscale is only the private transport.

## Runtime paths

Default paths:

- home: `~/.agent-vault`
- storage: `~/.agent-vault/storage`
- database: `~/.agent-vault/agent-vault.sqlite`
- local admin token file: `~/.agent-vault/dev-token`
- MacBook sync folder: `~/AgentVault`

Override with:

```bash
AGENT_VAULT_HOME=~/.agent-vault
AGENT_VAULT_STORAGE_ROOT=~/.agent-vault/storage
AGENT_VAULT_DB=~/.agent-vault/agent-vault.sqlite
AGENT_VAULT_HOST=127.0.0.1
AGENT_VAULT_PORT=3474
```

The token file is a local secret and is not included in backups by default.

## First local start

From the repo:

```bash
pnpm install
pnpm build
pnpm dev:server
```

This starts the server in the foreground. Do not leave a production launch dependent on a terminal tab; use the LaunchAgent template only after Nils explicitly approves loading it.

## Device tokens

Create the MacBook token:

```bash
curl -X POST \
  -H "Authorization: Bearer $(cat ~/.agent-vault/dev-token)" \
  -H "content-type: application/json" \
  -d '{"name":"macbook","scopes":[{"space":"MacBook Shared","permissions":["read","write","delete"]},{"space":"Inbox","permissions":["read","write"]}]}' \
  http://127.0.0.1:3474/devices
```

Create the phone token:

```bash
curl -X POST \
  -H "Authorization: Bearer $(cat ~/.agent-vault/dev-token)" \
  -H "content-type: application/json" \
  -d '{"name":"phone","scopes":[{"space":"Inbox","permissions":["read","write"]},{"space":"Projects","permissions":["read"]}]}' \
  http://127.0.0.1:3474/devices
```

Create the Agent Desk token:

```bash
curl -X POST \
  -H "Authorization: Bearer $(cat ~/.agent-vault/dev-token)" \
  -H "content-type: application/json" \
  -d '{"name":"agent-desk","scopes":[{"space":"Inbox","permissions":["read"]},{"space":"Agent Drafts","permissions":["read"]},{"space":"Approvals","permissions":["read"]}]}' \
  http://127.0.0.1:3474/devices
```

Device tokens are shown once. Store them locally, not in docs or chat.

## MacBook sync

One-command install from the MacBook while it is connected to Tailscale:

```bash
curl -fsSL https://mac-mini-von-nils.tail8ca788.ts.net:8476/install/macbook.sh | bash
```

The installer downloads the packaged client from the private Vault URL, initializes `~/AgentVault`, and tries to fetch the MacBook device token from the private live token asset without printing it. It does not require SSH to the Mac Mini. If the private token asset is missing, it prompts for the MacBook device token without echoing input.

Initialize the sync folder on the MacBook:

```bash
pnpm --filter @agent-vault/mac-sync exec agent-vault-sync init \
  --server https://mac-mini-von-nils.tail8ca788.ts.net:8476 \
  --token "<macbook-device-token>" \
  --dir ~/AgentVault \
  --space "MacBook Shared"
```

Daily commands:

```bash
pnpm --filter @agent-vault/mac-sync exec agent-vault-sync status
pnpm --filter @agent-vault/mac-sync exec agent-vault-sync push
pnpm --filter @agent-vault/mac-sync exec agent-vault-sync pull
pnpm --filter @agent-vault/mac-sync exec agent-vault-sync watch
```

Conflicts are written under `~/AgentVault/.agent-vault/conflicts` instead of overwriting edits.

## Phone PWA over Tailscale

The local Tailscale CLI supports:

```bash
tailscale serve --https=8476 --bg 3474
tailscale serve status
```

Use that only after the server is intentionally running. V1 does not use Funnel and does not create public links.

Open the PWA at `https://mac-mini-von-nils.tail8ca788.ts.net:8476/`, enter the phone device token, then use `Inbox` for quick uploads. The built PWA is served by the Agent Vault server; `pnpm dev:web` is only needed for local UI development.

## CB connector

CB uses only the read-only Agent Desk token:

```env
AGENT_VAULT_URL=https://mac-mini-von-nils.tail8ca788.ts.net:8476
AGENT_VAULT_TOKEN=<agent-desk-device-token>
```

The CB browser never receives this token. If the CB daemon is already running, new connector code or env changes need Nils' manual restart approval before they become live.

## Backup

Create a backup:

```bash
pnpm backup --label manual
```

Custom destination:

```bash
pnpm backup --out ~/AgentVaultBackups --label before-launch
```

Each backup contains `storage/`, `agent-vault.sqlite`, and `manifest.json`. The script creates a SQLite snapshot with `VACUUM INTO`, copies the storage root, and verifies that active file and version references in the DB exist with matching hashes in the copied storage.

## Restore

Always inspect first:

```bash
pnpm restore --backup ~/.agent-vault/backups/<backup-dir> --dry-run
```

Restore into empty targets:

```bash
pnpm restore --backup ~/.agent-vault/backups/<backup-dir>
```

If targets already exist and Nils explicitly wants to replace them:

```bash
pnpm restore --backup ~/.agent-vault/backups/<backup-dir> --force
```

`--force` moves existing storage, DB and SQLite sidecars aside with a `.before-restore-*` suffix before placing restored files. The restore script does not load, stop, restart, kickstart or reload any service.

## QA

Run the full V1 local check:

```bash
pnpm build
pnpm smoke:local
pnpm smoke:sync
pnpm smoke:mac-sync
pnpm smoke:web
pnpm smoke:three-device
```

The three-device smoke covers MacBook push/pull, Mac Mini edit roundtrip, phone upload, conflict materialization, trash/restore, token-scope denial, and the read-only Agent Desk connector contract.

## Safety checks

V1 safety expectations:

- no public share links
- no Tailscale Funnel path
- no plaintext device tokens in backups
- device tokens are stored hashed in SQLite
- path traversal uploads are rejected
- CB connector is read-only and server-side
