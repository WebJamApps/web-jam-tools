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
#   * the body ALWAYS ends with an attribution footer naming the tool + model.
# When an issue is resolved (from the branch name or --issue), the PR CLOSES it on
# merge (`Closes #N`); pass --part-of for a partial PR or a standing run-log/epic
# issue that must stay open (`Part of #N`). An issue is OPTIONAL: with none, the PR
# simply has no issue reference — do NOT create an issue just to satisfy this
# script (Josh, 2026-07-03: issue-per-PR is bureaucracy for small standalone fixes).
# Josh alone reviews and flips draft -> ready on GitHub.
#
# Usage:
#   create-draft-pr.sh --author "<tool> — <model>" [--issue N] [--part-of] \
#       [--summary TEXT] [--test-plan TEXT] [--test-evidence TEXT] [--screenshots TEXT]
#
#   --author        REQUIRED. e.g. "Claude Code — Opus 4.8", "agy — Gemini 3 Pro".
#                   Lands in the footer so Josh can track per-model quality.
#   --part-of       Opt-in flag: DON'T close the issue on merge (emits `Part of #N`).
#                   Use only for a partial PR or a standing run-log/epic issue.
#   --closes        Deprecated no-op (closing is now the default); still accepted.
#   --issue N       Issue number. Normally parsed from the branch name
#                   (<lane>/<issue#>-<slug>); use this only as a fallback.
#                   OPTIONAL: no issue anywhere ⇒ PR opens without a Closes line
#                   (title then comes from the last commit subject).
#   --summary       REQUIRED. Fills "## Summary" (what changed and why).
#   --test-plan     REQUIRED. Fills "## How to test locally". Exact commands + expected
#                   result AND steps exercising the change itself: UI -> start command,
#                   route, clicks, expected visible result; API -> curl/Postman request(s)
#                   + expected response. "npm test green" alone is not enough (#135).
#   --test-evidence REQUIRED. Fills "## Test evidence" (real lint + test output, ran green).
#   --screenshots   Fills "## Screenshots"; omit the flag to omit the section.
#
# --summary, --test-plan, and --test-evidence are REQUIRED (web-jam-tools#77): the
# script refuses to open a PR whose description is empty or left as a placeholder.
# This is the single choke point — no caller (/next, ad-hoc, or future) can open a
# PR with an empty description. Put the summary and real test evidence IN THE PR via
# these flags, not only in the chat/REPL. --screenshots stays optional.
#
# Refuses (exit 1) when: --author missing; any of --summary/--test-plan/--test-evidence
# missing or left as a placeholder; body text contains raw HTML-like tags outside
# backticks (GitHub strips them silently — backtick them); current branch is dev/main;
# working tree dirty; the repo has no `dev` branch; a resolved issue is missing/closed;
# or --part-of is passed without a resolvable issue.

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
PART_OF=0

while [ $# -gt 0 ]; do
  case "$1" in
    --part-of)
      PART_OF=1
      shift 1 ;;
    --closes) # deprecated no-op: closing is now the default
      shift 1 ;;
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
# An issue is optional (2026-07-03): small standalone fixes don't need one, and an
# issue must never be created just to satisfy this script. With no issue, the PR
# has no Closes line and the title falls back to the last commit subject.
if [ -z "$ISSUE" ]; then
  if [ "$PART_OF" -eq 1 ]; then
    echo "ERROR: --part-of needs an issue — name the branch <lane>/<issue#>-<slug> or pass --issue N." >&2
    exit 1
  fi
  echo "No issue resolved — opening the PR without a Closes line."
  PR_TITLE="$(git log -1 --format=%s)"
else
  # --- a resolved issue must exist and be open ---
  if ! ISSUE_STATE="$(gh issue view "$ISSUE" --json state --jq .state 2>/dev/null)"; then
    echo "ERROR: issue #$ISSUE not found in this repo (via gh)." >&2
    exit 1
  fi
  if [ "$ISSUE_STATE" != "OPEN" ]; then
    echo "ERROR: issue #$ISSUE is $ISSUE_STATE, not OPEN." >&2
    exit 1
  fi
  PR_TITLE="$(gh issue view "$ISSUE" --json title --jq .title)"
fi

