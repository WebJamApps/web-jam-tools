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
# Task source: a GitHub issue labeled `agy`/`Flash`, passed as "<Repo>#<num>"
# (title + body + comments = the task — see web-jam-tools#154 note below). The
# issue argument is REQUIRED — web-jam-tools#249 removed the older queue-file
# mode (a task line appended to ~/Dropbox/web-jam-llms/agy-tasks.txt, run with
# no argument) once Josh moved agy/Flash dispatch to GitHub-issues-only.
#
# Usage (interactive by default — you drive/watch agy in the REPL):
#   handle-agy-tasks.sh CollegeLutheran#123    # run an agy-labeled issue
#   handle-agy-tasks.sh --headless [...]       # unattended; auto-approves tools
#   handle-agy-tasks.sh --dry-run CollegeLutheran#123
#                                               # print the composed prompt and
#                                               # exit — no agy call. Still does
#                                               # the real git setup (fetch dev,
#                                               # create the branch), same as
#                                               # --setup-only. web-jam-tools#239
#                                               # item 2: this setup now happens
#                                               # in an isolated /tmp worktree,
#                                               # not the repo folder itself, so
#                                               # AGY_WEBJAM_ROOT (below) is no
#                                               # longer needed just to avoid
#                                               # disturbing a repo you're
#                                               # actively working in — it's
#                                               # still there for other scratch-
#                                               # clone testing needs.
#   handle-agy-tasks.sh                        # ERROR: no argument — prints a
#                                               # usage message and exits
#                                               # non-zero (web-jam-tools#249)
#
# AGY_EXTRA_RECIPE (web-jam-tools#235): optional env var carrying a fresh
# local-testing recipe (plain text/markdown) supplied by Opus at dispatch
# time as a gap-fill for THIS run only — appended to whatever material was
# injected from docs/local-testing.md + the shared recipes doc, so Flash can
# write real "How to test locally" steps even before that recipe has been
# committed anywhere. e.g.:
#   AGY_EXTRA_RECIPE="To induce a mongo error: ..." handle-agy-tasks.sh JaMmusic#1238
#
# web-jam-tools#154 — issue-based dispatch note: the composed prompt now also
# includes the issue's COMMENTS (chronological, newest last, under a clear
# delimiter), because locked decisions/spec changes kept accumulating there and
# never reaching Flash (two real PR rejections: TimShermanMusic#3, Henrickson-
# ForSalem#5). The issue BODY is still the canonical spec — comments are extra
# context, not a substitute for folding decisions into the body. AND: if the
# issue BODY still carries a BLOCKED / DO NOT START / DO-NOT-START marker as a
# STATUS DECLARATION — the marker at the START of a line (optionally behind
# markdown decoration like `>`, `#`, `*`, `-`, `_`, `**`, or an emoji), not
# buried mid-sentence in prose — the script refuses to dispatch and exits
# non-zero — update the body first. (web-jam-tools#395: the original word-
# anywhere-in-body match false-positived on ordinary prose describing a guard,
# e.g. "the hook BLOCKED the command" — scoping the match to line-start status
# declarations fixes that while still catching a real stale marker.) (Before
# web-jam-tools#249 this guard was noted as
# "issue-based dispatch only" because a queue-line mode with no body to check
# also existed; that mode is gone, so the guard now unconditionally applies to
# every invocation.)
#
# The agent finishes a task by opening a draft PR via scripts/create-draft-pr.sh
# (web-jam-tools#49).
#
# web-jam-tools#187 — two resilience fixes (JaMmusic#1194: a single-model
# AGY_MODELS override died in round 1 on a 60m print-timeout with the whole run
# ending, since there was no fallback model):
#   1. A non-zero headless turn exit no longer immediately burns the model —
#      the SAME model gets one CONTINUE-prompt retry (still AGY_MAX_ROUNDS-
#      bounded) before falling back to the next model in the chain.
#   2. Re-running against an issue whose agy/<issue#>-* branch already exists
#      (issue-based dispatch only) auto-detects it and RESUMES: checks it out
#      instead of re-branching off dev, salvages a dirty tree as a `wip:`
#      commit, and drives the headless loop with the CONTINUE prompt instead
#      of the fresh-task prompt.
#
# web-jam-tools#235 — local-testing playbook injection: Flash's "How to test
# locally" sections were restating diff changes instead of writing real repro
# steps, because it had neither the operational run recipe nor how to induce
# the error condition (tribal knowledge in Josh's head, not the diff). Fix
# (approach "P", Opus+Josh 2026-07-23, locked): before composing $PROMPT, this
# script reads the TARGET repo's `docs/local-testing.md` (if present) and
# resolves any reference in it to the shared recipes doc,
# web-jam-tools/docs/local-testing-recipes.md, injecting BOTH, fully expanded,
# into $PROMPT — the one var both the interactive and headless paths share
# (same pattern as the #239 `/learn` change, so both paths get identical
# material). AGY_EXTRA_RECIPE lets Opus append a fresh, dispatch-time recipe
# for just this run (the gap-fill), so a run is never blocked on a shared-doc
# PR landing first. Missing per-repo doc, or a doc with no resolvable
# reference -> the run proceeds normally with whatever material exists (or
# none) — never a crash, never a blocked dispatch. Format ("How to test
# locally" as an ordered list of steps a DIFFERENT developer would follow,
# not a diff restatement) is enforced via the prompt instruction only — the
# design explicitly rejects a new create-draft-pr.sh guard for this (a
# brittle "is this ordered human steps?" regex would false-positive-reject).

set -euo pipefail

# AGY_WEBJAM_ROOT override exists for --dry-run testing against a scratch clone
# instead of a repo folder you're actively working in (web-jam-tools#154).
WEBJAM="${AGY_WEBJAM_ROOT:-$HOME/WebJamApps}"
AGY="$(command -v agy || echo "$HOME/.local/bin/agy")"

