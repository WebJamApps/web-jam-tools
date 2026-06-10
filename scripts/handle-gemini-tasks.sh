#!/usr/bin/env bash
# handle-gemini-tasks.sh — web-jam-tools#43 (added 2026-06-09)
#
# Delegates easy/medium coding tasks to gemini-cli to save Opus tokens.
# Routing lane: Gemma = requirements/Q&A only, Gemini = easy coding, Opus = hard
# specs. Decision record: Claude memory gemini-cli-task-lane.md.
#
# Task sources (two):
#   1. Queue file (default): ~/Dropbox/web-jam-llms/gemini-tasks.txt
#      Line format: "<repo-name>: <task description>"  (# and blank lines ignored)
#   2. GitHub issue labeled `gemini`: pass "<Repo>#<num>" (title + body = the task)
#
# Usage (interactive by default — you drive/watch gemini in the REPL):
#   handle-gemini-tasks.sh                        # run the FIRST queue line
#   handle-gemini-tasks.sh CollegeLutheran#123    # run a gemini-labeled issue
#   handle-gemini-tasks.sh --headless [...]       # unattended; walks the model chain
#
# This script NEVER pushes, opens PRs, or edits the queue file — Josh deletes the
# queue line himself after accepting the work (queue management is manual).

set -euo pipefail

QUEUE_FILE="$HOME/Dropbox/web-jam-llms/gemini-tasks.txt"
WEBJAM="$HOME/WebJamApps"

# Model chain: interactive runs start on the first (pro) model — you can switch
# in-REPL with /model. --headless runs walk the chain, falling back when a model
# is out of quota. Override per-run with: GEMINI_MODELS="modelA modelB" ...
# Note: the free tier grants NO quota for gemini-3.1-pro (limit 0); gemini-3-pro
# and the 2.5-pro tiers have a small daily free quota, the flash tiers a larger
# one — hence pro-first, flash-fallback.
# shellcheck disable=SC2206
MODELS=(${GEMINI_MODELS:-gemini-3-pro-preview gemini-2.5-pro gemini-3.5-flash gemini-2.5-flash})

# --- parse args ---
# Interactive is the default; --headless (-H) runs unattended with the fallback chain.
HEADLESS=0
if [ "${1:-}" = "--headless" ] || [ "${1:-}" = "-H" ]; then
  HEADLESS=1
  shift
fi
TASK_ARG="${1:-}"

