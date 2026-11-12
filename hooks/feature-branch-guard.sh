#!/usr/bin/env bash
# PreToolUse guard (Bash|Edit|Write): block recognized writes to dev/main/master.
# Bash targets come from the same detector the delegation gate uses. Unknown
# shapes and files outside git working trees remain allowed. Codex apply_patch
# keeps its existing multi-file and malformed-patch handling.
# Rationale: see memory git-feature-branch-and-semver. Burned 2026-05-29 by
# building a whole migration on an unrelated leftover branch.
# Files outside any git repo and files on a feature branch remain allowed.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "$HOOK_DIR/lib/run_hook.sh" --group workflow --name feature-branch-guard \
  deno run --no-config --allow-read --allow-run=git --allow-env=HOME \
  "$HOOK_DIR/lib/check_feature_branch.ts"