# --- WARN (don't fail) on a lane mismatch between branch prefix and issue label ---
# Branch lane -> acceptable issue lane label(s): agy<->agy, claude<->opus|fable
# (Claude Code runs either Opus or Fable, so both labels are valid for a claude/ branch).
BRANCH_LANE="${BRANCH%%/*}"
case "$BRANCH_LANE" in
  agy)    EXPECT_LANES="agy" ;;
  claude) EXPECT_LANES="opus fable" ;;
  *)      EXPECT_LANES="" ;;
esac
if [ -n "$EXPECT_LANES" ] && [ -n "$ISSUE" ]; then
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

# --- require real description content (web-jam-tools#77) ---
# The single choke point: refuse a PR with an empty/placeholder description, so no
# caller (/next, ad-hoc, or future) can ship one. Rejects both an absent value and
# the legacy placeholder text (in case a caller echoes it back).
PLACEHOLDER_SUMMARY="_(fill in: what changed and why)_"
PLACEHOLDER_TEST_PLAN="_(fill in: exact commands + expected result)_"
PLACEHOLDER_TEST_EVIDENCE="_(fill in: confirm lint + unit tests ran green; paste final output)_"

missing=()
if [ -z "$SUMMARY" ] || [ "$SUMMARY" = "$PLACEHOLDER_SUMMARY" ]; then
  missing+=("--summary")
fi
if [ -z "$TEST_PLAN" ] || [ "$TEST_PLAN" = "$PLACEHOLDER_TEST_PLAN" ]; then
  missing+=("--test-plan")
fi
if [ -z "$TEST_EVIDENCE" ] || [ "$TEST_EVIDENCE" = "$PLACEHOLDER_TEST_EVIDENCE" ]; then
  missing+=("--test-evidence")
fi
if [ "${#missing[@]}" -gt 0 ]; then
  echo "ERROR: refusing to open a PR with an empty description (web-jam-tools#77)." >&2
  echo "       Provide real content for: ${missing[*]}" >&2
  echo "       Put your summary + actual test output IN THE PR via these flags," >&2
  echo "       not only in the chat/REPL reply." >&2
  exit 1
fi

# --- refuse raw HTML-like tags in body text (2026-07-03, after PR #137's body) ---
# GitHub's markdown sanitizer silently STRIPS unknown tags when rendering, so raw
# <lane>/<slug> prose collapses to garbage. Backtick spans, fenced blocks, and
# <https://...> autolinks are fine — strip those before checking (draft-pr skill rule).
raw_tag_check() {
  local field="$1" text="$2" stripped
  stripped="$(printf '%s' "$text" \
    | sed -E 's/```[^`]*```//g; s/`[^`]*`//g; s|<[A-Za-z][A-Za-z0-9+.-]*://[^<>]*>||g')"
  if printf '%s' "$stripped" | grep -qE '<[A-Za-z][^<>]*>'; then
    echo "ERROR: raw HTML-like tag(s) in --$field — GitHub strips them silently:" >&2
    printf '%s\n' "$stripped" | grep -oE '<[A-Za-z][^<>]*>' | sort -u | sed 's/^/         /' >&2
    echo "       Wrap them in backticks so they render literally (see the draft-pr skill)." >&2
    exit 1
  fi
}
raw_tag_check summary "$SUMMARY"
raw_tag_check test-plan "$TEST_PLAN"
raw_tag_check test-evidence "$TEST_EVIDENCE"
if [ "$HAS_SCREENSHOTS" -eq 1 ]; then
  raw_tag_check screenshots "$SCREENSHOTS"
fi

# --- assemble the body ---

if [ -z "$ISSUE" ]; then
  ISSUE_REF=""
elif [ "$PART_OF" -eq 1 ]; then
  ISSUE_REF="Part of #$ISSUE"
else
  ISSUE_REF="Closes #$ISSUE"
fi

BODY="$(cat <<EOF
## Summary
$SUMMARY
${ISSUE_REF:+
$ISSUE_REF
}
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

echo "Opening draft PR (base dev)${ISSUE:+ for issue #$ISSUE}..."
PR_URL="$(gh pr create --draft --base dev --title "$PR_TITLE" --body "$BODY")"

echo ""
echo "Draft PR opened: $PR_URL"
if [ -z "$ISSUE" ]; then
  echo "  base: dev | state: draft | no issue | by: $AUTHOR"
elif [ "$PART_OF" -eq 1 ]; then
  echo "  base: dev | state: draft | part of: #$ISSUE | by: $AUTHOR"
else
  echo "  base: dev | state: draft | closes: #$ISSUE | by: $AUTHOR"
fi
echo "Josh reviews the diff and flips draft -> ready on GitHub."
