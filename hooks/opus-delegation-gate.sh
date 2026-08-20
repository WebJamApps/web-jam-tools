#!/usr/bin/env bash
# opus-delegation-gate.sh — web-jam-tools#641
#
# HARD PreToolUse gate on Edit, Write, and NotebookEdit:
# Refuses repository code modifications attempted directly by the Opus main session,
# forcing delegation to a cheaper model tier (Sonnet, Haiku, or Flash).
#
# Allow/Refuse Sequence (design: Token_Savings/opus-delegation-gate-design-2026-08-18.md):
#   Step 1: Subagent call (agent_id present) AND permission_mode != "auto" -> allow (exit 0)
#   Step 2: No target path in tool input -> allow (exit 0)
#   Step 3: Not inside a git working tree -> allow (exit 0)
#   Step 4: Single invocation of select_transcript_entry.ts (--opus-gate)
#   Step 5: Session model != "Opus" -> allow (exit 0)
#   Step 6: Escape phrase present ("opus edit ok") -> allow (exit 0)
#   Step 7: Otherwise refuse (deny) with JSON response naming the target file,
#           explaining why repository code belongs on a cheaper tier, providing
#           ready-to-run delegation commands, and naming the escape phrase.
#
# Fail-CLOSED: If transcript is missing, unreadable, or the model cannot be
# determined, refuse (deny) — unknown must not silently run on the expensive model.
#
# KNOWN LIMITATION — permission_mode "auto" and the subagent exemption (web-jam-tools#663):
# Step 1's subagent exemption exists because this gate cannot recover which model a
# SPAWNED subagent is actually running: select_transcript_entry.ts deliberately skips
# isSidechain transcript entries when resolving "the session model" (that lookup is
# scoped to the main thread by design, for the Stop-hook use case), so a naive
# per-subagent check would just re-read the main session's model. Exempting subagent
# calls outright assumes a human is watching the session and chose to delegate.
#
# That assumption breaks under permission_mode "auto": a live reproduction
# (2026-08-19/20, see PR that introduced this comment) showed an Opus main session,
# denied a direct Edit by this gate, autonomously spawn an Agent/Task subagent in the
# SAME turn — no human involved — whose own Edit call then hit Step 1's unconditional
# subagent exemption and succeeded. The initial deny was honored correctly; auto mode's
# unattended multi-step retry is what routed around it. Since we still cannot verify a
# spawned subagent's real model, the safe fix is to withdraw the Step 1 exemption
# specifically while permission_mode is "auto": ALL Edit/Write/NotebookEdit calls to a
# git-tracked path from an Opus-flavored session are refused while unattended, main
# thread or subagent, unless the escape phrase is present. This intentionally also
# blocks genuinely-cheaper subagent delegation while running unattended in auto mode
# (the safe direction to fail) — a human-supervised session (default/plan/acceptEdits/
# bypassPermissions/dontAsk) keeps the original subagent exemption unchanged.
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
SELECTOR="$HOOK_DIR/lib/select_transcript_entry.ts"

input=$(cat)

# Step 1: Subagent tool call? (agent_id present and non-empty) — exempt only when a
# human is presumed to be supervising the session, i.e. NOT permission_mode "auto".
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

# Step 4: Single invocation of select_transcript_entry.ts to get model and escape check
tp="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)"

model=""
has_escape="false"
if [ -n "$tp" ] && [ -f "$tp" ]; then
  gate_info="$(deno run --allow-read "$SELECTOR" --opus-gate "$tp" 2>/dev/null || true)"
  if [ -n "$gate_info" ]; then
    model="$(printf '%s' "$gate_info" | jq -r '.model // empty' 2>/dev/null || true)"
    has_escape="$(printf '%s' "$gate_info" | jq -r '.hasEscape // false' 2>/dev/null || true)"
  fi
fi

# Step 5: Session model != "Opus"
case "$model" in
  *[oO][pP][uU][sS]*)
    # Session is on Opus, continue to escape check
    ;;
  "")
    # Missing / unreadable transcript / unknown model -> fail closed (refuse)
    ;;
  *)
    # Not Opus (e.g. Sonnet, Haiku) -> allow
    exit 0
    ;;
esac

# Step 6: Escape phrase present?
if [ "$has_escape" = "true" ]; then
  exit 0
fi

# Step 7: Refuse (deny)
reason="⛔ Opus delegation gate: refused write to '$target_path'.
Repository code must not be edited directly on Opus — implementation work belongs on a cheaper tier.
To delegate:
  • Backend / contained coding work: spawn a subagent with model: \"sonnet\" (or Haiku)
  • Frontend / UI work: delegate to Flash via agy (/work-issue or Antigravity)
To override for this turn only, include the exact phrase: opus edit ok"

jq -cn --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
exit 0
