# Agent Vault

Agent Vault is a private file vault for Nils' own devices first: Mac Mini as server, MacBook as sync client later, and phone access through a private web app later.

The first slice is a local tracer. It proves that a file can be uploaded through an authenticated local API, stored as a normal file, indexed in SQLite, listed, and downloaded byte-for-byte.

## Local tracer

```bash
pnpm install
pnpm build
pnpm smoke:local
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
  "http://127.0.0.1:3474/spaces/default/file?path=docs/readme.md"

curl -H "Authorization: Bearer $(cat ~/.agent-vault/dev-token)" \
  "http://127.0.0.1:3474/spaces/default/files"

curl -H "Authorization: Bearer $(cat ~/.agent-vault/dev-token)" \
  "http://127.0.0.1:3474/spaces/default/file?path=docs/readme.md" \
  -o readme-copy.md
```

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
