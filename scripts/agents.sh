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
# When `--restart` is given and the session already exists, it prints one line
# saying the session is being restarted, ends the existing session, and creates a
# fresh one with all three tabs before attaching. If the session does not exist,
# `--restart` behaves like a normal first run.
# Connected terminals wait in a temporary session while the old agent processes
# are ended, then switch back to the fresh tabs to pick up installed hooks/skills.
#
# Before it creates a new session, it runs scripts/update-all.sh in the foreground
# (output visible in the terminal) so Claude Code, agy and Codex start on their
# latest versions. A failed update prints a warning and the agents start anyway. It
# does not run when the session already exists and the command only attaches.
# Override the command with AGENTS_UPDATE_CMD.
#
# When `agents` is typed over SSH (SSH_CONNECTION is set) and no laptop-screen
# window is showing the session, it also opens a gnome-terminal window on the laptop
# screen attached to the session, both when it creates the session and when it only
# attaches (web-jam-tools#1128). A tmux client counts as a laptop-screen window when
# its process environment has no SSH_CONNECTION. The display comes from
# `systemctl --user show-environment`. The window is a convenience: if nobody is
# logged in to the desktop or anything fails, it is skipped silently and never
# changes the exit code. Override the window step with AGENTS_LAPTOP_WINDOW_CMD
# (run via `bash -c` instead of gnome-terminal; tests use it so no real window opens).
# Nothing here starts the agents on login or boot; the session starts only when
# `agents` is typed.
#
# Design reference:
#   ~/Dropbox/web-jam-llms/Operations/agent-remote-access-design-2026-09-26.md
#   ("The `agents` command").
#
# Usage:
#   agents [-L socket-name] [-S socket-path] [--no-attach] [--restart]
set -euo pipefail

SESSION="agents"
TMUX_ARGS=()
DO_ATTACH=1
DO_RESTART=0
inside_target_session=0
restart_hold=""

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
    --restart)
      DO_RESTART=1
      shift
      ;;
    -h|--help)
      echo "Usage: $(basename "$0") [-L socket] [-S socket-path] [--no-attach] [--restart]"
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
# Resolve the ~/.local/bin/agents symlink so REPO_DIR is the repository, not ~/.local.
REPO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
CLAUDE_SETTINGS="$REPO_DIR/scripts/claude-settings.json"
CLAUDE_CMD="${AGENTS_CLAUDE_CMD:-claude --settings $CLAUDE_SETTINGS}"
# $HOME expands here (the single quotes sit inside a double-quoted default); Codex runs
# the notify argv without a shell, so it needs the real path.
# shellcheck disable=SC2016 # false positive, see above
CODEX_CMD="${AGENTS_CODEX_CMD:-codex -c 'hooks.PermissionRequest=[{matcher=\".*\",hooks=[{type=\"command\",command=\"$HOME/.claude/hooks/agent-alert.sh codex prompt\"}]}]' -c 'notify=[\"$HOME/.claude/hooks/agent-alert.sh\", \"codex\", \"finished\"]'}"
AGY_CMD="${AGENTS_AGY_CMD:-agy}"
UPDATE_CMD="${AGENTS_UPDATE_CMD:-$REPO_DIR/scripts/update-all.sh}"
AGY_CONFIG_CMD="${AGENTS_AGY_CONFIG_CMD:-agy -p /config}"
# agy skips the laptop's login keyring whenever any SSH_* variable is set, so a
# session started over SSH (tablet or phone) made agy ask to log in again
# (measured 2026-09-28, agy 1.2.12). Every tab starts without them, so the session
# behaves the same wherever `agents` was typed.
TAB_ENV="unset SSH_CLIENT SSH_CONNECTION SSH_TTY;"

# True (exit 0) when a tmux client attached to the session was not started over SSH,
# i.e. a window on the laptop screen is already showing it.
laptop_client_present() {
  local pid client_env
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    client_env=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null) || continue
    case $'\n'"$client_env" in
      *$'\n'SSH_CONNECTION=*) ;;
      *) return 0 ;;
    esac
  done < <(tmux "${TMUX_ARGS[@]}" list-clients -t "$SESSION" -F '#{client_pid}' 2>/dev/null || true)
  return 1
}

