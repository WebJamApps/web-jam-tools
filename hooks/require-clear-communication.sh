#!/usr/bin/env bash
# require-clear-communication.sh — web-jam-tools#531
#
# BLOCKING Stop hook, same enforcement model as
# hooks/require-issue-citation-titles.sh (web-jam-tools#311) — the only
# chat-communication rule that has ever reliably held is the one enforced by
# a Stop hook, not the one written down in CLAUDE.md/docs. This hook reads
# the transcript path from stdin (same Stop-hook payload shape), extracts
# the LAST assistant message's text, and mechanically checks four rules
# that are decidable without a judgment call (see the detector's docstring
# for the full rationale, including the deliberate decision on "rhetorical
# questions"):
#
#   1. More than one open question to Josh in the same reply.
#   2. A question followed by more than a configurable amount of content —
#      a question must be the last thing in the message.
#   3. A safety-critical finding (security / data-loss / credential / prod /
#      money) appearing outside the final section of the reply.
#   4. More than a configurable number of "section leads" (a heading or a
#      bold-run label starting a line) in a reply that is also over a
#      configurable length — several topics jumbled into one message. A
#      list, however long, is one topic; list items never count as leads.
#
# Detection lives in hooks/lib/detect_clear_communication_violations.ts so
# the string/regex logic is independently unit-testable (same split as
# require-issue-citation-titles.sh / hooks/lib/detect_bare_issue_refs.ts).
# Rule 3's keyword list, rule 2's content threshold, and rule 4's count/
# length thresholds are CONFIGURATION, not hardcoded logic — tune them in
# hooks/clear-communication.yaml, no code change needed.
#
# False positives are the primary risk (a hook that fires on ordinary
# replies gets worked around or disabled, which is worse than no hook) — the
# detector strips fenced code blocks, inline backticks, double-quoted text
# (which also covers a cited `repo#number "title"`), blockquote lines and
# URLs before rule 1/2 ever look for a "?", and rule 3 only looks at text
# outside fenced/inline code.
#
# IMPORTANT — transcript entry selection (web-jam-tools#531, web-jam-tools#596):
# selects the last genuine main-thread assistant entry in the current turn via
# hooks/lib/select_transcript_entry.ts. Excludes:
#   - entries before the most recent genuine user entry (turn boundary isolation)
#   - isSidechain:true entries — a subagent's own transcript lines are
#     interleaved into the SAME transcript file and are typed "assistant"
#     too; they are never the message actually sent to Josh.
#   - isApiErrorMessage:true entries — Claude Code inserts a synthetic
#     assistant-typed entry (e.g. "You've hit your session limit...") on an
#     API error/retry, with real .message.content text. If one of these
#     lands as the last assistant-typed line in the file, a selector that
#     only checks `.type == "assistant"` grades that synthetic text instead
#     of the genuine final reply — a false positive that is unfixable from
#     the author's side, since rewriting the real message can't change what
#     is being judged. Confirmed present in real transcripts on this laptop
#     (top-level fields, siblings of "message", not nested under it).
# DECISION on outcome 3 (cannot evaluate) — proceed with visible warning (web-jam-tools#1073):
# When the hook cannot determine whether a reply is clean or violating (stdin unreadable
# or empty, transcript_path missing from payload, transcript file nonexistent, the selector
# EXITING non-zero, or the detector exiting non-zero), it proceeds (exit 0) with a visible
# diagnostic naming the failed step and the captured stderr, rather than refusing.
# Because this is a Stop hook, refusing would block the reply from being delivered at all.
# A transient deno or runtime failure would then wedge every turn in every session with no
# way for the author to comply, since rewriting the message cannot fix a broken subprocess.
#
# The diagnostic goes to stdout as a Stop-hook `systemMessage` JSON object, and to stderr
# as plain text. stdout is what Claude Code surfaces for a hook that proceeds; stderr on
# exit 0 is not surfaced, so stderr alone would have left outcome 3 as invisible as the
# `|| true` fallbacks this replaced. See cannot_evaluate() below.
#
# NOT outcome 3: the selector succeeding with an EMPTY selection. The selector is bounded
# to the current turn (web-jam-tools#596), so no selectable entry means there is no reply
# from this turn to judge — a designed outcome that exits 0 silently. Warning there would
# fire on healthy turns and bury the diagnostics that matter.
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
DETECTOR="$HOOK_DIR/lib/detect_clear_communication_violations.ts"
SELECTOR="$HOOK_DIR/lib/select_transcript_entry.ts"
CONFIG="$HOOK_DIR/clear-communication.yaml"
# DETECTOR imports bare "@std/path"/"@std/yaml" specifiers, which only resolve
# via an import map — but `deno run` auto-discovers the nearest deno.json from
# cwd, so a repo deno.json with conflict markers (routine mid-rebase — every
# PR bumps its version line) would deadlock this hook (web-jam-tools#714).
# Point at a hook-owned config carrying just those two imports instead, so
# this hook never depends on repo state to evaluate.
DENO_HOOK_CONFIG="$HOOK_DIR/lib/deno-hook-config.json"

