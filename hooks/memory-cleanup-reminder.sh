#!/usr/bin/env bash
# SessionStart: remind when weekly memory cleanup has not been run in >= 7 days
# (or has never been run, or has an unreadable stamp).
#
# Config: MEMORY_CLEANUP_STAMP_PATH overrides the watched stamp file. Default:
#   $HOME/.claude/skills/memory-cleanup/last-run.txt
#
# Behavior:
#   - Stamp missing or empty -> remind with "never run"
#   - Stamp unparseable by date -d -> remind with "stamp unreadable: <contents>"
#   - Stamp parses and >= 7 days old -> remind with "last run: <ISO date>, <N> days ago"
#   - Stamp parses and < 7 days old -> print nothing
#
# Reminders are emitted as SessionStart JSON systemMessage. Always exits 0.
set -euo pipefail

S="${MEMORY_CLEANUP_STAMP_PATH:-$HOME/.claude/skills/memory-cleanup/last-run.txt}"
L=$(cat "$S" 2>/dev/null || true)
E=$(date -d "$L" +%s 2>/dev/null || true)

if [ -z "$L" ]; then
  W="never run"; D=1
elif [ -z "$E" ]; then
  W="stamp unreadable: $L"; D=1
else
  A=$(( ( $(date +%s) - E ) / 86400 ))
  W="last run: $L, $A days ago"
  if [ "$A" -ge 7 ]; then D=1; else D=0; fi
fi

if [ "$D" = 1 ]; then
  printf '%s' "{\"systemMessage\":\"Weekly memory cleanup due ($W) — run /memory-cleanup (scan runs cheap on a Haiku subagent).\"}"
fi

exit 0
