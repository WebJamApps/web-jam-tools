---
name: pr-review
description: Cross-model PR review pipeline where reviewer tier is never below author tier (Flash High reviews Flash Medium/Haiku; Sonnet reviews Flash High/Flash Medium/Haiku; Opus reviews Sonnet on Josh's per-PR call). Triggered via `/pr-review <Repo>#<pr-num>` or `/pr-review` (auto-detects open candidate PRs). Audits PR diff against issue acceptance criteria, scope, single semver bump, package-lock engine alignment (--ignore-scripts), test evidence integrity, and AGENTS.md guardrails, posting structured feedback via `deno task post-pr-review` (the guarded route to `gh pr review --comment`).
metadata:
  version: v2
  publisher: josh
---

# pr-review — cross-model pull request review pipeline

This skill provides a systematic pipeline for automated cross-model pull request reviews across WebJamApps repositories.

## Purpose & Model Pairing

Cross-model review ensures fresh perspective and catches model-specific blind spots before Josh does final human review and merge.

Reviewer tier is **never below author tier** (a weaker model never reviews a stronger model's work).

### Cross-Model Review Pairing Matrix

| Reviewer | Reviews |
|---|---|
| Flash High | Flash Medium, Haiku |
| Sonnet | Flash High, Flash Medium, Haiku |
| Opus | Sonnet |

**Ceiling rule (never a schedule):**
The matrix is a **ceiling on who MAY review whose work, never a schedule.** Opus reviewing a Sonnet PR happens only when Josh deems that specific PR critical enough for an Opus review — his decision, per PR, not automatic. Nothing in this skill or its auto-detect mode may auto-dispatch an Opus review off this matrix.

## Trigger & Invocation

- **Named mode**: `/pr-review <Repo>#<pr-num>` (e.g. `/pr-review web-jam-tools#363` or `https://github.com/WebJamApps/web-jam-tools/pull/363`).
- **Auto-detect mode**: `/pr-review` (with no arguments).
  - Sweeps open draft/ready PRs across all eight active WebJamApps repositories (see the canonical repo list in [`skills/flash-issues/SKILL.md`](../flash-issues/SKILL.md) under "Scope — all eight active repos, exactly these slugs").
  - Matches candidate PRs based on the active reviewer's model tier per the pairing matrix:
    - **Sonnet (`Claude Code — Sonnet 5`)**: matches PRs authored by `Gemini Flash (High)`, `Gemini Flash (Medium)`, or `Claude Haiku 4.5`.
    - **Flash High (`Gemini Flash (High)`)**: matches PRs authored by `Gemini Flash (Medium)` or `Claude Haiku 4.5`.
    - **Opus (`Claude Opus`)**: does NOT auto-detect candidates; Opus reviews are strictly manual/named mode per Josh's instruction.
    - Matching inspects the author footer attribution (`🤖 Work by ...` or `--author` string) using the `ROSTER` spellings from `scripts/create-draft-pr.sh`:
      - `Gemini Flash (High)` (e.g. `Antigravity — Gemini Flash (High)` / `agy — Gemini Flash (High)`)
      - `Gemini Flash (Medium)` (e.g. `Antigravity — Gemini Flash (Medium)` / `agy — Gemini Flash (Medium)`)
      - `Claude Haiku 4.5` (e.g. `Claude Code — Haiku 4.5` / `Claude Code — Claude Haiku 4.5`)
  - Determines review status for each candidate PR using the head-SHA comparison from Step 1's "Already-Reviewed Check":
    - Compares the commit SHA of the newest automated review (`reviews | map(select((.body // "") | test("(?i)## PR Review Summary"))) | last | .commit.oid`) against the PR's current head commit SHA (`commits | last | .oid`).
    - If equal (`head_sha == last_review_sha`), mark as `reviewed at current head`. Already-reviewed PRs are included in the pick-list rather than filtered out.
    - If no prior automated review exists or if new commits have been pushed since the last automated review (`head_sha != last_review_sha`), mark as `needs review`.
  - Builds and displays a numbered pick-list table carrying per row: repo, PR number, PR title, author tier, age in days, draft/ready state, and review status.
  - **Stops and waits for Josh**: The skill STOPS and waits for Josh to choose a PR by number from the numbered pick-list before fetching, posting, or beginning any review. It **never** silently auto-selects a PR.
  - **Empty result handling**: If no open candidate PRs matching the reviewer's eligible author tiers exist across any of the eight active repositories, reports plainly that no candidate PRs were found (e.g., *"No open candidate PRs matching the reviewer tier found across the eight active WebJamApps repositories."*) and stops immediately, without falling through to named mode.

## Review Pipeline

### Where to run it

The review is read-only and API-driven — `gh pr view` and `gh pr diff` need no checkout at all.
**Never `git checkout`, `git switch`, `git reset` or `git cherry-pick` in a shared working
directory.** Another agent may be mid-task on the branch that is checked out there, and switching
it pulls the working tree out from under that agent.

If auditing test evidence requires actually running the suite, run it in a throwaway worktree
under `/tmp`, never in the shared checkout and never inside the repository directory:

```sh
git -C <repo> fetch origin <headRefName>
git -C <repo> worktree add /tmp/pr-review-<pr-num> origin/<headRefName>
# run the suite inside /tmp/pr-review-<pr-num>
git -C <repo> worktree remove /tmp/pr-review-<pr-num>
```

Remove the worktree when finished. Reviewing without running anything is the normal case; a
worktree is only needed when a pasted test-evidence block has to be reproduced.

### Step 1: Fetch PR Details and Context
1. Fetch PR details, metadata, mergeability, reviews, and commits:
   ```sh
   gh pr view <pr-num> --repo WebJamApps/<Repo> --json number,title,body,author,headRefName,baseRefName,state,isDraft,mergeable,mergeStateStatus,reviews,commits
   ```
2. **Already-Reviewed Check**:
   - Filter `reviews` for automated reviews carrying the `## PR Review Summary` header:
     ```sh
     gh pr view <pr-num> --repo WebJamApps/<Repo> --json reviews,commits \
       --jq '{last_review_sha: (.reviews | map(select((.body // "") | test("(?i)## PR Review Summary"))) | last | .commit.oid), head_sha: (.commits | last | .oid)}'
     ```
   - Compare the commit SHA of the newest automated review (`last_review_sha` from `.commit.oid`) against the PR's current head commit SHA (`head_sha` from `.commits | last | .oid`).
   - If equal (and a prior automated review exists at that SHA), stop and report to Josh that the PR was already reviewed at that SHA with no new commits, and post NO review comment.
   - If new commits exist after the newest review (or if the PR has no prior automated reviews), proceed with the review. When re-reviewing after new commits, state that the review evaluates the delta since the previous review.
3. Fetch only the non-CircleCI status checks Step 2 needs (Snyk). **CircleCI's status is
   deliberately NOT fetched here** — it stays unread until Step 4, strictly after the initial
   post, so post #1's verdict can never be influenced by it:
   ```sh
   gh pr checks <pr-num> --repo WebJamApps/<Repo> --json name,state,link \
     --jq '.[] | select(.name | test("snyk"; "i"))'
   ```
   *(Note: A non-zero exit from `gh pr checks`, such as exit code 8 when other checks on the PR are pending, is expected and carries no CircleCI verdict — treat empty output as "no Snyk check" and move on.)*
4. Fetch the PR diff:
   ```sh
   gh pr diff <pr-num> --repo WebJamApps/<Repo>
   ```
5. If the PR references a GitHub issue (e.g., `Closes #N` or `Part of #N`), fetch the issue description and acceptance criteria:
   ```sh
   gh issue view <issue-num> --repo WebJamApps/<Repo>
   ```

### Step 2: Audit Checklist

Review the PR diff, description, mergeability, and non-CircleCI status checks (Snyk, etc.) against these mandatory audit criteria.

**Audit Execution Order**: Perform the code, diff, and architectural audits (merge conflicts, Snyk, scope, semver bump, package-lock, test plan, architectural judgment items, guardrails). CircleCI gates nothing here — it is not checked, waited on, or polled anywhere in Step 2. Post the resulting content-only review immediately via Step 3. CircleCI is evaluated strictly afterward, in Step 4 ("CircleCI Resolution"), which runs only once Step 3's initial post is live.

1. **Merge Conflicts (Must Fix)**:
   - Check `mergeable` status and `mergeStateStatus` from Step 1.
   - If the PR has merge conflicts with the base branch (`dev` / `main`), report it as a **Must Fix** item requiring a rebase or conflict resolution before merging.

2. **CircleCI & Automated Build Health (Deferred to Step 4 — Not Evaluated Pre-Post)**:
   - CircleCI is **not inspected, checked, or waited on here.** It is removed from Step 2's
     pre-post evaluation entirely and moved to Step 4 ("CircleCI Resolution"), which runs strictly
     after Step 3's initial content-only review post. See Step 4 for how CircleCI's
     pending/passing/failing states are checked and reported, and for the two follow-up posts that
     carry its result.
   - CircleCI natively executes mechanical static analysis gates across repositories (and as per-repo tooling rollouts land):
     - Code duplication (`jscpd` with `threshold: 5`)
     - Code complexity (`eslint-plugin-sonarjs`)
     - Code quality & plugin linters (`unicorn`, `promise`, `security`, `react-hooks`, `jsx-a11y-x`, `import-x`)
     - Code formatting & syntax (`deno task fmt:check`, `npm run lint`)
     - Unit test suites & coverage thresholds (`deno task test`, `npm test`)
   - **Non-Redundancy Principle**: Because mechanical static checks are enforced directly in CircleCI (where configured), `pr-review` **never duplicates or re-audits static linter rules, complexity metrics, formatting styles, or duplication percentages in review prose** — this applies no less to Step 4's follow-up posts than it does here.

3. **Snyk Security Audits (Must Fix)**:
   - Inspect the Snyk-scoped status checks fetched in Step 1 item 3 for Snyk security failures (`security/snyk`, `snyk-code`, etc.). Do not broaden that fetch to all checks — CircleCI stays unread until Step 4.
   - If Snyk security checks fail, report the failure as a **Must Fix** item. Note: If Snyk reports are inaccessible locally due to API limits or auth, ask the author/Josh for the exact Snyk failure details and vulnerability IDs per AGENTS.md guidelines.

4. **Issue Acceptance Criteria & Scope**:
   - Does the diff fulfill all requirements and acceptance criteria stated in the linked issue?
   - Is the PR tightly scoped to the issue task? Are there any out-of-scope files, unintended refactors, or stray code additions?
   - **Exception — `AGENTS.md` updates are never a scope violation.** A `/learn`-sourced change to
     `AGENTS.md` (an agent folding in a lesson or guardrail it picked up while doing the PR's actual
     work) is standing cross-cutting instruction content, not scope creep — it has no natural issue
     of its own to belong to, and routing every such tweak through a separate PR would suppress the
     mechanism by which agents correct their own guidance. Do not raise a Must Fix (or any) finding
     over an `AGENTS.md` diff being unrelated to the PR's linked issue. Still review the content on
     its own merits — it must not contradict or duplicate existing `AGENTS.md`/`docs/cross-ai-rules.md`
     text (flag that as a normal correctness finding if it does).

5. **Single Semver Version Bump per PR**:
   - Check `package.json` (or `deno.json` for `web-jam-tools`).
   - The version must be bumped on the PR's first commit and must strictly exceed the current `origin/dev` tip (matching `.circleci/config.yml:127`, "Version bump check (PR branches only)", with the strictly-greater comparison at lines 130-160).
   - **Must Fix**: a version that fails to strictly exceed the `origin/dev` tip. CircleCI's version-bump gate genuinely fails on this, so the PR cannot merge as it stands.
   - **Suggestion, not Must Fix**: a follow-up commit that re-bumps the version when `dev` did not move (a gratuitous double bump). The re-bump still strictly exceeds the floor, so CircleCI's gate passes and nothing blocks the merge — it is untidy, not blocking.
   - **Exception — re-bumping when `dev` advances**: If `origin/dev` advances to or past the PR's version after the PR's first commit, re-bumping in a follow-up commit to clear the new `origin/dev` tip is required and explicitly correct — do NOT flag this as a finding.

6. **Package-Lock Engine Alignment**:
   - When bumping Node.js version in `package.json` `engines`, verify `package-lock.json` root engine definition was updated using `npm install --package-lock-only --ignore-scripts` (or `npm install --ignore-scripts`) so both files stay in sync without running unverified postinstall scripts.

7. **Test Plan Integrity**:
   - **Test evidence is OPTIONAL, and pasted suite logs are not wanted.**
     `scripts/create-draft-pr.sh` treats `--test-evidence` as optional by design — unit-test
     runner output in a PR body is noise to the reviewer it is meant to inform. **Never raise a
     finding because the "Test evidence" section is absent, thin, or omits suite numbers**, and
     never ask an author to paste `deno task test` / `npm test` output. Whether the suites actually
     ran and passed is CircleCI's job, confirmed in Step 4 (after the initial post) — this item
     only audits that the `--test-plan` narration itself is concrete, not whether CI has run yet.
   - If a Test evidence block *is* present it must not be fabricated, but a missing or partial one
     is not a defect and must not be reported as one.
   - Inspect the `--test-plan` section. It must contain concrete steps exercising the change itself (UI manual steps, runnable `curl` commands, or tooling commands), not just suite invocations like `npm test` or `deno task test` (web-jam-tools#152).

8. **Architectural Judgment Audits (Non-Redundant)**:
   Focus review scrutiny on high-leverage architectural judgment calls:
   - **Exported API Contract Drift**: Verify that modified public function signatures, route payloads, endpoint handlers, or exported types update all callers across the codebase.
   - **Backward Compatibility & Expand-Contract**: Ensure database schema updates (Mongoose/MongoDB), GraphQL mutations, and backend API changes remain additive and non-breaking before frontend consumers deploy.
   - **Secret Literal Safety**: Inspect diffs for hardcoded tokens, API keys, webhook secrets, private URLs, or unscrubbed credentials.
   - **Playwright E2E Test Suggestions (Suggest-Only)**: When a diff introduces new user-facing UI components, client routes, or interactive forms lacking end-to-end coverage, suggest adding a Playwright test under `### 🟡 Suggestions`. The reviewer **never** creates, adds, or modifies test files itself; suggested tests must provide runnable local (`npm run test:e2e`) and CI verification steps.

9. **AGENTS.md Guardrails Audit**:
   - **TypeScript / Code Standards**:
     - No raw `any` types allowed in new or modified TypeScript code.
   - **Form Required Asterisks (`*`)**:
     - Never allow a required field asterisk (`*`) to wrap alone onto a new line. The trailing word and asterisk MUST be wrapped together in a `white-space: nowrap` container (e.g. `<span style={{ whiteSpace: "nowrap" }}>word <span className="required-star">*</span></span>` or `.no-wrap-text`).
   - **Mobile Floating Utility Buttons**:
     - Floating admin/utility buttons must be tiny (e.g., 24px circular icon), have low default opacity (0.25), and be pinned in viewport side margins (e.g., `right: 0.25rem`) on mobile viewports (<= 600px) so they do not obstruct main content.
   - **Mobile Google OAuth Direct Redirect**:
     - Mobile login buttons (width <= 600px) must invoke `loginWithGoogle()` directly on first click rather than directing the user to an intermediate modal.
   - **Footer Logo Inline Alignment**:
     - Inline logo SVG and brand heading in footer must be wrapped in flex container (`display: flex; align-items: flex-start; gap: 0.75rem;`) with `margin-top: -1px; flex-shrink: 0;` on `.footer-logo-icon`.
   - **Cloudflare Pages Headers**:
     - For Vite SPA projects, verify `public/_headers` sets `Cache-Control: no-cache, no-store, must-revalidate` for `/*` and `Cache-Control: public, max-age=31536000, immutable` for `/assets/*`.
   - **Setlist API Mongoose Filtering**:
     - `sort` parameter must be stripped from `req.query` before passing the filter object to Mongoose `Schema.find(filter)`.

10. **Draft / Ready State (Never a Finding)**:
    - A PR's draft or ready-for-review state is Josh's own action on his own PR, not a
      property of the work under review — he moves PRs in and out of draft himself as part of
      his workflow. **Never report it as a finding, of any severity — not a Must Fix, not a
      Suggestion — whether the PR is currently a draft or was created as a draft and
      later marked ready.**

11. **Issue Body & PR Body Prose (Never a Must Fix)**:
    - Prose in a linked issue's body — including its Non-goals section, its acceptance
      criteria wording, or its "Files changed" list — and prose in the PR's own description —
      including its Summary and its "How to test locally" / test-plan narration — is **never**
      a Must Fix item. Not when it is stale, not when it is incomplete, not when it
      contradicts what the PR actually built, and not when it describes a superseded design.
    - Reason: Must Fix means *this cannot merge as it stands* — it is reserved for a failing
      CircleCI check, a failing Snyk check, a merge conflict with the base branch, and defects
      in the code being merged. A description that has drifted from its diff does not stop the
      code from being correct and does not stop the merge.
    - Such a drift may still be raised, but only under `### 🟡 Suggestions`.
    - This is a deliberate carve-out from "A found defect is fixed before merge — never
      deferred" below: that section's "if it is wrong, it is Must Fix or it is not a finding
      at all" binary governs defects in the artifact being merged (the code/diff itself);
      issue-body and PR-body description prose is outside that binary's scope.

### Step 3: Post Review Feedback (Initial, Content-Only Post)

**The three posts, in order** (this step, Step 3, produces post #1 only; Step 4 produces posts #2
and #3, strictly after post #1 is live — this list and Step 4 always agree with each other):

1. **Initial review (content only)** — this step, via `deno task post-pr-review`. Posted
   immediately after Step 2 finishes, before CircleCI is checked at all. Its verdict reflects only
   the non-CircleCI findings from Step 2 and never carries a CircleCI row or state.
2. **Results-again follow-up** — Step 4a, via `deno task post-pr-comment`. Restates post #1's
   Checklist Verification **as amended** (any row whose status changed, or any finding resolved,
   between the two posts reflects reality at post-#2 time, not a stale copy of post #1), now with
   a `**CircleCI**` row filled in (✅ passing, or 🛑 failing/still-pending with the detail added as
   a new Must Fix line).
3. **Verdict-only follow-up** — Step 4b, via `deno task post-pr-comment`. Carries only the final
   verdict line, now accounting for CircleCI's result alongside everything from post #1.

This step (Step 3) never checks, waits on, or references CircleCI — that is Step 4's job, strictly
afterward.

1. Synthesize review findings into a structured review comment using severity icons so merge blockers and check statuses are immediately recognizable without reading full prose.
2. Format feedback with clear section headers and severity icons:
   - **PR Review Summary**: Overall status — one of two verdict states, based only on the
     non-CircleCI findings from Step 2 (merge conflicts, Snyk, scope, semver bump, package-lock,
     test plan, architectural judgment, guardrails):
     - `**✅ Approved**` (clean diff, no Must Fix items found in Step 2)
     - `**🛑 Changes Requested**` (any Must Fix item found in Step 2, or a blocking defect exists)
   - **Icon meaning**: A 🛑 icon marks an unresolved problem that blocks merge, and nothing else. Narration, context, notes on which commits arrived, and a previously-reported finding that has since been fixed never carry 🛑 — a fixed finding is reported with ✅ (see "Changes Since Last Review" below), because it is no longer a problem.
   - **Must Fix Items** (`### 🛑 Must Fix Items`): List only unresolved problems that block merge — Snyk security failures, merge conflicts, or blocking bugs still present in the reviewed commit. This initial post never includes CircleCI here; a CircleCI failure (or unresolved-at-cap status) surfaces as a new Must Fix line added by Step 4a's results-again follow-up, once CircleCI resolves or its poll cap is hit (either surface). Prefix each individual must-fix finding line with 🛑. If none, render `### Must Fix Items` with `✅ None` (never render a stop sign for an empty Must Fix section). **Nothing but Must Fix items may appear between the `**🛑 Changes Requested**` verdict line and this heading** — no narration, no delta summary, no commit notes.
   - **Changes Since Last Review** (`### Changes Since Last Review`, re-review only): When this run evaluates what changed since the last review, that narration — including which commits arrived and which previously-reported findings are now fixed — goes in this section, **placed after `### 🛑 Must Fix Items`**, never before it. A finding fixed since the last review is reported here with ✅ (e.g. `✅ Fixed: <what was wrong> — <how it was resolved>`), never as a bullet under the red verdict. Omit this section on a first-pass review with no prior automated review to diff against.
   - **Checklist Verification**: Status of mergeability, Snyk audits, scope, semver bump, package-lock engine alignment, test plan, architectural audits, and guardrails. The initial post never carries a CircleCI row — that row is added by Step 4a's results-again follow-up once CircleCI resolves. Place the severity icon (✅ or 🛑) immediately after the bold check label and colon on each line (e.g. `- **Mergeability**: ✅ ...`, `- **Snyk**: ✅ ...`).
   - **Suggestions** (`### 🟡 Suggestions`): Specific code references or line numbers where concrete code-quality or design improvements are suggested. Prefix each suggestion line with 🟡. If none, render `### Suggestions` with `✅ None`.
     - **Exclusion of Process & Git Mechanics Trivia**: This section is strictly for code-relevant improvement suggestions tied directly to the diff under review. It **never** carries process/mechanics trivia, speculative workflow commentary, or git/semver heads-ups that are not defects in the PR itself.
       - **Never post cross-PR version-bump collision warnings** (e.g. noting that another open PR shares the same semver target and might merge first) or git workflow lectures — those describe another PR's state, not a defect in the diff under review.
       - A gratuitous double version bump made *within the PR under review* is different: Step 2 item 5 evaluates that PR's own commits and reports such a bump as a Suggestion, so it belongs in this section as a real, permitted finding.
       - A version that fails to strictly exceed `origin/dev` at review time is the other case Step 2 item 5 covers, and that one is caught deterministically as a Must Fix, not a Suggestion.

   **Example — initial post (post #1), re-review with one remaining blocker and two now-fixed
   findings.** Note that the only thing between the verdict line and `### 🛑 Must Fix Items` is the
   heading itself, that `### Changes Since Last Review` sits after the Must Fix section, not before
   it, and that no row here mentions CircleCI — this post is content-only:

   ````md
   ## PR Review Summary
   **🛑 Changes Requested**

   ### 🛑 Must Fix Items
   - 🛑 Version bump — `deno.json`'s version does not strictly exceed `origin/dev`'s current tip (Step 2 item 5).

   ### Changes Since Last Review
   - ✅ Fixed: the missing unit test for `handleHttpReq` — added in `test/uptime.test.ts`.
   - ✅ Fixed: the stale Non-goals bullet in the linked issue — no longer reportable as a finding of any kind per Step 2 item 11.

   ### Checklist Verification
   - **Mergeability**: ✅ No conflicts with `dev`.
   - **Semver Bump**: 🛑 `deno.json` version does not strictly exceed `origin/dev` (see Must Fix Items).
   - **Snyk**: ✅ Clean.
   - **Scope**: ✅ Matches linked issue.

   ### 🟡 Suggestions
   ✅ None
   ````

   **Example — Step 4's two follow-ups for the same PR, once CircleCI resolves failing.** Post #2
   restates the checklist with the new CircleCI row and its Must Fix line; post #3 carries only the
   updated verdict:

   ````md
   <!-- post #2 (Step 4a, results-again) via deno task post-pr-comment -->
   ## PR Review Summary
   **🛑 Changes Requested**

   ### 🛑 Must Fix Items
   - 🛑 Version bump — `deno.json`'s version does not strictly exceed `origin/dev`'s current tip (Step 2 item 5).
   - 🛑 CircleCI "Format check" is failing — `deno fmt --check` found unformatted files in `src/uptime/cron.ts`.

   ### Checklist Verification
   - **Mergeability**: ✅ No conflicts with `dev`.
   - **Semver Bump**: 🛑 `deno.json` version does not strictly exceed `origin/dev` (see Must Fix Items).
   - **CircleCI**: 🛑 Format check failing (see Must Fix Items).
   - **Snyk**: ✅ Clean.
   - **Scope**: ✅ Matches linked issue.

   ### 🟡 Suggestions
   ✅ None
   ````

   ````md
   <!-- post #3 (Step 4b, verdict-only) via deno task post-pr-comment -->
   ## PR Review Summary
   **🛑 Changes Requested**
   ````
3. Write the finished review body to a scratch file (e.g. `/tmp/pr-review-<Repo>-<pr-num>.md` — never inside the repo, per AGENTS.md convention), then post it with the guarded command — the only route to `gh pr review` on either agent surface (web-jam-tools#685):
   ```sh
   deno task post-pr-review --repo <Owner/Repo> --pr <pr-num> --body-file <scratch_review_file>
   ```
   *(Note: Review comments provide feedback for the PR author and Josh. Final PR merge remains under Josh's approval.)*

   **This works identically whether the skill is running as the top-level session or as an
   Agent-tool-dispatched subagent — no scratch-file handoff back to the orchestrating session is
   needed or correct anymore.** The earlier version of this step asked a dispatched subagent to
   write the file and report its path back, on the theory that subagents run in an independent
   permission context that never inherits `permissions.allow`. That theory was wrong (verified
   2026-08-22): `gh pr review` was never in `permissions.allow` at all — it sits under
   `permissions.ask`, and an `ask` prompt with no human present to answer it is what actually
   dead-ended, no inheritance question involved. `deno task post-pr-review` sidesteps that dead end
   two ways: it is itself a named `permissions.allow` capability (`scripts/install-hooks.sh`'s
   `ALLOW_RULES`), so the Bash tool call that invokes it needs no prompt; and the `gh pr review`
   subprocess it runs internally never becomes a separate Bash tool call, so the `ask` rule that
   gates the raw verb never sees it. `hooks/block-raw-gh-write.sh` (`PreToolUse`, both surfaces)
   denies anyone — human or agent — who tries to run the raw verb directly instead, so this guarded
   command is the only path left regardless of who is running the skill.

   The command itself refuses an empty body, a body carrying a credential-shaped literal, and a
   review body with no `## PR Review Summary` header, and skips posting outright (no double-post,
   exit 0) when the PR already carries an automated review at the current head SHA — see
   `scripts/gh-write/guard.ts`. A transient network failure (e.g. an `i/o timeout` against the
   GitHub API, the actual failure mode measured posting a review to
   `WebJamApps/JaMmusic#1324 "Remove the localhost:7000 BackendUrl default and hardcoded credentials
   from vite.config.ts"` on 2026-08-20) is retried automatically rather than surfaced on the first
   attempt.

   If the command itself reports a real failure (not the already-reviewed skip, which is success),
   fix the underlying problem and re-run it — there is no fallback path to hand off to a different
   session.

### Step 4: CircleCI Resolution

Runs strictly after Step 3's initial post (post #1) is live — never before it, never interleaved
with it. This step produces posts #2 and #3.

1. **Check CircleCI status once**:
   ```sh
   gh pr checks <pr-num> --repo WebJamApps/<Repo>
   ```
2. **Already resolved (pass or fail) at this check**: skip polling entirely — proceed to item 4
   below with whatever this single check returned.
3. **Still pending**: poll for resolution, per agent surface. **Both surfaces' polls are bounded
   and terminate with the same outcome — "still pending, treat as blocking" — if CircleCI never
   resolves in time; neither surface polls forever:**
   - **Claude Code**: use the `ScheduleWakeup` tool to re-check at intervals — never a blocking
     Bash `sleep` loop (a blocking sleep loop is the exact pattern this step replaces — see
     web-jam-tools#782 "pr-review skill has no defined behavior for a pending CircleCI check, so
     review sessions improvise polling loops"). Pick a delay matched to how fast CircleCI state
     actually changes (a full run is minutes, not seconds); re-run `gh pr checks` each time
     `ScheduleWakeup` fires. **Cap total polling at ~30 minutes** (in line with typical CircleCI
     job run times) — if CircleCI still has not resolved by then, stop scheduling further
     wakeups, report "CircleCI still pending after N minutes", and proceed to item 4 below with
     CircleCI unresolved. This cap bounds `ScheduleWakeup` re-checks only; it is not a licence to
     fall back to a blocking Bash sleep loop.
   - **Antigravity/agy**: agy has no confirmed equivalent to `ScheduleWakeup`. Fall back to a
     bounded check-then-sleep loop: check every ~60 seconds, capped at ~15 minutes total, then
     report "CircleCI still pending after N minutes" and stop rather than looping forever.
     **This fallback is an unverified best guess, not a confirmed agy capability** — flag it for
     correction if agy turns out to have a native scheduling equivalent, and prefer that instead
     once confirmed.
4. **Once CircleCI resolves, or its poll cap is hit (Claude Code's ~30-minute `ScheduleWakeup`
   cap, or agy's ~15-minute check-then-sleep cap — whichever surface is running), post exactly two
   follow-ups**, both via `deno task post-pr-comment` — never `deno task post-pr-review` again for
   this PR (see item 5 below):
   a. **Results-again (post #2)**: write a scratch file (e.g.
      `/tmp/pr-review-<Repo>-<pr-num>-results.md` — never inside the repo, per AGENTS.md
      convention) restating post #1's Checklist Verification **as amended** — any row whose status
      changed, or any finding resolved, between post #1 and now reflects reality at post-#2 time,
      not a verbatim copy of the stale post #1 — now with a `**CircleCI**` row added:
      - `✅ Passing` if CircleCI resolved green.
      - `🛑 Failing: <failure detail>` if it resolved red — also add a matching `🛑` line under
        `### 🛑 Must Fix Items`.
      - `🛑 Still pending after N minutes — could not confirm passing status, verify manually
        before merge` if the poll cap was hit (either surface) with CircleCI still unresolved —
        also add a matching `🛑` line under `### 🛑 Must Fix Items` (an unresolved CI status is
        treated as blocking, never as silently passing).
      ```sh
      deno task post-pr-comment --repo <Owner/Repo> --pr <pr-num> --body-file <scratch_results_file>
      ```
   b. **Verdict-only (post #3)**: write a second scratch file (e.g.
      `/tmp/pr-review-<Repo>-<pr-num>-verdict.md`) carrying only the `## PR Review Summary` header and final verdict line:
      - `## PR Review Summary\n**✅ Approved**` — CircleCI resolved passing and no other Must Fix item remains.
      - `## PR Review Summary\n**🛑 Changes Requested**` — CircleCI resolved failing, CircleCI is still unresolved at the
        poll cap (either surface), or any other Must Fix item is present.
      ```sh
      deno task post-pr-comment --repo <Owner/Repo> --pr <pr-num> --body-file <scratch_verdict_file>
      ```
5. **`deno task post-pr-review` is never called a second time for the same PR.** Its guard
   (`scripts/gh-write/guard.ts`) skips posting a second review at the same head SHA (no
   double-post, exit 0), so a second `post-pr-review` call would silently no-op. Both follow-ups
   above go through `scripts/post-pr-comment.ts` instead, which carries no same-SHA guard and is
   built for exactly this repeat-posting case.

### A found defect is fixed before merge — never deferred

**"Fix it later", "merge anyway", "not a blocker, ship it" and "we can follow up in another issue" are NOT available outcomes of a review.** A defect the review found is a defect the review is responsible for getting fixed while the PR is still open — that is the entire point of reviewing before merge rather than after.

This binds the reviewing model AND the session relaying the review to Josh:

- **Never recommend merging a PR with a known unfixed defect in the code or artifact being merged**, however small, and never soften a real finding into a "nice to have" so that it can be waved through. If it is wrong, it is Must Fix or it is not a finding at all. This binary applies to defects in the code/artifact being merged, with two named exceptions — not a precedence rule, since each is a distinct case the binary was never meant to cover: issue-body or PR-body description prose is never a Must Fix, handled instead under Step 2's item 11 ("Issue Body & PR Body Prose (Never a Must Fix)"); and a gratuitous double version bump made within the PR under review is a Suggestion, not a Must Fix, per Step 2 item 5 — because CircleCI's version-bump gate still passes, it is untidy rather than merge-blocking, so reporting it as a Suggestion does not violate "Must Fix or not a finding at all."
- **Never propose a follow-up issue as the answer to a defect found in the PR under review.** A new issue is where NEW work goes, not where this PR's known problems are parked.
- **A defect in the artifact being merged is fixed in THAT PR**, not in a later one — including when the artifact is a skill, a doc, or a rule rather than code.
- Size is not a reason to defer. "One line" and "no behavioural effect" are arguments for fixing it now, because it is cheap, not for postponing it.

The reviewing model reports; it does not apply the fix itself. It names the defect, says plainly that it blocks merge, and the fix goes back to the PR's own lane on the PR's own branch.
