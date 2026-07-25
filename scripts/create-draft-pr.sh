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
#   create-draft-pr.sh --author "<tool> — <model>" [--issue N] [--part-of] [--dry-run] \
#       [--update] \
#       [--summary TEXT | --summary-file PATH] \
#       [--test-plan TEXT | --test-plan-file PATH] \
#       [--test-evidence TEXT | --test-evidence-file PATH] [--screenshots TEXT]
#
#   --author        REQUIRED. e.g. "Claude Code — Opus 4.8", "agy — Gemini 3.6 Flash
#                   (Medium)". Lands in the footer so Josh can track per-model
#                   quality. MUST name a model on the ROSTER list maintained near
#                   the top of this script (web-jam-tools#190) — models routinely
#                   confabulate their own checkpoint name (JaMmusic#1212: a Gemini
#                   Flash run self-reported "Gemini 1.5 Pro"), so the script
#                   checks the value itself rather than trusting it. Matched as a
#                   SUBSTRING (caller format is "<tool> — <model>"), not an exact
#                   match. FORCED_PR_AUTHOR in the environment overrides --author
#                   entirely (see below) — headless/scripted callers that already
#                   know the exact model should set it instead of trusting the
#                   model to self-report correctly.
#   --part-of       Opt-in flag: DON'T close the issue on merge (emits `Part of #N`).
#                   Use only for a partial PR or a standing run-log/epic issue.
#   --closes        Deprecated no-op (closing is now the default); still accepted.
#   --issue N       Issue number. Normally parsed from the branch name
#                   (<lane>/<issue#>-<slug>); use this only as a fallback.
#                   OPTIONAL: no issue anywhere ⇒ PR opens without a Closes line
#                   (title then comes from the last commit subject).
#   --summary       REQUIRED (or --summary-file). Fills "## Summary" (what changed and why).
#   --test-plan     REQUIRED (or --test-plan-file). Fills "## How to test locally". Exact
#                   commands + expected result AND steps exercising the change itself:
#                   UI -> start command, route, clicks, expected visible result;
#                   API -> curl/Postman request(s) + expected response. "npm test
#                   green" alone is not enough (#135) — MACHINE-ENFORCED
#                   (web-jam-tools#152): a plan whose only content is test-suite
#                   invocations (npm test/typecheck/lint, deno task test, vitest,
#                   eslint, ...) is refused; it must have exercise-the-change
#                   content left over after stripping those.
#   --test-evidence REQUIRED (or --test-evidence-file). Fills "## Test evidence" (real
#                   lint + test output, ran green).
#                   AUTO-FENCED (web-jam-tools#150): if the value contains no ```
#                   code fence at all, the whole value is wrapped in one before the
#                   body is composed — raw console output otherwise garbles the
#                   markdown (web-jam-back#935: coverage ==== separator lines
#                   rendered as giant setext H1s). Values that already contain a
#                   fence pass through unchanged; fencing properly yourself is
#                   still the polite thing to do.
#   --summary-file / --test-plan-file / --test-evidence-file  PATH (web-jam-tools#145).
#                   File-based alternative to the inline flags above — reads that
#                   section's content from PATH instead. A multi-line shell argument
#                   gets FLATTENED to one line during agy's headless `-p` turn (the
#                   serialization happens upstream, outside this script's control);
#                   a file written with a real file-write tool preserves newlines, so
#                   headless dispatch should always use the *-file form for anything
#                   multi-line. Refuses (exit 1) if PATH is missing or empty, or if
#                   both the inline flag and its *-file counterpart are given for the
#                   same section (ambiguous). File content is otherwise treated
#                   IDENTICALLY to an inline value: same required-content, placeholder,
#                   raw-HTML-tag, and (for test-evidence) auto-fence checks below.
#   --screenshots   Fills "## Screenshots"; omit the flag to omit the section.
#   --dry-run       Run every guard and compose the full PR body, print it, and
#                   exit 0 WITHOUT pushing or opening/editing a PR. For testing
#                   this script's composition/guards safely (web-jam-tools#150).
#   --update        Update the CURRENT BRANCH's existing open PR instead of
#                   opening a new one (web-jam-tools#236). Runs through the exact
#                   same guard pipeline as create mode — author roster, the #77
#                   empty/placeholder check, the unbulleted-summary check, the
#                   #190 recognizable-test-evidence check, the #152
#                   suite-invocations-only test-plan check, and the raw-HTML-tag
#                   check all fire on the REAL final content, not just at initial
#                   creation. Looks the PR up via `gh pr view` for the current
#                   branch (push happens first, same as create mode) and refuses
#                   if none is found — open one first (omit --update). Only the
#                   body is replaced; the title is left as-is. Exists for a
#                   "checkpoint" PR opened early (e.g. by the delegate skill's
#                   dispatch-checkpoint mechanism) whose body starts as a
#                   plan/status scaffold and needs the REAL Summary/Test
#                   plan/Test evidence swapped in — with the same guards — once
#                   the work is actually done, without opening a second PR.
#
# FORCED_PR_AUTHOR (environment variable, not a flag): when set, REPLACES
# whatever --author was passed (or not passed) before any check runs. It still
# has to be on the roster — this is an override of the SOURCE of the author
# string, not a bypass of the roster check. handle-agy-tasks.sh sets this to
# the exact "agy — <model>" string for the model it actually invoked, so a
# headless or interactive agy run's PR footer can never depend on the model
# correctly naming itself (web-jam-tools#190).
#
# --summary, --test-plan, and --test-evidence are REQUIRED (web-jam-tools#77), each
# either inline or via its *-file counterpart: the script refuses to open a PR whose
# description is empty or left as a placeholder. This is the single choke point — no
# caller (/next, ad-hoc, or future) can open a PR with an empty description. Put the
# summary and real test evidence IN THE PR via these flags, not only in the
# chat/REPL. --screenshots stays optional (inline only).
#
# Refuses (exit 1) when: --author missing or names a model not on the ROSTER
# (web-jam-tools#190); any of --summary/--test-plan/--test-evidence (inline or
# *-file) missing or left as a placeholder; --summary has zero markdown bullet
# lines (web-jam-tools#190); --test-evidence (inline or *-file) has no
# recognizable test-runner output (web-jam-tools#190); --test-plan (inline or
# *-file) is only test-suite invocations with nothing exercising the change
# (web-jam-tools#152); a *-file flag points at a missing or empty file; both a
# section's inline flag and its *-file flag are given; body text contains raw
# HTML-like tags outside backticks (GitHub strips them silently — backtick
# them); current branch is dev/main; working tree dirty; the repo has no `dev`
# branch; a resolved issue is missing/closed; --part-of is passed without a
# resolvable issue; or --update is passed but the current branch has no
# existing open PR to update.

