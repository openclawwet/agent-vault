# Agent Vault

Agent Vault is a private file vault for Nils' own devices first: Mac Mini as server, MacBook as sync client, and phone access through a private web app.

The first slice is a local tracer. It proves that a file can be uploaded through an authenticated local API, stored as a normal file, indexed in SQLite, listed, and downloaded byte-for-byte.

## Local tracer

```bash
pnpm install
pnpm build
pnpm smoke:local
pnpm smoke:mac-sync
pnpm smoke:web
pnpm smoke:three-device
```

Start the server:

```bash
pnpm dev:server
```

By default the server uses `~/.agent-vault`:

- `~/.agent-vault/storage` for files
- `~/.agent-vault/agent-vault.sqlite` for metadata
- `~/.agent-vault/dev-token` for the local bearer token

The token is created on first run with file mode `0600` and is never printed by the server.

## API

All endpoints except health require `Authorization: Bearer <token>`.

```bash
curl http://127.0.0.1:3474/health
curl -H "Authorization: Bearer $(cat ~/.agent-vault/dev-token)" http://127.0.0.1:3474/spaces

curl -X PUT \
  -H "Authorization: Bearer $(cat ~/.agent-vault/dev-token)" \
  --data-binary @README.md \
  "http://127.0.0.1:3474/spaces/Inbox/file?path=docs/readme.md"

curl -H "Authorization: Bearer $(cat ~/.agent-vault/dev-token)" \
  "http://127.0.0.1:3474/spaces/Inbox/files"

curl -H "Authorization: Bearer $(cat ~/.agent-vault/dev-token)" \
  "http://127.0.0.1:3474/spaces/Inbox/file?path=docs/readme.md" \
  -o readme-copy.md
```

Create a scoped device token:

```bash
curl -X POST \
  -H "Authorization: Bearer $(cat ~/.agent-vault/dev-token)" \
  -H "content-type: application/json" \
  -d '{"name":"macbook","scopes":[{"space":"Inbox","permissions":["read","write"]}]}' \
  http://127.0.0.1:3474/devices
```

Device tokens are stored hashed in SQLite and returned only once when created or rotated.

## Mac sync CLI

From the MacBook, install the client over the private Tailnet:

```bash
curl -fsSL https://mac-mini-von-nils.tail8ca788.ts.net:8476/install/macbook.sh | bash
```

That creates `~/AgentVault`, copies the client from the Mac Mini over SSH, and initializes sync against the live Agent Vault server.

```bash
pnpm --filter @agent-vault/mac-sync build
pnpm --filter @agent-vault/mac-sync exec agent-vault-sync init \
  --server http://127.0.0.1:3474 \
  --token "$(cat ~/.agent-vault/dev-token)" \
  --dir ~/AgentVault \
  --space Inbox

pnpm --filter @agent-vault/mac-sync exec agent-vault-sync status
pnpm --filter @agent-vault/mac-sync exec agent-vault-sync push
pnpm --filter @agent-vault/mac-sync exec agent-vault-sync pull
pnpm --filter @agent-vault/mac-sync exec agent-vault-sync watch
```

The CLI keeps sync metadata under `.agent-vault` inside the selected folder and writes conflict review files there instead of overwriting divergent edits.

## Phone PWA

Create a scoped phone token with read/write access to `Inbox`:

```bash
curl -X POST \
  -H "Authorization: Bearer $(cat ~/.agent-vault/dev-token)" \
  -H "content-type: application/json" \
  -d '{"name":"phone","scopes":[{"space":"Inbox","permissions":["read","write"]},{"space":"Projects","permissions":["read"]}]}' \
  http://127.0.0.1:3474/devices
```

In live local use, the built PWA is served by the Agent Vault server:

```bash
open https://mac-mini-von-nils.tail8ca788.ts.net:8476/
```

Start the separate web app only during UI development:

```bash
pnpm dev:web
```

The phone UI connects with the server URL and the one-time device token. It shows only spaces allowed by that token, uploads files into the selected space, previews images/PDFs/text files, and downloads files through authenticated API calls. V1 has no public share links and no Tailscale Funnel path.

## Configuration

```bash
AGENT_VAULT_HOST=127.0.0.1
AGENT_VAULT_PORT=3474
AGENT_VAULT_HOME=~/.agent-vault
AGENT_VAULT_STORAGE_ROOT=~/.agent-vault/storage
AGENT_VAULT_DB=~/.agent-vault/agent-vault.sqlite
AGENT_VAULT_TOKEN=optional-local-token
```

V1 has no public links and no cloud storage dependency.

## Backup, restore and launch

Runbook: [docs/LAUNCH_RUNBOOK.md](docs/LAUNCH_RUNBOOK.md).

Create a local backup:

```bash
pnpm backup --label manual
```

Inspect a restore before writing:

```bash
pnpm restore --backup ~/.agent-vault/backups/<backup-dir> --dry-run
```

The backup includes the storage root, a SQLite snapshot, and a non-secret manifest. It does not include `dev-token` or plaintext device tokens. A LaunchAgent plist template is prepared under `docs/launchd/`, but loading or restarting it is a manual step.
