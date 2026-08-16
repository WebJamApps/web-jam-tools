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
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
DETECTOR="$HOOK_DIR/lib/detect_clear_communication_violations.ts"
SELECTOR="$HOOK_DIR/lib/select_transcript_entry.ts"
CONFIG="$HOOK_DIR/clear-communication.yaml"

input="$(cat)" || exit 0
tp="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)"
[ -n "$tp" ] && [ -f "$tp" ] || exit 0

# Last genuine assistant transcript entry's text content, selected via
# hooks/lib/select_transcript_entry.ts (excludes isSidechain and
# isApiErrorMessage entries, bounds search to current turn — web-jam-tools#596).
msg="$(deno run --allow-read "$SELECTOR" --text "$tp" 2>/dev/null || true)"

[ -n "$msg" ] || exit 0

report="$(MSG_FOR_PY="$msg" deno run --allow-env --allow-read="$CONFIG" "$DETECTOR" 2>/dev/null || true)"
[ -n "$report" ] || exit 0

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
