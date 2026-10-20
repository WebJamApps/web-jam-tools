#!/usr/bin/env bash
# SessionEnd: prune offending local permission allow rules on session end (web-jam-tools#818).
#
# Behavior:
#   - Target files absent or clean -> left unmodified, exits 0.
#   - Offending rules detected -> pruned in-place, backed up, exits 0.
#   - The prune tool's report is always printed to stdout (not silent), in
#     both cases above.
#   - Never blocks, hangs, or fails session teardown (always exits 0).
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "$HOOK_DIR/lib/run_hook.sh" --group workflow --name prune-permission-allows-on-session-end deno run --allow-read --allow-write --allow-env "$HOOK_DIR/../src/prune-local-permission-allows/cli.ts" --apply "$@"
