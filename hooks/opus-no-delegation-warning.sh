#!/usr/bin/env bash
# opus-no-delegation-warning.sh
# web-jam-tools#290
#
# DETECTIVE, NOT PREVENTIVE. This hook cannot stop an Opus session from
# burning top-tier tokens on mechanical work it should have delegated — it
# only reports after the fact, once the turn is already over. A preventive
# gate is impossible here: hooks fire on tool calls, and the failure being
# detected is the ABSENCE of a Task call. There is no hook event for a call
# that never happened, so nothing earlier in the turn could have blocked
# this. Do NOT "fix" this into a PreToolUse/permission-denying gate — that
# is a different, unbuildable feature. This is a Stop hook: it looks back
# over the turn that just ended and, if the pattern matches, surfaces a
# warning via systemMessage for Josh to see.
#
# Behaviour: if the CURRENT session model is Opus, and the current turn
# (since the last real user message in the transcript) contains >= THRESHOLD
# Edit/Write/NotebookEdit tool calls AND zero Task tool calls, emit a
# systemMessage warning naming the actual edit count. Otherwise stay silent.
#
# "Since the last real user message": transcript JSONL entries with
# type=="user" include BOTH messages Josh actually typed (message.content is
# a plain string) and tool_result entries fed back to the assistant after a
# tool call (message.content is an array of tool_result blocks). Only the
# former count as a turn boundary — the latter are part of the assistant's
# own turn.
#
# Claude Code does NOT expose the current model to hooks directly (not in
# the payload, not in env), so — same technique as haiku-only-gmail-gate.sh —
# we recover it by reading the newest assistant message's model from the
# transcript JSONL.
#
# Fail-OPEN — the OPPOSITE of haiku-only-gmail-gate.sh, which fails closed.
# This is a warning-only, best-effort detector, not a cost gate: if the
# model can't be determined, the transcript is missing/unreadable, or jq
# fails for any reason, exit 0 and stay quiet. A future reader must NOT flip
# this to fail-closed — a warning hook that blocks or spams on ambiguous
# input is worse than one that occasionally misses a real case.
#
# Path exclusions (web-jam-tools#286-follow-up, 2026-08-01): session-memory
# bookkeeping — checkpoint files, the per-project MEMORY.md index, and the
# session scratchpad — is inherently non-delegable. A subagent spawns cold
# and does not inherit the parent's context, which is the exact thing this
# bookkeeping exists to preserve, so counting it toward "should have
# delegated" is a false positive by construction. It also characteristically
# happens in the turn right after a dispatch, so an unfiltered count fires
# precisely when delegation DID just occur — the worst possible time to cry
# wolf. Excluded-path edits are IGNORED ENTIRELY (filtered out before
# counting), not subtracted after the fact — same effect, simpler jq.
# Excluded, matched against each Edit/Write/NotebookEdit's target path:
#   - anything under .claude/projects/<anything>/memory/ (per-project, so we
#     match the "memory/" segment rather than hardcoding a home directory)
#   - MEMORY.md anywhere under .claude/
#   - the session scratchpad: /tmp/claude-*/.../scratchpad/
# A Task call is NEVER excluded by this logic — it's the one thing this hook
# is trying to detect the absence of.
set -euo pipefail

# Minimum edits (Edit + Write + NotebookEdit combined) in the current turn,
# with zero Task calls, before this hook warns.
THRESHOLD=5

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
SELECTOR="$HOOK_DIR/lib/select_transcript_entry.ts"

input="$(cat)" || exit 0
tp="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)"
[ -n "$tp" ] && [ -f "$tp" ] || exit 0

# newest genuine assistant turn's model = current session model
# (selected via hooks/lib/select_transcript_entry.ts, excluding isSidechain and isApiErrorMessage entries)
model="$(deno run --allow-read "$SELECTOR" --model "$tp" 2>/dev/null || true)"
case "$model" in
  *opus*) ;;
  *) exit 0 ;;
esac

# Excluded-path regexes, applied to each Edit/Write/NotebookEdit's target
# path (Edit/Write use .input.file_path, NotebookEdit uses
# .input.notebook_path). See the header comment for what/why.
MEMORY_DIR_RE='\.claude/projects/[^/]+/memory/'
MEMORY_MD_RE='\.claude/.*MEMORY\.md$'
SCRATCHPAD_RE='^/tmp/claude-[^/]+/.*/scratchpad/'

counts="$(jq -s -c \
  --arg memDirRe "$MEMORY_DIR_RE" \
  --arg memMdRe "$MEMORY_MD_RE" \
  --arg scratchRe "$SCRATCHPAD_RE" '
  . as $all
  | ([range(0;length)
      | select($all[.].type=="user"
          and (($all[.].message.content? // null) | type) == "string")]
     | (last // -1)) as $lastUserIdx
  | ($all[($lastUserIdx + 1):])
  | map(select(.type=="assistant")
        | ((.message.content? // []) | .[]?)
        | select(.type=="tool_use"))
  | map({name, path: ((.input.file_path // .input.notebook_path) // "")})
  | map(select(
      if (.name=="Edit" or .name=="Write" or .name=="NotebookEdit") then
        ((.path | test($memDirRe))
          or (.path | test($memMdRe))
          or (.path | test($scratchRe))
        ) | not
      else true end
    ))
  | map(.name)
  | {edits: (map(select(.=="Edit" or .=="Write" or .=="NotebookEdit")) | length),
     tasks: (map(select(.=="Task")) | length)}
' "$tp" 2>/dev/null || true)"

[ -n "$counts" ] || exit 0

edit_count="$(printf '%s' "$counts" | jq -r '.edits // empty' 2>/dev/null || true)"
task_count="$(printf '%s' "$counts" | jq -r '.tasks // empty' 2>/dev/null || true)"

# Anything non-numeric (jq failure, unexpected shape, etc.) → bail quietly
# rather than risk a bad comparison.
case "$edit_count" in
  ''|*[!0-9]*) exit 0 ;;
esac
case "$task_count" in
  ''|*[!0-9]*) exit 0 ;;
esac

if [ "$edit_count" -ge "$THRESHOLD" ] && [ "$task_count" -eq 0 ]; then
  msg="⚠️ ${edit_count} file edits this turn on Opus with zero subagent spawns — this is the web-jam-tools#286 failure mode. Cheaper-model spawns are pre-authorized; delegate."
  jq -cn --arg m "$msg" '{systemMessage:$m}'
fi

exit 0