# --- explicit environment for the `agy` subprocess (web-jam-tools#439) -----
# `agy` is launched with an explicitly constructed environment, never the
# caller's full inherited one: a broad inherited environment let a subagent
# read GH_TOKEN and Dropbox credentials via a shell tool call and send them to
# Google's API mid-run (web-jam-tools#282 section D, 2026-08-07 — full record
# in ~/Dropbox/web-jam-llms/Access_Controls/credential-rotation-282-full-record.md).
# Established by measurement 2026-08-07: `env -i HOME PATH USER` is sufficient
# for agy to run normally — it authenticates from ~/.gemini/oauth_creds.json,
# not environment variables. Add to this allowlist BY NAME as new needs arise;
# never widen it by passing the inherited environment through.
AGY_ENV_ALLOWLIST=(HOME PATH USER AGY_MODELS FORCED_PR_AUTHOR)
# Rebuild right before each agy call (FORCED_PR_AUTHOR changes per model/round)
# and use as: env -i "${AGY_ENV_ARGS[@]}" "$AGY" ...
agy_env_args() {
  AGY_ENV_ARGS=()
  local name
  for name in "${AGY_ENV_ALLOWLIST[@]}"; do
    if [ -n "${!name+x}" ]; then
      AGY_ENV_ARGS+=("$name=${!name}")
    fi
  done
}

# Cost-ordered model chain (Antigravity PAID account — Josh's prepaid Google
# credit), CHEAPEST FIRST: Gemini Flash medium is the default lane; Flash (High)
# is the only rate-limit fallback (3.1 Pro removed as too expensive). Claude models are deliberately
# NOT in the default chain (they drain the credit fastest — the old
# most-capable-first order was a free-tier assumption). Override with:
#   AGY_MODELS="Model A|Model B" handle-agy-tasks.sh    (pipe-separated; the
# names contain spaces, so pipes — not spaces — separate them).
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEFAULT_MODELS=$(deno run --allow-env "$SCRIPT_DIR/../hooks/lib/check_agy_model.ts" --default-models 2>/dev/null || echo 'Gemini 3.6 Flash (Medium)|Gemini 3.6 Flash (High)')
IFS='|' read -r -a MODELS <<< "${AGY_MODELS:-$DEFAULT_MODELS}"

# --- parse args ---
# Interactive is the default. Leading flags (any order, before the optional task):
#   --headless / -H   run unattended (auto-approves tools)
#   --setup-only      do the issue + git-branch setup, print the task, and
#                     STOP without launching agy. Used by the `/work-issue` (or `/next`) agy skill:
#                     you're already inside agy, so agy itself does the coding.
#   --dry-run         do the issue fetch + git-branch setup, print the
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
# GitHub issue form only: <Repo>#<num>. web-jam-tools#249 removed the
# alternate queue-file form (no argument -> first line of agy-tasks.txt), so a
# no-arg (or malformed) invocation now fails cleanly here instead of falling
# through to a queue-file lookup.
if [ -z "$TASK_ARG" ]; then
  echo "ERROR: missing required <Repo>#<issue-num> argument." >&2
  echo "Usage: $(basename "$0") [--headless|-H] [--setup-only|--dry-run] <Repo>#<issue-num>" >&2
  echo "  e.g. $(basename "$0") --headless \"CollegeLutheran#123\"" >&2
  exit 1
fi
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

# --- BLOCKED guard (web-jam-tools#154, scoped to status declarations in #395) ---
# Refuse to dispatch when the issue BODY still carries a blocked marker AS A
# STATUS DECLARATION, not as ordinary prose. A status declaration is the
# marker sitting at the START of a line, optionally behind markdown
# decoration (`>`, `#`/`##`, `*`, `-`, `_`, `**`) and/or an emoji — e.g.
# "**BLOCKED**", "> BLOCKED: reason", "## BLOCKED", "🔴 BLOCKED". Comments are
# for humans; the BODY is what agy actually reads as the spec, so a stale
# "don't start" left in the body must stop the dispatch loudly rather than
# let Flash improvise (HenricksonForSalem#5 rejection). Mid-sentence prose
# ("...the hook BLOCKED the command...") and table cells no longer
# false-positive (web-jam-tools#395 — a real refusal fired on prose describing
# a guard, with no status marker present), because grep applies `^` per line
# and a real sentence/cell never starts the physical line with the bare word.
#
# Implementation: `grep` (no -z) matches `^`/`$` per line already, so this
# runs once against the whole (possibly multi-line) body. `^[^A-Za-z0-9]*`
# consumes any run of leading non-alphanumeric bytes — whitespace, markdown
# punctuation, and multi-byte emoji sequences all fall outside [A-Za-z0-9] —
# so "any combination" of decoration/emoji is handled without needing a
# PCRE/Unicode character class (portable across grep implementations). That
# same leading-strip also keeps "UNBLOCKED"/"unblocking" excluded: stripping
# stops at the first alphanumeric byte, which is the "U", so the marker
# alternation is never tried starting there.
if grep -qiE '^[^A-Za-z0-9]*(BLOCKED|DO[ -]NOT[ -]START)\b' <<< "$ISSUE_BODY"; then
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

REPO_DIR="$WEBJAM/$REPO"
if [ ! -d "$REPO_DIR" ]; then
  echo "ERROR: repo folder not found: $REPO_DIR" >&2
  exit 1
fi
cd "$REPO_DIR"

# --- worktree isolation (web-jam-tools#239 item 2) --------------------------
# agy runs in an isolated git worktree under /tmp instead of cd-ing/branching
# in Josh's main clone directly, so the main clone stays free (on whatever
# branch, even dirty) for the whole run. Prune stale worktree admin entries
# left behind by previously-reaped /tmp worktrees first.
git worktree prune

mkdir -p /tmp/agy-worktrees
worktree_path_for() {
  local branch="$1"
  local path="/tmp/agy-worktrees/${REPO}-${branch//\//-}"
  if [ -e "$path" ]; then
    path="$(mktemp -u "${path}.XXXXXX")"
  fi
  echo "$path"
}

