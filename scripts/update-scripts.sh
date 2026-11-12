#!/usr/bin/env bash
# update-scripts.sh — update installed hooks from any directory.
#
# Fast-forward pulls dev in the web-jam-tools clone, then runs install-hooks.sh
# (arguments such as --check are passed through). Refuses unless the clone is
# on dev, so it never merges dev into a feature branch.
set -euo pipefail

REPO="${WJT_REPO_DIR:-$HOME/WebJamApps/web-jam-tools}"

branch="$(git -C "$REPO" symbolic-ref --short HEAD)"
if [ "$branch" != "dev" ]; then
  echo "update-scripts: the clone at $REPO is on branch '$branch', not dev; pulling would merge dev into that branch." >&2
  echo "Switch it to dev first: git -C \"$REPO\" checkout dev" >&2
  exit 1
fi

git -C "$REPO" pull --ff-only origin dev
exec bash "$REPO/scripts/install-hooks.sh" "$@"
