#!/usr/bin/env bash
set -euo pipefail

FLASH_PATH="${FLASH_ISSUES_PATH:-$HOME/Dropbox/web-jam-llms/flash-issues.md}"
MAX_AGE="${FLASH_ISSUES_MAX_AGE_DAYS:-7}"

if [ ! -f "$FLASH_PATH" ]; then
  printf '%s' '{"systemMessage":"Flash worklist has never been generated on this machine — run /flash-issues."}'
  exit 0
fi

mtime="$(stat -c '%Y' "$FLASH_PATH" 2>/dev/null || stat -f '%m' "$FLASH_PATH" 2>/dev/null || echo "")"
[ -n "$mtime" ] || exit 0

age_days=$(( ( $(date +%s) - mtime ) / 86400 ))

if [ "$age_days" -ge "$MAX_AGE" ]; then
  printf '%s' "{\"systemMessage\":\"Flash worklist is ${age_days} days old — run /flash-issues to regenerate it.\"}"
fi

exit 0
