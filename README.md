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

Authenticated requests also update lightweight device presence. Any authenticated client can call:

```bash
curl -H "Authorization: Bearer $(cat ~/.agent-vault/dev-token)" \
  http://127.0.0.1:3474/devices/status
```

That returns the Mac Mini Vault server plus known clients with online/recent/offline status, last-seen time and scoped spaces. It never returns device tokens.

## Mac sync CLI

From the MacBook, install the client over the private Tailnet:

```bash
curl -fsSL https://mac-mini-von-nils.tail8ca788.ts.net:8476/install/macbook.sh | bash
```

That creates `~/AgentVault`, downloads the packaged client from the private Vault URL, and initializes sync against the live Agent Vault server. It does not require SSH to the Mac Mini. If the private live token asset is missing, it prompts for the MacBook device token without echoing input.

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
pnpm --filter @agent-vault/mac-sync exec agent-vault-sync ui
```

The CLI keeps sync metadata under `.agent-vault` inside the selected folder and writes conflict review files there instead of overwriting divergent edits. Local scans keep a per-folder hash cache, so unchanged files are not re-read and re-hashed on every sync pass. `watch` follows the main sync folder plus every enabled shared folder from `~/.agent-vault/shares.json`, uses file-system events for local changes, and does not run a timed full-sync loop.

The desktop UI is packaged as a native macOS app and a private DMG at `/install/Agent-Vault.dmg`. The Onecurl installer configures the client and installs `Agent Vault.app` into `/Applications` when possible, falling back to `~/Applications` only without write access. The app bundle carries its own built sync client, starts a private local UI bridge on demand, keeps the device token server-side, adds a macOS menu bar status item, and stays active from the menu bar when the window is closed. The status menu shows connection state, the Mac Mini Vault server, connected clients, recent flow stats, and actions for opening the window, refreshing, syncing now, toggling auto-sync, and saving edited files. Menu status uses a lightweight summary and the hidden window pauses its UI refresh loop, so background mode does not keep repainting the WebView. Auto-sync is optional and event-driven: when enabled, it reacts to local filesystem changes in shared folders and debounces one sync pass; it does not sync on startup, remote polls, UI refreshes, or edited-copy changes. The installer writes a user LaunchAgent so the menu bar app can start on the next login; it does not load or restart services during install. The window lets the user add shared folders through a native macOS folder picker, queue an initial sync without blocking the UI, create empty shared folders through a hidden marker file, open folders in Finder, and browse shared folders with lazy local/remote folder listings instead of capped summary trees. Shares can be `readonly`, `writeonly`, or `readwrite`; the sync direction follows that mode. Drag-out is copy-safe through a local file URL when the file is local and a download payload when it is remote, not a move of the source file. Native macOS drops pass real file URLs to the local bridge, so dropped folders become persistent shares and dropped files go into the currently open writable Vault folder, falling back to `Desktop Drops`. Remote files with write permission open as tracked edit copies under `~/.agent-vault/edits`; only `save edits` writes them back, and it does so only if the remote hash still matches. Share prefixes are ignored by the main `~/AgentVault` sync so shared folders do not duplicate back into the main folder. `agent-vault-sync ui --browser` is only a debug fallback.

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