set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
}

# --- author roster (web-jam-tools#190) ---
# The actual, currently-running WebJamApps model roster. Easy to extend: add a
# line. Entries print verbatim in refusal messages; matching against --author
# strips a leading "Claude " (see author_roster_check) because the caller
# format is "<tool> — <model>" (e.g. "Claude Code — Sonnet 5" — the tool name
# already says "Claude", so the model half doesn't repeat it).
ROSTER=(
  "Gemini 3.6 Flash (Medium)"
  "Gemini 3.6 Flash (High)"
  "Claude Sonnet 5"
  "Claude Haiku 4.5"
  "Claude Opus 4.8"
  "Claude Fable 5"
)

author_roster_check() {
  local author="$1" entry needle
  for entry in "${ROSTER[@]}"; do
    needle="${entry#Claude }"
    if printf '%s' "$author" | grep -qF "$needle"; then
      return 0
    fi
  done
  echo "ERROR: --author '$author' does not name a model on the roster (web-jam-tools#190)." >&2
  echo "       Models routinely misidentify their own checkpoint — this is checked," >&2
  echo "       not trusted. Valid models:" >&2
  printf '         - %s\n' "${ROSTER[@]}" >&2
  exit 1
}

AUTHOR=""
ISSUE=""
SUMMARY=""
TEST_PLAN=""
TEST_EVIDENCE=""
SCREENSHOTS=""
HAS_SCREENSHOTS=0
HAS_SUMMARY=0
HAS_TEST_PLAN=0
HAS_TEST_EVIDENCE=0
SUMMARY_FILE=""
TEST_PLAN_FILE=""
TEST_EVIDENCE_FILE=""
PART_OF=0
DRY_RUN=0
UPDATE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --part-of)
      PART_OF=1
      shift 1 ;;
    --dry-run)
      DRY_RUN=1
      shift 1 ;;
    --update)
      UPDATE=1
      shift 1 ;;
    --closes) # deprecated no-op: closing is now the default
      shift 1 ;;
    --author|--issue|--summary|--test-plan|--test-evidence|--screenshots|--summary-file|--test-plan-file|--test-evidence-file)
      [ $# -ge 2 ] || { echo "ERROR: $1 requires a value." >&2; exit 1; }
      case "$1" in
        --author)              AUTHOR="$2" ;;
        --issue)               ISSUE="$2" ;;
        --summary)             SUMMARY="$2"; HAS_SUMMARY=1 ;;
        --test-plan)           TEST_PLAN="$2"; HAS_TEST_PLAN=1 ;;
        --test-evidence)       TEST_EVIDENCE="$2"; HAS_TEST_EVIDENCE=1 ;;
        --screenshots)         SCREENSHOTS="$2"; HAS_SCREENSHOTS=1 ;;
        --summary-file)        SUMMARY_FILE="$2" ;;
        --test-plan-file)      TEST_PLAN_FILE="$2" ;;
        --test-evidence-file)  TEST_EVIDENCE_FILE="$2" ;;
      esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# --- FORCED_PR_AUTHOR env override (web-jam-tools#190) ---
