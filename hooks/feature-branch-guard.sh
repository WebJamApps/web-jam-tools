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

input=$(cat)
file=$(printf '%s' "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null || true)
[ -z "$file" ] && exit 0

dir=$(dirname "$file")
top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
[ -z "$top" ] && exit 0  # not in a git repo → allow

branch=$(git -C "$dir" branch --show-current 2>/dev/null || true)
case "$branch" in
  dev|main|master)
    echo "BLOCKED: $top is on protected branch '$branch'. Create a feature branch before editing code:" >&2
    echo "  git -C '$top' checkout -b <feat-name> origin/dev" >&2
    echo "(rule: git-feature-branch-and-semver)" >&2
    exit 2
    ;;
esac
exit 0
