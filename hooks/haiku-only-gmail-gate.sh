#!/usr/bin/env bash
# haiku-only-gmail-gate.sh
# HARD gate: block the handle-gmails Gmail tools unless the session is on Haiku.
#
# PreToolUse hook, matched against the local Gmail MCP tools (mcp__gmail__*).
# Claude Code does NOT expose the current model to hooks (not in the payload,
# not in env — feature request sent to Anthropic 2026-07-22), so we recover it
# by reading the newest assistant message's model from the transcript JSONL.
# If the model is not Haiku, we DENY the tool call and tell Josh to switch.
#
# Fail-CLOSED: if the model can't be determined, deny (this is a hard cost gate,
# so "unknown" must not silently run on an expensive model).
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
SELECTOR="$HOOK_DIR/lib/select_transcript_entry.ts"

input="$(cat)"
tp="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)"

model=""
if [ -n "$tp" ] && [ -f "$tp" ]; then
  # newest genuine assistant turn's model = current session model
  # (selected via hooks/lib/select_transcript_entry.ts, excluding isSidechain and isApiErrorMessage entries — web-jam-tools#566)
  model="$(deno run --allow-read "$SELECTOR" --model "$tp" 2>/dev/null || true)"
fi

case "$model" in
  *haiku*)
    exit 0 ;;  # on Haiku — allow the Gmail action
  *)
    reason="⛔ handle-gmails is hard-gated to Haiku (current model: ${model:-unknown}). Gmail actions are blocked to keep inbox cleanup cheap. Switch first — type /model haiku — then re-run /handle-gmails."
    jq -cn --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
    exit 0 ;;
esac