# Open the session in a terminal window on the laptop screen. Best effort: every
# failure is swallowed and it never blocks, prints, or returns non-zero.
open_laptop_window() {
  if [ -n "${AGENTS_LAPTOP_WINDOW_CMD:-}" ]; then
    # The window must not look like an SSH client to laptop_client_present.
    (unset SSH_CONNECTION SSH_CLIENT SSH_TTY; timeout 10 bash -c "$AGENTS_LAPTOP_WINDOW_CMD") >/dev/null 2>&1 || true
    return 0
  fi
  local env_out display xauth
  env_out=$(timeout 5 systemctl --user show-environment 2>/dev/null) || return 0
  display=$(printf '%s\n' "$env_out" | sed -n 's/^DISPLAY=//p' | head -n 1) || return 0
  [ -n "$display" ] || return 0
  xauth=$(printf '%s\n' "$env_out" | sed -n 's/^XAUTHORITY=//p' | head -n 1) || xauth=""
  (
    # gnome-terminal passes its environment to the new window; without this the
    # laptop window's tmux client would look like an SSH client.
    unset SSH_CONNECTION SSH_CLIENT SSH_TTY
    export DISPLAY="$display"
    if [ -n "$xauth" ]; then export XAUTHORITY="$xauth"; fi
    if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -n "${XDG_RUNTIME_DIR:-}" ]; then
      export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
    fi
    timeout 10 gnome-terminal -- tmux "${TMUX_ARGS[@]}" attach-session -t "$SESSION" >/dev/null 2>&1 || true
  ) >/dev/null 2>&1 &
  disown 2>/dev/null || true
  return 0
}

# Over SSH with no laptop-screen window showing the session, open one.
maybe_open_laptop_window() {
  [ -n "${SSH_CONNECTION:-}" ] || return 0
  laptop_client_present && return 0
  open_laptop_window || true
  return 0
}

# Return parked clients before removing the temporary session. Also runs on
# failure: if the old agents session survived, its clients are switched back.
# The holding session keeps the server alive without changing exit-empty.
finish_restart() {
  [ -n "$restart_hold" ] || return 0
  local clients client
  if tmux "${TMUX_ARGS[@]}" has-session -t "=$SESSION" 2>/dev/null; then
    clients=$(tmux "${TMUX_ARGS[@]}" list-clients -t "=$restart_hold" -F '#{client_name}') || return 1
    while IFS= read -r client; do
      [ -n "$client" ] || continue
      tmux "${TMUX_ARGS[@]}" switch-client -c "$client" -t "=$SESSION" || return 1
    done <<< "$clients"
  fi
  tmux "${TMUX_ARGS[@]}" kill-session -t "=$restart_hold" || return 1
  restart_hold=""
}

