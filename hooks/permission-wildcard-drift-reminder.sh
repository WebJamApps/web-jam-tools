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
exec "$HOOK_DIR/lib/run_hook.sh" --group workflow --name permission-wildcard-drift-reminder deno run --allow-read --allow-env "$HOOK_DIR/lib/check_permission_wildcard_drift.ts" "$@"
