#!/usr/bin/env bash
# PreToolUse guard (Bash): refuse a git command that would change the
# web-jam-tools canonical clone's checkout or history, on Claude Code and Codex
# (draft-pr design 1.2.0, "Lanes never change the canonical clone", web-jam-tools#1819).
#
# agy receives the same registration via hooks/agy-hook-shim.sh, though agy
# does not honour hook refusals; git's reference-transaction hook holds on agy.
#
# Workflow guard: allows with additionalContext when it cannot tell which
# folder or command runs. Exit 2 = block (stderr shown to model), exit 0 = allow.
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
exec "$HOOK_DIR/lib/run_hook.sh" --group workflow --name block-canonical-clone-change \
  deno run --no-config --allow-env "$HOOK_DIR/lib/check_canonical_clone_change.ts"
