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
    printf '%s' "{\"systemMessage\":\"WARNING: Claude Code settings.json backup was REFUSED ($C) — run scripts/scan-settings-for-secrets.sh to inspect and resolve.\"}"
  fi
fi

exit 0
