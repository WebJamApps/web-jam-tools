#!/usr/bin/env bash
# PreToolUse guard: deny an issue-creating or issue-editing call that violates
# model-label, native-type, or executable-issue rules.
# Design: web-jam-tools#265 (model label on issue creation), web-jam-tools#342 (executable issue rule) & web-jam-tools#415 (native type).
#
# Intercepts BOTH surfaces (web-jam-tools#747 fixed the registration gap that
# had left the Bash half of this unreachable — see scripts/install-hooks.sh's
# PRE_TOOL_USE_HOOKS matcher for this script, which must include "Bash" for
# this comment to be true):
#   - Bash: `gh issue create`, `gh issue edit`, `deno task create-issue`,
#     `deno task issue:create`, `deno run .../create-issue.ts`, and a direct
#     `scripts/create-issue.ts` invocation (web-jam-tools#553)
#   - MCP: any `mcp__*__issue_write` tool call (method: create, update, edit)
#
# Fail CLOSED on ambiguity. Exit 2 = block (stderr shown to model).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"/.. && pwd)"
MODEL_LABELS_JSON="$REPO_DIR/skills/fix-labels/model-labels.json"

input=$(cat)

result=$(printf '%s' "$input" | MODEL_LABELS_JSON_PATH="$MODEL_LABELS_JSON" REPO_DIR="$REPO_DIR" deno run --no-config --allow-env --allow-read "$REPO_DIR/hooks/lib/check_model_label_on_issue_create.ts" 2>/dev/null) || true


if [ -z "$result" ]; then
  if printf '%s' "$input" | grep -Eq '"tool_name"[[:space:]]*:[[:space:]]*"mcp__[^"]*__issue_write"' \
    || (printf '%s' "$input" | grep -Eq '\bgh\b' \
        && printf '%s' "$input" | grep -Eq '\bissue\b' \
        && (printf '%s' "$input" | grep -Eq '\bcreate\b' || printf '%s' "$input" | grep -Eq '\bedit\b')) \
    || printf '%s' "$input" | grep -Eq 'create-issue'; then
    echo "BLOCKED (model-label guard): couldn't parse this issue create/edit call (hook parser failure)." >&2
    echo "Check that model label, native type, and issue body meet requirements (web-jam-tools#265, web-jam-tools#342, web-jam-tools#415)." >&2
    exit 2
  fi
  exit 0
fi

case "$result" in
  PASS)
    exit 0
    ;;
  DENY:*)
    echo "BLOCKED (model-label guard): ${result#DENY:}" >&2
    echo "(rule: executable-issue / model-label / native-type — see skills/file-issue/SKILL.md)" >&2
    exit 2
    ;;
  *)
    exit 0
    ;;
esac