# --- resume-mode detection (web-jam-tools#187, prefix-agnostic since #250) —
# auto-detect, no flag needed: if a branch/PR already exists for this issue (a
# died-mid-run branch from a prior invocation — e.g. JaMmusic#1194's 60m
# print-timeout — OR a branch an INTERACTIVE agy run started, which uses the
# `gemini/<issue#>-*` prefix, not `agy/` — e.g. JaMmusic PR#1255 on
# `gemini/1238-find-eligible-venues-why`), resume it instead of erroring on a
# dirty tree or, worse, forking a duplicate PR closing the same issue
# (web-jam-tools#250). Auto-detect was chosen over a --resume flag because
# re-running the exact same command against the same issue is the natural
# recovery gesture — nothing extra for Josh (or a re-dispatch) to remember.
# ISSUE_NUM is always set by this point — web-jam-tools#249 made the issue
# argument mandatory (removing the queue-line mode, which had no issue number
# to key off), so this no longer needs its own guard the way the BLOCKED guard
# above once did.
#
# Detection is two-tiered:
#   1. PREFERRED: resolve the existing OPEN PR that closes/is-part-of this
#      issue via `gh pr list` and resume ITS head branch. This is inherently
#      prefix-agnostic (agy/, gemini/, or any other name a human/interactive
#      run used) and also catches a branch that exists only on the remote —
#      never fetched into this local clone — since it's fetched explicitly
#      below. create-draft-pr.sh always renders the body as "Closes #N" or
#      "Part of #N" (web-jam-tools#49), so matching on that phrase is reliable.
#   2. FALLBACK: if no open PR resolves (e.g. a died-mid-run branch with no PR
#      opened yet), scan local refs across BOTH known prefixes — `agy/` from
#      headless dispatch and `gemini/` from an interactive agy run — and pick
#      the most recently committed if several exist. This ref lookup reads
#      local refs shared by the whole repo (main clone + all its worktrees),
#      so it runs before any worktree is created.
RESUME_MODE=0
EXISTING_BRANCH=""
PR_JQ_FILTER='.[] | select((.body // "") | test("(?i)(closes|part of)\\s+#'"$ISSUE_NUM"'([^0-9]|$)")) | .headRefName'
PR_HEAD_BRANCH="$(gh pr list -R "WebJamApps/$REPO" --state open --json headRefName,body \
  --jq "$PR_JQ_FILTER" 2>/dev/null | head -1 || true)"
if [ -n "$PR_HEAD_BRANCH" ]; then
  echo "Found existing open PR head branch $PR_HEAD_BRANCH for issue #$ISSUE_NUM (via gh pr list) — resuming instead of starting fresh."
  git fetch origin "$PR_HEAD_BRANCH"
  if ! git show-ref --verify --quiet "refs/heads/$PR_HEAD_BRANCH"; then
    # No local ref yet (branch only ever existed on the remote) — create one
    # tracking the fetched remote tip. If a local ref already exists, leave
    # it as-is here; it's brought up to date (or reused) once we're cd'd
    # into its worktree below, where updating it is safe.
    git branch "$PR_HEAD_BRANCH" "origin/$PR_HEAD_BRANCH"
  fi
  EXISTING_BRANCH="$PR_HEAD_BRANCH"
  RESUME_MODE=1
else
  EXISTING_BRANCH="$(git for-each-ref --sort=-committerdate \
    --format='%(refname:short)' "refs/heads/agy/${ISSUE_NUM}-*" "refs/heads/gemini/${ISSUE_NUM}-*" | head -1)"
  if [ -n "$EXISTING_BRANCH" ]; then
    RESUME_MODE=1
    echo "Found existing local branch $EXISTING_BRANCH for issue #$ISSUE_NUM (no open PR resolved via gh) — resuming instead of starting fresh."
  fi
fi

if [ "$RESUME_MODE" -eq 1 ]; then
  BRANCH="$EXISTING_BRANCH"
  # If a worktree for this branch is already attached — e.g. left over from a
  # run that crashed mid-task, exactly the scenario this resume path exists
  # for (JaMmusic#1194) — reuse it instead of trying to add a second one (git
  # refuses to check out the same branch into two worktrees at once).
  EXISTING_WORKTREE="$(git worktree list --porcelain \
    | awk -v b="refs/heads/$BRANCH" '/^worktree /{p=substr($0,10)} /^branch /{if (substr($0,8)==b) print p}')"
  if [ -n "$EXISTING_WORKTREE" ]; then
    WORKTREE_DIR="$EXISTING_WORKTREE"
    echo "Reusing existing worktree for $BRANCH at $WORKTREE_DIR ..."
  else
    WORKTREE_DIR="$(worktree_path_for "$BRANCH")"
    echo "Adding worktree for existing branch $BRANCH at $WORKTREE_DIR ..."
    if ! git worktree add "$WORKTREE_DIR" "$BRANCH"; then
      echo "ERROR: could not add a worktree for existing branch $BRANCH — resolve manually (e.g. it may already be checked out elsewhere) and retry." >&2
      exit 1
    fi
  fi
  cd "$WORKTREE_DIR"
  # Bring the local branch up to date with its remote counterpart before doing
  # anything else — the PR-based detection above may have picked up a branch
  # pushed to since this local ref was last touched (or, via the `git branch`
  # above, one that never existed locally until just now). Best-effort and
  # non-fatal: a real divergence needs human judgment anyway, and the existing
  # dirty-tree handling below still runs regardless of whether this succeeds.
  if git rev-parse --verify -q "refs/remotes/origin/$BRANCH" >/dev/null; then
    git fetch origin "$BRANCH" 2>/dev/null || true
    git merge --ff-only "origin/$BRANCH" 2>/dev/null \
      || echo "NOTE: could not fast-forward $BRANCH to origin/$BRANCH (local ahead/diverged, or dirty tree) — continuing as-is." >&2
  fi
  if [ -n "$(git status --porcelain)" ]; then
    # A died-mid-run branch commonly has uncommitted work (that's exactly what
    # killed JaMmusic#1194 — nearly-complete work sitting uncommitted when the
    # print-timeout hit). Salvage it as a WIP commit instead of refusing like
    # the fresh-branch path below does. Credited model = this run's configured
    # chain's first model (MODELS[0]) — the script doesn't persist which model
    # authored prior uncommitted work, and the motivating case is a single-model
    # AGY_MODELS override, where that's exactly right.
    WIP_MODEL="${MODELS[0]}"
    echo "Working tree on $BRANCH is dirty — committing WIP (crediting $WIP_MODEL) before resuming."
    git add -A
    git commit -m "wip: salvage uncommitted work from interrupted agy run (model: $WIP_MODEL)"
  fi
  echo "Resuming on branch: $BRANCH (worktree: $WORKTREE_DIR)"
