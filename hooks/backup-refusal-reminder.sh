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
    HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)

    DENO_BIN="${DENO_BIN:-}"
    if [ -z "$DENO_BIN" ]; then
      if command -v deno >/dev/null 2>&1; then
        DENO_BIN="deno"
      elif [ -x "$HOME/.deno/bin/deno" ]; then
        DENO_BIN="$HOME/.deno/bin/deno"
      elif [ -x "/usr/local/bin/deno" ]; then
        DENO_BIN="/usr/local/bin/deno"
      else
        DENO_BIN="deno"
      fi
    fi

    ESCAPED=""
    if command -v "$DENO_BIN" >/dev/null 2>&1; then
      ESCAPED=$(printf '%s' "$C" | "$DENO_BIN" run --allow-env "$HOOK_DIR/lib/json_escape.ts" 2>/dev/null || true)
    elif command -v python3 >/dev/null 2>&1; then
      ESCAPED=$(printf '%s' "$C" | python3 -c 'import json, sys; print(json.dumps(sys.stdin.read())[1:-1], end="")' 2>/dev/null || true)
    fi

    if [ -z "$ESCAPED" ]; then
      ESCAPED=$(printf '%s' "$C" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{if (NR>1) printf "\\n"; printf "%s", $0}')
    fi

    printf '%s' "{\"systemMessage\":\"WARNING: Claude Code settings.json backup was REFUSED ($ESCAPED) — run scripts/scan-settings-for-secrets.sh to inspect and resolve.\"}"
  fi
fi

exit 0