# --- resolve task text + target repo ---
if [ -n "$TASK_ARG" ]; then
  # GitHub issue form: <Repo>#<num>
  if [[ ! "$TASK_ARG" =~ ^([A-Za-z0-9._-]+)#([0-9]+)$ ]]; then
    echo "ERROR: argument must look like <Repo>#<num> (e.g. CollegeLutheran#123)" >&2
    exit 1
  fi
  REPO="${BASH_REMATCH[1]}"
  ISSUE_NUM="${BASH_REMATCH[2]}"
  echo "Fetching issue $REPO#$ISSUE_NUM ..."
  ISSUE_TITLE=$(gh issue view "$ISSUE_NUM" -R "WebJamApps/$REPO" --json title -q .title)
  ISSUE_BODY=$(gh issue view "$ISSUE_NUM" -R "WebJamApps/$REPO" --json body -q .body)
  TASK_TEXT="$ISSUE_TITLE"$'\n\n'"$ISSUE_BODY"
  SLUG_SOURCE="$ISSUE_TITLE"
else
  # Queue file form: first non-comment, non-blank line
  if [ ! -f "$QUEUE_FILE" ]; then
    echo "ERROR: queue file not found: $QUEUE_FILE" >&2
    exit 1
  fi
  LINE=$(grep -vE '^[[:space:]]*(#|$)' "$QUEUE_FILE" | head -1 || true)
  if [ -z "$LINE" ]; then
    echo "No tasks in $QUEUE_FILE" >&2
    exit 1
  fi
  REPO="$(echo "${LINE%%:*}" | xargs)"   # text before the first colon, trimmed
  TASK_TEXT="${LINE#*: }"                 # text after the first ": "
  SLUG_SOURCE="$TASK_TEXT"
fi

REPO_DIR="$WEBJAM/$REPO"
if [ ! -d "$REPO_DIR" ]; then
  echo "ERROR: repo folder not found: $REPO_DIR" >&2
  exit 1
fi
cd "$REPO_DIR"

# --- never stomp uncommitted work ---
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is dirty in $REPO_DIR — commit or stash first." >&2
  git status --short >&2
  exit 1
fi

# --- fresh dev ---
echo "Updating dev in $REPO ..."
git checkout dev
git pull

# --- slug + unique branch off dev ---
slugify() {
  echo "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's#https?://[^ ]+# #g; s/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-40 | sed -E 's/-+$//'
}
SLUG="$(slugify "$SLUG_SOURCE")"
[ -z "$SLUG" ] && SLUG="task"
BRANCH="gemini/$SLUG"
N=2
while git show-ref --verify --quiet "refs/heads/$BRANCH"; do
  BRANCH="gemini/$SLUG-$N"
  N=$((N + 1))
done
git checkout -b "$BRANCH"
echo "Working on branch: $BRANCH"

# --- per-repo GEMINI.md presence (warn loudly but continue) ---
if [ ! -f "GEMINI.md" ]; then
  echo "" >&2
  echo "*** WARNING: no GEMINI.md in $REPO_DIR ***" >&2
  echo "*** Running without repo-specific guidance. Josh adds per-repo" >&2
  echo "*** GEMINI.md files lazily — consider committing one for $REPO.   ***" >&2
  echo "" >&2
fi

# --- composed prompt: standing rules wrapped around the task ---
read -r -d '' PROMPT <<EOF || true
You are working in the $REPO repo on branch $BRANCH, already created off the latest dev.

Task:
$TASK_TEXT

Rules:
- Commit your work incrementally with clear, conventional messages as you go.
- Before declaring done, run this repo's lint and test commands and fix issues
  until both pass. Find the exact script names in this repo's GEMINI.md and its
  package.json "scripts" (commonly "npm run lint" and "npm test"; some repos
  use "npm run test:lint" / "npm run test:unit").
- Do not push, do not create pull requests, do not switch branches, do not add
  new dependencies.
- When finished, summarize what you changed and confirm lint and tests are green.
EOF

# --- run gemini ---
# Strip the IDE-companion env vars that VS Code's integrated terminal injects, so
# gemini's workspace is JUST this repo (cwd) instead of the whole multi-root VS
# Code workspace. gemini enables IDE mode only when both GEMINI_CLI_IDE_SERVER_PORT
# and GEMINI_CLI_IDE_WORKSPACE_PATH are set; clearing the IDE env vars keeps the
# task scoped to one repo (no context bloat, and no crash if some other workspace
# folder is missing). Checkpointing comes from ~/.gemini/settings.json.
# Also unset GEMINI_API_KEY: the lane authenticates via "Login with Google"
# (oauth-personal / Code Assist) for pro-model access. A stray free-tier
# GEMINI_API_KEY in the env would route to a tier with zero pro quota. Requires a
# one-time `gemini` interactive login (Login with Google) on this machine.
run_gemini() {
  env -u GEMINI_CLI_IDE_SERVER_PORT \
      -u GEMINI_CLI_IDE_WORKSPACE_PATH \
      -u GEMINI_CLI_IDE_PID \
      -u GEMINI_CLI_IDE_AUTH_TOKEN \
      -u GEMINI_CLI_IDE_CONNECTION_TYPE \
      -u GEMINI_CLI_IDE_SERVER_STDIO_COMMAND \
      -u GEMINI_CLI_IDE_SERVER_STDIO_ARGS \
      -u GEMINI_API_KEY \
      gemini --skip-trust "$@"
}

if [ "$HEADLESS" -eq 1 ]; then
  # Headless (opt-in): walk the model chain until one run succeeds.
  GEMINI_OK=0
  for model in "${MODELS[@]}"; do
    echo ">>> gemini (headless) — model: $model"
    if run_gemini -m "$model" -p "$PROMPT"; then
      GEMINI_OK=1
      echo ">>> gemini finished on model: $model"
      break
    fi
    echo "!!! model '$model' failed (out of tokens or error) — trying next fallback if any." >&2
  done
  [ "$GEMINI_OK" -eq 1 ] || echo "!!! all models failed: ${MODELS[*]}" >&2
else
  # Interactive (default): drop into the gemini REPL on the pro model with the
  # task preloaded. You drive it, watch it work, and switch models with /model
  # if the pro tier is tapped out.
  run_gemini -m "${MODELS[0]}" -i "$PROMPT"
fi

# --- finish summary ---
echo ""
echo "================ handle-gemini-tasks finished ================"
echo "Repo:   $REPO_DIR"
echo "Branch: $BRANCH"
echo "--- commits (dev..HEAD) ---"
git log --oneline dev..HEAD || true
echo "--- git status ---"
git status --short
echo ""
echo "Review the diff, run the app locally, push yourself."
echo "(Queue line NOT removed — delete it from $QUEUE_FILE after you accept the work.)"