else
  # --- fresh dev: fetch the latest tip without touching the main clone's own
  # checked-out branch (that's the whole point of worktree isolation) — no
  # local `dev` checkout/pull here; the new branch is created straight off
  # origin/dev when the worktree is added, below.
  echo "Fetching dev in $REPO ..."
  git fetch origin dev

  # --- slug + unique branch name off dev (ref-only; no checkout yet) ---
  slugify() {
    echo "$1" \
      | tr '[:upper:]' '[:lower:]' \
      | sed -E 's#https?://[^ ]+# #g; s/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
      | cut -c1-40 | sed -E 's/-+$//'
  }
  SLUG="$(slugify "$SLUG_SOURCE")"
  [ -z "$SLUG" ] && SLUG="task"
  # Branch convention (web-jam-tools#49): <lane>/<issue#>-<slug>. Lane = agy.
  # (Pre-web-jam-tools#249 there was also a queue-line form with no issue
  # number, <lane>/<slug>; that mode is gone, so ISSUE_NUM is always set here.)
  BRANCH_BASE="agy/${ISSUE_NUM}-${SLUG}"
  BRANCH="$BRANCH_BASE"
  N=2
  while git show-ref --verify --quiet "refs/heads/$BRANCH"; do
    BRANCH="${BRANCH_BASE}-$N"
    N=$((N + 1))
  done

  WORKTREE_DIR="$(worktree_path_for "$BRANCH")"
  echo "Adding worktree for new branch $BRANCH at $WORKTREE_DIR (off origin/dev) ..."
  git worktree add "$WORKTREE_DIR" -b "$BRANCH" origin/dev
  cd "$WORKTREE_DIR"
  echo "Working on branch: $BRANCH (worktree: $WORKTREE_DIR)"
fi

# --- per-repo instructions presence (agy reads AGENTS.md and GEMINI.md) ---
if [ ! -f "GEMINI.md" ] && [ ! -f "AGENTS.md" ]; then
  echo "" >&2
  echo "*** WARNING: no AGENTS.md or GEMINI.md in $REPO_DIR ***" >&2
  echo "*** Running without repo-specific guidance. Add one lazily as the repo" >&2
  echo "*** enters rotation (committed, public-safe).                          ***" >&2
  echo "" >&2
fi

# --- local-testing playbook injection (web-jam-tools#235) -------------------
# Per-repo doc convention: `docs/local-testing.md` at the target repo's root
# (documented alongside this in docs/local-testing-recipes.md). Read from the
# worktree (cwd here), which already reflects the branch's dev tree, exactly
# like the AGENTS.md/GEMINI.md check just above. The shared doc lives in
# web-jam-tools under $WEBJAM (same root override, AGY_WEBJAM_ROOT, used for
# --dry-run scratch-clone testing per the comment at the top of this file —
# so a test fixture can supply its own fake web-jam-tools/docs/local-testing-
# recipes.md without touching the real repo).
PER_REPO_TESTING_DOC="docs/local-testing.md"
SHARED_RECIPES_DOC="$WEBJAM/web-jam-tools/docs/local-testing-recipes.md"
LOCAL_TESTING_MATERIAL=""
if [ -f "$PER_REPO_TESTING_DOC" ]; then
  PER_REPO_TESTING_CONTENT="$(cat "$PER_REPO_TESTING_DOC")"
  LOCAL_TESTING_MATERIAL="--- Per-repo local-testing doc ($REPO/$PER_REPO_TESTING_DOC) ---"$'\n\n'"$PER_REPO_TESTING_CONTENT"
  # Resolve a reference to the shared doc: a plain filename mention is enough
  # (repos sit at different relative depths, so matching the exact link path
  # would be fragile). "Resolvable" also requires the shared file to actually
  # exist on disk — a mention with no matching file degrades the same as no
  # mention at all, per web-jam-tools#235 (never crash, never block dispatch).
  if grep -qF 'local-testing-recipes.md' "$PER_REPO_TESTING_DOC" && [ -f "$SHARED_RECIPES_DOC" ]; then
    SHARED_RECIPES_CONTENT="$(cat "$SHARED_RECIPES_DOC")"
    LOCAL_TESTING_MATERIAL="$LOCAL_TESTING_MATERIAL"$'\n\n'"--- Shared recipes doc (web-jam-tools/docs/local-testing-recipes.md) ---"$'\n\n'"$SHARED_RECIPES_CONTENT"
  fi
fi
# AGY_EXTRA_RECIPE: Opus-supplied dispatch-time gap-fill for this run only
# (see the usage-block note near the top of this file) — appended last so it
# reads as the newest/most specific material.
if [ -n "${AGY_EXTRA_RECIPE:-}" ]; then
  LOCAL_TESTING_MATERIAL="$LOCAL_TESTING_MATERIAL"$'\n\n'"--- Extra recipe supplied for this run only (AGY_EXTRA_RECIPE, web-jam-tools#235) ---"$'\n\n'"$AGY_EXTRA_RECIPE"
