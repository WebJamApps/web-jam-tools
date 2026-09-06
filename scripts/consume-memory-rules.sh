#!/usr/bin/env bash
# consume-memory-rules.sh — thin shell wrapper around scripts/consume_memory_rules.ts (web-jam-tools#499)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DENO_BIN="${DENO_BIN:-}"
if [ -z "$DENO_BIN" ]; then
  if command -v deno >/dev/null 2>&1; then
    DENO_BIN="deno"
  elif [ -x "$HOME/.deno/bin/deno" ]; then
    DENO_BIN="$HOME/.deno/bin/deno"
  elif [ -x "/usr/local/bin/deno" ]; then
    DENO_BIN="/usr/local/bin/deno"
  else
    DENO_BIN="deno"
  fi
fi

exec "$DENO_BIN" run --allow-read --allow-write --allow-env --allow-run "$REPO_DIR/scripts/consume_memory_rules.ts" "$@"