# Emits the outcome-3 diagnostic on BOTH channels, then proceeds (exit 0).
#
# stdout carries a Stop-hook JSON object with `systemMessage`, because that is
# the only channel Claude Code surfaces for a hook that proceeds: on exit 0 it
# shows stdout (and renders `systemMessage` to the user), while stderr is
# surfaced only on a non-zero exit. Writing the warning to stderr alone left it
# exactly as invisible as the `|| true` fallbacks it replaced — the gap
# web-jam-tools#1073 "hooks/require-clear-communication: the guard fails open
# silently on every internal failure, so a violating reply ships with no trace"
# exists to close. stderr is kept as well so `bash hooks/...` by hand still
# shows it.
#
# The captured detail is bounded (first 5 lines, 500 chars): a detector stack
# trace is diagnostic, but dumping it whole into the user's chat is not.
cannot_evaluate() {
  local step="$1"
  local detail="${2:-}"
  local trimmed=""
  if [ -n "$detail" ]; then
    trimmed="$(printf '%s' "$detail" | head -n 5 | head -c 500)"
  fi
  local message="WARN (clear-communication guard): could not evaluate reply — failed at step: $step"
  if [ -n "$trimmed" ]; then
    message="$message"$'\n'"$trimmed"
  fi
  printf '%s\n' "$message" >&2
  jq -cn --arg m "$message" '{systemMessage:$m}' || true
  exit 0
}

TMP_ERR="$(mktemp)"
trap 'rm -f "$TMP_ERR"' EXIT

if ! input="$(cat 2>"$TMP_ERR")"; then
  cannot_evaluate "read stdin payload" "$(<"$TMP_ERR")"
fi

if [ -z "$input" ]; then
  cannot_evaluate "read stdin payload" "empty stdin payload"
fi

if ! tp="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>"$TMP_ERR")"; then
  cannot_evaluate "extract transcript_path" "$(<"$TMP_ERR")"
fi

if [ -n "$tp" ]; then
  if [ ! -f "$tp" ]; then
    cannot_evaluate "verify transcript file" "transcript file does not exist: $tp"
  fi

  # Last genuine assistant transcript entry's text content, selected via
  # hooks/lib/select_transcript_entry.ts (excludes isSidechain and
  # isApiErrorMessage entries, bounds search to current turn — web-jam-tools#596).
  if ! msg="$(deno run --no-config --allow-read "$SELECTOR" --text "$tp" 2>"$TMP_ERR")"; then
    cannot_evaluate "run selector" "$(<"$TMP_ERR")"
  fi
elif printf '%s' "$input" | jq -e '.last_assistant_message != null and (.last_assistant_message | type == "string")' >/dev/null 2>&1; then
  # On Codex, Stop payload carries last_assistant_message directly (web-jam-tools#1139)
  if ! msg="$(printf '%s' "$input" | deno run --no-config --allow-read "$SELECTOR" --text 2>"$TMP_ERR")"; then
    cannot_evaluate "run selector" "$(<"$TMP_ERR")"
  fi
else
  cannot_evaluate "extract transcript_path" "payload carries no transcript_path"
fi

# An empty selection is NOT a failure: the selector is deliberately bounded to
# the current turn (web-jam-tools#596 "The shared transcript selector has no turn
# boundary, so Stop hooks grade the previous message"), so returning nothing means there
# is no reply from this turn to judge. That is the designed outcome, not
# outcome 3, and it stays silent — a warning here would cry failure on a healthy
# path and drown the diagnostics this guard now emits when something really did
# break. A selector that EXITS non-zero is a real failure and is caught above.
if [ -z "$msg" ]; then
  exit 0
fi

if ! report="$(MSG_FOR_PY="$msg" deno run --config "$DENO_HOOK_CONFIG" --no-lock --allow-env --allow-read="$CONFIG" "$DETECTOR" 2>"$TMP_ERR")"; then
  cannot_evaluate "run detector" "$(<"$TMP_ERR")"
fi

if [ -z "$report" ]; then
  exit 0
fi

{
  echo "BLOCKED (clear-communication guard): this message violates one or more chat"
  echo "communication rules."
  echo
  printf '%s\n' "$report"
  echo
  echo "Rewrite the message so it satisfies all three rules, then send it again."
  echo "(rules and thresholds configured in hooks/clear-communication.yaml)"
} >&2

exit 2
