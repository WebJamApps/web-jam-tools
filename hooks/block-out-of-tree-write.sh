#!/usr/bin/env bash
# PreToolUse guard (Write|Edit|NotebookEdit): deny write/edit calls to files outside the repo working tree.
#
# COVERAGE LIMIT:
# This hook fences Claude Code sessions and subagents only. It does not fence agy.
# agy internal file writes are not seen by Claude Code PreToolUse hooks.
# Full coverage of agy is blocked on web-jam-tools#432 "agy hooks do not enforce — all 12 are inert on Flash, and a Stop/SessionStart entry kills the whole config; fix that, then give Antigravity Gmail MCP fenced by a working hook".
#
# Exit 2 = block (stderr shown to model).
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
input=$(cat)

printf '%s' "$input" | deno run --allow-env --allow-read --allow-run "$HOOK_DIR/lib/check_out_of_tree_write.ts"
