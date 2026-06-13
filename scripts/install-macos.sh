#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-client}"
if [[ $# -gt 0 ]]; then
  shift
fi

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
DEFAULT_SERVER_URL="https://mac-mini-von-nils.tail8ca788.ts.net:8476"

usage() {
  cat <<'USAGE'
Usage:
  scripts/install-macos.sh client [--server URL] [--token TOKEN] [--sync-dir PATH] [--space NAME]
  scripts/install-macos.sh server
  scripts/install-macos.sh deps

Modes:
  client  Install dependencies, build the macOS app/DMG, install Agent Vault.app, and init sync.
  server  Install dependencies and build the server/web/client packages. Does not start or restart services.
  deps    Install dependencies only.

Environment overrides:
  AGENT_VAULT_SERVER_URL
  AGENT_VAULT_TOKEN
  AGENT_VAULT_SYNC_DIR
  AGENT_VAULT_SYNC_SPACE
  AGENT_VAULT_APP_PATH
USAGE
}

if [[ "$MODE" == "-h" || "$MODE" == "--help" || "$MODE" == "help" ]]; then
  usage
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)
      export AGENT_VAULT_SERVER_URL="$2"
      shift 2
      ;;
    --token)
      export AGENT_VAULT_TOKEN="$2"
      shift 2
      ;;
    --sync-dir)
      export AGENT_VAULT_SYNC_DIR="$2"
      shift 2
      ;;
    --space)
      export AGENT_VAULT_SYNC_SPACE="$2"
      shift 2
      ;;
    --app)
      export AGENT_VAULT_APP_PATH="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare pnpm@10.33.3 --activate
  fi

  need_command pnpm
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Agent Vault native install currently requires macOS." >&2
  exit 1
fi

need_command node
need_command curl
need_command tar
ensure_pnpm

cd "$REPO_ROOT"

case "$MODE" in
  deps)
    pnpm install --frozen-lockfile
    ;;
  server)
    pnpm install --frozen-lockfile
    pnpm build
    mkdir -p "${AGENT_VAULT_HOME:-$HOME/.agent-vault}" "${AGENT_VAULT_STORAGE_ROOT:-$HOME/.agent-vault/storage}"
    cat <<EOF

Agent Vault server packages are installed and built.
No service was started or restarted.

Foreground start for local testing:
  cd "$REPO_ROOT" && pnpm dev:server
EOF
    ;;
  client)
    export AGENT_VAULT_SERVER_URL="${AGENT_VAULT_SERVER_URL:-$DEFAULT_SERVER_URL}"
    export AGENT_VAULT_TOKEN_URL="${AGENT_VAULT_TOKEN_URL:-file:///dev/null}"

    pnpm install --frozen-lockfile
    pnpm package:macbook

    PACKAGE_PATH="$REPO_ROOT/apps/web/public/install/agent-vault-macbook-client.tar.gz"
    if [[ ! -f "$PACKAGE_PATH" ]]; then
      echo "Expected package was not built: $PACKAGE_PATH" >&2
      exit 1
    fi

    export AGENT_VAULT_PACKAGE_URL="file://$PACKAGE_PATH"
    bash "$REPO_ROOT/apps/web/public/install/macbook.sh"
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    usage >&2
    exit 2
    ;;
esac
