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
# Usage:
#   handle-gemini-tasks.sh                       # run the FIRST queue line
#   handle-gemini-tasks.sh CollegeLutheran#123   # run a gemini-labeled issue
#   handle-gemini-tasks.sh -i [...]              # interactive instead of headless
#
# This script NEVER pushes, opens PRs, or edits the queue file — Josh deletes the
# queue line himself after accepting the work (queue management is manual).

set -euo pipefail

QUEUE_FILE="$HOME/Dropbox/web-jam-llms/gemini-tasks.txt"
WEBJAM="$HOME/WebJamApps"

# --- parse args ---
INTERACTIVE=0
if [ "${1:-}" = "-i" ]; then
  INTERACTIVE=1
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
run_gemini() {
  env -u GEMINI_CLI_IDE_SERVER_PORT \
      -u GEMINI_CLI_IDE_WORKSPACE_PATH \
      -u GEMINI_CLI_IDE_PID \
      -u GEMINI_CLI_IDE_AUTH_TOKEN \
      -u GEMINI_CLI_IDE_CONNECTION_TYPE \
      -u GEMINI_CLI_IDE_SERVER_STDIO_COMMAND \
      -u GEMINI_CLI_IDE_SERVER_STDIO_ARGS \
      gemini "$@"
}

if [ "$INTERACTIVE" -eq 1 ]; then
  run_gemini -i "$PROMPT"
else
  run_gemini -p "$PROMPT"
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
