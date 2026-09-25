#!/usr/bin/env bash
# reaper-launcher.sh — shared REAPER MCP server launcher for Claude Code, agy, and Codex.
#
# 1. Checks that an active recording claim exists (REAPER_CLAIM_FILE). If missing or empty,
#    exits immediately (status 1) with no server started.
# 2. Acquires a non-blocking flock on REAPER_LOCK_FILE. If another session holds the lock,
#    exits immediately (status 1) naming that holding session.
# 3. If lock is acquired, writes session name into the lock file, execs into reaper_mcp server,
#    holding the lock for the entire duration of the process.
set -euo pipefail

STATE_DIR="${CLAUDE_STATE_DIR:-$HOME/.claude/state}"
CLAIM_FILE="${REAPER_CLAIM_FILE:-$STATE_DIR/reaper-recording-claim.json}"
LOCK_FILE="${REAPER_LOCK_FILE:-$STATE_DIR/reaper-session.lock}"

# 1. Check for active recording claim
if [ ! -s "$CLAIM_FILE" ]; then
  echo "No active REAPER recording claim found at $CLAIM_FILE. Exiting without starting server." >&2
  exit 1
fi

# Determine current session name from claim file or environment
session_name="${SESSION_NAME:-}"
if [ -z "$session_name" ] && [ -f "$CLAIM_FILE" ]; then
  session_name="$(grep -o '"session"[[:space:]]*:[[:space:]]*"[^"]*"' "$CLAIM_FILE" | head -n1 | sed -E 's/.*"session"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || true)"
fi
if [ -z "$session_name" ]; then
  session_name="session-$(date +%s)"
fi

mkdir -p "$(dirname "$LOCK_FILE")"
touch "$LOCK_FILE"

# Open lock file on FD 200 without truncating
exec 200<>"$LOCK_FILE"

# 2. Try non-blocking flock
if ! flock -n 200; then
  holding_session="$(tr -d '\r\n' < "$LOCK_FILE" 2>/dev/null || true)"
  if [ -z "$holding_session" ]; then
    holding_session="another session"
  fi
  echo "REAPER lock is already held by $holding_session. Refusing to start a second server." >&2
  exit 1
fi

# 3. Lock acquired: write session name into lock file
truncate -s 0 "$LOCK_FILE"
printf '%s\n' "$session_name" >&200

# Exec into reaper-mcp
REAPER_MCP_BIN="${REAPER_MCP_BIN:-/home/joshua/opt/Reaper-MCP/.venv/bin/reaper-mcp}"
exec "$REAPER_MCP_BIN" "$@"
