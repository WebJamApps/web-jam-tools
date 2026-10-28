#!/usr/bin/env bash
# PreToolUse guard (Bash|Edit|Write|NotebookEdit): refuses an agent changing an
# existing audio, video or image file, or removing or moving a lead-sheet
# document, in ~/Dropbox/joshandmariamusic (web-jam-tools#1580).
#
# Safety guard: when it cannot tell, it refuses (exit 2, reason on stderr).
#
# Registered for:
#   - Claude Code: directly into ~/.claude/settings.json under matcher "Bash|Edit|Write|NotebookEdit".
#   - agy: via hooks/agy-hook-shim.sh into ~/.gemini/config/hooks.json under matcher ".*".
#   - Codex: registered into ~/.codex/config.toml (WJT_SURFACE=codex) by scripts/install-codex.ts.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "$HOOK_DIR/lib/run_hook.sh" --group safety --name block-production-media-change deno run --no-config --allow-env --allow-read "$HOOK_DIR/lib/check_production_media_change.ts" "$@"
