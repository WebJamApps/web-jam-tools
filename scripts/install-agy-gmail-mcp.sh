#!/usr/bin/env bash
# install-agy-gmail-mcp.sh — merges the `gmail` MCP server entry into
# Antigravity's mcp_config.json (web-jam-tools#432 scope item 2).
#
# NOT run automatically by scripts/install-hooks.sh, and NOT run by any
# agent session. Connecting a new MCP server to a Flash surface requires
# Josh's explicit authorization naming that connection — this script only
# makes the change reproducible FROM THIS REPO instead of a hand-applied,
# untracked laptop edit. Josh runs this himself when he's ready:
#
#   scripts/install-agy-gmail-mcp.sh
#
# Before running it for real, confirm the send/delete fence is installed —
# scripts/install-hooks.sh must have been run first (it installs
# hooks/block-agy-gmail-send-delete.sh onto the agy surface) — and restart
# agy afterwards for both changes to take effect (agy reads its MCP config
# and hooks config at startup).
#
# Usage: scripts/install-agy-gmail-mcp.sh [--mcp-config-path PATH]
#   --mcp-config-path PATH   Merge into PATH instead of
#                             $HOME/.gemini/config/mcp_config.json (also
#                             settable via AGY_MCP_CONFIG_PATH). For testing
#                             the merge without touching the real config.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -n "${AGY_MCP_CONFIG_PATH:-}" ]; then
  MCP_CONFIG_PATH="$AGY_MCP_CONFIG_PATH"
else
  MCP_CONFIG_PATH="$HOME/.gemini/config/mcp_config.json"
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --mcp-config-path)
      MCP_CONFIG_PATH="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

deno run --allow-read --allow-write "$REPO_DIR/scripts/merge-agy-gmail-mcp.ts" "$MCP_CONFIG_PATH"

echo ""
echo "Restart agy for the new MCP server to take effect."
