#!/usr/bin/env bash
# SessionStart: remind when settings.json backup was refused due to secret literal guard
#
# Config: SETTINGS_BACKUP_REFUSAL_FILE overrides the watched refusal file. Default:
#   $HOME/.claude/settings-backup-refusal.txt
#
# Reminders are emitted as SessionStart JSON systemMessage. Always exits 0.
set -euo pipefail

F="${SETTINGS_BACKUP_REFUSAL_FILE:-$HOME/.claude/settings-backup-refusal.txt}"

if [ -f "$F" ]; then
  C=$(cat "$F" 2>/dev/null || true)
  if [ -n "$C" ]; then
    ESCAPED=$(printf '%s' "$C" | LC_ALL=C awk '
BEGIN {
  for (i = 0; i < 32; i++) {
    hex[sprintf("%c", i)] = sprintf("\\u%04x", i)
  }
  hex["\t"] = "\\t"
  hex["\r"] = "\\r"
  hex["\b"] = "\\b"
  hex["\f"] = "\\f"
}
{
  if (NR > 1) printf "\\n"
  len = length($0)
  for (i = 1; i <= len; i++) {
    c = substr($0, i, 1)
    if (c == "\\") printf "\\\\"
    else if (c == "\"") printf "\\\""
    else if (c < " ") printf "%s", hex[c]
    else printf "%s", c
  }
}')

    printf '%s' "{\"systemMessage\":\"WARNING: Claude Code settings.json backup was REFUSED ($ESCAPED) — run scripts/scan-settings-for-secrets.sh to inspect and resolve.\"}"
  fi
fi

exit 0
