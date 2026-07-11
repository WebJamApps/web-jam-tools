#!/usr/bin/env bash
# SessionStart: remind when the shared cross-instance notes file (the team
# Dropbox hub, e.g. windows-desktop-notes.md) has new content since the last
# session on this machine. Cross-instance learnings from other Claude Code
# installs (desktop, other laptops) are appended there; this hook makes
# noticing new content machine-enforced instead of a memory convention
# (web-jam-tools#163).
#
# Config: CLAUDE_SYNC_NOTES_PATH overrides the watched file. Default:
#   $HOME/Dropbox/web-jam-llms/windows-desktop-notes.md
#
# Behavior:
#   - Watched path doesn't exist (no Dropbox share on this machine, wrong
#     path, etc.) -> silent no-op (exit 0, no output).
#   - Unchanged since the last session -> silent (no output).
#   - Changed (or first time this hook has ever run here) -> a 1-2 line
#     reminder, emitted as SessionStart JSON so it surfaces to the user.
#
# State: a content-hash marker in ~/.claude/state/ (per-user, gitignored,
# never committed) records the hash last surfaced, so unrelated sessions on
# the same machine don't re-remind until the file changes again.
#
# Scope (v1): POSIX/bash + coreutils (sha256sum or shasum). Not tested on
# Windows — see README "Claude Code hooks" section. Falls back to an
# mtime+size marker if no hashing tool is found, so the hook still degrades
# gracefully instead of erroring on an unusual PATH.
set -euo pipefail

NOTES_PATH="${CLAUDE_SYNC_NOTES_PATH:-$HOME/Dropbox/web-jam-llms/windows-desktop-notes.md}"

# No file at the watched path -> nothing to surface, nothing to record.
[ -f "$NOTES_PATH" ] || exit 0

STATE_DIR="${CLAUDE_STATE_DIR:-$HOME/.claude/state}"
MARKER="$STATE_DIR/notes-sync-marker.txt"
mkdir -p "$STATE_DIR"

fingerprint() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    # No hashing tool on PATH: fall back to mtime+size (GNU then BSD stat).
    stat -c '%Y-%s' "$1" 2>/dev/null || stat -f '%m-%z' "$1" 2>/dev/null || echo "unknown"
  fi
}

current="$(fingerprint "$NOTES_PATH")"
previous="$(cat "$MARKER" 2>/dev/null || true)"

if [ "$current" != "$previous" ]; then
  printf '%s' "$current" > "$MARKER"
  printf '%s' "{\"systemMessage\":\"Cross-instance notes have new content: $NOTES_PATH — worth a read before you start.\"}"
fi

exit 0
