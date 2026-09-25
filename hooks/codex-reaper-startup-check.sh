#!/usr/bin/env bash
# SessionStart: check for and remove a Codex REAPER registration left in
# ~/.codex/config.toml when no active recording session claim exists (web-jam-tools#1147).
#
# Behavior:
#   - Active claim exists -> no-op (preserves registration for active recording).
#   - No leftover registration in config.toml -> no-op.
#   - Leftover registration found and no claim -> removes [mcp_servers.reaper] section.
#
# Always exits 0.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

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

"$DENO_BIN" run --allow-read --allow-write --allow-env "$HOOK_DIR/lib/codex_reaper_startup_check.ts" "$@" || exit 0
exit 0
