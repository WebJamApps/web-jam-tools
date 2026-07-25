#!/usr/bin/env bash
# PreToolUse guard (Bash): restrict `agy` (Antigravity CLI) invocations to
# Flash 3.6 models only. Design: web-jam-tools#267 ("agy flash default model
# fix", approved by Josh 2026-07-25).
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
#     configured default — separately pinned to Flash 3.6 Medium in
#     ~/.gemini/antigravity-cli/settings.json, a laptop-local step outside
#     this hook's / this repo's reach, web-jam-tools#267 item 2).
#   - `--model` (or `--model=`) equal to one of the three Flash 3.6 slugs:
#     gemini-3.6-flash-low, gemini-3.6-flash-medium, gemini-3.6-flash-high.
#
# BLOCKED:
#   - any other --model value (notably claude-sonnet-4-6,
#     claude-opus-4-6-thinking, gpt-oss-120b-medium, gemini-3.1-pro-*, and
#     every gemini-3.5-flash-* slug).
#   - an AGY_MODELS=... env-var prefix on the SAME agy invocation naming
#     anything outside those three slugs — that path bypasses --model
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
cmd=$(printf '%s' "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
[ -z "$cmd" ] && exit 0

result=$(CMD_FOR_PY="$cmd" python3 <<'PYEOF' 2>/dev/null
import os
import re
import shlex
import sys

ALLOWED = {"gemini-3.6-flash-low", "gemini-3.6-flash-medium", "gemini-3.6-flash-high"}
OPERATORS = {"&&", "||", ";", "|", "(", ")"}
ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")

cmd = os.environ.get("CMD_FOR_PY", "")
try:
    tokens = shlex.split(cmd, posix=True)
except ValueError:
    # Unbalanced quotes etc: fail open rather than guess — matches this
    # hook's narrow scope (only ever acts on a real, parseable `agy` call).
    print("OK")
    sys.exit(0)

# Split into simple commands on shell chain/pipe operators. shlex.split
# already treats newlines as whitespace, so each operator survives as its
# own token and is enough to split on.
simple_commands = [[]]
for tok in tokens:
    if tok in OPERATORS:
        simple_commands.append([])
    else:
        simple_commands[-1].append(tok)

for sc in simple_commands:
    if not sc:
        continue

    # Leading VAR=value assignments (standard `VAR=val cmd` shell prefix
    # form) before the actual command token.
    i = 0
    env_agy_models = None
    while i < len(sc):
        m = ASSIGN_RE.match(sc[i])
        if not m:
            break
        if m.group(1) == "AGY_MODELS":
            env_agy_models = m.group(2)
        i += 1
    if i >= len(sc):
        continue  # only assignments, no command

    command_name = sc[i].rsplit("/", 1)[-1]
    if command_name != "agy":
        continue

    args = sc[i + 1:]

    if env_agy_models is not None:
        values = [v for v in env_agy_models.split("|") if v]
        bad = [v for v in values if v not in ALLOWED]
        if not values or bad:
            print("BLOCK_ENV:" + env_agy_models)
            sys.exit(0)

    j = 0
    while j < len(args):
        a = args[j]
        if a == "--model":
            if j + 1 >= len(args):
                print("BLOCK_MODEL:(missing value)")
                sys.exit(0)
            val = args[j + 1]
            if val not in ALLOWED:
                print("BLOCK_MODEL:" + val)
                sys.exit(0)
            j += 2
            continue
        if a.startswith("--model="):
            val = a[len("--model="):]
            if val not in ALLOWED:
                print("BLOCK_MODEL:" + val)
                sys.exit(0)
            j += 1
            continue
        j += 1

print("OK")
PYEOF
) || true

# python3 unavailable/crashed, or nothing came back: fail open — this is a
# cost-control guard, not a secret-leak guard, so an unparseable command is
# let through rather than guessed at.
[ -z "$result" ] && exit 0
[ "$result" = "OK" ] && exit 0

block() {
  echo "BLOCKED (agy-model guard): $1" >&2
  echo "agy is restricted to Flash 3.6: gemini-3.6-flash-low, gemini-3.6-flash-medium, or gemini-3.6-flash-high — or omit --model entirely to use agy's own configured default." >&2
  echo "(design: web-jam-tools#267 — override by rephrasing to one of the allowed slugs)" >&2
  exit 2
}

case "$result" in
  BLOCK_MODEL:*)
    block "agy --model '${result#BLOCK_MODEL:}' is not an allowed Flash 3.6 slug."
    ;;
  BLOCK_ENV:*)
    block "AGY_MODELS='${result#BLOCK_ENV:}' names a model outside Flash 3.6 (this path bypasses --model)."
    ;;
  *)
    exit 0
    ;;
esac
