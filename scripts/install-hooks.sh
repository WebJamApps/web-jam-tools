#!/usr/bin/env bash
# install-hooks.sh — make this repo the single source of truth for Claude Code hooks.
#
# For every *.sh under <repo>/hooks/, symlink ~/.claude/hooks/<name> -> it.
# Idempotent: already-correct symlinks are left alone. An existing REAL file
# is backed up (never deleted) to ~/.claude/hooks/<name>.bak-<date>.
#
# Note: ~/.claude/settings.json is what REGISTERS these hooks (which script
# fires on which event/matcher) and is intentionally NOT version-controlled
# in this public repo — it contains Josh's permission strings. It is backed
# up privately instead, alongside Claude Code memory (see
# scripts/backup-claude-memory.sh). This script only installs the hook
# scripts themselves; wiring them into settings.json is a manual, one-time
# step done directly on the laptop.
#
# Usage: scripts/install-hooks.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_SRC="$REPO_DIR/hooks"
HOOKS_DEST="$HOME/.claude/hooks"
STAMP="$(date +%Y%m%d-%H%M%S)"

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
