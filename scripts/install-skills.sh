#!/usr/bin/env bash
# install-skills.sh — make this repo the single source of truth for Claude Code skills.
#
# For every directory under <repo>/skills/, symlink ~/.claude/skills/<name> -> it.
# Idempotent: already-correct symlinks are left alone. An existing REAL dir is
# backed up (never deleted) to ~/.claude/skills/<name>.bak-<date>; any local-only
# files in it (runtime/personal state such as rules.yaml, log/, last-run.txt) are
# first copied into the repo dir so they stay reachable through the symlink —
# those patterns are gitignored, so they never end up in the (public) repo.
#
# Usage: scripts/install-skills.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_SRC="$REPO_DIR/skills"
SKILLS_DEST="$HOME/.claude/skills"
STAMP="$(date +%Y%m%d-%H%M%S)"

[ -d "$SKILLS_SRC" ] || { echo "error: $SKILLS_SRC not found" >&2; exit 1; }
mkdir -p "$SKILLS_DEST"

for src in "$SKILLS_SRC"/*/; do
  src="${src%/}"
  name="$(basename "$src")"
  dest="$SKILLS_DEST/$name"

  # Already the correct symlink → nothing to do.
  if [ -L "$dest" ] && [ "$(readlink -f "$dest")" = "$(readlink -f "$src")" ]; then
    echo "$name: ok (already linked)"
    continue
  fi

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ -d "$dest" ] && [ ! -L "$dest" ]; then
      # Real dir: preserve local-only regular files (runtime/personal state)
      # by copying them into the repo dir before backing the dir up.
      while IFS= read -r -d '' f; do
        rel="${f#"$dest"/}"
        if [ ! -e "$src/$rel" ]; then
          mkdir -p "$src/$(dirname "$rel")"
          cp -p "$f" "$src/$rel"
        fi
      done < <(find "$dest" -type f -print0)
    fi
    mv "$dest" "$dest.bak-$STAMP"
    ln -s "$src" "$dest"
    echo "$name: linked (previous version backed up to $name.bak-$STAMP)"
  else
    ln -s "$src" "$dest"
    echo "$name: linked (new)"
  fi
done
