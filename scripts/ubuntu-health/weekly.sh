#!/usr/bin/env bash
# weekly.sh — the root-owned weekly job, run by ubuntu-health-weekly.timer (Sundays 03:00).
#
# Runs the drift check, and sends one email through gmail-send.sh when it finds anything. A week
# with nothing to report sends nothing and makes no network call. Everything it writes goes to the
# job's log, /var/log/ubuntu-health.log. It runs only the root-owned copies beside it.
set -uo pipefail

ROOT="${UBUNTU_HEALTH_ROOT:-}"
LIB="/usr/local/lib/ubuntu-health"
LOG="$ROOT/var/log/ubuntu-health.log"

umask 077
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "=== ubuntu-health weekly run $(date -Is) ==="

findings="$("$ROOT$LIB/ubuntu-health.sh" --check 2>&1)"
check_status=$?
echo "$findings"

system="this system"
case "$findings" in
  *"mode: laptop"*) system="the laptop" ;;
  *"mode: wsl"*) system="the desktop's WSL" ;;
esac

if [ "$check_status" -eq 0 ]; then
  echo "nothing to report"
  exit 0
fi

if ! printf '%s\n\nTo fix: run  sudo scripts/ubuntu-health.sh  from the web-jam-tools repository on %s.\n' \
  "$findings" "$system" | "$ROOT$LIB/gmail-send.sh" "ubuntu-health: $system needs attention"; then
  echo "email not sent"
  exit 1
fi
echo "email sent"
