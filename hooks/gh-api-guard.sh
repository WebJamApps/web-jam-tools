#!/usr/bin/env bash
# PreToolUse guard (Bash): Match gh api commands to enforce consent rules (R-6).
# - Deny (exit 2) if method is DELETE (-X DELETE / --method DELETE), EXCEPT
#   for the narrow, reversible carve-out of removing an issue dependency:
#   gh api --method DELETE repos/<owner>/<repo>/issues/<N>/dependencies/blocked_by/<ID>
#   (see the DELETE block below for the safety posture on that carve-out).
# - Force prompt (JSON ask) if method is POST/PUT/PATCH or field flags are passed.
set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // .toolCall.args.CommandLine // empty' 2>/dev/null || true)
[ -z "$cmd" ] && exit 0

# Check if command includes `gh api`
if ! printf '%s' "$cmd" | grep -Eq 'gh +api( |$)'; then
  exit 0
fi

# Lowercase for uniform inspection, then strip quote characters so a quoted
# method/flag value (gh api -X 'DELETE', --method='DELETE') cannot dodge the
# unquoted-literal regexes below (web-jam-tools#425 post-approval finding).
lc_cmd=$(printf '%s' "$cmd" | tr '[:upper:]' '[:lower:]')
norm_cmd=$(printf '%s' "$lc_cmd" | tr -d "\"'")

# Check for DELETE method
if printf '%s' "$norm_cmd" | grep -Eq '(-x|--method) +delete|(-xdelete|--method=delete)'; then
  # Narrow carve-out (web-jam-tools, gh-api-guard blocked_by DELETE carve-out):
  # allow ONLY removing an issue dependency —
  #   gh api --method DELETE repos/<owner>/<repo>/issues/<N>/dependencies/blocked_by/<ID>
  # (or the -X DELETE spelling) — because it is reversible: the dependency
  # can be re-added with the corresponding POST to .../dependencies/blocked_by.
  # Everything else that is a DELETE stays denied.
  #
  # Safety posture (this must never become a general DELETE bypass):
  #  1. The path is matched anchored to the full (whitespace-squeezed)
  #     command, not merely as a substring — "blocked_by" appearing
  #     anywhere else (a comment, a different path) does not match.
  #  2. Any shell metacharacter that could chain or embed another command
  #     (`;`, `&&`, `||`, `|`, backtick, `$(`, or an embedded newline)
  #     disqualifies the command from the carve-out outright, so a DELETE
  #     hidden in a compound/chained command is always denied.
  #  3. Extra trailing arguments, a different owner/repo/issue/dependency
  #     id shape, or a different endpoint all fail the anchored match and
  #     fall through to the standard deny below.
  is_compound=0
  case "$cmd" in
    *$'\n'*) is_compound=1 ;;
  esac
  if [ "$is_compound" -eq 0 ] && printf '%s' "$norm_cmd" | grep -Eq '[;|&`]|\$\('; then
    is_compound=1
  fi

  if [ "$is_compound" -eq 0 ]; then
    squeezed_cmd=$(printf '%s' "$norm_cmd" | tr -s '[:space:]' ' ' | sed -e 's/^ *//' -e 's/ *$//')
    allowed_re='^gh api (--method[[:space:]]+delete|--method=delete|-x[[:space:]]+delete|-xdelete)[[:space:]]+repos/[a-z0-9_.-]+/[a-z0-9_.-]+/issues/[0-9]+/dependencies/blocked_by/[0-9]+$'
    if printf '%s' "$squeezed_cmd" | grep -Eq "$allowed_re"; then
      exit 0
    fi
  fi

  echo "BLOCKED (gh api guard): gh api DELETE is denied (irreversible state change)." >&2
  echo "This is Josh's decision to make — propose the command and let Josh run it manually." >&2
  exit 2
fi

# Check for state-changing methods (POST, PUT, PATCH) or field flags (-f, --raw-field,
# --field, --input). -F is not matched separately: $norm_cmd is already lowercased, so
# -F can never appear in it.
if printf '%s' "$norm_cmd" | grep -Eq '(-x|--method) +(post|put|patch)|(-xpost|-xput|-xpatch|--method=post|--method=put|--method=patch)|(^|[[:space:]])-f([[:space:]=$]|$)|--field|--raw-field|--input'; then
  jq -cn '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:"gh api state-changing command requires user confirmation"}}'
  exit 0
fi

exit 0
