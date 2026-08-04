#!/usr/bin/env bash
# check-install-hooks-drift.sh — SessionStart drift check hook (web-jam-tools#339)
#
# Runs `scripts/install-hooks.sh --check` on session start to verify that
# symlinks and settings rules are up to date.
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
HOOKS_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPO_DIR="$(cd "$HOOKS_DIR/.." && pwd)"

INSTALL_HOOKS="$REPO_DIR/scripts/install-hooks.sh"
if [ -f "$INSTALL_HOOKS" ]; then
  exec "$INSTALL_HOOKS" --check "$@"
else
  FALLBACK="$HOME/WebJamApps/web-jam-tools/scripts/install-hooks.sh"
  if [ -f "$FALLBACK" ]; then
    exec "$FALLBACK" --check "$@"
  fi
fi
