#!/usr/bin/env bash
# handle-agy-tasks.sh — web-jam-tools#43 (added 2026-06-09 as handle-gemini-tasks.sh;
# retargeted to Antigravity CLI `agy` on 2026-06-10 when Gemini CLI dropped its free
# tier; renamed to handle-agy-tasks.sh in #49 once the lane was fully agy-named).
#
# Delegates easy/medium coding tasks to the Antigravity CLI (`agy`) to save Opus
# tokens. Routing lane: agy = easy coding, Opus = hard specs/judgment.
# Decision record: Claude memory gemini-cli-task-lane.md.
#
# Auth: `agy` uses Google sign-in (run `agy` once to log in). The free tier
# exposes capable models — Claude Opus/Sonnet 4.6, Gemini 3.1 Pro, etc.
#
# Task sources (two):
#   1. Queue file (default): ~/Dropbox/web-jam-llms/agy-tasks.txt
#      Line format: "<repo-name>: <task description>"  (# and blank lines ignored)
#   2. GitHub issue labeled `agy`: pass "<Repo>#<num>" (title + body + comments =
#      the task — see web-jam-tools#154 note below)
#
# Usage (interactive by default — you drive/watch agy in the REPL):
#   handle-agy-tasks.sh                        # run the FIRST queue line
#   handle-agy-tasks.sh CollegeLutheran#123    # run an agy-labeled issue
#   handle-agy-tasks.sh --headless [...]       # unattended; auto-approves tools
#   handle-agy-tasks.sh --dry-run CollegeLutheran#123
#                                               # print the composed prompt and
#                                               # exit — no agy call. Still does
#                                               # the real git setup (checkout
#                                               # dev, pull, create the branch),
#                                               # same as --setup-only, so point
#                                               # it at a scratch clone (see
#                                               # AGY_WEBJAM_ROOT below) rather
#                                               # than a repo you're actively
#                                               # working in.
#
# web-jam-tools#154 — issue-based dispatch note: the composed prompt now also
# includes the issue's COMMENTS (chronological, newest last, under a clear
# delimiter), because locked decisions/spec changes kept accumulating there and
# never reaching Flash (two real PR rejections: TimShermanMusic#3, Henrickson-
# ForSalem#5). The issue BODY is still the canonical spec — comments are extra
# context, not a substitute for folding decisions into the body. AND: if the
# issue BODY still carries a BLOCKED / DO NOT START / DO-NOT-START marker
# (case-insensitive), the script refuses to dispatch and exits non-zero —
# update the body first. This guard only applies to issue-based dispatch, not
# queue-line tasks (queue lines have no "body" to check).
#
# This script never edits the queue file — Josh deletes the queue line himself
# after accepting the work (queue management is manual). The agent finishes a task
# by opening a draft PR via scripts/create-draft-pr.sh (web-jam-tools#49).

set -euo pipefail

QUEUE_FILE="$HOME/Dropbox/web-jam-llms/agy-tasks.txt"
# AGY_WEBJAM_ROOT override exists for --dry-run testing against a scratch clone
# instead of a repo folder you're actively working in (web-jam-tools#154).
WEBJAM="${AGY_WEBJAM_ROOT:-$HOME/WebJamApps}"
AGY="$(command -v agy || echo "$HOME/.local/bin/agy")"

# Cost-ordered model chain (Antigravity PAID account — Josh's prepaid Google
# credit), CHEAPEST FIRST: Gemini Flash medium is the default lane; Flash (High)
# is the only rate-limit fallback (3.1 Pro removed as too expensive). Claude models are deliberately
# NOT in the default chain (they drain the credit fastest — the old
# most-capable-first order was a free-tier assumption). Override with:
#   AGY_MODELS="Model A|Model B" handle-agy-tasks.sh    (pipe-separated; the
# names contain spaces, so pipes — not spaces — separate them).
DEFAULT_MODELS='Gemini 3.5 Flash (Medium)|Gemini 3.5 Flash (High)'
IFS='|' read -r -a MODELS <<< "${AGY_MODELS:-$DEFAULT_MODELS}"

