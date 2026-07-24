#!/usr/bin/env bash
# scripts/new-agent-worktree.sh — web-jam-tools#257
#
# Creates an isolated git worktree for a WebJamApps repo/branch, and seeds
# gitignored .env / .env.test into it from the repo's main clone when
# present (a fresh worktree never inherits gitignored files — that gap broke
# local DB-backed test runs in isolated worktrees). The cp step depends on
# hooks/block-secret-dumps.sh's cp/test exception added alongside this
# script (#257) — without it, an agent working in the new worktree couldn't
# `cp` the seeded files itself if it ever needed to redo this by hand.
#
# Usage: scripts/new-agent-worktree.sh <Repo> <branch> [base]
#   Repo   - sibling directory name under the WebJamApps workspace root
#            (e.g. WebJamSocketCluster), must already be a git clone
#   branch - branch name to create for the new worktree
#   base   - base ref to branch from (default: dev)
#
# Env:
#   WEBJAMAPPS_ROOT - workspace root containing the sibling repo clones
#                      (default: /home/joshua/WebJamApps)
#
# Prints the new worktree's absolute path on stdout as the last line.

set -euo pipefail

REPO_NAME="${1:?Usage: $0 <Repo> <branch> [base]}"
BRANCH="${2:?Usage: $0 <Repo> <branch> [base]}"
BASE="${3:-dev}"

WORKSPACE_ROOT="${WEBJAMAPPS_ROOT:-/home/joshua/WebJamApps}"
MAIN_CLONE="$WORKSPACE_ROOT/$REPO_NAME"

if [ ! -d "$MAIN_CLONE/.git" ]; then
  echo "error: $MAIN_CLONE is not a git repo (no .git found)" >&2
  exit 1
fi

# Sanitize the branch name for use as a directory (branches may contain "/").
WORKTREE_DIRNAME="${BRANCH//\//-}"
WORKTREE_DIR="$MAIN_CLONE/.claude/worktrees/$WORKTREE_DIRNAME"

if [ -e "$WORKTREE_DIR" ]; then
  echo "error: $WORKTREE_DIR already exists" >&2
  exit 1
fi

echo "Fetching origin/$BASE in $MAIN_CLONE..." >&2
git -C "$MAIN_CLONE" fetch origin "$BASE"

echo "Adding worktree $WORKTREE_DIR on branch $BRANCH (from origin/$BASE)..." >&2
git -C "$MAIN_CLONE" worktree add -B "$BRANCH" "$WORKTREE_DIR" "origin/$BASE"

for f in .env .env.test; do
  if test -f "$MAIN_CLONE/$f"; then
    cp "$MAIN_CLONE/$f" "$WORKTREE_DIR/$f"
    echo "Seeded $f into $WORKTREE_DIR" >&2
  fi
done

echo "$WORKTREE_DIR"
