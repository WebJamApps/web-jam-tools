#!/usr/bin/env bash
# PreToolUse guard (Write|Edit|NotebookEdit): deny write/edit calls to files outside the repo working tree.
#
# agy reaches this guard through agy-hook-shim.sh. Its conversation artifact folder
# is allowed alongside the existing scratch/document paths.
#
# Exit 2 = block (stderr shown to model).
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "$HOOK_DIR/lib/run_hook.sh" --group workflow --name block-out-of-tree-write \
  --allow-with-note "out-of-tree write guard: could not determine the repository root or write target; proceeding. Verify the target is in the intended repository working tree or an allowed scratch/document path before writing." \
  deno run --no-config --allow-env --allow-read --allow-run "$HOOK_DIR/lib/check_out_of_tree_write.ts"
