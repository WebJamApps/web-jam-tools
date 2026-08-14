#!/usr/bin/env bash
# install-skills.sh — make this repo the single source of truth for Claude Code & agy skills.
#
# For every directory under <repo>/skills/, symlink ~/.claude/skills/<name> and
# ~/.gemini/config/plugins/webjam-tasks/skills/<name> -> it.
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
CLAUDE_SKILLS_DEST="$HOME/.claude/skills"
AGY_SKILLS_DEST="$HOME/.gemini/config/plugins/webjam-tasks/skills"
STAMP="$(date +%Y%m%d-%H%M%S)"

[ -d "$SKILLS_SRC" ] || { echo "error: $SKILLS_SRC not found" >&2; exit 1; }
mkdir -p "$CLAUDE_SKILLS_DEST" "$AGY_SKILLS_DEST"

install_to_dest() {
  local target_dest="$1" label="$2"
  for src in "$SKILLS_SRC"/*/; do
    src="${src%/}"
    name="$(basename "$src")"
    dest="$target_dest/$name"

    # Already the correct symlink → nothing to do.
    if [ -L "$dest" ] && [ "$(readlink -f "$dest")" = "$(readlink -f "$src")" ]; then
      echo "$label: $name: ok (already linked)"
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
      echo "$label: $name: linked (previous version backed up to $name.bak-$STAMP)"
    else
      ln -s "$src" "$dest"
      echo "$label: $name: linked (new)"
    fi
  done
}

prune_from_dest() {
  local target_dest="$1" label="$2"
  [ -d "$target_dest" ] || return 0

  local canonical_skills_src
  canonical_skills_src="$(readlink -f "$SKILLS_SRC" 2>/dev/null || echo "$SKILLS_SRC")"

  shopt -s nullglob
  for link in "$target_dest"/*; do
    name="$(basename "$link")"

    # Never touch *.bak-* directories/files
    if [[ "$name" == *.bak-* ]]; then
      continue
    fi

    # Check if entry is a symlink
    if [ -L "$link" ]; then
      local link_target
      link_target="$(readlink "$link")" || continue

      local is_pointing_to_repo=0
      if [[ "$link_target" == "$SKILLS_SRC"* ]] || [[ "$link_target" == "$canonical_skills_src"* ]]; then
        is_pointing_to_repo=1
      else
        local abs_target="$target_dest/$link_target"
        if [[ "$abs_target" == "$SKILLS_SRC"* ]] || [[ "$abs_target" == "$canonical_skills_src"* ]]; then
          is_pointing_to_repo=1
        fi
      fi

      # If pointing to repo skills/ and target does not exist (dangling link), prune it
      if [ "$is_pointing_to_repo" -eq 1 ] && [ ! -e "$link" ]; then
        rm -f "$link"
        echo "$label: $name: pruned stale symlink (target deleted)"
      fi
    fi
  done
  shopt -u nullglob
}

prune_from_dest "$CLAUDE_SKILLS_DEST" "Claude"
prune_from_dest "$AGY_SKILLS_DEST" "agy"
install_to_dest "$CLAUDE_SKILLS_DEST" "Claude"
install_to_dest "$AGY_SKILLS_DEST" "agy"
