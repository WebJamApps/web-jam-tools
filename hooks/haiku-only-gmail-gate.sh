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
# Workflow guard: if the session model cannot be determined, allow and tell
# the agent to verify that Gmail work is running on Haiku.
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
SELECTOR="$HOOK_DIR/lib/select_transcript_entry.ts"

input="$(cat)"
tp="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)"

model=""
if [ -n "$tp" ] && [ -f "$tp" ]; then
  NOTE_FILE=$(mktemp)
  trap 'rm -f "$NOTE_FILE"' EXIT
  # newest genuine assistant turn's model = current session model
  # (selected via hooks/lib/select_transcript_entry.ts, excluding isSidechain and isApiErrorMessage entries — web-jam-tools#566)
  model="$("$HOOK_DIR/lib/run_hook.sh" --group workflow --name haiku-only-gmail-gate --allow-with-note "Haiku Gmail gate: could not determine the session model from transcript_path; proceeding. Before using Gmail tools, verify the session is on Haiku or switch with /model haiku." --note-file "$NOTE_FILE" deno run --no-config --allow-read "$SELECTOR" --model "$tp" 2>/dev/null)" || model=""
  if [ -s "$NOTE_FILE" ]; then
    cat "$NOTE_FILE"
    exit 0
  fi
fi

case "$model" in
  "")
    note="Haiku Gmail gate: could not determine the session model from transcript_path; proceeding. Before using Gmail tools, verify the session is on Haiku or switch with /model haiku."
    jq -cn --arg note "$note" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$note}}'
    exit 0 ;;
  *haiku*)
    exit 0 ;;  # on Haiku — allow the Gmail action
  *)
    reason="⛔ handle-gmails is hard-gated to Haiku (current model: ${model:-unknown}). Gmail actions are blocked to keep inbox cleanup cheap. Switch first — type /model haiku — then re-run /handle-gmails."
    jq -cn --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
    exit 0 ;;
esac
