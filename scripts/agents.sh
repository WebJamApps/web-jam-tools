#!/usr/bin/env bash
# scripts/agents.sh — start or attach to the shared agents tmux session (web-jam-tools#1174).
#
# Creates the tmux session `agents` with tabs `claude`, `codex`, `agy` (in that
# order, tab numbers 1, 2, 3), each started in Josh's home folder, and attaches
# to it. If the session already exists, attaches to it without creating a second
# session or failing. Tab names are fixed (automatic-rename is off). Window size
# is set to `latest` so the tab fits whichever screen (laptop, tablet, phone)
# Josh last typed on. When an agent exits, its tab drops to a normal shell
# prompt instead of closing.
#
# Design reference:
#   ~/Dropbox/web-jam-llms/Operations/agent-remote-access-design-2026-09-26.md
#   ("The `agents` command").
#
# Usage:
#   agents [-L socket-name] [-S socket-path] [--no-attach]
set -euo pipefail

SESSION="agents"
TMUX_ARGS=()
DO_ATTACH=1

while [ $# -gt 0 ]; do
  case "$1" in
    -L|-S)
      [ $# -ge 2 ] || { echo "error: $1 requires an argument" >&2; exit 1; }
      TMUX_ARGS+=("$1" "$2")
      shift 2
      ;;
    --no-attach)
      DO_ATTACH=0
      shift
      ;;
    -h|--help)
      echo "Usage: $(basename "$0") [-L socket] [-S socket-path] [--no-attach]"
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ ${#TMUX_ARGS[@]} -eq 0 ] && [ -n "${TMUX_SOCKET:-}" ]; then
  TMUX_ARGS=(-L "$TMUX_SOCKET")
fi

USER_SHELL="${SHELL:-/bin/bash}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_SETTINGS="$REPO_DIR/scripts/claude-settings.json"
CLAUDE_CMD="${AGENTS_CLAUDE_CMD:-claude --settings $CLAUDE_SETTINGS}"
# shellcheck disable=SC2016 # literal $HOME on purpose
CODEX_CMD="${AGENTS_CODEX_CMD:-codex -c 'hooks.PermissionRequest=[{matcher=\".*\",hooks=[{type=\"command\",command=\"$HOME/.claude/hooks/agent-alert.sh codex\"}]}]' -c 'notify=[\"$HOME/.claude/hooks/agent-alert.sh\", \"codex\"]'}"
AGY_CMD="${AGENTS_AGY_CMD:-agy}"

# Attach to the session (or switch to it from inside tmux), then exit.
attach_and_exit() {
  if [ "$DO_ATTACH" = "1" ]; then
    if { [ -t 0 ] && [ "${TERM:-dumb}" != "dumb" ]; } || [ "${AGENTS_FORCE_ATTACH:-0}" = "1" ]; then
      if [ -n "${TMUX:-}" ] && [ ${#TMUX_ARGS[@]} -eq 0 ]; then
        exec tmux switch-client -t "$SESSION"
      else
        exec tmux "${TMUX_ARGS[@]}" attach-session -t "$SESSION"
      fi
    fi
  fi
  exit 0
}

# If session already exists, attach to it. Never create a second session.
if tmux "${TMUX_ARGS[@]}" has-session -t "$SESSION" 2>/dev/null; then
  attach_and_exit
fi

# Create session with tab 1: claude in Josh's home folder.
# Drop to a plain shell prompt when the agent exits instead of closing the tab.
# Another `agents` run (laptop and tablet connecting at once) can create the
# session between the check above and this line; when it did, attach to that
# session instead of failing with "duplicate session".
if ! new_session_err=$(tmux "${TMUX_ARGS[@]}" new-session -d -s "$SESSION" -n claude -c "$HOME" "$CLAUDE_CMD; exec $USER_SHELL" 2>&1); then
  if tmux "${TMUX_ARGS[@]}" has-session -t "$SESSION" 2>/dev/null; then
    attach_and_exit
  fi
  echo "error: could not create tmux session '$SESSION': $new_session_err" >&2
  exit 1
fi

# Ensure the first tab is at index 1 even if global tmux base-index is 0.
if tmux "${TMUX_ARGS[@]}" list-windows -t "$SESSION" -F "#{window_index}" | grep -q "^0$"; then
  tmux "${TMUX_ARGS[@]}" move-window -s "$SESSION:0" -t "$SESSION:1"
fi

# Apply session-scoped settings to the `agents` session only.
tmux "${TMUX_ARGS[@]}" set -t "$SESSION" base-index 1
tmux "${TMUX_ARGS[@]}" set -t "$SESSION" window-size latest
tmux "${TMUX_ARGS[@]}" set-hook -t "$SESSION" after-select-window 'set -w -u @waiting'
tmux "${TMUX_ARGS[@]}" set -t "$SESSION" window-status-format '#{?@waiting,#[fg=red]!#I:#W#[default],#I:#W#F}'
tmux "${TMUX_ARGS[@]}" set -t "$SESSION" window-status-current-format '#{?@waiting,#[fg=red]!#I:#W#[default],#I:#W#F}'
tmux "${TMUX_ARGS[@]}" set-window-option -t "$SESSION" automatic-rename off
tmux "${TMUX_ARGS[@]}" set-window-option -t "$SESSION:1" automatic-rename off

# Create tab 2: codex in Josh's home folder.
tmux "${TMUX_ARGS[@]}" new-window -t "$SESSION:2" -n codex -c "$HOME" "$CODEX_CMD; exec $USER_SHELL"
tmux "${TMUX_ARGS[@]}" set-window-option -t "$SESSION:2" automatic-rename off

# Create tab 3: agy in Josh's home folder.
tmux "${TMUX_ARGS[@]}" new-window -t "$SESSION:3" -n agy -c "$HOME" "$AGY_CMD; exec $USER_SHELL"
tmux "${TMUX_ARGS[@]}" set-window-option -t "$SESSION:3" automatic-rename off

# Start on tab 1 (claude).
tmux "${TMUX_ARGS[@]}" select-window -t "$SESSION:1"

attach_and_exit
