#!/usr/bin/env bash
# opus-delegation-gate.sh — web-jam-tools#641, web-jam-tools#965
#
# HARD PreToolUse gate on Edit, Write, NotebookEdit, and file-writing Bash commands:
# Refuses repository code modifications made on Opus without Josh's approval, forcing
# implementation work down to a cheaper model tier (Sonnet, Haiku, or Flash).
#
# Bash: a command that writes files (a redirect, tee, sed -i, cp/mv, inline python/node/deno code
# that writes, ...) is judged exactly like an Edit/Write to each file it writes — same exemptions,
# same decision. hooks/lib/bash_write_targets.ts lists the shapes recognized and the known gaps; it
# closes the accidental path (an Opus session refused Edit rewrote repo files with a python script),
# not a determined bypass. Commands that write nothing (git, gh, deno task test, grep, ls) pass.
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
#       Opus and the human prompt that spawned it contains "opus edit ok", asks for an Opus
#       subagent, or asks Opus to do the work (D-8, e.g. "use Opus to fix it"). An undeterminable
#       model or spawning prompt refuses.
#     - Main-thread call: allow when the session model is not Opus, when Josh has approved Opus
#       edits anywhere earlier in the SESSION — a human prompt containing "opus edit ok" or asking
#       Opus to do the work (D-8) — and has not since withdrawn it with "opus edit off", or when the
#       most recent slash command he typed is /work-issue on an issue labeled Opus (D-7; the label is
#       read with gh and reused for ten minutes). Any other label, no issue named, or a failed lookup
#       gives no approval, so Opus must delegate. His approval is session-scoped rather than
#       per-turn: it is not discarded by whatever he happens to type next.
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

cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"

# Prints "true" when a path (relative to the payload cwd) is inside a git working tree. A path that
# does not exist yet is judged by its nearest existing ancestor directory.
in_git_tree() {
  local resolved_path="$1" dir parent
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
  if [ -n "$dir" ] && [ -d "$dir" ]; then
    git -C "$dir" rev-parse --is-inside-work-tree 2>/dev/null || true
  fi
}

tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)"
command_text="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
via_bash=""

if [ "$tool_name" = "Bash" ]; then
  # Bash: a command that writes files is judged exactly like an Edit/Write to each of them. hooks/lib/bash_write_targets.ts lists the targets and documents the shapes and known gaps.
  via_bash="1"

  # agy/Antigravity (the shim maps run_command to Bash) names its model in modelName and has no
  # Claude transcript to read. A non-Opus agy model is never gated; without this, every file write
  # Flash makes through run_command would fail closed on the unreadable transcript.
  agy_model="$(printf '%s' "$input" | jq -r '.modelName // empty' 2>/dev/null || true)"
  if [ -n "$agy_model" ] && ! printf '%s' "$agy_model" | grep -qi 'opus'; then
    exit 0
  fi

  # Cheap pre-filter: a command with none of these words or a ">" cannot write a file this gate
  # recognizes, so it never pays for a deno start (git status, ls, gh, grep ...).
  if ! printf '%s' "$command_text" | grep -qE '>|\b(tee|sed|perl|ruby|python[0-9.]*|node|nodejs|deno|cp|mv|install|truncate|dd|patch|apply|eval|sh|bash|zsh|ksh|dash)\b'; then
    exit 0
  fi

  # Step 2 (Bash): no written file named -> allow. Step 3 (Bash): the first target inside a git
  # working tree is the one judged; when none is, allow.
  target_path=""
  while IFS= read -r candidate; do
    [ -z "$candidate" ] && continue
    if [ "$(in_git_tree "$candidate")" = "true" ]; then
      target_path="$candidate"
      break
    fi
  done < <(printf '%s' "$input" | deno run --no-config --allow-read --allow-env=HOME "$HOOK_DIR/lib/bash_write_targets.ts" 2>/dev/null || true)
  if [ -z "$target_path" ]; then
    exit 0
  fi
else
  # Step 2: No target path in tool input?
  target_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // .tool_input.path // empty' 2>/dev/null || true)"
  if [ -z "$target_path" ]; then
    exit 0
  fi

  # Step 3: Inside a git working tree?
  if [ "$(in_git_tree "$target_path")" != "true" ]; then
    exit 0
  fi
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
what="write to '$target_path'"
if [ -n "$via_bash" ]; then
  what="Bash command that writes to '$target_path' (a file write through Bash is gated like Edit/Write)"
fi

if [ "$kind" = "subagent" ]; then
  if [ -z "$why" ]; then
    why="The subagent's model or spawning message could not be determined."
  fi
  reason="⛔ Opus delegation gate: refused a subagent's $what.
In auto mode a Sonnet or Haiku subagent may edit. An Opus subagent may edit only when the message Josh typed to ask for it contains \"opus edit ok\", asks for an Opus subagent, or asks Opus to do the work.
$why"
else
  reason="⛔ Opus delegation gate: refused ${via_bash:+a }$what.
Repository code must not be edited directly on Opus — implementation work belongs on a cheaper tier.
To delegate:
  • Backend / contained coding work: spawn a subagent with model: \"sonnet\" (or Haiku)
  • Frontend / UI work: delegate to Flash via agy (/work-issue or Antigravity)
To authorize Opus edits for the rest of this session, include the exact phrase: opus edit ok
(that approval then holds until you withdraw it with: opus edit off)"
  if [ -n "$why" ]; then
    reason="$reason
($why)"
  fi
fi

jq -cn --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
exit 0
