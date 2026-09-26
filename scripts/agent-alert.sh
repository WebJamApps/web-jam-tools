#!/usr/bin/env bash
# scripts/agent-alert.sh — mark the waiting agent's tab and send an ntfy alert (web-jam-tools#1176).
#
# When an agent (Claude Code, Codex, agy) is waiting for user approval/input,
# or has finished its turn and is idle, this command:
# 1. Marks the waiting agent's tab in the `agents` tmux session (shows in red
#    with `!` in the status bar; clears when the tab is switched to).
# 2. Sends an ntfy notification to the tablet and phone with the body:
#    "<Agent> is waiting for you".
#
# Silent cases (no mark, no notification, exits 0):
# - $TMUX_PANE is not set (not running inside tmux)
# - tmux session of $TMUX_PANE is not named "agents"
# - tab (window) name of $TMUX_PANE does not match the agent argument
# - Codex first input begins with "Generate a concise, single-line task title"
#
# Never fails: always exits 0 even if curl fails or times out.
#
# Design reference:
#   ~/Dropbox/web-jam-llms/Operations/agent-remote-access-design-2026-09-26.md
#   ("The waiting alert", "When the alert stays silent", "What it refuses to do").
#
# Usage:
#   agent-alert.sh <claude|codex|agy>
set -euo pipefail

# Refuse to fail or block an agent under any circumstances.
trap 'exit 0' ERR

AGENT="${1:-}"
if [ -z "$AGENT" ]; then
  exit 0
fi

# Silent case 1: $TMUX_PANE is not set.
if [ -z "${TMUX_PANE:-}" ]; then
  exit 0
fi

TMUX_CMD=(tmux)
if [ -n "${TMUX_SOCKET:-}" ]; then
  TMUX_CMD=(tmux -L "$TMUX_SOCKET")
fi

# Silent case 2: tmux session is not named "agents".
SESSION_NAME=$("${TMUX_CMD[@]}" display-message -p -t "$TMUX_PANE" "#{session_name}" 2>/dev/null || true)
if [ "$SESSION_NAME" != "agents" ]; then
  exit 0
fi

# Silent case 3: tab name does not match the agent argument.
WINDOW_NAME=$("${TMUX_CMD[@]}" display-message -p -t "$TMUX_PANE" "#{window_name}" 2>/dev/null || true)
if [ "$WINDOW_NAME" != "$AGENT" ]; then
  exit 0
fi

# Read stdin if available (for Codex hidden title-writing check).
INPUT=""
if [ ! -t 0 ]; then
  INPUT=$(cat 2>/dev/null || true)
fi

# Silent case 4: Codex title-writing step at the start of conversation.
if [ "$AGENT" = "codex" ]; then
  case "$INPUT" in
    *"Generate a concise, single-line task title"*)
      exit 0
      ;;
  esac
fi

# 1. Mark the waiting agent's tab in tmux.
"${TMUX_CMD[@]}" set -w -t "$TMUX_PANE" @waiting 1 2>/dev/null || true
"${TMUX_CMD[@]}" set-hook -t "$SESSION_NAME" after-select-window 'set -w -u @waiting' 2>/dev/null || true

# 2. Format notification message.
case "$AGENT" in
  claude) DISPLAY_NAME="Claude" ;;
  codex) DISPLAY_NAME="Codex" ;;
  agy) DISPLAY_NAME="agy" ;;
  *) DISPLAY_NAME="$AGENT" ;;
esac
MESSAGE="${DISPLAY_NAME} is waiting for you"

# Resolve ntfy topic.
TOPIC="${NTFY_TOPIC:-}"
TOPIC_FILE="${AGENT_ALERTS_TOPIC_FILE:-$HOME/.config/agent-alerts/ntfy-topic}"
if [ -z "$TOPIC" ] && [ -f "$TOPIC_FILE" ]; then
  TOPIC=$(tr -d ' \r\n' < "$TOPIC_FILE" 2>/dev/null || true)
fi
if [ -z "$TOPIC" ]; then
  mkdir -p "$(dirname "$TOPIC_FILE")" 2>/dev/null || true
  TOPIC="agent-alerts-$(od -vN 16 -An -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || date +%s%N)"
  echo "$TOPIC" > "$TOPIC_FILE" 2>/dev/null || true
fi

# Send notification with short timeout, never failing on error or timeout.
NTFY_SERVER="${NTFY_SERVER:-https://ntfy.sh}"
curl -s --max-time 3 -d "$MESSAGE" "$NTFY_SERVER/$TOPIC" >/dev/null 2>&1 || true

exit 0
