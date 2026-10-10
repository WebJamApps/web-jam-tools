#!/usr/bin/env bash
# PreToolUse guard: check issue citations in bodies written to GitHub (web-jam-tools#1056).
# Reuses hooks/lib/detect_bare_issue_refs.ts against bodies written via:
#   - Bash: gh pr comment, gh pr review, gh issue comment, gh issue create, gh issue edit
#     (and guarded task equivalents: post-pr-comment, post-pr-review, post-issue-comment, edit-issue, create-issue)
#   - MCP: issue_write, pull_request_review_write, add_comment_to_pending_review,
#     add_reply_to_pull_request_comment, update_issue_comment, add_issue_comment
#
# Fail OPEN on parse errors (workflow guard, D-16, D-20). Exit 2 on bare citation (stderr shown to model).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"/.. && pwd)"
CHECKER="$REPO_DIR/hooks/lib/check_issue_citation_on_write.ts"

input=$(cat)

status=0
result=$(printf '%s' "$input" | deno run --no-config --allow-env --allow-read "$CHECKER" 2>/dev/null) || status=$?

if [ "$status" -ne 0 ]; then
  result="PASS: citation check could not run (checker exited $status); proceeding"
elif [ -z "$result" ]; then
  result="PASS: citation check could not run (checker returned no result); proceeding"
fi

emit_note() {
  local note="issue-citation guard: $1"
  jq -cn --arg note "$note" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $note}}' 2>/dev/null || printf '%s\n' "$note" >&2
}

case "$result" in
  PASS)
    exit 0
    ;;
  PASS:*)
    emit_note "${result#PASS: }"
    exit 0
    ;;
  DENY:*)
    printf '%s\n' "${result#DENY:}" >&2
    exit 2
    ;;
  *)
    emit_note "citation check could not run (unrecognized checker result); proceeding"
    exit 0
    ;;
esac
