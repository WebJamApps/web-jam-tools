#!/usr/bin/env bash
# PreToolUse guard (Bash): block commands that carry a credential-shaped
# LITERAL as an argument, before Claude Code can approve (and permanently
# persist) them.
#
# Rationale (web-jam-tools#304): approving a Bash command that contains a
# literal secret causes the ENTIRE command string — secret included — to be
# written into permissions.allow in ~/.claude/settings.json, in plaintext,
# forever. A live Gemini API key was found sitting there as allow rule #104
# in the form `Bash(export GEMINI_API_KEY="<key>")`. Neither existing secret
# hook catches this:
#   - scan-output-for-secrets.sh is PostToolUse and scans PRINTED output —
#     `export` prints nothing.
#   - block-secret-dumps.sh is PreToolUse but only blocks commands that READ
#     a known secret FILE — a secret passed as a literal argument never
#     reads a file.
# This hook closes that gap by matching the command TEXT itself for
# credential shapes, independent of whether the command reads or prints
# anything. Exit 2 = block (stderr is shown to the model).
set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[ -z "$cmd" ] && exit 0

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
match=$(CMD_FOR_PY="$cmd" deno run --allow-env "$HOOK_DIR/lib/detect_credential_literal.ts" 2>/dev/null) || true

if [ -n "$match" ]; then
  echo "BLOCKED (secret-literal guard): this command contains a credential-shaped literal ($match)." >&2
  echo "Approving it would persist the SECRET ITSELF, verbatim, into permissions.allow in ~/.claude/settings.json — permanently and in plaintext." >&2
  echo "Safe alternative: set the variable in ~/.bashrc (e.g. export GEMINI_API_KEY=\"...\") and let the shell supply it — never pass the literal value as a command argument." >&2
  echo "(rule: web-jam-tools#304 — secrets-in-approved-Bash-commands)" >&2
  exit 2
fi

exit 0
