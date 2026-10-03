#!/usr/bin/env bash
# scripts/agy-prompt-watch.sh — watch for agy approval prompt on its tab and alert (web-jam-tools#1212).
#
# A PreToolUse hook registered for agy in ~/.gemini/config/hooks.json.
# Discards stdin, prints nothing on stdout, and exits 0 at once so it never
# delays the agy tool call.
#
# In the background (stdin, stdout, stderr detached), it looks at agy's own tab
# three seconds after the hook started and again at eight seconds.
# When the tab shows the literal, case-sensitive marker "tab Amend",
# it calls `agent-alert.sh agy prompt` at most once, the first time a look finds it.
# The tab text is piped directly in memory and never written to disk anywhere.
#
# Silent cases (does nothing and exits 0 immediately without starting the background check):
# - $TMUX_PANE is unset (not running inside tmux)
# - tmux session of $TMUX_PANE is not named "agents"
# - tab (window) name of $TMUX_PANE is not "agy"
#
# Timing overrides:
# - AGY_PROMPT_WATCH_DELAY1: delay before first look (default: 3 seconds)
# - AGY_PROMPT_WATCH_DELAY2: delay between first and second look (default: 5 seconds, i.e. 8s from start)
#
# Alert command override:
# - AGY_PROMPT_WATCH_ALERT_CMD: alert executable (defaults to agent-alert.sh on PATH, or ~/.claude/hooks/agent-alert.sh)
set -euo pipefail

# Always exit 0 under any error.
trap 'exit 0' ERR

# Discard stdin completely.
exec </dev/null

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

# Silent case 3: tab (window) name is not "agy".
WINDOW_NAME=$("${TMUX_CMD[@]}" display-message -p -t "$TMUX_PANE" "#{window_name}" 2>/dev/null || true)
if [ "$WINDOW_NAME" != "agy" ]; then
  exit 0
fi

if [ -n "${AGY_PROMPT_WATCH_ALERT_CMD:-}" ]; then
  # Split custom override into array words if flags/args are present
  # shellcheck disable=SC2206
  ALERT_CMD=($AGY_PROMPT_WATCH_ALERT_CMD)
elif command -v agent-alert.sh >/dev/null 2>&1; then
  ALERT_CMD=(agent-alert.sh)
elif [ -x "$HOME/.claude/hooks/agent-alert.sh" ]; then
  ALERT_CMD=("$HOME/.claude/hooks/agent-alert.sh")
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -x "$SCRIPT_DIR/agent-alert.sh" ]; then
    ALERT_CMD=("$SCRIPT_DIR/agent-alert.sh")
  else
    ALERT_CMD=(agent-alert.sh)
  fi
fi

DELAY1="${AGY_PROMPT_WATCH_DELAY1:-3}"
DELAY2="${AGY_PROMPT_WATCH_DELAY2:-5}"
MARKER="tab Amend"

# Detached background check (stdin, stdout, and stderr closed so caller never waits).
(
  sleep "$DELAY1"
  if "${TMUX_CMD[@]}" capture-pane -p -t "$TMUX_PANE" 2>/dev/null | grep -qF "$MARKER"; then
    "${ALERT_CMD[@]}" agy prompt
    exit 0
  fi

  sleep "$DELAY2"
  if "${TMUX_CMD[@]}" capture-pane -p -t "$TMUX_PANE" 2>/dev/null | grep -qF "$MARKER"; then
    "${ALERT_CMD[@]}" agy prompt
    exit 0
  fi
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
