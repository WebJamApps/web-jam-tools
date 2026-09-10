#!/usr/bin/env bash
# opus-delegation-gate.sh — web-jam-tools#641, web-jam-tools#965
#
# HARD PreToolUse gate on Edit, Write, and NotebookEdit:
# Refuses repository code modifications made on Opus without Josh's approval, forcing
# implementation work down to a cheaper model tier (Sonnet, Haiku, or Flash).
#
# Design: ~/Dropbox/web-jam-llms/Token_Savings/opus-delegation-gate-design-2026-08-18.md
# (decision record D-1..D-7 in its Appendix C).
#
# Allow/Refuse Sequence:
#   Step 1: Subagent call (agent_id present) AND permission_mode != "auto" -> allow (exit 0)
#   Step 2: No target path in tool input -> allow (exit 0)
#   Step 3: Not inside a git working tree -> allow (exit 0)
#   Step 4: hooks/lib/opus_gate.ts decides everything else from the payload:
#     - Subagent call in auto mode (D-6): allow when the subagent's own model is not Opus, or it is
#       Opus and the human prompt that spawned it contains "opus edit ok" or asks for an Opus
#       subagent. An undeterminable model or spawning prompt refuses.
#     - Main-thread call: allow when the session model is not Opus, when Josh's latest HUMAN prompt
#       contains "opus edit ok", or when the most recent slash command he typed is /work-issue on an
#       issue labeled Opus (D-7; the label is read with gh and reused for ten minutes). Any other
#       label, no issue named, or a failed lookup gives no approval, so Opus must delegate.
#     Only prompts Josh actually sent (origin.kind "human", not isMeta) count, so a task
#     notification neither grants approval nor cancels it.
#   Step 5: Otherwise refuse (deny) with JSON naming the target file and the reason. A main-thread
#           refusal also carries the delegation commands and the escape phrase.
#
# Fail-CLOSED: a missing or unreadable transcript, an unknown model, or no decision from the
# module refuses — unknown must not silently run on the expensive model.
#
# transcript_path shape. Verified against the installed Claude Code 2.1.267 binary on 2026-09-10:
# the PreToolUse payload's transcript_path is the MAIN session transcript
# (<project>/<session_id>.jsonl) on every call, subagent calls included; a subagent is identified
# only by agent_id. A subagent's own transcript path is sent only as agent_transcript_path, on
# SubagentStop. opus_gate.ts accepts either shape and resolves both to the same session files.
#
# History of the auto-mode subagent case. The gate first exempted every subagent call, and in
# permission_mode "auto" an Opus session refused a direct edit once routed around the refusal by
# spawning a subagent in the same turn (web-jam-tools#663). Because a subagent's model was then
# believed unrecoverable, web-jam-tools#675 withdrew the exemption in auto mode, which refused every
# subagent edit, Sonnet and Haiku included. That premise no longer holds: each subagent's model is
# recorded in <session>/subagents/agent-<id>.meta.json and in its own transcript. D-6 now decides by
# that real model, and still refuses an Opus subagent that Opus started without Josh asking.
#
# agy/Antigravity reaches this script through agy-hook-shim.sh. Its payload carries no agent_id, so
# the subagent branch is inert there and agy behaviour is unchanged.
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
GATE_LIB="$HOOK_DIR/lib/opus_gate.ts"

input=$(cat)

# Step 1: Subagent tool call? (agent_id present and non-empty) — exempt outside auto mode.
agent_id="$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null || true)"
permission_mode="$(printf '%s' "$input" | jq -r '.permission_mode // empty' 2>/dev/null || true)"
if [ -n "$agent_id" ] && [ "$permission_mode" != "auto" ]; then
  exit 0
fi

# Step 2: No target path in tool input?
target_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // .tool_input.path // empty' 2>/dev/null || true)"
if [ -z "$target_path" ]; then
  exit 0
fi

# Resolve directory relative to cwd if target_path is relative
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
resolved_path="$target_path"
if [[ "$resolved_path" != /* ]] && [ -n "$cwd" ]; then
  resolved_path="$cwd/$resolved_path"
fi

dir="$resolved_path"
if [ ! -d "$dir" ]; then
  dir="$(dirname "$resolved_path")"
fi

while [ -n "$dir" ] && [ ! -d "$dir" ]; do
  parent="$(dirname "$dir")"
  [ "$parent" = "$dir" ] && break
  dir="$parent"
done

# Step 3: Inside a git working tree?
in_tree=""
if [ -n "$dir" ] && [ -d "$dir" ]; then
  in_tree="$(git -C "$dir" rev-parse --is-inside-work-tree 2>/dev/null || true)"
fi

if [ "$in_tree" != "true" ]; then
  exit 0
fi

# Step 4: One invocation of opus_gate.ts decides the rest.
gate_json="$(printf '%s' "$input" | deno run --no-config --allow-read --allow-run=timeout --allow-env=OPUS_GATE_CACHE_DIR --allow-write=/tmp "$GATE_LIB" 2>/dev/null || true)"
decision="$(printf '%s' "$gate_json" | jq -r '.decision // empty' 2>/dev/null || true)"
kind="$(printf '%s' "$gate_json" | jq -r '.kind // empty' 2>/dev/null || true)"
why="$(printf '%s' "$gate_json" | jq -r '.why // empty' 2>/dev/null || true)"

if [ "$decision" = "allow" ]; then
  exit 0
fi

# Step 5: Refuse (deny)
if [ "$kind" = "subagent" ]; then
  if [ -z "$why" ]; then
    why="The subagent's model or spawning message could not be determined."
  fi
  reason="⛔ Opus delegation gate: refused a subagent's write to '$target_path'.
In auto mode a Sonnet or Haiku subagent may edit. An Opus subagent may edit only when the message Josh typed to ask for it contains \"opus edit ok\" or asks for an Opus subagent.
$why"
else
  reason="⛔ Opus delegation gate: refused write to '$target_path'.
Repository code must not be edited directly on Opus — implementation work belongs on a cheaper tier.
To delegate:
  • Backend / contained coding work: spawn a subagent with model: \"sonnet\" (or Haiku)
  • Frontend / UI work: delegate to Flash via agy (/work-issue or Antigravity)
To override for this turn only, include the exact phrase: opus edit ok"
  if [ -n "$why" ]; then
    reason="$reason
($why)"
  fi
fi

jq -cn --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
exit 0
