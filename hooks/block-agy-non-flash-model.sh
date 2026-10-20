#!/usr/bin/env bash
# PreToolUse guard (Bash): restrict `agy` (Antigravity CLI) invocations to
# Flash models (3.7 floor or newer), Gemini 4 Argon and Claude Sonnet 5.5 at high effort. Design:
# web-jam-tools#267 ("agy flash default model fix", approved by Josh 2026-07-25;
# web-jam-tools#549), extended by the model tier-order design 1.6.0, "The agy model guard".
#
# Rationale: agy's own configured default has drifted before, and nothing stopped an ad hoc
# `agy --model claude-opus-4-6-thinking` (or similar) from burning
# Claude/Gemini-Pro-priced quota on what's supposed to be the cheap Flash
# lane. Config-and-docs alone was rejected in the design discussion because
# it leaves "agy never picks another model" a promise instead of a guarantee
# — this hook makes it a guarantee.
#
# ALLOWED:
#   - a bare `agy` call with no --model flag (falls through to agy's own
#     configured default — separately pinned to Flash in
#     ~/.gemini/antigravity-cli/settings.json, a laptop-local step outside
#     this hook's / this repo's reach, web-jam-tools#267 item 2, web-jam-tools#549).
#   - `--model` (or `--model=`) equal to a Flash model (3.7 floor or newer)
#     (e.g. gemini-3.8-flash-high, gemini-3.8-flash-tiered). The medium level is retired
#     (web-jam-tools#1202): Gemini Flash runs at high effort only.
#   - Argon or Sonnet high, by slug or exact display name from ALLOWED_AGY_MODELS.
#     agy's default stays Gemini 3.8 Flash (High); low and medium levels are refused.
#
# BLOCKED:
#   - any other --model value (notably claude-sonnet-4-6,
#     claude-opus-4-6-thinking, gpt-oss-120b-medium, gemini-3.1-pro-*, and
#     every Flash slug below the 3.7 floor).
#   - an AGY_MODELS=... env-var prefix on the SAME agy invocation naming
#     anything outside the allowed models — that path bypasses --model
#     entirely, so it must be checked too.
#
# Fires wherever a command runs `agy`: as the first word (bare `agy` or a path ending in
# /agy, e.g. ~/.local/bin/agy), behind `timeout`, `nice`, `nohup`, `env`, `command`, `exec`,
# `time` or `sudo`, after `cd x &&`, or inside a `bash -c` / `sh -c` payload. A command that
# mentions agy and cannot be parsed is refused (fails closed). It does NOT fire on wrapper scripts like
# scripts/handle-agy-tasks.sh that happen to shell out to agy internally;
# those are a separate command as far as the Bash tool (and this hook) is
# concerned. Exit 2 = block (stderr is shown to the model), matching
# hooks/block-secret-dumps.sh's convention.
set -euo pipefail

input=$(cat)
HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[ -z "$cmd" ] && exit 0

result=$(CMD_FOR_PY="$cmd" "$HOOK_DIR/lib/run_hook.sh" --group workflow --name block-agy-non-flash-model deno run --no-config --allow-env "$HOOK_DIR/lib/check_agy_model.ts" 2>/dev/null) || true

# python3/deno unavailable/crashed, or nothing came back: fail open — this is a
# cost-control guard, not a secret-leak guard, so an unparseable command is
# let through rather than guessed at.
if [[ "$result" == *'"hookSpecificOutput"'* ]]; then
  printf '%s\n' "$result"
  exit 0
fi
[ -z "$result" ] && exit 0
[ "$result" = "OK" ] && exit 0

ALLOWED_SLUGS=$("$HOOK_DIR/lib/run_hook.sh" --group workflow --name block-agy-non-flash-model deno run --no-config "$HOOK_DIR/lib/check_agy_model.ts" --allowed-slugs 2>/dev/null || echo "gemini-3.8-flash-high or gemini-3.8-flash-tiered")
if [[ "$ALLOWED_SLUGS" == *'"hookSpecificOutput"'* ]] || [ -z "$ALLOWED_SLUGS" ]; then
  ALLOWED_SLUGS="gemini-3.8-flash-high or gemini-3.8-flash-tiered"
fi

block() {
  echo "BLOCKED (agy-model guard): $1" >&2
  echo "agy is restricted to Flash, Argon and Sonnet at high: $ALLOWED_SLUGS — or omit --model entirely to use agy's own configured default." >&2
  echo "(design: web-jam-tools#267 — override by rephrasing to one of the allowed slugs)" >&2
  exit 2
}

case "$result" in
  BLOCK_MODEL:*)
    block "agy --model '${result#BLOCK_MODEL:}' is not an allowed agy model."
    ;;
  BLOCK_ENV:*)
    block "AGY_MODELS='${result#BLOCK_ENV:}' names a model outside the allowed list (this path bypasses --model)."
    ;;
  BLOCK_PARSE:*)
    block "this command runs agy but could not be parsed (${result#BLOCK_PARSE:}); rephrase it so the model can be checked."
    ;;
  *)
    exit 0
    ;;
esac
