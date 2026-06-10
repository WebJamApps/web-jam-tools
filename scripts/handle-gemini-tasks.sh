#!/usr/bin/env bash
# handle-gemini-tasks.sh — web-jam-tools#43 (added 2026-06-09; retargeted to
# Antigravity CLI `agy` on 2026-06-10 when Gemini CLI dropped its free tier).
#
# Delegates easy/medium coding tasks to the Antigravity CLI (`agy`) to save Opus
# tokens. Routing lane: Gemma = requirements/Q&A only, agy = easy coding, Opus =
# hard specs. Decision record: Claude memory gemini-cli-task-lane.md.
#
# Auth: `agy` uses Google sign-in (run `agy` once to log in). The free tier
# exposes capable models — Claude Opus/Sonnet 4.6, Gemini 3.1 Pro, etc.
#
# Task sources (two):
#   1. Queue file (default): ~/Dropbox/web-jam-llms/agy-tasks.txt
#      Line format: "<repo-name>: <task description>"  (# and blank lines ignored)
#   2. GitHub issue labeled `gemini`: pass "<Repo>#<num>" (title + body = the task)
#
# Usage (interactive by default — you drive/watch agy in the REPL):
#   handle-gemini-tasks.sh                        # run the FIRST queue line
#   handle-gemini-tasks.sh CollegeLutheran#123    # run a gemini-labeled issue
#   handle-gemini-tasks.sh --headless [...]       # unattended; auto-approves tools
#
# This script NEVER pushes, opens PRs, or edits the queue file — Josh deletes the
# queue line himself after accepting the work (queue management is manual).

set -euo pipefail

QUEUE_FILE="$HOME/Dropbox/web-jam-llms/agy-tasks.txt"
WEBJAM="$HOME/WebJamApps"
AGY="$(command -v agy || echo "$HOME/.local/bin/agy")"

# Capability-ordered model chain (Antigravity free tier), MOST CAPABLE FIRST.
# The wrapper probes them in order and uses the first that's currently available
# (so rate limits on the top model fall back automatically). Override with:
#   AGY_MODELS="Model A|Model B" handle-gemini-tasks.sh    (pipe-separated; the
# names contain spaces, so pipes — not spaces — separate them).
DEFAULT_MODELS='Claude Opus 4.6 (Thinking)|Claude Sonnet 4.6 (Thinking)|Gemini 3.1 Pro (High)|Gemini 3.5 Flash (High)'
IFS='|' read -r -a MODELS <<< "${AGY_MODELS:-$DEFAULT_MODELS}"

# --- parse args ---
# Interactive is the default. Leading flags (any order, before the optional task):
#   --headless / -H   run unattended (auto-approves tools)
#   --setup-only      do the queue/issue + git-branch setup, print the task, and
#                     STOP without launching agy. Used by the `/next` agy skill:
#                     you're already inside agy, so agy itself does the coding.
HEADLESS=0
SETUP_ONLY=0
while [ $# -gt 0 ]; do
  case "${1:-}" in
    --headless|-H) HEADLESS=1; shift ;;
    --setup-only)  SETUP_ONLY=1; shift ;;
    *) break ;;
  esac
done
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

# --- per-repo instructions presence (agy reads AGENTS.md and GEMINI.md) ---
if [ ! -f "GEMINI.md" ] && [ ! -f "AGENTS.md" ]; then
  echo "" >&2
  echo "*** WARNING: no AGENTS.md or GEMINI.md in $REPO_DIR ***" >&2
  echo "*** Running without repo-specific guidance. Add one lazily as the repo" >&2
  echo "*** enters rotation (committed, public-safe).                          ***" >&2
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
  until both pass. Find the exact script names in this repo's AGENTS.md/GEMINI.md
  and its package.json "scripts" (commonly "npm run lint" and "npm test"; some
  repos use "npm run test:lint" / "npm run test:unit").
- Do not push, do not create pull requests, do not switch branches, do not add
  new dependencies.
- When finished, summarize what you changed and confirm lint and tests are green.
EOF

# --- setup-only: emit the prepared task for an in-REPL agent (the /next skill) ---
# The branch is already created and checked out above; agy reads this block and
# does the coding itself, so we stop here (no model probe, no nested agy launch).
if [ "$SETUP_ONLY" -eq 1 ]; then
  cat <<EOF2
=== GEMINI-TASK READY ===
REPO_DIR: $REPO_DIR
BRANCH: $BRANCH
=== TASK PROMPT (implement this) ===
$PROMPT
=== END TASK ===
EOF2
  exit 0
fi

# --- pick the most capable currently-available model (fallback on rate limits) ---
echo "Selecting model (most capable available)..."
ACTIVE_MODEL=""
REMAINING=()
for i in "${!MODELS[@]}"; do
  m="${MODELS[$i]}"
  printf '  probing: %-32s ... ' "$m"
  if timeout 90 "$AGY" --model "$m" -p "reply with: ok" >/dev/null 2>&1; then
    echo "available"
    ACTIVE_MODEL="$m"
    REMAINING=("${MODELS[@]:$((i + 1))}")
    break
  fi
  echo "unavailable — falling back"
done
if [ -z "$ACTIVE_MODEL" ]; then
  echo "ERROR: no model in the chain is available right now: ${MODELS[*]}" >&2
  exit 1
fi
echo "Using model: $ACTIVE_MODEL"

# --- run agy ---
if [ "$HEADLESS" -eq 1 ]; then
  # Headless (opt-in): auto-approve tools; if the chosen model fails mid-task,
  # walk the remaining (less capable) models.
  AGY_OK=0
  for m in "$ACTIVE_MODEL" "${REMAINING[@]}"; do
    echo ">>> agy (headless) — model: $m"
    if "$AGY" --model "$m" --dangerously-skip-permissions -p "$PROMPT"; then
      AGY_OK=1
      echo ">>> agy finished on model: $m"
      break
    fi
    echo "!!! model '$m' failed — trying next fallback if any." >&2
  done
  [ "$AGY_OK" -eq 1 ] || echo "!!! all models failed: ${MODELS[*]}" >&2
else
  # Interactive (default): drop into the agy REPL on the selected model with the
  # task preloaded. You drive it, watch it work, and switch models with /model.
  "$AGY" --model "$ACTIVE_MODEL" -i "$PROMPT"
fi

# --- finish summary ---
echo ""
echo "================ handle-gemini-tasks finished ================"
echo "Repo:   $REPO_DIR"
echo "Branch: $BRANCH"
echo "Model:  $ACTIVE_MODEL"
echo "--- commits (dev..HEAD) ---"
git log --oneline dev..HEAD || true
echo "--- git status ---"
git status --short
echo ""
echo "Review the diff, run the app locally, push yourself."
echo "(Queue line NOT removed — delete it from $QUEUE_FILE after you accept the work.)"
