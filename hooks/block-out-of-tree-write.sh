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

status=0
result=$(printf '%s' "$input" | "$HOOK_DIR/lib/run_hook.sh" --group workflow --name block-out-of-tree-write deno run --no-config --allow-env --allow-read --allow-run "$HOOK_DIR/lib/check_out_of_tree_write.ts" 2>&1) || status=$?
case "$status" in
  0) printf '%s' "$result" ;;
  2) printf '%s\n' "$result" >&2; exit 2 ;;
  *)
    note="out-of-tree write guard: could not determine the repository root or write target (checker exited $status); proceeding. Verify the target is in the intended repository working tree or an allowed scratch/document path before writing."
    jq -cn --arg note "$note" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$note}}'
    ;;
esac
