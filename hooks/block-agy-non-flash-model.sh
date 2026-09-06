#!/usr/bin/env bash
# PreToolUse guard (Bash): restrict `agy` (Antigravity CLI) invocations to
# Flash models only (3.7 floor or newer). Design: web-jam-tools#267 ("agy flash
# default model fix", approved by Josh 2026-07-25; web-jam-tools#549).
#
# Rationale: agy's own configured default has drifted before (Flash High
# instead of the intended cheaper Medium), and nothing stopped an ad hoc
# `agy --model claude-opus-4-6-thinking` (or similar) from burning
# Claude/Gemini-Pro-priced quota on what's supposed to be the cheap Flash
# lane. Config-and-docs alone was rejected in the design discussion because
# it leaves "agy never picks another model" a promise instead of a guarantee
# — this hook makes it a guarantee.
#
# ALLOWED:
#   - a bare `agy` call with no --model flag (falls through to agy's own
#     configured default — separately pinned to Flash High in
#     ~/.gemini/antigravity-cli/settings.json, a laptop-local step outside
#     this hook's / this repo's reach, web-jam-tools#267 item 2, web-jam-tools#549).
#   - `--model` (or `--model=`) equal to a Flash model (3.7 floor or newer)
#     (e.g. gemini-3.8-flash-high, gemini-3.8-flash-medium).
#
# BLOCKED:
#   - any other --model value (notably claude-sonnet-4-6,
#     claude-opus-4-6-thinking, gpt-oss-120b-medium, gemini-3.1-pro-*, and
#     every Flash slug below the 3.7 floor).
#   - an AGY_MODELS=... env-var prefix on the SAME agy invocation naming
#     anything outside allowed Flash slugs — that path bypasses --model
#     entirely, so it must be checked too.
#
# Only fires on a literal `agy` command invocation (bare `agy` or a path
# ending in /agy, e.g. ~/.local/bin/agy) — NOT on wrapper scripts like
# scripts/handle-agy-tasks.sh that happen to shell out to agy internally;
# those are a separate command as far as the Bash tool (and this hook) is
# concerned. Exit 2 = block (stderr is shown to the model), matching
# hooks/block-secret-dumps.sh's convention.
set -euo pipefail

input=$(cat)
HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[ -z "$cmd" ] && exit 0

result=$(CMD_FOR_PY="$cmd" deno run --no-config --allow-env "$HOOK_DIR/lib/check_agy_model.ts" 2>/dev/null) || true

# python3/deno unavailable/crashed, or nothing came back: fail open — this is a
# cost-control guard, not a secret-leak guard, so an unparseable command is
# let through rather than guessed at.
[ -z "$result" ] && exit 0
[ "$result" = "OK" ] && exit 0

ALLOWED_SLUGS=$(deno run --no-config "$HOOK_DIR/lib/check_agy_model.ts" --allowed-slugs 2>/dev/null || echo "gemini-3.8-flash-high or gemini-3.8-flash-medium")

block() {
  echo "BLOCKED (agy-model guard): $1" >&2
  echo "agy is restricted to Flash: $ALLOWED_SLUGS — or omit --model entirely to use agy's own configured default." >&2
  echo "(design: web-jam-tools#267 — override by rephrasing to one of the allowed slugs)" >&2
  exit 2
}

case "$result" in
  BLOCK_MODEL:*)
    block "agy --model '${result#BLOCK_MODEL:}' is not an allowed Flash slug."
    ;;
  BLOCK_ENV:*)
    block "AGY_MODELS='${result#BLOCK_ENV:}' names a model outside Flash (this path bypasses --model)."
    ;;
  *)
    exit 0
    ;;
esac
