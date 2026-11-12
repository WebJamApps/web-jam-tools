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

# The Codex installer sets this on its SessionStart command. A direct call from
# another surface must not edit Codex's configuration.
if [ "${WJT_SURFACE:-}" != "codex" ]; then
  exit 0
fi

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "$HOOK_DIR/lib/run_hook.sh" --group workflow --name codex-reaper-startup-check deno run --allow-read --allow-write --allow-env "$HOOK_DIR/lib/codex_reaper_startup_check.ts" "$@"
