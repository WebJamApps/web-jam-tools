#!/usr/bin/env bash
# agy-model-guard.sh — agy-native in-session model guard (web-jam-tools#432
# scope item 7).
#
# Registered ONLY on the agy surface, wrapped by hooks/agy-hook-shim.sh with
# matcher ".*" (every tool call). Checks the selected model IN-SESSION,
# using the `modelName` agy's own PreToolUse payload carries directly
# (finding 7) — a capability Claude Code hooks don't have at all.
#
# This is the runtime counterpart to hooks/block-agy-non-flash-model.sh,
# which only sees a literal `agy --model ...` Bash invocation FROM Claude
# Code and cannot see what model an already-running agy session switched to.
# Both share the same allowed-slug floor via hooks/lib/check_agy_model.ts so
# they can't drift apart.
#
# Flash, Argon and Sonnet at high pass this session guard. It does not grant Gmail actions or
# provide the Gmail skill's cost confirmation; those belong to the separate Gmail fences and
# model-choice workflow in the hooks design, "Gmail model choice and connections".
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
input=$(cat)
status=0
result=$(printf '%s' "$input" | deno run --no-config --allow-read --allow-env --allow-write "$HOOK_DIR/lib/check_agy_session_model.ts" 2>&1) || status=$?
case "$status" in
  0) printf '%s' "$result" ;;
  2) printf '%s\n' "$result" >&2; exit 2 ;;
  *)
    note="agy-model guard: could not determine modelName (checker exited $status); proceeding. Verify the agy session uses an allowed high model before continuing."
    jq -cn --arg note "$note" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$note}}'
    ;;
esac
