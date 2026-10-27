#!/usr/bin/env bash
# PreToolUse gh-api consent guard. Decisions live in lib/check_gh_api.ts.
# The safety runner refuses if the checker cannot run; unresolved commands
# use the existing text fallback inside the checker.
set -euo pipefail
HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
exec "$HOOK_DIR/lib/run_hook.sh" --group safety --name gh-api-guard --event PreToolUse \
  deno run --no-config --allow-env=WJT_SURFACE "$HOOK_DIR/lib/check_gh_api.ts"