# Wins over --author unconditionally. handle-agy-tasks.sh sets this to the exact
# "agy — <model>" string for the model it actually invoked, so the PR footer
# never depends on the model self-reporting correctly (still has to clear the
# roster check below — this overrides the SOURCE of the value, not the check).
if [ -n "${FORCED_PR_AUTHOR:-}" ]; then
  AUTHOR="$FORCED_PR_AUTHOR"
fi

# --- required: author ---
if [ -z "$AUTHOR" ]; then
  echo "ERROR: --author is required (e.g. --author \"Claude Code — Opus 4.8\")." >&2
  exit 1
fi
author_roster_check "$AUTHOR"

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

# --- resolve *-file flags into content (web-jam-tools#145) ---
# A multi-line shell argument gets flattened to one line during agy's headless
# `-p` turn (upstream serialization, outside this script's control — #145). A
# file written with a real file-write tool preserves newlines, so a *-file flag
# lets a caller point at a file instead of inlining the section. Resolved content
# then flows through the SAME validation as an inline value (placeholder check,
# raw-tag check, and — for test-evidence — the auto-fence below).
read_body_file() {
  local flag="$1" path="$2" content
  if [ ! -f "$path" ]; then
    echo "ERROR: --$flag points at a missing file: $path" >&2
    exit 1
  fi
  content="$(cat "$path")"
  if [ -z "$content" ]; then
    echo "ERROR: --$flag file is empty: $path" >&2
    exit 1
  fi
  printf '%s' "$content"
}

if [ -n "$SUMMARY_FILE" ]; then
  if [ "$HAS_SUMMARY" -eq 1 ]; then
    echo "ERROR: pass --summary or --summary-file, not both." >&2
    exit 1
  fi
  SUMMARY="$(read_body_file summary-file "$SUMMARY_FILE")"
fi
if [ -n "$TEST_PLAN_FILE" ]; then
  if [ "$HAS_TEST_PLAN" -eq 1 ]; then
    echo "ERROR: pass --test-plan or --test-plan-file, not both." >&2
    exit 1
  fi
  TEST_PLAN="$(read_body_file test-plan-file "$TEST_PLAN_FILE")"
