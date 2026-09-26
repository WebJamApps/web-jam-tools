#!/usr/bin/env bash
# PreToolUse guard (Bash): refuses any shell command naming one of the 16 private
# Dropbox folders Claude Code's Read/Edit deny rules cover (web-jam-tools#1141).
#
# Reads the live folder list directly from ~/.claude/settings.json's permissions.deny
# Read(//home/joshua/Dropbox/<folder>/**) rules — one list, read once, not duplicated
# into the repo.
#
# Three outcomes:
#   - Allow: command names no listed folder (passes, exit 0).
#   - Deny: command names a listed folder (refused, exit 2, reason on stderr).
#   - Refused (fails closed): ~/.claude/settings.json missing/unreadable/unparseable (exit 2).
#
# Registered for:
#   - Claude Code: directly into settings.json under matcher "Bash".
#   - agy: via hooks/agy-hook-shim.sh into ~/.gemini/config/hooks.json under matcher ".*".
#   - Codex: registered into ~/.codex/config.toml (WJT_SURFACE=codex) by Codex installer.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec deno run --no-config --allow-env --allow-read "$HOOK_DIR/lib/check_private_folder_read.ts" "$@"
