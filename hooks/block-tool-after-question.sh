#!/usr/bin/env bash
# PreToolUse workflow guard (matcher .*): refuse tool calls emitted after an
# unanswered prose question (`?`) in the current turn across agy, Codex, and Claude Code.
#
# Design: ~/Dropbox/web-jam-llms/AI_Misbehaves/hooks-design-2026-09-15.md (v3.8.0),
# section "Tool calls after an unanswered question" (web-jam-tools#1892).
#
# Exit 2 = block (stderr shown to model). Exit 0 = allow (or allow with
# additionalContext note when transcript/payload is missing or unreadable).
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "$HOOK_DIR/lib/run_hook.sh" \
  --group workflow \
  --name block-tool-after-question \
  --event PreToolUse \
  --allow-with-note "block-tool-after-question: checker could not evaluate the transcript; proceeding via workflow default. Ensure you have not asked Josh an unanswered question in the current turn before calling tools." \
  deno run --config "$HOOK_DIR/lib/deno-hook-config.json" --no-lock --allow-read --allow-write --allow-env "$HOOK_DIR/lib/check_tool_after_question.ts"
