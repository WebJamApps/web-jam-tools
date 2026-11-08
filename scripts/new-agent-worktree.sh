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
#   branch - branch to use, tracking origin when present; never reset
#   base   - base for a new branch (default: dev); ignored for existing branches
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

git check-ref-format --branch "$BRANCH" >/dev/null
echo "Fetching origin in $MAIN_CLONE..." >&2
git -C "$MAIN_CLONE" fetch --prune origin '+refs/heads/*:refs/remotes/origin/*'

REMOTE_REF="refs/remotes/origin/$BRANCH"
LOCAL_REF="refs/heads/$BRANCH"
if git -C "$MAIN_CLONE" show-ref --verify --quiet "$REMOTE_REF"; then
  REMOTE_COMMIT="$(git -C "$MAIN_CLONE" rev-parse "$REMOTE_REF")"
  if git -C "$MAIN_CLONE" show-ref --verify --quiet "$LOCAL_REF"; then
    LOCAL_COMMIT="$(git -C "$MAIN_CLONE" rev-parse "$LOCAL_REF")"
    if [ "$LOCAL_COMMIT" != "$REMOTE_COMMIT" ]; then
      echo "error: branch $BRANCH differs locally and on origin; refusing to move either branch" >&2
      echo "local $BRANCH: $LOCAL_COMMIT" >&2
      echo "origin/$BRANCH: $REMOTE_COMMIT" >&2
      exit 1
    fi
    echo "Case: branch on origin, matching local branch; base '$BASE' ignored." >&2
    git -C "$MAIN_CLONE" worktree add "$WORKTREE_DIR" "$BRANCH"
    git -C "$MAIN_CLONE" branch --set-upstream-to="origin/$BRANCH" "$BRANCH"
  else
    echo "Case: branch on origin, creating tracking local branch; base '$BASE' ignored." >&2
    git -C "$MAIN_CLONE" worktree add --track -b "$BRANCH" "$WORKTREE_DIR" "origin/$BRANCH"
  fi
elif git -C "$MAIN_CLONE" show-ref --verify --quiet "$LOCAL_REF"; then
  echo "Case: local-only branch, using its existing commits; base '$BASE' ignored." >&2
  git -C "$MAIN_CLONE" worktree add "$WORKTREE_DIR" "$BRANCH"
else
  echo "Case: new branch, starting from origin/$BASE." >&2
  git -C "$MAIN_CLONE" worktree add -b "$BRANCH" "$WORKTREE_DIR" "origin/$BASE"
fi

for f in .env .env.test; do
  if test -f "$MAIN_CLONE/$f"; then
    cp "$MAIN_CLONE/$f" "$WORKTREE_DIR/$f"
    echo "Seeded $f into $WORKTREE_DIR" >&2
  fi
done

echo "$WORKTREE_DIR"
