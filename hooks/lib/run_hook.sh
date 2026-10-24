#!/usr/bin/env bash
# run_hook.sh — shared hook runner (web-jam-tools#717, decision D-32).
#
# Runs hook Deno modules through one shared runner that applies each hook's
# group default when Deno cannot run (missing from PATH, crashed, or timed out):
#   - Safety guards: refuse (fail closed, exit 2, refusal message on stderr).
#   - Workflow guards: allow with a note for the agent (exit 0, additionalContext
#     or systemMessage JSON on stdout).
#
# On normal execution (exit 0 or 2), passes through stdout, stderr, and exit code
# byte-identically.
set -euo pipefail

GROUP=""
NAME=""
EVENT=""
SURFACE="claude"
TIMEOUT="15s"
CHECK_ONLY=0
ALLOW_NOTE=""
NOTE_FILE=""
DISCARD_STDOUT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --group|--type)
      GROUP="$2"
      shift 2
      ;;
    --name)
      NAME="$2"
      shift 2
      ;;
    --event)
      EVENT="$2"
      shift 2
      ;;
    --surface)
      SURFACE="$2"
      shift 2
      ;;
    --timeout)
      TIMEOUT="$2"
      shift 2
      ;;
    --allow-with-note)
      ALLOW_NOTE="$2"
      shift 2
      ;;
    --note-file)
      NOTE_FILE="$2"
      shift 2
      ;;
    --discard-stdout)
      DISCARD_STDOUT=1
      shift
      ;;
    --check-only)
      CHECK_ONLY=1
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "run_hook.sh: unknown option: $1" >&2
      exit 1
      ;;
    *)
      # Non-option argument: check if it's positional group/name
      if [ -z "$GROUP" ] && { [ "$1" = "safety" ] || [ "$1" = "workflow" ]; }; then
        GROUP="$1"
        shift
        if [ $# -gt 0 ] && [[ "$1" != -* ]] && [[ "$1" != "deno" ]] && [[ "$1" != *"/"* ]]; then
          NAME="$1"
          shift
        fi
      else
        break
      fi
      ;;
  esac
done

# If NAME was not passed, derive from basename of caller or first script arg
if [ -z "$NAME" ]; then
  if [ $# -gt 0 ]; then
    NAME="$(basename "${!#}" .ts)"
    NAME="${NAME%.sh}"
  else
    NAME="hook"
  fi
fi

# Infer GROUP from hook name if still unset (D-32 authoritative classification)
if [ -z "$GROUP" ]; then
  case "$NAME" in
    block-secret-dumps*|\
    block-secret-literals*|\
    block-dangerous-git-deploy*|\
    block-irreversible-operations*|\
    block-backend-mutation*|\
    block-human-only-credentials*|\
    block-private-folder-read*|\
    require-approval-token-on-issue-write*|\
    block-agy-gmail-send-delete*|\
    scan-output-for-secrets*|\
    gh-api-guard*)
      GROUP="safety"
      ;;
    *)
      GROUP="workflow"
      ;;
  esac
fi

# Buffer stdin if available (non-terminal)
INPUT=""
if [ "$CHECK_ONLY" -eq 0 ] && [ ! -t 0 ]; then
  INPUT="$(cat)"
fi

# Infer EVENT from name or payload if unset
if [ -z "$EVENT" ]; then
  if printf '%s' "$INPUT" | grep -Eq '"(hook_event_name|hookEventName)"[[:space:]]*:[[:space:]]*"PostToolUse"'; then
    EVENT="PostToolUse"
  elif printf '%s' "$INPUT" | grep -Eq '"(hook_event_name|hookEventName)"[[:space:]]*:[[:space:]]*"Stop"'; then
    EVENT="Stop"
  elif printf '%s' "$INPUT" | grep -Eq '"(hook_event_name|hookEventName)"[[:space:]]*:[[:space:]]*"SessionStart"'; then
    EVENT="SessionStart"
  elif printf '%s' "$INPUT" | grep -Eq '"(hook_event_name|hookEventName)"[[:space:]]*:[[:space:]]*"SessionEnd"'; then
    EVENT="SessionEnd"
  else
    case "$NAME" in
      *scan-output-for-secrets*|*regenerate-memory-index*)
        EVENT="PostToolUse"
        ;;
      *stop*|*require-issue-citation-titles*|*require-clear-communication*)
        EVENT="Stop"
        ;;
      *reminder*|notes-sync*|backlog-groom*|backup-refusal*|hook-install*|permission-wildcard*|codex-reaper*)
        EVENT="SessionStart"
        ;;
      *session-end*)
        EVENT="SessionEnd"
        ;;
      *)
        EVENT="PreToolUse"
        ;;
    esac
  fi
fi

emit_workflow_note() {
  local note="$1"
  local ev="${2:-PreToolUse}"
  local payload=""

  if [ "$SURFACE" = "agy" ]; then
    if [ "$ev" = "PostToolUse" ]; then
      payload='{}'
    else
      payload='{"decision":"allow"}'
    fi
  elif [ "$NAME" = "agy-skill-run-hook" ]; then
    local escaped
    escaped=$(printf '%s' "$note" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' ')
    payload=$(printf '{"decision":"allow","hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}' "$ev" "$escaped")
  elif [ "$ev" = "SessionStart" ] || [ "$ev" = "Stop" ]; then
    if command -v jq >/dev/null 2>&1; then
      payload=$(jq -cn --arg m "$note" '{systemMessage: $m}' 2>/dev/null) || payload=""
    fi
    if [ -z "$payload" ]; then
      local escaped
      escaped=$(printf '%s' "$note" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' ')
      payload=$(printf '{"systemMessage":"%s"}' "$escaped")
    fi
  elif [ "$ev" = "SessionEnd" ]; then
    payload=""
  else
    if command -v jq >/dev/null 2>&1; then
      payload=$(jq -cn --arg ev "$ev" --arg ctx "$note" '{hookSpecificOutput: {hookEventName: $ev, additionalContext: $ctx}}' 2>/dev/null) || payload=""
    fi
    if [ -z "$payload" ]; then
      printf '%s\n' "$note" >&2
    fi
  fi

  if [ -n "$NOTE_FILE" ]; then
    if [ -n "$payload" ]; then
      printf '%s\n' "$payload" >"$NOTE_FILE"
    else
      printf '__FALLBACK_STDERR__\n' >"$NOTE_FILE"
    fi
  else
    if [ -n "$payload" ]; then
      printf '%s\n' "$payload"
    fi
  fi
}