fi
if [ -n "$TEST_EVIDENCE_FILE" ]; then
  if [ "$HAS_TEST_EVIDENCE" -eq 1 ]; then
    echo "ERROR: pass --test-evidence or --test-evidence-file, not both." >&2
    exit 1
  fi
  TEST_EVIDENCE="$(read_body_file test-evidence-file "$TEST_EVIDENCE_FILE")"
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

# --- refuse an unbulleted --summary (web-jam-tools#190) ---
# JaMmusic#1212: a long agy run's summary decayed into a numbered run-on
# paragraph instead of bullets. Require at least one markdown bullet line
# (`- ` or `* `, optionally indented for nesting).
if ! printf '%s' "$SUMMARY" | grep -qE '^[[:space:]]*[-*][[:space:]]'; then
  echo "ERROR: --summary has no markdown bullet lines (web-jam-tools#190)." >&2
  echo "       Write it as bullets (one change per line, starting with '- ' or '* ')," >&2
  echo "       not a run-on paragraph." >&2
  exit 1
fi

# --- refuse --test-evidence with no recognizable test-runner output (web-jam-tools#190) ---
# JaMmusic#1212: evidence was a fenced PARAPHRASE ("All unit tests, lints, and
# typechecks passed successfully") with no actual runner output. Heuristic only
# (no --run-tests re-execution mode — out of scope for this pass): require a
# line that looks like real pass/fail output. Tuned against real WebJamApps
# output: vitest/jest "Tests: N passed" / "N passed (N)", deno's
# "ok | N passed | 0 failed", and ✓-marked lines.
if ! printf '%s' "$TEST_EVIDENCE" | grep -qE '[0-9]+[[:space:]]*pass|[Tt]ests?:|ok[[:space:]]*\||✓'; then
  echo "ERROR: --test-evidence has no recognizable test-runner output (web-jam-tools#190)." >&2
  echo "       A paraphrase like \"all tests passed successfully\" is refused — paste the" >&2
  echo "       ACTUAL runner output (e.g. vitest/jest \"Tests: N passed\", deno" >&2
  echo "       \"ok | N passed | 0 failed\", or ✓-marked lines)." >&2
  exit 1
fi

# --- refuse a --test-plan that is only test-suite invocations (web-jam-tools#152) ---
# web-jam-back#918: a "How to test locally" section that was just `npm test` +
# `npm run typecheck` shipped — running the suite is obvious and isn't what this
# section is for; it must show how to exercise the CHANGE (routes hit, curl
# commands, manual steps, expected behavior). #135 already put this rule in the
# draft-pr skill docs, but docs alone don't stick (subagents dispatched via the
# delegate templates never load the skill) — so it's machine-enforced here too,
# the same #77 pattern as the placeholder-body check.
#
# Cheap heuristic, not NLP: strip fenced-block markers and any line that is
# ONLY a known suite-invocation command (npm test/typecheck/lint, deno task
# test/check/lint/fmt/coverage:check, deno test/check/lint/fmt, vitest, eslint,
# jscpd, pytest, yarn test/lint/typecheck — with any trailing flags/comments on
# that same line). If nothing but blank/comment lines remains, there is no
# exercise-the-change content — refuse. A plan with suite commands PLUS a route/
# curl/URL/manual step keeps that step as leftover content and passes.
test_plan_has_substance() {
  local text="$1" stripped
  stripped="$(printf '%s\n' "$text" | grep -vE '^[[:space:]]*```')"
  stripped="$(printf '%s\n' "$stripped" | grep -vE '^[[:space:]]*(npm[[:space:]]+(run[[:space:]]+)?(test|typecheck|lint)|deno[[:space:]]+task[[:space:]]+(coverage:check|fmt:check|test|check|lint|fmt)|deno[[:space:]]+(test|check|lint|fmt)|(npx[[:space:]]+)?vitest|(npx[[:space:]]+)?eslint|jscpd|pytest|yarn[[:space:]]+(test|lint|typecheck))([[:space:]].*)?$')"
  stripped="$(printf '%s\n' "$stripped" | grep -vE '^[[:space:]]*(#.*)?$')"
  [ -n "$stripped" ]
}
if ! test_plan_has_substance "$TEST_PLAN"; then
  echo "ERROR: --test-plan is only test-suite invocations (web-jam-tools#152)." >&2
  echo "       Running the suite (npm test, deno task test, vitest, eslint, ...) is a" >&2
  echo "       gate, not the whole plan — it doesn't show the CHANGE works. Add steps" >&2
  echo "       that exercise it, mirroring the draft-pr skill rule:" >&2
  echo "         UI change      -> exact manual steps (start command, route, clicks," >&2
  echo "                           expected visible result)" >&2
  echo "         Backend/API    -> runnable curl (or Postman-equivalent) + expected response" >&2
  echo "         Docs/tooling   -> the command that shows the change took effect" >&2
  exit 1
