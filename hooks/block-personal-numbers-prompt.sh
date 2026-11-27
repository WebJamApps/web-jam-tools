#!/usr/bin/env bash
# Prompt check (Claude Code and Codex UserPromptSubmit, agy PreInvocation): refuses a
# message Josh types before the model sees it, when it holds a Social Security number
# or ITIN, a full card number, a routing number or a bank account number
# (web-jam-tools#1861).
#
# Design: ~/Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.md,
# "What Josh types". The check lives in hooks/lib/check_personal_numbers_prompt.ts;
# the checker in hooks/lib/detect_personal_numbers.ts.
#
# Three outcomes:
#   - Refuse: the message holds a protected number (kind named, never the number).
#   - Allow: it holds none; the message is sent.
#   - Refuse (fails closed): the payload carries no readable message, or the check
#     cannot run.
#
# Registered for:
#   - Claude Code: settings.json UserPromptSubmit (exit 2, refusal on stderr).
#   - Codex: ~/.codex/config.toml UserPromptSubmit, WJT_SURFACE=codex
#     ({"decision":"block",...} on stdout).
#   - agy: ~/.gemini/config/hooks.json PreInvocation, launched with --surface agy
#     (injectSteps errorMessage with "terminationBehavior":"terminate" on stdout).
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
SURFACE="claude"
EVENT="UserPromptSubmit"
if [ "${1:-}" = "--surface" ] && [ "${2:-}" = "agy" ]; then
  SURFACE="agy"
  EVENT="PreInvocation"
elif [ "${WJT_SURFACE:-}" = "codex" ]; then
  SURFACE="codex"
fi
exec "$HOOK_DIR/lib/run_hook.sh" --group safety --name block-personal-numbers-prompt --surface "$SURFACE" --event "$EVENT" deno run --no-config --allow-env "$HOOK_DIR/lib/check_personal_numbers_prompt.ts" "$@"
