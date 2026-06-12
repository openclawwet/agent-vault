#!/usr/bin/env bash
set -euo pipefail

SERVER_URL="${AGENT_VAULT_SERVER_URL:-https://mac-mini-von-nils.tail8ca788.ts.net:8476}"
PACKAGE_URL="${AGENT_VAULT_PACKAGE_URL:-$SERVER_URL/install/agent-vault-macbook-client.tar.gz}"
TOKEN_URL="${AGENT_VAULT_TOKEN_URL:-$SERVER_URL/install/macbook.token}"
INSTALL_DIR="${AGENT_VAULT_INSTALL_DIR:-$HOME/.agent-vault/client/agent-vault}"
SYNC_DIR="${AGENT_VAULT_SYNC_DIR:-$HOME/AgentVault}"
SYNC_SPACE="${AGENT_VAULT_SYNC_SPACE:-MacBook Shared}"

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    return 1
  fi
}

need_command curl
need_command tar
need_command node

if [[ -z "$INSTALL_DIR" || "$INSTALL_DIR" == "/" ]]; then
  echo "Unsafe install directory." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$(dirname "$INSTALL_DIR")" "$SYNC_DIR" "$HOME/.agent-vault/bin"

echo "Installing Agent Vault MacBook client from private Vault URL..."
curl -fsSL "$PACKAGE_URL" -o "$TMP_DIR/client.tar.gz"
tar -xzf "$TMP_DIR/client.tar.gz" -C "$TMP_DIR"

if [[ ! -d "$TMP_DIR/agent-vault-client" ]]; then
  echo "Client package is invalid." >&2
  exit 1
fi

rm -rf "$INSTALL_DIR"
mv "$TMP_DIR/agent-vault-client" "$INSTALL_DIR"

mkdir -p "$INSTALL_DIR/apps/mac-sync/node_modules/@agent-vault"
mkdir -p "$INSTALL_DIR/packages/sync/node_modules/@agent-vault"
mkdir -p "$INSTALL_DIR/bin"
ln -sfn "../../../../packages/core" "$INSTALL_DIR/apps/mac-sync/node_modules/@agent-vault/core"
ln -sfn "../../../../packages/sync" "$INSTALL_DIR/apps/mac-sync/node_modules/@agent-vault/sync"
ln -sfn "../../../core" "$INSTALL_DIR/packages/sync/node_modules/@agent-vault/core"

cat >"$INSTALL_DIR/bin/agent-vault-sync" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  if [[ "$SOURCE" != /* ]]; then
    SOURCE="$SOURCE_DIR/$SOURCE"
  fi
done
ROOT_DIR="$(cd -P "$(dirname "$SOURCE")/.." >/dev/null 2>&1 && pwd)"
exec node "$ROOT_DIR/apps/mac-sync/dist/cli.js" "$@"
SCRIPT
chmod +x "$INSTALL_DIR/bin/agent-vault-sync"
ln -sfn "$INSTALL_DIR/bin/agent-vault-sync" "$HOME/.agent-vault/bin/agent-vault-sync"

TOKEN="${AGENT_VAULT_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(curl -fsSL "$TOKEN_URL" 2>/dev/null | tr -d '\r\n' || true)"
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

"$INSTALL_DIR/bin/agent-vault-sync" init \
  --server "$SERVER_URL" \
  --token "$TOKEN" \
  --dir "$SYNC_DIR" \
  --space "$SYNC_SPACE" >/dev/null

"$INSTALL_DIR/bin/agent-vault-sync" status

cat <<EOF

Agent Vault MacBook client is installed.
Sync folder: $SYNC_DIR
Server: $SERVER_URL

Daily commands:
  "$HOME/.agent-vault/bin/agent-vault-sync" push
  "$HOME/.agent-vault/bin/agent-vault-sync" pull
  "$HOME/.agent-vault/bin/agent-vault-sync" watch
  "$HOME/.agent-vault/bin/agent-vault-sync" ui
EOF