fi
if [ -n "$LOCAL_TESTING_MATERIAL" ]; then
  LOCAL_TESTING_INSTRUCTIONS="Write the PR's \"How to test locally\" section as an ORDERED LIST of steps a
  DIFFERENT developer would follow to run this repo's stack locally (and, if
  relevant, deliberately reproduce the condition this change addresses) —
  drawn from the local-testing material below. Do NOT restate what changed in
  the diff; that is a different section (web-jam-tools#235).

$LOCAL_TESTING_MATERIAL"
else
  LOCAL_TESTING_INSTRUCTIONS="No local-testing playbook material was found for this repo (no
  $PER_REPO_TESTING_DOC, or no resolvable reference to the shared recipes doc,
  and no AGY_EXTRA_RECIPE override) — write \"How to test locally\" best-effort
  from what you know. Do NOT fabricate a specific operational recipe (e.g. how
  to start a service, or how to induce an error condition) you don't actually
  have (web-jam-tools#235)."
fi

# --- composed prompt: standing rules wrapped around the task ---
read -r -d '' PROMPT <<EOF || true
You are working in the $REPO repo on branch $BRANCH, already created off the latest dev.

Task:
$TASK_TEXT

Rules:
- Commit your work incrementally with clear, conventional messages as you go.
- If this repo has a package.json at its root, bump its "version" field exactly
  ONCE for this whole PR, on the FIRST commit (patch bump for a fix, minor bump
  for a feature) — every commit after that keeps the same version, do not bump
  again (web-jam-tools#181: a missing bump here was only caught by manual PR
  review last time). Repos with no root package.json don't need this from you.
- Before declaring done, run this repo's lint and test commands and fix issues
  until both pass. Find the exact script names in this repo's AGENTS.md/GEMINI.md
  and its package.json "scripts" (commonly "npm run lint" and "npm test"; some
  repos use "npm run test:lint" / "npm run test:unit").
- Do not switch branches and do not add new dependencies.
- $LOCAL_TESTING_INSTRUCTIONS
- Before opening the PR (web-jam-tools#239): run the \`/learn\` slash command in
  this session, then commit whatever changes it makes to AGENTS.md onto THIS
  SAME branch as its own commit (e.g. "chore: fold /learn updates into
  AGENTS.md") — do not open a separate PR or defer it to a follow-up step. If
  \`/learn\` makes no changes, that's fine; just don't skip running it.
- When lint and tests are green, finish by opening a draft PR — run:
    ~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh --author "agy — <the model you are running as>" \\
      --summary-file /tmp/pr-summary.md --test-plan-file /tmp/pr-test-plan.md --test-evidence-file /tmp/pr-test-evidence.md
  NOTE (web-jam-tools#190): this session already exports FORCED_PR_AUTHOR with
  the correct value, so create-draft-pr.sh will use that regardless of what you
  pass to --author — pass the flag anyway (it's still validated against a
  roster if the override weren't there), but don't worry about getting your own
  model name exactly right.
  IMPORTANT (web-jam-tools#145): a multi-line value passed inline (e.g.
  \`--test-plan "1. ...\\n2. ...\\n3. ..."\`) gets FLATTENED to one line before the
  script sees it — the newlines are lost and a numbered test plan renders as one
  run-on line. Avoid this by WRITING each section to its own temp .md file with
  your file-write tool (which preserves newlines exactly), one file per section
  (summary / test plan / test evidence), then pass \`--summary-file\` /
  \`--test-plan-file\` / \`--test-evidence-file\` with those paths instead of
  inlining the text. Every section still needs real content (bulleted summary,
  exact commands + expected result in the test plan, actual lint/test output in
  the evidence) — the file just carries it losslessly. It pushes the branch and
  opens a draft PR based on dev with "Closes #N" baked in (web-jam-tools#49).
  Never run \`gh pr create\` directly. Then summarize what you changed.
EOF

# --- setup-only: emit the prepared task for an in-REPL agent (the /work-issue skill) ---
# The branch is already created and checked out above; agy reads this block and
# does the coding itself, so we stop here (no model probe, no nested agy launch).
# web-jam-tools#239 item 2: REPO_DIR here is the isolated /tmp worktree (not the
# main clone at $REPO_DIR-the-shell-variable) — the /work-issue skill just cds into
# whatever path is printed, so pointing it at the worktree keeps the main clone
# free without needing a skill change.
if [ "$SETUP_ONLY" -eq 1 ]; then
  cat <<EOF2
=== GEMINI-TASK READY ===
REPO_DIR: $WORKTREE_DIR
MAIN_CLONE: $REPO_DIR (untouched)
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
REPO_DIR: $WORKTREE_DIR
MAIN_CLONE: $REPO_DIR (untouched)
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
  agy_env_args
  if timeout 90 env -i "${AGY_ENV_ARGS[@]}" "$AGY" --model "$m" -p "reply with: ok" >/dev/null 2>&1; then
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

# --- capture pre-run tip (web-jam-tools#252) --------------------------------
# Recorded HERE — after resume-mode setup (WIP-salvage, model selection) but
# before agy is actually launched — so the completion checks below can tell
# whether THIS invocation did anything, instead of trusting "a draft PR
# exists" / "a version bump is in the diff": in resume mode BOTH of those
# facts can pre-date this run entirely (JaMmusic#1238: PR #1255 and its
# version bump were already on the branch from a previous run; this run made
# no commit at all, yet both checks passed trivially and the script reported
# success).
PRE_AGY_HEAD="$(git rev-parse HEAD)"

# --- run agy ---
if [ "$HEADLESS" -eq 1 ]; then
  # Headless (opt-in): auto-approve tools. agy's one-shot `-p` mode can END ITS
  # TURN before a long multi-step task is actually done — it exits 0 with work
  # uncommitted, no tests run, no PR (bit us 3x on JaMmusic#1162). A zero exit is
  # therefore NOT treated as task success by itself: after every `-p` turn we
  # check for REAL completion (a draft PR exists for this branch). If the turn
  # exited zero but the PR isn't there, we re-invoke the SAME model with a
  # "resume/finish" prompt instead of moving on. If a turn exits non-zero (e.g. a
  # --print-timeout kill), web-jam-tools#187 (JaMmusic#1194: a single-model
  # AGY_MODELS override died in round 1 on a 60m print-timeout and the whole run
  # ended, since there was no fallback model) gives that SAME model one
  # CONTINUE-prompt retry first — a bad turn usually means "slow/interrupted",
  # not "model can't do this task" — before it's declared failed and we fall
  # back to the next model in the chain (which also gets its own driver-loop
  # rounds). AGY_MAX_ROUNDS bounds total turns spent across ALL models combined
  # (crash-retries included), so a stuck model can't loop forever.
  AGY_MAX_ROUNDS="${AGY_MAX_ROUNDS:-4}"

  pr_exists_for_branch() {
    gh pr list -R "WebJamApps/$REPO" --head "$BRANCH" --json number -q '.[0].number' 2>/dev/null
  }

  # web-jam-tools#152 — bypass check: "a draft PR exists" is not proof agy
  # actually went through create-draft-pr.sh. If it disobeys the prompt rule
  # ("Never run `gh pr create` directly") and opens the PR itself, EVERY guard
  # in that script (author roster, real summary/test-plan/test-evidence,
  # bulleted summary, real test-runner evidence, test-plan substance, raw-tag
  # check) is silently skipped. create-draft-pr.sh always composes the body's
  # LAST line as the attribution footer "🤖 Work by $AUTHOR" — and this script
  # forces AUTHOR to "agy — $m" via FORCED_PR_AUTHOR for the model that round
  # is actually running as (web-jam-tools#190) — so a body that doesn't end
  # with that exact footer proves the script was bypassed. This can't be
  # exercised against real GitHub in the test suite; verified by inspection +
  # `bash -n` (see the PR that introduced it).
  footer_present_for_model() {
    local pr_num="$1" model="$2" body expected
    body="$(gh pr view "$pr_num" -R "WebJamApps/$REPO" --json body -q .body 2>/dev/null || true)"
    expected="🤖 Work by agy — $model"
    # Trim trailing whitespace/newlines before the suffix check — gh's JSON
    # decode can leave a trailing newline that would otherwise false-negative.
    case "$(printf '%s' "$body" | sed -e 's/[[:space:]]*$//')" in
      *"$expected") return 0 ;;
      *) return 1 ;;
    esac
  }

  # web-jam-tools#181 — "PR exists" alone isn't real completion for Node target
  # repos: agy finished JaMmusic#1204 -> PR JaMmusic#1205 with NO package.json
  # version bump, and it was only caught by manual review. Repos without a root
  # package.json (or web-jam-tools itself, which is deno.json + pre-push-hook
  # enforced) trivially pass — this only gates Node targets.
  version_bump_present() {
    if [ ! -f package.json ]; then
      return 0
    fi
    git diff origin/dev..HEAD -- package.json | grep -q '^[+-].*"version"'
  }

  CONTINUE_PROMPT_PREFIX="You are resuming an interrupted task in the $REPO repo on branch $BRANCH. Previous turns did partial work (check \`git status\` and \`git log origin/dev..HEAD\`). Task acceptance is NOT met until: lint and tests pass, work is committed, and a draft PR is opened via ~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh. Continue from where things stand and finish. Original task follows:"

  VERSION_BUMP_PROMPT_PREFIX="You are resuming an interrupted task in the $REPO repo on branch $BRANCH. A draft PR already exists, but \`git diff origin/dev..HEAD -- package.json\` shows no \"version\" change — the one-bump-per-PR rule (bump package.json's \"version\" exactly once, on the PR's first commit; patch for a fix, minor for a feature) was not followed. Add a commit that bumps package.json's \"version\" field appropriately and push it — do NOT open a second PR. Original task follows:"

  # web-jam-tools#187 — resume mode (an existing agy branch was found for this
  # issue) starts the driven loop with the CONTINUE prompt instead of the
  # fresh-task prompt, since the branch may already carry partial (possibly
  # just-salvaged-as-WIP) work rather than being a clean slate.
  INITIAL_TURN_PROMPT="$PROMPT"
  if [ "$RESUME_MODE" -eq 1 ]; then
    INITIAL_TURN_PROMPT="$CONTINUE_PROMPT_PREFIX"$'\n\n'"$PROMPT"
  fi

  AGY_OK=0
  ROUNDS=0
  for m in "$ACTIVE_MODEL" "${REMAINING[@]}"; do
    TURN_PROMPT="$INITIAL_TURN_PROMPT"
    CRASH_RETRIED=0
    echo ">>> agy (headless) — model: $m"
    # web-jam-tools#190: force the exact author create-draft-pr.sh will use,
    # regardless of what --author the model passes (or forgets). $m is the
    # model this round is ACTUALLY running as, so this stays correct across
    # fallback rounds — unlike the model's own self-report.
    export FORCED_PR_AUTHOR="agy — $m"
    while [ "$ROUNDS" -lt "$AGY_MAX_ROUNDS" ]; do
      ROUNDS=$((ROUNDS + 1))
      echo ">>> round $ROUNDS/$AGY_MAX_ROUNDS — model: $m"
      # --print-timeout: agy's default 5m kills long silent work stretches in -p
      # mode (bit us on JaMmusic#1162 — Flash Medium thinks slowly; run died twice).
      agy_env_args
      if ! env -i "${AGY_ENV_ARGS[@]}" "$AGY" --model "$m" --dangerously-skip-permissions --print-timeout 60m -p "$TURN_PROMPT"; then
        # web-jam-tools#187 — one same-model retry on ANY non-zero exit (not
        # just a detected timeout): distinguishing timeout-vs-crash would mean
        # pattern-matching agy's error text, which is fragile (wording can
        # change, or a tool's own output could false-positive on "timeout").
        # The issue accepts this simpler fallback explicitly. Bounded by
        # AGY_MAX_ROUNDS like every other round, and fires at most once per
        # model so a genuinely broken model still falls back promptly.
        if [ "$CRASH_RETRIED" -eq 0 ] && [ "$ROUNDS" -lt "$AGY_MAX_ROUNDS" ]; then
          echo "!!! model '$m' failed (non-zero exit) — re-invoking same model once with a resume prompt before falling back." >&2
          CRASH_RETRIED=1
          TURN_PROMPT="$CONTINUE_PROMPT_PREFIX"$'\n\n'"$PROMPT"
          continue
        fi
        echo "!!! model '$m' failed (non-zero exit) — trying next fallback if any." >&2
        break
      fi
      # --- worktree-integrity check (web-jam-tools#252) ----------------------
      # agy's own turn just exited zero, but a zero exit doesn't mean the
      # worktree it ran in still exists: on JaMmusic#1238 the model deleted its
      # own working directory mid-run, which then made every trailing `git`
      # call in this script fail with "fatal: Unable to read current working
      # directory" — silently, since those calls weren't gated. Check for that
      # directly and fail hard the moment it's detected, before trusting ANY
      # PR/version-bump signal below (both would be meaningless from here on).
      if [ ! -d "$WORKTREE_DIR" ] || ! git -C "$WORKTREE_DIR" status >/dev/null 2>&1; then
        echo "" >&2
        echo "================ handle-agy-tasks FAILED (worktree lost, web-jam-tools#252) ================" >&2
        echo "Repo:     $REPO_DIR" >&2
        echo "Branch:   $BRANCH" >&2
        echo "Worktree: $WORKTREE_DIR" >&2
        echo "Model:    $m (round $ROUNDS)" >&2
        echo "The worktree directory no longer exists, or git can no longer read it —" >&2
        echo "agy likely deleted its own working directory mid-run. Nothing after this" >&2
        echo "point (PR state, version bump, commit count) can be trusted, so this is a" >&2
        echo "hard failure, not a cosmetic one — no success banner." >&2
        echo "===============================================================================" >&2
        exit 1
      fi
      PR_NUM="$(pr_exists_for_branch)"
      if [ -n "$PR_NUM" ]; then
        if ! footer_present_for_model "$PR_NUM" "$m"; then
          echo "" >&2
          echo "================ handle-agy-tasks BYPASS DETECTED (web-jam-tools#152) ================" >&2
          echo "Draft PR #$PR_NUM exists for branch $BRANCH but its body does NOT end with the" >&2
          echo "script-composed footer '🤖 Work by agy — $m'." >&2
          echo "This means agy opened the PR with \`gh pr create\` directly instead of" >&2
          echo "scripts/create-draft-pr.sh, which skips EVERY guard in that script (author" >&2
          echo "roster, real summary/test-plan/test-evidence, bulleted summary, real" >&2
          echo "test-runner evidence, test-plan substance, raw-HTML-tag check)." >&2
          echo "Repo:   $REPO_DIR" >&2
          echo "Branch: $BRANCH" >&2
          echo "PR:     #$PR_NUM" >&2
          echo "Not auto-retrying — a bypassing model already produced an unvetted PR; fix" >&2
          echo "requires human judgment (close/redo the PR via create-draft-pr.sh, or accept" >&2
          echo "it manually if it's otherwise fine)." >&2
          echo "=========================================================================================" >&2
          exit 1
        fi
        # web-jam-tools#252 — "a draft PR exists" and "a version bump is in the
        # diff" are BOTH trivially true in resume mode: they can pre-date this
        # run entirely (they did on JaMmusic#1238 — PR #1255 and its bump were
        # already on the branch, and this run committed nothing). Require the
        # branch tip to have actually MOVED since before this run's first turn
        # before trusting either signal as real completion.
        if [ "$(git rev-parse HEAD)" = "$PRE_AGY_HEAD" ]; then
          echo "!!! draft PR #$PR_NUM exists (and package.json may already show a version bump) but HEAD is still $PRE_AGY_HEAD — unchanged since before this run started. Both facts pre-date this run in resume mode; not real completion." >&2
          NEXT_TURN_PREFIX="$CONTINUE_PROMPT_PREFIX"
        elif version_bump_present; then
          AGY_OK=1
          ACTIVE_MODEL="$m"
          echo ">>> agy finished on model: $m — draft PR #$PR_NUM confirmed for branch $BRANCH (package.json version bump verified this run)"
          break 2
        else
          echo "!!! draft PR #$PR_NUM exists but no package.json version bump found in git diff origin/dev..HEAD -- package.json — task incomplete." >&2
          NEXT_TURN_PREFIX="$VERSION_BUMP_PROMPT_PREFIX"
        fi
      else
        echo "!!! turn exited zero but no draft PR found for branch $BRANCH — task incomplete." >&2
        NEXT_TURN_PREFIX="$CONTINUE_PROMPT_PREFIX"
      fi
      if [ "$ROUNDS" -ge "$AGY_MAX_ROUNDS" ]; then
        echo "!!! AGY_MAX_ROUNDS ($AGY_MAX_ROUNDS) reached — giving up on model '$m'." >&2
        break
      fi
      echo ">>> re-invoking model '$m' with a resume prompt (round $((ROUNDS + 1)) coming)..."
      TURN_PROMPT="$NEXT_TURN_PREFIX"$'\n\n'"$PROMPT"
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
    echo "--- commits (origin/dev..HEAD) ---" >&2
    git log --oneline origin/dev..HEAD >&2 || true
    echo "--- git status (WIP left behind) ---" >&2
    git status --short >&2 || true
    echo "=========================================================================" >&2
    # web-jam-tools#252 — this branch previously fell through to the finish
    # summary / land step below (which can itself `exit 0`, e.g. "no draft PR
    # found yet — nothing to land") instead of stopping here. All models/
    # rounds are exhausted at this point with no confirmed completion, so this
    # IS the failure — exit non-zero now rather than letting later steps mask
    # it with a zero exit.
    exit 1
  fi
else
  # Interactive (default): drop into the agy REPL on the selected model with the
  # task preloaded. You drive it, watch it work, and switch models with /model.
  # web-jam-tools#190: force the exact author for the model this REPL is
  # LAUNCHED on (JaMmusic#1212's confabulated "Gemini 1.5 Pro" attribution
  # happened in exactly this interactive path). KNOWN LIMITATION: if you
  # switch models mid-session via /model, this stays pinned to the launch
  # model — re-run with AGY_MODELS set to the new model (or export
  # FORCED_PR_AUTHOR yourself) before finishing, if you do switch.
  export FORCED_PR_AUTHOR="agy — $ACTIVE_MODEL"
  agy_env_args
  env -i "${AGY_ENV_ARGS[@]}" "$AGY" --model "$ACTIVE_MODEL" -i "$PROMPT"
fi

# --- post-run worktree-integrity check (web-jam-tools#252) ------------------
# Belt-and-suspenders alongside the mid-loop check above: covers the
# interactive path too (which has no per-round check of its own) and catches
# a worktree lost on the LAST headless turn, after the loop already broke out.
# Everything below this point (finish summary, land step) assumes the
# worktree is a real, readable directory — verify that before trusting any of
# it, rather than letting a deleted cwd surface as scattered, unguarded
# "fatal: Unable to read current working directory" noise further down.
if [ ! -d "$WORKTREE_DIR" ] || ! git -C "$WORKTREE_DIR" status >/dev/null 2>&1; then
  echo "" >&2
  echo "================ handle-agy-tasks FAILED (worktree lost, web-jam-tools#252) ================" >&2
  echo "Repo:     $REPO_DIR" >&2
  echo "Branch:   $BRANCH" >&2
  echo "Worktree: $WORKTREE_DIR" >&2
  echo "The worktree directory no longer exists, or git can no longer read it. Nothing" >&2
  echo "can be trusted as real completion; treating this as a hard failure rather than" >&2
  echo "printing a success/finish banner." >&2
  echo "===============================================================================" >&2
  exit 1
fi

# --- post-run no-op check, headless only (web-jam-tools#252) ----------------
# Final safety net alongside the inline HEAD-moved gate inside the headless
# loop above: if the tip genuinely never moved from before this run's first
# turn AND the tree is clean, this run did nothing, full stop — say so
# plainly and exit non-zero instead of falling through to a "finished" banner
# and a land step that has nothing new to land. (The interactive path is
# human-driven — a person ending a session having only reviewed code, with no
# changes to commit, is a normal outcome there, not a failure.)
if [ "$HEADLESS" -eq 1 ] && [ "$(git rev-parse HEAD)" = "$PRE_AGY_HEAD" ] \
  && [ -z "$(git status --porcelain)" ]; then
  echo "" >&2
  echo "================ handle-agy-tasks FAILED (no-op run, web-jam-tools#252) ================" >&2
  echo "Repo:   $REPO_DIR" >&2
  echo "Branch: $BRANCH" >&2
  echo "Branch tip is still $PRE_AGY_HEAD — unchanged since before this run started, and" >&2
  echo "the worktree is clean. This run made no commit at all; whatever PR/version-bump" >&2
  echo "state exists on this branch pre-dates this invocation." >&2
  echo "==========================================================================================" >&2
  exit 1
fi

# --- finish summary ---
echo ""
echo "================ handle-agy-tasks finished ================"
echo "Repo:     $REPO_DIR"
echo "Worktree: $WORKTREE_DIR"
echo "Branch:   $BRANCH"
echo "Model:    $ACTIVE_MODEL"
echo "--- commits (origin/dev..HEAD) ---"
git log --oneline origin/dev..HEAD || true
echo "--- git status ---"
git status --short
echo ""
echo "agy should have opened a draft PR via create-draft-pr.sh — review it on GitHub."

# --- land step (web-jam-tools#239 item 2) -----------------------------------
# Only attempt to land when a PR actually exists for this branch. If agy never
# got that far (headless exhausted its rounds, or you quit the interactive
# REPL early), there is nothing to land yet — the worktree is simply left in
# place; Josh can resume/test there, and /tmp reaps it after 30 days untouched
# (nothing is lost, since a landable branch is always pushed).
LAND_PR_NUM="$(gh pr list -R "WebJamApps/$REPO" --head "$BRANCH" --json number -q '.[0].number' 2>/dev/null || true)"
if [ -z "$LAND_PR_NUM" ]; then
  echo ""
  echo "No draft PR found yet for branch $BRANCH — nothing to land. Worktree left at:"
  echo "  $WORKTREE_DIR"
  exit 0
fi

echo ""
echo "================ land: draft PR #$LAND_PR_NUM found for $BRANCH ================"

# Verify the worktree's work is actually committed + pushed before touching
# anything else — a /tmp worktree that later gets reaped must never be the
# only copy of anything.
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: worktree $WORKTREE_DIR still has uncommitted changes — not landing." >&2
  echo "Commit/push manually in the worktree, then re-run to land, or land by hand:" >&2
  echo "  cd $WORKTREE_DIR && git status" >&2
  exit 1
fi
# NOTE: don't use @{u} here — `git worktree add -b $BRANCH origin/dev` auto-sets
# BRANCH's upstream to origin/dev (its start point), NOT to a same-named remote
# branch, so @{u} would never reflect whether THIS branch itself was pushed.
# Check for origin/$BRANCH directly instead.
if ! git rev-parse --verify "refs/remotes/origin/$BRANCH" >/dev/null 2>&1; then
  echo "Branch $BRANCH not yet pushed — pushing ..."
  git push -u origin "$BRANCH"
elif [ -n "$(git log "origin/$BRANCH..HEAD" --oneline)" ]; then
  echo "Branch $BRANCH has unpushed commits — pushing ..."
  git push origin "$BRANCH"
fi

# --- safety check on the MAIN clone --------------------------------------
cd "$REPO_DIR"
OLD_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
MAIN_DIRTY="$(git status --porcelain)"

if [ -n "$MAIN_DIRTY" ]; then
  echo ""
  echo "Did NOT check out $BRANCH into your main clone — it has uncommitted changes on $OLD_BRANCH."
  echo "Nothing lost: pushed + PR #$LAND_PR_NUM."
  echo "Test in the worktree at $WORKTREE_DIR, or when clean run: git fetch && git checkout $BRANCH."
  exit 0
fi

# Main clone is clean — confirm, then land. Switching away from a clean
# branch is non-destructive (the old branch is printed so Josh can switch
# back), so the only thing gated here is the go-ahead to proceed.
DO_LAND=0
if [ "$HEADLESS" -eq 1 ]; then
  echo "NEEDS-CONFIRM: safe to check out $BRANCH"
  DO_LAND=1
elif [ -t 0 ]; then
  read -r -p "Check out $BRANCH into main clone (currently on $OLD_BRANCH)? [Y/n] " ANSWER
  case "$ANSWER" in
    [nN]*)
      echo "Skipped. Land manually later with: git fetch && git checkout $BRANCH"
      ;;
    *)
      DO_LAND=1
      ;;
  esac
else
  # No TTY and not --headless (e.g. a piped/non-interactive invocation): there
  # is no one to prompt, so behave like headless — print the same confirm
  # marker and proceed.
  echo "NEEDS-CONFIRM: safe to check out $BRANCH"
  DO_LAND=1
fi

if [ "$DO_LAND" -eq 1 ]; then
  git worktree remove "$WORKTREE_DIR"
  git checkout "$BRANCH"
  echo "Checked out $BRANCH into main clone; you were on $OLD_BRANCH — git checkout $OLD_BRANCH to return."
fi