emit_safety_refusal() {
  local reason="$1"
  if [ "$SURFACE" = "agy" ]; then
    local escaped
    escaped=$(printf 'BLOCKED (%s): safety guard could not run (%s).' "$NAME" "$reason" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' ')
    if [ "$EVENT" = "PostToolUse" ]; then
      printf '{"overwrite_result":"[BLOCKED BY HOOK] %s — original tool output withheld by a PostToolUse guard."}\n' "$escaped"
    else
      printf '{"decision":"deny","reason":"%s"}\n' "$escaped"
    fi
    echo "BLOCKED ($NAME): safety guard could not run ($reason). Refusing action (safety default: fail closed)." >&2
    echo "Stop and report this refusal to Josh; do not retry the action through another route." >&2
  else
    echo "BLOCKED ($NAME): safety guard could not run ($reason). Refusing action (safety default: fail closed)." >&2
    echo "Stop and report this refusal to Josh; do not retry the action through another route." >&2
  fi
}

# If explicit --allow-with-note was requested without a command to run
if [ -n "$ALLOW_NOTE" ] && [ $# -eq 0 ]; then
  emit_workflow_note "$ALLOW_NOTE" "$EVENT"
  exit 0
fi

get_workflow_note() {
  local fallback="$1"
  if [ -n "$ALLOW_NOTE" ]; then
    printf '%s' "$ALLOW_NOTE"
  else
    printf '%s' "$fallback"
  fi
}

# Locate Deno binary on PATH
DENO_BIN=""
if command -v deno >/dev/null 2>&1; then
  DENO_BIN="$(command -v deno)"
fi

if [ -z "$DENO_BIN" ]; then
  if [ "$GROUP" = "safety" ]; then
    emit_safety_refusal "Deno is unavailable on PATH"
    if [ "$SURFACE" = "agy" ]; then
      exit 0
    else
      exit 2
    fi
  else
    note="$(get_workflow_note "$NAME: Deno is unavailable on PATH; proceeding via workflow default.")"
    emit_workflow_note "$note" "$EVENT"
    exit 0
  fi
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  exit 0
fi

if [ $# -eq 0 ]; then
  exit 0
fi

# Normalize command arguments: strip leading 'deno' if present
CMD_ARGS=("$@")
if [ "${CMD_ARGS[0]}" = "deno" ]; then
  CMD_ARGS=("${CMD_ARGS[@]:1}")
fi

STDOUT_FILE=$(mktemp)
STDERR_FILE=$(mktemp)
trap 'rm -f "$STDOUT_FILE" "$STDERR_FILE"' EXIT

set +e
if command -v timeout >/dev/null 2>&1; then
  printf '%s' "$INPUT" | timeout "$TIMEOUT" "$DENO_BIN" "${CMD_ARGS[@]}" >"$STDOUT_FILE" 2>"$STDERR_FILE"
  STATUS=$?
else
  printf '%s' "$INPUT" | "$DENO_BIN" "${CMD_ARGS[@]}" >"$STDOUT_FILE" 2>"$STDERR_FILE"
  STATUS=$?
fi
set -e

if [ "$STATUS" -eq 0 ]; then
  if [ "$DISCARD_STDOUT" -eq 0 ]; then
    cat "$STDOUT_FILE"
  fi
  cat "$STDERR_FILE" >&2
  exit 0
elif [ "$STATUS" -eq 2 ]; then
  cat "$STDOUT_FILE"
  cat "$STDERR_FILE" >&2
  exit 2
elif [ "$STATUS" -eq 124 ]; then
  if [ "$GROUP" = "safety" ]; then
    emit_safety_refusal "checker timed out after $TIMEOUT"
    if [ "$SURFACE" = "agy" ]; then
      exit 0
    else
      exit 2
    fi
  else
    if [ "$NAME" = "check-issue-citation-on-write" ]; then
      note="$(get_workflow_note "issue-citation guard: citation check could not run (checker timed out after $TIMEOUT); proceeding via workflow default.")"
    else
      note="$(get_workflow_note "$NAME: checker timed out after $TIMEOUT; proceeding via workflow default.")"
    fi
    emit_workflow_note "$note" "$EVENT"
    exit 0
  fi
else
  if [ "$GROUP" = "safety" ]; then
    cat "$STDERR_FILE" >&2
    emit_safety_refusal "checker failed with exit code $STATUS"
    if [ "$SURFACE" = "agy" ]; then
      exit 0
    else
      exit 2
    fi
  else
    if [ "$NAME" = "check-issue-citation-on-write" ]; then
      note="$(get_workflow_note "issue-citation guard: citation check could not run (checker exited $STATUS); proceeding via workflow default.")"
    else
      note="$(get_workflow_note "$NAME: checker failed (exit $STATUS); proceeding via workflow default.")"
    fi
    emit_workflow_note "$note" "$EVENT"
    exit 0
  fi
fi