# --- parse args ---
# Interactive is the default. Leading flags (any order, before the optional task):
#   --headless / -H   run unattended (auto-approves tools)
#   --setup-only      do the queue/issue + git-branch setup, print the task, and
#                     STOP without launching agy. Used by the `/next` agy skill:
#                     you're already inside agy, so agy itself does the coding.
#   --dry-run         do the queue/issue fetch + git-branch setup, print the
#                     composed prompt, and STOP without launching agy. For
#                     testing prompt composition (comments folded in, BLOCKED
#                     guard) without spending an agy call (web-jam-tools#154).
HEADLESS=0
SETUP_ONLY=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "${1:-}" in
    --headless|-H) HEADLESS=1; shift ;;
    --setup-only)  SETUP_ONLY=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
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
  echo "Fetching issue $REPO#$ISSUE_NUM (title + body + comments) ..."
  ISSUE_JSON=$(gh issue view "$ISSUE_NUM" -R "WebJamApps/$REPO" --json title,body,comments)
  ISSUE_TITLE=$(jq -r '.title' <<< "$ISSUE_JSON")
  ISSUE_BODY=$(jq -r '.body' <<< "$ISSUE_JSON")

  # --- BLOCKED guard (issue-based dispatch only — web-jam-tools#154) ---
  # Refuse to dispatch when the issue BODY still carries a blocked marker.
  # Comments are for humans; the BODY is what agy actually reads as the spec,
  # so a stale "don't start" left in the body must stop the dispatch loudly
  # rather than let Flash improvise (HenricksonForSalem#5 rejection). Word-
  # bounded so "UNBLOCKED"/"unblocking" etc. don't false-positive.
  if grep -qiE '\bBLOCKED\b|\bDO[ -]NOT[ -]START\b' <<< "$ISSUE_BODY"; then
    echo "" >&2
    echo "ERROR: issue $REPO#$ISSUE_NUM body still contains a BLOCKED / DO NOT" >&2
    echo "START marker — refusing to dispatch agy against it." >&2
    echo "Update the issue BODY first (clear the marker and fold any comment-only" >&2
    echo "decisions into the body — the body is the spec agy reads), then retry." >&2
    echo "" >&2
    exit 1
  fi

  # --- fold comments into the task text (web-jam-tools#154) ---
  # Locked decisions/spec changes keep accumulating as comments after an issue
  # is filed; handle-agy-tasks.sh used to feed Flash title+body only, so it
  # missed them (TimShermanMusic#3, HenricksonForSalem#5 rejections). Comments
  # are appended chronologically (oldest first, newest last) under a clear
  # delimiter. The BODY remains the canonical spec — comments are context.
  COMMENTS_TEXT=$(jq -r '
    (.comments // [])
    | map("[" + (.author.login // "unknown") + " — " + .createdAt + "]\n" + .body)
    | join("\n\n---\n\n")
  ' <<< "$ISSUE_JSON")
  MAX_COMMENT_CHARS=20000
  if [ -n "$COMMENTS_TEXT" ]; then
    if [ "${#COMMENTS_TEXT}" -gt "$MAX_COMMENT_CHARS" ]; then
      COMMENTS_TEXT="${COMMENTS_TEXT:0:$MAX_COMMENT_CHARS}"$'\n\n[... comments truncated at '"$MAX_COMMENT_CHARS"' chars — see the issue on GitHub for the full discussion ...]'
    fi
    TASK_TEXT="$ISSUE_TITLE"$'\n\n'"$ISSUE_BODY"$'\n\n--- Discussion/decisions from issue comments (newest last) ---\n\n'"$COMMENTS_TEXT"
  else
    TASK_TEXT="$ISSUE_TITLE"$'\n\n'"$ISSUE_BODY"
  fi
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
# Branch convention (web-jam-tools#49): <lane>/<issue#>-<slug> when the issue
# number is known (issue form), else <lane>/<slug> (queue-line form). Lane = agy.
if [ -n "${ISSUE_NUM:-}" ]; then
  BRANCH_BASE="agy/${ISSUE_NUM}-${SLUG}"
else
  BRANCH_BASE="agy/${SLUG}"
fi
BRANCH="$BRANCH_BASE"
N=2
while git show-ref --verify --quiet "refs/heads/$BRANCH"; do
  BRANCH="${BRANCH_BASE}-$N"
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
- Do not switch branches and do not add new dependencies.
- When lint and tests are green, finish by opening a draft PR — run:
    ~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh --author "agy — <the model you are running as>"
  It pushes the branch and opens a draft PR based on dev with "Closes #N" baked in
  (web-jam-tools#49). Never run \`gh pr create\` directly. Then summarize what you changed.
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

# --- dry-run: print the composed prompt and stop, no agy call (web-jam-tools#154) ---
if [ "$DRY_RUN" -eq 1 ]; then
  cat <<EOF3
=== DRY RUN (no agy invocation) ===
REPO_DIR: $REPO_DIR
BRANCH: $BRANCH
=== COMPOSED PROMPT ===
$PROMPT
=== END DRY RUN ===
EOF3
  exit 0
fi

# --- pick the first currently-available model in the chain (cheapest first; fallback on rate limits) ---
echo "Selecting model (cheapest available)..."
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
  # Headless (opt-in): auto-approve tools. agy's one-shot `-p` mode can END ITS
  # TURN before a long multi-step task is actually done — it exits 0 with work
  # uncommitted, no tests run, no PR (bit us 3x on JaMmusic#1162). A zero exit is
  # therefore NOT treated as task success by itself: after every `-p` turn we
  # check for REAL completion (a draft PR exists for this branch). If the turn
  # exited zero but the PR isn't there, we re-invoke the SAME model with a
  # "resume/finish" prompt instead of moving on. If a turn exits non-zero, that
  # model is considered failed and we fall back to the next model in the chain
  # (which also gets its own driver-loop rounds). AGY_MAX_ROUNDS bounds total
  # turns spent across ALL models combined, so a stuck model can't loop forever.
  AGY_MAX_ROUNDS="${AGY_MAX_ROUNDS:-4}"

  pr_exists_for_branch() {
    gh pr list -R "WebJamApps/$REPO" --head "$BRANCH" --json number -q '.[0].number' 2>/dev/null
  }

  CONTINUE_PROMPT_PREFIX="You are resuming an interrupted task in the $REPO repo on branch $BRANCH. Previous turns did partial work (check \`git status\` and \`git log dev..HEAD\`). Task acceptance is NOT met until: lint and tests pass, work is committed, and a draft PR is opened via ~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh. Continue from where things stand and finish. Original task follows:"

  AGY_OK=0
  ROUNDS=0
  for m in "$ACTIVE_MODEL" "${REMAINING[@]}"; do
    TURN_PROMPT="$PROMPT"
    echo ">>> agy (headless) — model: $m"
    while [ "$ROUNDS" -lt "$AGY_MAX_ROUNDS" ]; do
      ROUNDS=$((ROUNDS + 1))
      echo ">>> round $ROUNDS/$AGY_MAX_ROUNDS — model: $m"
      # --print-timeout: agy's default 5m kills long silent work stretches in -p
      # mode (bit us on JaMmusic#1162 — Flash Medium thinks slowly; run died twice).
      if ! "$AGY" --model "$m" --dangerously-skip-permissions --print-timeout 60m -p "$TURN_PROMPT"; then
        echo "!!! model '$m' failed (non-zero exit) — trying next fallback if any." >&2
        break
      fi
      PR_NUM="$(pr_exists_for_branch)"
      if [ -n "$PR_NUM" ]; then
        AGY_OK=1
        ACTIVE_MODEL="$m"
        echo ">>> agy finished on model: $m — draft PR #$PR_NUM confirmed for branch $BRANCH"
        break 2
      fi
      echo "!!! turn exited zero but no draft PR found for branch $BRANCH — task incomplete." >&2
      if [ "$ROUNDS" -ge "$AGY_MAX_ROUNDS" ]; then
        echo "!!! AGY_MAX_ROUNDS ($AGY_MAX_ROUNDS) reached — giving up on model '$m'." >&2
        break
      fi
      echo ">>> re-invoking model '$m' with a continue/finish prompt (round $((ROUNDS + 1)) coming)..."
      TURN_PROMPT="$CONTINUE_PROMPT_PREFIX"$'\n\n'"$PROMPT"
    done
    [ "$AGY_OK" -eq 1 ] && break
    if [ "$ROUNDS" -ge "$AGY_MAX_ROUNDS" ]; then
      echo "!!! total round budget (AGY_MAX_ROUNDS=$AGY_MAX_ROUNDS) exhausted — stopping." >&2
      break
    fi
  done

  if [ "$AGY_OK" -ne 1 ]; then
    echo "" >&2
    echo "================ handle-agy-tasks FAILED (no draft PR) ================" >&2
    echo "Repo:   $REPO_DIR" >&2
    echo "Branch: $BRANCH" >&2
    echo "Models tried: ${MODELS[*]}" >&2
    echo "Rounds used: $ROUNDS / $AGY_MAX_ROUNDS" >&2
    echo "--- commits (dev..HEAD) ---" >&2
    git log --oneline dev..HEAD >&2 || true
    echo "--- git status (WIP left behind) ---" >&2
    git status --short >&2
    echo "=========================================================================" >&2
  fi
else
  # Interactive (default): drop into the agy REPL on the selected model with the
  # task preloaded. You drive it, watch it work, and switch models with /model.
  "$AGY" --model "$ACTIVE_MODEL" -i "$PROMPT"
fi

# --- finish summary ---
echo ""
echo "================ handle-agy-tasks finished ================"
echo "Repo:   $REPO_DIR"
echo "Branch: $BRANCH"
echo "Model:  $ACTIVE_MODEL"
echo "--- commits (dev..HEAD) ---"
git log --oneline dev..HEAD || true
echo "--- git status ---"
git status --short
echo ""
echo "agy should have opened a draft PR via create-draft-pr.sh — review it on GitHub."
echo "(Queue line NOT removed — delete it from $QUEUE_FILE after you accept the work.)"
