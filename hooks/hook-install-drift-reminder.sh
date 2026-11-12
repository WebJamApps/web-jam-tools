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
exec "$HOOK_DIR/lib/run_hook.sh" --group workflow --name hook-install-drift-reminder deno run --allow-read --allow-env --allow-run "$HOOK_DIR/lib/check_hook_install_drift.ts" "$@"
