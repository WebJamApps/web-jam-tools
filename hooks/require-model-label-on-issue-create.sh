#!/usr/bin/env bash
# PreToolUse guard: deny an issue-creating or issue-editing call that violates
# model-label, native-type, executable-issue, or duplicate-search rules.
# Design: web-jam-tools#265 (model label on issue creation), web-jam-tools#342 (executable issue rule),
# web-jam-tools#415 (native type) & web-jam-tools#901 (enforced duplicate search).
#
# The duplicate-search check (web-jam-tools#901) shells out to `gh issue
# list` when a create call carries both --repo/repo and --title/title (see
# hooks/lib/detect_duplicate_issue.ts) — hence --allow-run=gh below. The
# Authored-by footer check (web-jam-tools#1205) runs the read-only roster probe
# scripts/create-draft-pr.sh --check-author, so that one script is allowed too.
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
# Workflow guard: allow with additionalContext when the check cannot run.
# Determinable violations still exit 2 (stderr shown to model).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"/.. && pwd)"
MODEL_LABELS_JSON="$REPO_DIR/skills/fix-labels/model-labels.json"

input=$(cat)

status=0
result=$(printf '%s' "$input" | MODEL_LABELS_JSON_PATH="$MODEL_LABELS_JSON" REPO_DIR="$REPO_DIR" deno run --no-config --allow-env --allow-read --allow-run=gh,"$REPO_DIR/scripts/create-draft-pr.sh" "$REPO_DIR/hooks/lib/check_model_label_on_issue_create.ts" 2>/dev/null) || status=$?

if [ "$status" -ne 0 ]; then
  result="PASS: could not determine issue model-label requirements (checker exited $status); proceeding. Verify the model label, native type, and body before creating or editing an issue."
elif [ -z "$result" ]; then
  result="PASS: could not determine issue model-label requirements (checker returned no result); proceeding. Verify the model label, native type, and body before creating or editing an issue."
fi

case "$result" in
  PASS)
    exit 0
    ;;
  PASS:*)
    # Allowed, and the guard says why it could not check everything (web-jam-tools#1115).
    note="model-label guard: ${result#PASS: }"
    jq -cn --arg note "$note" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $note}}'
    exit 0
    ;;
  DENY:*)
    echo "BLOCKED (model-label guard): ${result#DENY:}" >&2
    echo "(rule: executable-issue / model-label / native-type — see skills/file-issue/SKILL.md)" >&2
    exit 2
    ;;
  *)
    note="model-label guard: could not determine issue model-label requirements (unrecognized checker result); proceeding. Verify the model label, native type, and body before creating or editing an issue."
    jq -cn --arg note "$note" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $note}}'
    exit 0
    ;;
esac