fi

# --- refuse raw HTML-like tags in body text (2026-07-03, after PR #137's body) ---
# GitHub's markdown sanitizer silently STRIPS unknown tags when rendering, so raw
# <lane>/<slug> prose collapses to garbage. Backtick spans, fenced blocks, and
# <https://...> autolinks are fine — strip those before checking (draft-pr skill rule).
raw_tag_check() {
  local field="$1" text="$2" stripped
  # shellcheck disable=SC2016 # sed pattern literals — no shell expansion wanted
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

# --- auto-fence an unfenced --test-evidence (web-jam-tools#150) ---
# Callers across lanes keep passing raw console output, which markdown garbles
# (web-jam-back#935: the coverage report's "====" separator lines acted as
# setext-heading underlines, so plain output rendered as giant H1s). If the
# value contains no ``` fence at all, wrap the whole value in one before the
# body is composed. Detection is deliberately conservative: ANY existing fence
# means the caller formatted the section themselves — pass through unchanged.
# (Not applied to --test-plan: plans are legitimately prose + fenced commands,
# and blanket-fencing would garble real markdown; see #150.)
if ! printf '%s' "$TEST_EVIDENCE" | grep -qF '```'; then
  echo "NOTE: --test-evidence had no code fence — auto-wrapping it in one (web-jam-tools#150)."
  TEST_EVIDENCE="\`\`\`
$TEST_EVIDENCE
\`\`\`"
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

# --- dry-run: print the composed body and stop — no push, no PR opened/edited (web-jam-tools#150) ---
if [ "$DRY_RUN" -eq 1 ]; then
  MODE_LABEL="CREATE"
  [ "$UPDATE" -eq 1 ] && MODE_LABEL="UPDATE"
  cat <<EOF
=== DRY RUN ($MODE_LABEL — no push, no PR opened/edited) ===
TITLE: $PR_TITLE
=== COMPOSED BODY ===
$BODY
=== END DRY RUN ===
EOF
  exit 0
fi

# --- push, then either open a new draft PR or update the existing one (web-jam-tools#236) ---
echo "Pushing branch '$BRANCH' to origin..."
git push -u origin HEAD

if [ "$UPDATE" -eq 1 ]; then
  echo "Looking up the existing PR for branch '$BRANCH'..."
  if ! PR_NUMBER="$(gh pr view --json number --jq .number 2>/dev/null)" || [ -z "$PR_NUMBER" ]; then
    echo "ERROR: --update passed but branch '$BRANCH' has no existing PR (via gh pr view)." >&2
    echo "       Open one first (omit --update) — --update only edits an existing PR's body." >&2
    exit 1
  fi

  echo "Updating draft PR #$PR_NUMBER body..."
  gh pr edit "$PR_NUMBER" --body "$BODY"
  PR_URL="$(gh pr view "$PR_NUMBER" --json url --jq .url)"

  echo ""
  echo "Draft PR updated: $PR_URL"
  if [ -z "$ISSUE" ]; then
    echo "  base: dev | state: draft | no issue | by: $AUTHOR"
  elif [ "$PART_OF" -eq 1 ]; then
    echo "  base: dev | state: draft | part of: #$ISSUE | by: $AUTHOR"
  else
    echo "  base: dev | state: draft | closes: #$ISSUE | by: $AUTHOR"
  fi
  echo "Josh reviews the diff and flips draft -> ready on GitHub."
else
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
fi
