#!/usr/bin/env bash
# drive-cleanup-prepass.sh — web-jam-tools#51 (drive-cleanup Tier 2)
#
# Deterministic rclone pre-pass for /drive-cleanup. It inventories My Drive root
# and the JoshMariaMusic mirror with `rclone lsjson` (one call each — including
# Drive file IDs), mechanically classifies everything rule-shaped, and prints a
# compact report: proposed actions (exact rclone commands, files referenced by
# Drive ID), an ambiguous list for the model to classify, or `CLEAN`.
#
# READ-ONLY: it proposes, it never executes. Phase 2 (Josh's approval) and Phase 3
# (execute) happen in the skill, not here. On a CLEAN result the skill short-
# circuits with zero model analysis and zero MCP calls.
#
# Testability: if PREPASS_ROOT_JSON / PREPASS_JMM_JSON are set, they are used as the
# inventory instead of calling rclone (lets the classifier be unit-tested with a
# seeded set, no Drive access). Otherwise rclone provides the live inventory.
set -euo pipefail

RCLONE="$(command -v rclone || echo rclone)"

if [ -n "${PREPASS_ROOT_JSON:-}" ]; then
  ROOT_JSON="$PREPASS_ROOT_JSON"
else
  ROOT_JSON="$("$RCLONE" lsjson gdrive: --max-depth 1 2>/dev/null || echo '[]')"
fi
if [ -n "${PREPASS_JMM_JSON:-}" ]; then
  JMM_JSON="$PREPASS_JMM_JSON"
else
  JMM_JSON="$("$RCLONE" lsjson gdrive:JoshMariaMusic/ 2>/dev/null || echo '[]')"
fi

export ROOT_JSON JMM_JSON
export JMM_LOCAL="${JMM_LOCAL:-$HOME/Dropbox/joshandmariamusic/JoshMariaMusic}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deno run --allow-env --allow-read "$SCRIPT_DIR/drive_cleanup_prepass.ts"
