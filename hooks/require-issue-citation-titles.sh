#!/usr/bin/env bash
# require-issue-citation-titles.sh — web-jam-tools#311
#
# BLOCKING Stop hook. Contrast with hooks/opus-no-delegation-warning.sh,
# which is deliberately detective-only (always exits 0). This hook reads
# the transcript path from stdin (same Stop-hook payload shape), extracts
# the LAST assistant message's text, and scans it for a bare issue/PR
# citation — a `#` immediately followed by digits that is NOT part of a
# full `repo#number "title"` citation. If any are found, it exits 2:
# Claude Code blocks the turn from ending and feeds stderr back to the
# model, so the message gets rewritten before it reaches Josh.
#
# Origin: web-jam-tools#307 "Add ISSUE CITATIONS hard rule to operational
# rules" merged the rule into prose docs on 2026-07-29, and it was STILL
# violated about an hour later, in the closing sentence of a message.
# Prose documentation is not enforcement — same shape as web-jam-tools#308
# "Remote branches can be deleted by an agent with no authorization —
# advisory guard does not block", which is why THAT gap got a real
# permissions.deny rule instead of just another sentence in CLAUDE.md.
#
# Detection rule (delegated to hooks/lib/detect_bare_issue_refs.py so the
# regex logic is independently unit-testable — see that file's docstring
# for the full rationale): flag any `#` immediately followed by digits,
# UNLESS a repo name sits immediately before it (no space) AND a quoted
# title sits immediately after it, e.g.:
#   web-jam-tools#299 "Delete replaced labels org-wide, after migration"
# The repo token is not validated against a real repo list — this is a
# regex heuristic, not a GitHub lookup.
#
# DECISION on milestone/ordinal parentheticals like "(#2)": these ARE
# flagged, not exempted. Josh's own HARD RULE 1 states "# followed by
# digits is an ILLEGAL token in anything Josh reads... there is no
# context... in which the number may travel alone" — a milestone ordinal
# is exactly the kind of "context" that rule already refuses to carve out
# an exception for. Exempting "(#2)" would require this hook to guess
# intent from a bare number (is it really a milestone, or a mis-cited
# issue?) — precisely the judgment call a regex can't make and Josh has
# said he doesn't want left to guesswork. Flagging it costs one rewrite:
# spell it out without a bare `#`, e.g. "milestone 2" or "the 2nd point
# above" instead of "(#2)".
#
# Known limits (documented here AND in the PR that shipped this):
#  1. Hooks do not run in the Claude app, only in Claude Code — phone
#     sessions stay unenforced. No repo change can fix that; it needs a
#     phone-side habit/reminder instead.
#  2. Detection is a regex heuristic, not a citation database lookup. A
#     false positive (an unusual pattern this hook mistakes for a bare
#     citation) costs one rewrite — annoying but safe. A false negative —
#     a bare "#NNN" slipping through uncaught — is the exact failure this
#     hook exists to eliminate, so the regex is deliberately biased toward
#     over-flagging rather than under-flagging.
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
DETECTOR="$HOOK_DIR/lib/detect_bare_issue_refs.py"

input="$(cat)" || exit 0
tp="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)"
[ -n "$tp" ] && [ -f "$tp" ] || exit 0

# Last assistant transcript entry's text content, concatenated across any
# text blocks it carries (an assistant entry can interleave text and
# tool_use blocks). Reverse the file first (tac) so slurping into an array
# and taking the first element that matches gives the ORIGINAL last
# assistant entry — same technique opus-no-delegation-warning.sh uses to
# recover "the current turn's model" from the same transcript shape.
msg="$(tac "$tp" 2>/dev/null | jq -rs '
  [ .[] | select(.type == "assistant" and ((.message.content? // null) != null)) ]
  | first
  | (.message.content // [])
  | map(select(.type == "text") | .text)
  | join("\n")
' 2>/dev/null || true)"

[ -n "$msg" ] || exit 0

offenders="$(MSG_FOR_PY="$msg" python3 "$DETECTOR" 2>/dev/null || true)"
[ -n "$offenders" ] || exit 0

{
  echo "BLOCKED (issue-citation guard): this message cites an issue/PR without its title."
  echo "Offending token(s):"
  printf '%s\n' "$offenders" | sed 's/^/  - /'
  echo
  echo 'Every issue/PR mention needs the full form: repo#number "title" — e.g.:'
  echo '  web-jam-tools#299 "Delete replaced labels org-wide, after migration"'
  echo "If you don't know the title, look it up first: gh issue view N --repo OWNER/REPO --json title"
  echo
  echo 'Milestone/ordinal references like "(#2)" are ALSO flagged — rewrite without a'
  echo 'bare #, e.g. "milestone 2" or "the 2nd point above"; only a full'
  echo 'repo#number "title" citation is exempt.'
  echo "(rule: cite-issues-with-title-repo-number — do not retry with the same bare number)"
} >&2

exit 2
