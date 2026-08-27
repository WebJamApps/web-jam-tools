#!/usr/bin/env bash
# SessionStart: remind when settings.local.json contains over-broad allow rules
# with non-trailing wildcards that span option positions (web-jam-tools#784).
#
# Behavior:
#   - Target files absent or clean -> silent no-op (exits 0, no output).
#   - Non-trailing wildcard rules detected -> reports offenders via systemMessage (exits 0).
#
# Read-only: never writes to files, never blocks session (always exits 0).
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

"$DENO_BIN" run --allow-read --allow-env "$HOOK_DIR/lib/check_permission_wildcard_drift.ts" "$@" || exit 0
exit 0
