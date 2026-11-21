#!/usr/bin/env bash
# PreToolUse guard (Bash, Read, agy view_file and read_file): refuses an agent read of a file
# that holds a Social Security number or ITIN, a full card number, a routing
# number or a bank account number (web-jam-tools#1860).
#
# Design: ~/Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.md,
# "What an agent reads". The checks live in hooks/lib/check_personal_numbers_read.ts;
# the checker in hooks/lib/detect_personal_numbers.ts.
#
# Three outcomes:
#   - Refuse: a file the call names holds a protected number (exit 2, kind and
#     file on stderr, never the number).
#   - Allow: no file the call names holds one (exit 0).
#   - Refuse (fails closed): the guard cannot open a file the call names, or a
#     folder sweep passes 20,000 files or 8 seconds (exit 2).
#
# Registered for:
#   - Claude Code: settings.json PreToolUse, matcher "Bash|Read".
#   - agy: via hooks/agy-hook-shim.sh on run_command and view_file|read_file.
#   - Codex: ~/.codex/config.toml PreToolUse, matcher "Bash" (WJT_SURFACE=codex).
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "$HOOK_DIR/lib/run_hook.sh" --group safety --name block-personal-numbers-read deno run --no-config --allow-env --allow-read --allow-run=pdftotext "$HOOK_DIR/lib/check_personal_numbers_read.ts" "$@"