# Attach to the session (or switch to it from inside tmux), then exit.
attach_and_exit() {
  finish_restart
  maybe_open_laptop_window || true
  # The invoking client was switched back by finish_restart. Its old pane and
  # tty are gone, so don't try to create a second attachment from this process.
  [ "$inside_target_session" -eq 0 ] || exit 0
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

# If session already exists, attach to it unless --restart is requested.
# If --restart is requested, end the existing session and fall through to create a fresh one.
# If has-session errors for any reason other than "no session", fail closed.
has_session_err=""
if has_session_err=$(tmux "${TMUX_ARGS[@]}" has-session -t "$SESSION" 2>&1); then
  if [ "$DO_RESTART" -eq 1 ]; then
    echo "Restarting '$SESSION' tmux session..."
    trap '' HUP
    if [ -n "${TMUX_PANE:-}" ]; then
      pane_session=$(tmux "${TMUX_ARGS[@]}" display-message -t "$TMUX_PANE" -p '#{session_name}' 2>/dev/null || true)
      if [ "$pane_session" = "$SESSION" ]; then
        inside_target_session=1
      fi
    elif [ -n "${TMUX:-}" ]; then
      pane_session=$(tmux "${TMUX_ARGS[@]}" display-message -p '#{session_name}' 2>/dev/null || true)
      if [ "$pane_session" = "$SESSION" ]; then
        inside_target_session=1
      fi
    fi
    restart_hold="agents-restart-$$"
    if ! hold_err=$(tmux "${TMUX_ARGS[@]}" new-session -d -s "$restart_hold" -n restarting -c "$HOME" "printf 'Restarting agents; please wait...\\n'; exec sleep 86400" 2>&1); then
      echo "error: could not prepare tmux restart: $hold_err" >&2
      exit 1
    fi
    trap 'finish_restart || true' EXIT
    if [ "$DO_ATTACH" = "1" ]; then
      clients=$(tmux "${TMUX_ARGS[@]}" list-clients -t "=$SESSION" -F '#{client_name}')
      while IFS= read -r client; do
        [ -n "$client" ] || continue
        tmux "${TMUX_ARGS[@]}" switch-client -c "$client" -t "=$restart_hold"
      done <<< "$clients"
    fi
    if ! kill_err=$(tmux "${TMUX_ARGS[@]}" kill-session -t "$SESSION" 2>&1); then
      echo "error: could not end tmux session '$SESSION': $kill_err" >&2
      exit 1
    fi
    if [ "$inside_target_session" -eq 1 ]; then
      exec </dev/null >/dev/null 2>&1
    fi
  else
    attach_and_exit
  fi
else
  case "$has_session_err" in
    *"can't find session"*|*"cant find session"*|*"session not found"*|*"no server running on"*|*"error connecting to "*"No such file or directory"*|*"failed to connect to server"*)
      ;;
    *)
      echo "error: tmux has-session failed: $has_session_err" >&2
      exit 1
      ;;
  esac
fi

# Update the agents right before creating a new session (not when only attaching).
# A failed update must never stop the agents from starting.
if ! bash -c "$UPDATE_CMD"; then
  echo "warning: update-all failed; starting the agents on the versions already installed" >&2
fi

# Check agy's Tool Permission setting before creating a new session (web-jam-tools#1212).
# agy asks for approvals only under request-review; any other value or failure warns and continues.
agy_config_out=""
if agy_config_out=$(timeout 5 bash -c "$AGY_CONFIG_CMD" 2>/dev/null); then
  tool_perm_line=$(printf '%s\n' "$agy_config_out" | grep -m 1 "^toolPermission" || true)
  if [ -n "$tool_perm_line" ]; then
    tool_perm_val=$(printf '%s\n' "$tool_perm_line" | awk -F'\t' '{print $2}')
    if [ -z "$tool_perm_val" ]; then
      tool_perm_val=$(printf '%s\n' "$tool_perm_line" | awk '{print $2}')
    fi
    if [ "$tool_perm_val" != "request-review" ]; then
      echo "warning: agy Tool Permission is '$tool_perm_val' (expected 'request-review')" >&2
    fi
  else
    echo "warning: agy Tool Permission could not be read" >&2
  fi
else
  echo "warning: agy Tool Permission could not be read" >&2
fi

# Create session with tab 1: claude in Josh's home folder.
# Drop to a plain shell prompt when the agent exits instead of closing the tab.
# Another `agents` run (laptop and tablet connecting at once) can create the
# session between the check above and this line; when it did, attach to that
# session instead of failing with "duplicate session".
if ! new_session_err=$(tmux "${TMUX_ARGS[@]}" new-session -d -s "$SESSION" -n claude -c "$HOME" "$TAB_ENV $CLAUDE_CMD; exec $USER_SHELL" 2>&1); then
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
tmux "${TMUX_ARGS[@]}" new-window -t "$SESSION:2" -n codex -c "$HOME" "$TAB_ENV $CODEX_CMD; exec $USER_SHELL"
tmux "${TMUX_ARGS[@]}" set-window-option -t "$SESSION:2" automatic-rename off

# Create tab 3: agy in Josh's home folder.
tmux "${TMUX_ARGS[@]}" new-window -t "$SESSION:3" -n agy -c "$HOME" "$TAB_ENV $AGY_CMD; exec $USER_SHELL"
tmux "${TMUX_ARGS[@]}" set-window-option -t "$SESSION:3" automatic-rename off

# Start on tab 1 (claude).
tmux "${TMUX_ARGS[@]}" select-window -t "$SESSION:1"

attach_and_exit
