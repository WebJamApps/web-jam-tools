#!/usr/bin/env bash
# SessionStart: remind when installed Claude hooks are behind origin/dev,
# registered at dead paths, or missing from settings.json (web-jam-tools#664).
#
# Behavior:
#   - Checkout level with origin/dev and all hook paths valid -> silent no-op.
#   - Hook added, deleted or modified on origin/dev -> reports drift.
#   - Hook registered in settings.json with a missing path -> reports dead path.
#   - Hook on origin/dev not registered in settings.json -> reports unregistered.
#
# Read-only: never pulls, never writes to settings, never blocks session (exits 0).
# Emits SessionStart JSON systemMessage.
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

"$DENO_BIN" run --allow-read --allow-env --allow-run "$HOOK_DIR/lib/check_hook_install_drift.ts" "$@"
exit 0
