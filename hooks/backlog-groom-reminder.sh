#!/usr/bin/env bash
set -euo pipefail

GROOM_PATH="${BACKLOG_GROOM_PATH:-$HOME/Dropbox/web-jam-llms/backlog-groom-report.md}"
MAX_AGE="${BACKLOG_GROOM_MAX_AGE_DAYS:-7}"

if [ ! -f "$GROOM_PATH" ]; then
  printf '%s' '{"systemMessage":"Backlog groom report has never been generated on this machine — run /backlog-groom."}'
  exit 0
fi

mtime="$(stat -c '%Y' "$GROOM_PATH" 2>/dev/null || stat -f '%m' "$GROOM_PATH" 2>/dev/null || echo "")"
[ -n "$mtime" ] || exit 0

age_days=$(( ( $(date +%s) - mtime ) / 86400 ))

if [ "$age_days" -ge "$MAX_AGE" ]; then
  printf '%s' "{\"systemMessage\":\"Backlog groom report is ${age_days} days old — run /backlog-groom to refresh it.\"}"
fi

exit 0
