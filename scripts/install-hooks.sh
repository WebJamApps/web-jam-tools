#!/usr/bin/env bash
# install-hooks.sh — make this repo the single source of truth for Claude Code hooks.
#
# 1. For every *.sh under <repo>/hooks/, symlink ~/.claude/hooks/<name> -> it.
#    Idempotent: already-correct symlinks are left alone. An existing REAL
#    file is backed up (never deleted) to ~/.claude/hooks/<name>.bak-<date>.
#
# 2. Idempotently merges the SessionStart hook(s) listed in
#    SESSION_START_HOOKS, and the PreToolUse hook(s) (any matcher) listed in
#    PRE_TOOL_USE_HOOKS, below into ~/.claude/settings.json (only adding
#    entries that aren't already there; every other key — permissions,
#    other hook events, etc. — is left untouched). settings.json is backed
#    up to settings.json.bak-<date> immediately before any write, and only
#    if a write is actually happening.
#
# Note: settings.json itself is intentionally NOT version-controlled in this
# public repo (it contains Josh's permission strings); it's backed up
# privately instead, alongside Claude Code memory (see
# scripts/backup-claude-memory.sh). SESSION_START_HOOKS / PRE_TOOL_USE_HOOKS
# below are the hooks THIS script keeps registered automatically; add a new
# hook's script name (+ matcher, for PreToolUse) there and re-run to wire it
# up with no manual settings edit (web-jam-tools#163; PreToolUse matcher
# generalization web-jam-tools#265).
#
# Usage: scripts/install-hooks.sh [--settings-path PATH]
#   --settings-path PATH   Merge into PATH instead of $HOME/.claude/settings.json
#                           (also settable via CLAUDE_SETTINGS_PATH). Mainly for
#                           testing the merge without touching a real settings file.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_SRC="$REPO_DIR/hooks"
HOOKS_DEST="$HOME/.claude/hooks"
STAMP="$(date +%Y%m%d-%H%M%S)"
SETTINGS_PATH="${CLAUDE_SETTINGS_PATH:-$HOME/.claude/settings.json}"

# SessionStart hooks this installer keeps registered in settings.json.
# Script names only (must exist under hooks/); the merge step below turns
# each into the literal command string "$HOME/.claude/hooks/<name>" (expanded
# by the shell that runs the hook, not by this installer — matches the style
# of the hooks already wired into settings.json).
SESSION_START_HOOKS=(notes-sync-reminder.sh)

# PreToolUse hooks this installer keeps registered in settings.json, as
# "<matcher>::<script>" pairs (web-jam-tools#265 — generalized from a
# Bash-only array so a hook can be wired to ANY PreToolUse matcher, not just
# Bash). Multiple scripts may share a matcher — each becomes its own entry
# under that matcher's "hooks" array in settings.json. Script names must
# exist under hooks/; matchers are plain PreToolUse matcher strings (a
# literal tool name, an alternation like "Edit|Write", or a regex like
# "mcp__.*__issue_write").
PRE_TOOL_USE_HOOKS=(
  "Bash::semver-push-reminder.sh"
  "Bash::block-secret-dumps.sh"
  "Bash::block-dangerous-git-deploy.sh"
  "Bash::authorization-check.sh"
  "Bash::fmt-push-guard.sh"
  "Bash::block-agy-non-flash-model.sh"
  "Edit|Write::feature-branch-guard.sh"
  "mcp__gmail__.*::haiku-only-gmail-gate.sh"
  "mcp__.*__issue_write::require-model-label-on-issue-create.sh"
)

while [ $# -gt 0 ]; do
  case "$1" in
    --settings-path)
      SETTINGS_PATH="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

[ -d "$HOOKS_SRC" ] || { echo "error: $HOOKS_SRC not found" >&2; exit 1; }
mkdir -p "$HOOKS_DEST"

for src in "$HOOKS_SRC"/*.sh; do
  [ -e "$src" ] || continue
  name="$(basename "$src")"
  dest="$HOOKS_DEST/$name"

  # Already the correct symlink → nothing to do.
  if [ -L "$dest" ] && [ "$(readlink -f "$dest")" = "$(readlink -f "$src")" ]; then
    echo "$name: ok (already linked)"
    continue
  fi

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    mv "$dest" "$dest.bak-$STAMP"
    ln -s "$src" "$dest"
    echo "$name: linked (previous version backed up to $name.bak-$STAMP)"
  else
    ln -s "$src" "$dest"
    echo "$name: linked (new)"
  fi
done

# --- Merge SESSION_START_HOOKS and PRE_TOOL_USE_HOOKS into settings.json (idempotent) ---
merge_session_start_args=()
for name in "${SESSION_START_HOOKS[@]}"; do
  [ -e "$HOOKS_SRC/$name" ] || { echo "error: $HOOKS_SRC/$name not found (listed in SESSION_START_HOOKS)" >&2; exit 1; }
  # shellcheck disable=SC2016 # literal $HOME on purpose: expanded by the
  # shell that runs the hook later, not by this installer (see header note).
  merge_session_start_args+=('$HOME/.claude/hooks/'"$name")
done

merge_pre_tool_use_args=()
for entry in "${PRE_TOOL_USE_HOOKS[@]}"; do
  matcher="${entry%%::*}"
  name="${entry#*::}"
  [ -e "$HOOKS_SRC/$name" ] || { echo "error: $HOOKS_SRC/$name not found (listed in PRE_TOOL_USE_HOOKS)" >&2; exit 1; }
  # shellcheck disable=SC2016 # literal $HOME on purpose: expanded by the
  # shell that runs the hook later, not by this installer (see header note).
  merge_pre_tool_use_args+=("$matcher"'::$HOME/.claude/hooks/'"$name")
done

# The merge logic itself lives in its own file (web-jam-tools#265) so it can
# be unit-tested in isolation against fixture JSON — never by running this
# installer, which also symlinks hooks/*.sh into a real ~/.claude/hooks (see
# test/install_hooks_merge.test.ts, and web-jam-tools#273 for why exercising
# that symlink step outside a real install is dangerous).
python3 "$REPO_DIR/scripts/merge-hooks-into-settings.py" "$SETTINGS_PATH" "--" "${merge_session_start_args[@]}" "--pre-tool-use" "${merge_pre_tool_use_args[@]}"
