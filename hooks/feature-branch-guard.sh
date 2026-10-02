#!/usr/bin/env bash
# PreToolUse guard (Edit|Write): block edits when the target file's git repo is
# on a protected branch (dev/main/master), forcing a feature branch first.
#
# Rationale: see memory git-feature-branch-and-semver. Burned 2026-05-29 by
# building a whole migration on an unrelated leftover branch.
#
# Allows: files outside any git repo (e.g. ~/.claude memory, /tmp), and files
# already on a feature branch. Exit 2 = block (stderr is shown to the model).
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)

files=()
if [ "$tool_name" = "apply_patch" ]; then
  parsed_output="$(printf '%s' "$input" | deno run --no-config "$HOOK_DIR/lib/parse_apply_patch.ts" 2>/dev/null)" || {
    echo "BLOCKED: apply_patch contains no parseable file path (malformed or unrecognized patch text)." >&2
    exit 2
  }
  while IFS= read -r line; do
    [ -n "$line" ] && files+=("$line")
  done <<< "$parsed_output"

  if [ ${#files[@]} -eq 0 ]; then
    echo "BLOCKED: apply_patch contains no parseable file path (malformed or unrecognized patch text)." >&2
    exit 2
  fi
else
  file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
  [ -z "$file" ] && exit 0
  files+=("$file")
fi

for file in "${files[@]}"; do
  dir=$(dirname "$file")
  while [ -n "$dir" ] && [ ! -d "$dir" ]; do
    parent=$(dirname "$dir")
    [ "$parent" = "$dir" ] && break
    dir="$parent"
  done
  [ -z "$dir" ] && dir="."
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
  [ -z "$top" ] && continue  # not in a git repo → allow

  branch=$(git -C "$dir" branch --show-current 2>/dev/null || true)
  case "$branch" in
    dev|main|master)
      echo "BLOCKED: $top is on protected branch '$branch'. Create a feature branch before editing code (file: '$file'):" >&2
      echo "  git -C '$top' checkout -b <feat-name> origin/dev" >&2
      echo "(rule: git-feature-branch-and-semver)" >&2
      exit 2
      ;;
  esac
done

exit 0
