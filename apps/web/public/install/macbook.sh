#!/usr/bin/env bash
set -euo pipefail

SERVER_URL="${AGENT_VAULT_SERVER_URL:-https://mac-mini-von-nils.tail8ca788.ts.net:8476}"
SOURCE_HOST="${AGENT_VAULT_SOURCE_HOST:-mac-mini-von-nils}"
SOURCE_DIR="${AGENT_VAULT_SOURCE_DIR:-/Users/nilsmacmini/agent-vault}"
INSTALL_DIR="${AGENT_VAULT_INSTALL_DIR:-$HOME/.agent-vault/client/agent-vault}"
SYNC_DIR="${AGENT_VAULT_SYNC_DIR:-$HOME/AgentVault}"
SYNC_SPACE="${AGENT_VAULT_SYNC_SPACE:-MacBook Shared}"

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    return 1
  fi
}

need_command ssh
need_command rsync
need_command node

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
fi

need_command pnpm

mkdir -p "$INSTALL_DIR" "$SYNC_DIR" "$HOME/.agent-vault"

echo "Installing Agent Vault MacBook client from $SOURCE_HOST..."
rsync -az --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "*/node_modules" \
  --exclude "apps/web/dist" \
  "$SOURCE_HOST:$SOURCE_DIR/" \
  "$INSTALL_DIR/"

cd "$INSTALL_DIR"
pnpm install --silent
pnpm --filter @agent-vault/mac-sync build >/dev/null

TOKEN="${AGENT_VAULT_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(ssh "$SOURCE_HOST" 'cat "$HOME/.agent-vault/device-tokens/macbook.token" 2>/dev/null' || true)"
fi

if [[ -z "$TOKEN" ]]; then
  printf "MacBook device token: "
  IFS= read -rs TOKEN
  printf "\n"
fi

if [[ -z "$TOKEN" ]]; then
  echo "No device token provided." >&2
  exit 1
fi

pnpm --filter @agent-vault/mac-sync exec agent-vault-sync init \
  --server "$SERVER_URL" \
  --token "$TOKEN" \
  --dir "$SYNC_DIR" \
  --space "$SYNC_SPACE" >/dev/null

pnpm --filter @agent-vault/mac-sync exec agent-vault-sync status

cat <<EOF

Agent Vault MacBook client is installed.
Sync folder: $SYNC_DIR
Server: $SERVER_URL

Daily commands:
  cd "$INSTALL_DIR"
  pnpm --filter @agent-vault/mac-sync exec agent-vault-sync push
  pnpm --filter @agent-vault/mac-sync exec agent-vault-sync pull
  pnpm --filter @agent-vault/mac-sync exec agent-vault-sync watch
EOF
