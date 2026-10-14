#!/usr/bin/env bash
# agy-model-guard.sh — agy-native in-session model guard (web-jam-tools#432
# scope item 7).
#
# Registered ONLY on the agy surface, wrapped by hooks/agy-hook-shim.sh with
# matcher ".*" (every tool call). Denies a non-Flash model chosen IN-SESSION,
# using the `modelName` agy's own PreToolUse payload carries directly
# (finding 7) — a capability Claude Code hooks don't have at all.
#
# This is the runtime counterpart to hooks/block-agy-non-flash-model.sh,
# which only sees a literal `agy --model ...` Bash invocation FROM Claude
# Code and cannot see what model an already-running agy session switched to.
# Both share the same allowed-slug floor via hooks/lib/check_agy_model.ts so
# they can't drift apart.
#
# Side effect: because this fires on every agy tool call and denies anything
# not on the Flash allowlist, any Gmail tool call reaching
# hooks/block-agy-gmail-send-delete.sh's matcher is already guaranteed to be
# running on an allowed Flash model — this is how the Haiku-only cost gate
# (hooks/haiku-only-gmail-gate.sh, Claude Code-only — its matcher never
# matches agy's unprefixed Gmail tool names) becomes "surface-aware" without
# being edited: Claude Code keeps the transcript-based Haiku gate unchanged,
# and Antigravity gets this session-wide Flash gate instead.
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
input=$(cat)
status=0
result=$(printf '%s' "$input" | deno run --no-config --allow-read --allow-env --allow-write "$HOOK_DIR/lib/check_agy_session_model.ts" 2>&1) || status=$?
case "$status" in
  0) printf '%s' "$result" ;;
  2) printf '%s\n' "$result" >&2; exit 2 ;;
  *)
    note="agy-model guard: could not determine modelName (checker exited $status); proceeding. Verify the agy session uses an allowed Flash model before continuing."
    jq -cn --arg note "$note" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$note}}'
    ;;
esac
