#!/usr/bin/env bash
# create-draft-pr.sh — web-jam-tools#49
#
# The single source of truth for opening pull requests across the WebJamApps
# workspace. Bash + `gh` only, so it is model- and tool-agnostic: Claude Code and
# agy (any model within them) finish a coding task by calling this script instead
# of `gh pr create` directly.
#
# Hard invariants — NO flag can override them:
#   * the PR is ALWAYS a draft;
#   * the PR is ALWAYS based on `dev`;
#   * the body ALWAYS contains `Closes #N` (N derived from the branch, never typed);
#   * the body ALWAYS ends with an attribution footer naming the tool + model.
# Josh alone reviews and flips draft -> ready on GitHub.
#
# Usage:
#   create-draft-pr.sh --author "<tool> — <model>" [--issue N] \
#       [--summary TEXT] [--test-plan TEXT] [--test-evidence TEXT] [--screenshots TEXT]
#
#   --author        REQUIRED. e.g. "Claude Code — Opus 4.8", "agy — Gemini 3 Pro".
#                   Lands in the footer so Josh can track per-model quality.
#   --issue N       Issue number. Normally parsed from the branch name
#                   (<lane>/<issue#>-<slug>); use this only as a fallback.
#   --summary       Fills "## Summary" (what changed and why).
#   --test-plan     Fills "## How to test locally" (exact commands + expected result).
#   --test-evidence Fills "## Test evidence" (confirmation lint + tests ran green).
#   --screenshots   Fills "## Screenshots"; omit the flag to omit the section.
#
# Content flags are optional — when absent a visible placeholder is inserted so the
# agent (or Josh) can fill it in on GitHub. The structural invariants above always
# hold regardless of what the agent supplies.
#
# Refuses (exit 1) when: --author missing; current branch is dev/main; working tree
# dirty; the repo has no `dev` branch; or no issue number can be resolved.

set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
}

AUTHOR=""
ISSUE=""
SUMMARY=""
TEST_PLAN=""
TEST_EVIDENCE=""
SCREENSHOTS=""
HAS_SCREENSHOTS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --author|--issue|--summary|--test-plan|--test-evidence|--screenshots)
      [ $# -ge 2 ] || { echo "ERROR: $1 requires a value." >&2; exit 1; }
      case "$1" in
        --author)        AUTHOR="$2" ;;
        --issue)         ISSUE="$2" ;;
        --summary)       SUMMARY="$2" ;;
        --test-plan)     TEST_PLAN="$2" ;;
        --test-evidence) TEST_EVIDENCE="$2" ;;
        --screenshots)   SCREENSHOTS="$2"; HAS_SCREENSHOTS=1 ;;
      esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# --- required: author ---
if [ -z "$AUTHOR" ]; then
  echo "ERROR: --author is required (e.g. --author \"Claude Code — Opus 4.8\")." >&2
  exit 1
fi

# --- must be inside a git repo ---
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: not inside a git repository." >&2
  exit 1
fi

# --- never open a PR from dev/main ---
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "dev" ] || [ "$BRANCH" = "main" ]; then
  echo "ERROR: refusing to open a PR from '$BRANCH' — switch to a feature branch." >&2
  exit 1
fi

# --- working tree must be clean (everything committed) ---
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is dirty — commit everything first." >&2
  git status --short >&2
  exit 1
fi

# --- the repo must have a `dev` branch; never fall back to main ---
if ! git show-ref --verify --quiet refs/heads/dev \
   && ! git show-ref --verify --quiet refs/remotes/origin/dev; then
  echo "ERROR: no 'dev' branch in this repo — refusing (never falls back to main)." >&2
  exit 1
fi

# --- resolve the issue number (branch name first, then --issue) ---
if [ -z "$ISSUE" ] && [[ "$BRANCH" =~ ^[^/]+/([0-9]+)(-|$) ]]; then
  ISSUE="${BASH_REMATCH[1]}"
fi
if [ -z "$ISSUE" ]; then
  echo "ERROR: no issue number — name the branch <lane>/<issue#>-<slug> or pass --issue N." >&2
  exit 1
fi

# --- the issue must exist and be open ---
if ! ISSUE_STATE="$(gh issue view "$ISSUE" --json state --jq .state 2>/dev/null)"; then
  echo "ERROR: issue #$ISSUE not found in this repo (via gh)." >&2
  exit 1
fi
if [ "$ISSUE_STATE" != "OPEN" ]; then
  echo "ERROR: issue #$ISSUE is $ISSUE_STATE, not OPEN." >&2
  exit 1
fi
ISSUE_TITLE="$(gh issue view "$ISSUE" --json title --jq .title)"

# --- WARN (don't fail) on a lane mismatch between branch prefix and issue label ---
# Branch lane -> acceptable issue lane label(s): agy<->agy, claude<->opus|fable
# (Claude Code runs either Opus or Fable, so both labels are valid for a claude/ branch).
BRANCH_LANE="${BRANCH%%/*}"
case "$BRANCH_LANE" in
  agy)    EXPECT_LANES="agy" ;;
  claude) EXPECT_LANES="opus fable" ;;
  *)      EXPECT_LANES="" ;;
esac
if [ -n "$EXPECT_LANES" ]; then
  mapfile -t ISSUE_LABELS < <(gh issue view "$ISSUE" --json labels --jq '.labels[].name' 2>/dev/null || true)
  ISSUE_LANES=()
  for l in "${ISSUE_LABELS[@]}"; do
    case "$l" in opus|agy|fable) ISSUE_LANES+=("$l") ;; esac
  done
  if [ "${#ISSUE_LANES[@]}" -gt 0 ]; then
    matched=0
    for e in $EXPECT_LANES; do
      for il in "${ISSUE_LANES[@]}"; do
        [ "$e" = "$il" ] && matched=1
      done
    done
    if [ "$matched" -eq 0 ]; then
      echo "WARNING: branch lane '$BRANCH_LANE' doesn't match issue #$ISSUE lane label(s): ${ISSUE_LANES[*]}" >&2
      echo "         continuing — possible queue mix-up; confirm this is the right lane." >&2
    fi
  fi
fi

# --- assemble the body (placeholders for any unfilled section) ---
SUMMARY="${SUMMARY:-_(fill in: what changed and why)_}"
TEST_PLAN="${TEST_PLAN:-_(fill in: exact commands + expected result)_}"
TEST_EVIDENCE="${TEST_EVIDENCE:-_(fill in: confirm lint + unit tests ran green; paste final output)_}"

BODY="$(cat <<EOF
## Summary
$SUMMARY

Closes #$ISSUE

## How to test locally
$TEST_PLAN

## Test evidence
$TEST_EVIDENCE
EOF
)"
if [ "$HAS_SCREENSHOTS" -eq 1 ]; then
  BODY="$BODY

## Screenshots
$SCREENSHOTS"
fi
BODY="$BODY

🤖 Work by $AUTHOR"

# --- push, then open the draft PR based on dev ---
echo "Pushing branch '$BRANCH' to origin..."
git push -u origin HEAD

echo "Opening draft PR (base dev) for issue #$ISSUE..."
PR_URL="$(gh pr create --draft --base dev --title "$ISSUE_TITLE" --body "$BODY")"

echo ""
echo "Draft PR opened: $PR_URL"
echo "  base: dev | state: draft | closes: #$ISSUE | by: $AUTHOR"
echo "Josh reviews the diff and flips draft -> ready on GitHub."
