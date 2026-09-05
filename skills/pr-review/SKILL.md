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
   - **Record `head_sha`** from the query above (e.g. as `HEAD_SHA`) — this is the commit the diff
     fetched in item 4 below reflects, and every finding in this review is composed against it.
     Step 3 passes this same value back to `deno task post-pr-review --head-sha` (web-jam-tools#825)
     so that if the branch is force-pushed between now and the post landing, the guard refuses to
     post a review that no longer matches the head instead of silently stamping stale findings onto
     the new commit.
3. Fetch only the non-CircleCI status checks Step 2 needs (Snyk). **CircleCI's status is
   deliberately NOT fetched here** — it stays unread until Step 4, strictly after the initial
   post, so post #1's verdict can never be influenced by it:
   ```sh
   gh pr checks <pr-num> --repo WebJamApps/<Repo> --json name,state,link \
     --jq '.[] | select(.name | test("snyk"; "i"))'
   ```
   *(Note: A non-zero exit from `gh pr checks`, such as exit code 8 when other checks on the PR are pending, is expected and carries no CircleCI verdict — treat empty output as "no Snyk check" and move on.)*
4. Fetch the PR diff — this command always returns the diff against the PR's *live* head, taking
   no SHA argument, so it reflects `HEAD_SHA` recorded in item 2 above only as long as the branch
   hasn't moved since; if it has, the Step 3 refusal (via `post-pr-review --head-sha`) catches the
   mismatch rather than silently posting findings composed against a commit that's no longer current:
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
     pending/passing/failing states are checked and reported, and for the single follow-up post
     that carries its result — posted only when CircleCI does not pass.
   - CircleCI natively executes mechanical static analysis gates across repositories (and as per-repo tooling rollouts land):
     - Code duplication (`jscpd` with `threshold: 5`)
     - Code complexity (`eslint-plugin-sonarjs`)
     - Code quality & plugin linters (`unicorn`, `promise`, `security`, `react-hooks`, `jsx-a11y-x`, `import-x`)
     - Code formatting & syntax (`deno task fmt:check`, `npm run lint`)
     - Unit test suites & coverage thresholds (`deno task test`, `npm test`)
   - **Non-Redundancy Principle**: Because mechanical static checks are enforced directly in CircleCI (where configured), `pr-review` **never duplicates or re-audits static linter rules, complexity metrics, formatting styles, or duplication percentages in review prose** — this applies no less to Step 4's follow-up post than it does here.

3. **Snyk Security Audits (Must Fix)**:
   - Inspect the Snyk-scoped status checks fetched in Step 1 item 3 for Snyk security failures (`security/snyk`, `snyk-code`, etc.). Do not broaden that fetch to all checks — CircleCI stays unread until Step 4.
   - If Snyk security checks fail, report the failure as a **Must Fix** item. Note: If Snyk reports are inaccessible locally due to API limits or auth, ask the author/Josh for the exact Snyk failure details and vulnerability IDs per AGENTS.md guidelines.

4. **Issue Acceptance Criteria & Scope**:
   - Does the diff fulfill all requirements and acceptance criteria stated in the linked issue?
   - Is the PR tightly scoped to the issue task? Are there any out-of-scope files, unintended refactors, or stray code additions?
   - **Exception — `AGENTS.md` and `docs/cross-ai-rules.md` updates are never a scope violation.** Rule,
     lesson, and guardrail updates to `AGENTS.md` or `docs/cross-ai-rules.md` (whether learned
     interactively during task work or sourced from `/learn` on Antigravity sessions) are standing
     cross-cutting instruction content, not scope creep — they have no natural issue of their own to
     belong to, and routing every such tweak through a separate PR would suppress the mechanism by
     which agents correct their own guidance. Note: `/learn` is a Google Antigravity-native command;
     Claude Code (Sonnet) sessions do not have `/learn` and update memory/rules directly. Do not
     raise a Must Fix (or any) finding over an `AGENTS.md` / `docs/cross-ai-rules.md` diff being
     unrelated to the PR's linked issue, and never expect or flag a missing `/learn` invocation in
     reviews. Still review the instruction content on its own merits — it must be purely additive and
     must not contradict or duplicate existing `AGENTS.md`/`docs/cross-ai-rules.md` text (flag that
     as a normal correctness finding if it does).

5. **Single Semver Version Bump per PR**:
   - Check `package.json` (or `deno.json` for `web-jam-tools`).
   - The version must be bumped on the PR's first commit and must strictly exceed the current `origin/dev` tip (matching `.circleci/config.yml:127`, "Version bump check (PR branches only)", with the strictly-greater comparison at lines 130-160).
   - **Suggestion, not Must Fix**: any version-bump irregularity within the PR under review — a
     version that fails to strictly exceed the `origin/dev` tip (mechanical drift from `dev` moving
     under an open PR, not a defect the author introduced), or a follow-up commit that re-bumps the
     version when `dev` did not move (a gratuitous double bump). CircleCI's version-bump gate
     genuinely fails on a stale version and keeps the merge blocked deterministically — that gate,
     not the review's judgment, is what enforces it, so the review reports it as a Suggestion rather
     than wearing a 🛑 for something CI already reports and a rebase already clears.
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
      Suggestion, not a Nit — whether the PR is currently a draft or was created as a draft and
      later marked ready.**

11. **Issue Body & PR Body Prose (Never a Must Fix)**:
    - Prose in a linked issue's body — including its Non-goals section, its acceptance
      criteria wording, or its "Files changed" list — and prose in the PR's own description —
      including its Summary and its "How to test locally" / test-plan narration — is **never**
      a Must Fix item. Not when it is stale, not when it is incomplete, not when it
      contradicts what the PR actually built, and not when it describes a superseded design.
    - Reason: Must Fix means *this cannot merge as it stands* — it is reserved for a failing
      CircleCI check (other than `Version bump check (PR branches only)`, which
      Step 4 item 5's carve-out reports as a Suggestion instead), a failing Snyk check, a merge
      conflict with the base branch, and defects in the code being merged. A description that
      has drifted from its diff does not stop the
      code from being correct and does not stop the merge.
    - Such a drift may still be raised, but only under `### 🔵 Nits`. It never belongs under
      `### 🟡 Suggestions`, which is reserved for findings about the code in the diff — see
      Step 3 item 2's `### 🔵 Nits` definition.
    - This is a deliberate carve-out from "A found defect is fixed before merge — never
      deferred" below: that section's "if it is wrong, it is Must Fix or it is not a finding
      at all" binary governs defects in the artifact being merged (the code/diff itself);
      issue-body and PR-body description prose is outside that binary's scope.

### Step 3: Post Review Feedback (Initial, Content-Only Post)

**The posts, in order** (this step, Step 3, always produces post #1; Step 4 produces post #2 only
when CircleCI does not pass, strictly after post #1 is live — this list and Step 4 always agree
with each other):

1. **Initial review (content only)** — this step, via `deno task post-pr-review`. Posted
   immediately after Step 2 finishes, before CircleCI is checked at all. Its verdict reflects only
   the non-CircleCI findings from Step 2 and never carries a CircleCI row or state.
2. **CircleCI-failure follow-up** — Step 4, via `deno task post-pr-comment`, and **only when
   CircleCI resolves failing, or is still unresolved once its poll cap is hit**. It carries only
   what is new: the `## PR Review Summary` header, the updated verdict line, and the CircleCI
   result — a new Must Fix line naming the failing job and its detail, except for
   `Version bump check (PR branches only)`, which Step 4 item 5's carve-out always reports
   as a Suggestions line instead. It **never** reprints post #1's Checklist Verification, its
   other Must Fix items, its Suggestions, or its Nits — post #1 already carried all of that, and
   repeating it is the waste this shape exists to prevent.

**`### 🔵 Nits` never appears in a Step 4 follow-up post.** Nits hold PR/issue-body prose findings,
which are found in Step 2 and carried entirely by post #1. Step 4's follow-up carries only the
CircleCI result, and a CircleCI job result is never body prose, so Step 4 has no Nit of its own to
report and never restates post #1's. That is why the two-item list above, and Step 4 item 5's
"carry only" list, name Must Fix and Suggestions and stop there.

**When CircleCI passes there is no second post at all.** The review is complete at one comment, and
post #1's verdict stands as the final verdict.

This step (Step 3) never checks, waits on, or references CircleCI — that is Step 4's job, strictly
afterward.

1. Synthesize review findings into a structured review comment using severity icons so merge blockers and check statuses are immediately recognizable without reading full prose.
2. Format feedback with clear section headers and severity icons:
   - **PR Review Summary**: Overall status — one of two verdict states, based only on the
     non-CircleCI findings from Step 2 (merge conflicts, Snyk, scope, semver bump, package-lock,
     test plan, architectural judgment, guardrails):
     - `**✅ Approved**` (clean diff, no Must Fix items found in Step 2)
     - `**🛑 Changes Requested**` (any Must Fix item found in Step 2, or a blocking defect exists)
     - A version-bump finding (Step 2 item 5) is always a Suggestion, never a Must Fix — this
       classification does not depend on whether it is the only finding.
       The verdict is a separate question: it stays green on the strength of this finding alone
       only when the version-bump finding is the sole finding; it never by itself produces
       `**🛑 Changes Requested**`, in this post or in Step 4's follow-up.
     - A PR/issue-body prose finding (Step 2 item 11) is always a Nit — never a Must Fix and never
       a Suggestion. Like a version-bump finding it never by itself produces
       `**🛑 Changes Requested**`, and a post whose only findings are Nits carries
       `**✅ Approved**`.
   - **Icon meaning**: A 🛑 icon marks an unresolved problem that blocks merge, and nothing else. Narration, context, notes on which commits arrived, and a previously-reported finding that has since been fixed never carry 🛑 — a fixed finding is reported with ✅ (see "Changes Since Last Review" below), because it is no longer a problem. A 🟡 icon marks a non-blocking finding about the artifact being merged; a 🔵 icon marks a cosmetic PR/issue-body prose nit, which never blocks merge either.
   - **Must Fix Items** (`### 🛑 Must Fix Items`): List only unresolved problems that block merge — Snyk security failures, merge conflicts, or blocking bugs still present in the reviewed commit. This initial post never includes CircleCI here; a CircleCI failure (or unresolved-at-cap status) surfaces as a new Must Fix line in Step 4's failure follow-up, posted only when CircleCI does not pass. Prefix each individual must-fix finding line with 🛑. If none, render `### Must Fix Items` with `✅ None` (never render a stop sign for an empty Must Fix section). **Nothing but Must Fix items may appear between the `**🛑 Changes Requested**` verdict line and this heading** — no narration, no delta summary, no commit notes.
     - Exception: `Version bump check (PR branches only)` failing (or unresolved) is never listed here — Step 4 item 5's carve-out reports it under Suggestions instead of under `### 🛑 Must Fix Items`, whether it fails alone or alongside another job.
   - **Changes Since Last Review** (`### Changes Since Last Review`, re-review only): When this run evaluates what changed since the last review, that narration — including which commits arrived and which previously-reported findings are now fixed — goes in this section, **placed after `### 🛑 Must Fix Items`**, never before it. A finding fixed since the last review is reported here with ✅ (e.g. `✅ Fixed: <what was wrong> — <how it was resolved>`), never as a bullet under the red verdict. Omit this section on a first-pass review with no prior automated review to diff against.
   - **Checklist Verification**: Status of mergeability, Snyk audits, scope, semver bump, package-lock engine alignment, test plan, architectural audits, and guardrails. The initial post never carries a CircleCI row, and no later post ever restates this checklist — when CircleCI fails, Step 4's follow-up reports that failure alone rather than reprinting these rows. Place the severity icon (✅ or 🛑) immediately after the bold check label and colon on each line (e.g. `- **Mergeability**: ✅ ...`, `- **Snyk**: ✅ ...`).
     The **Semver Bump** row is the one exception to that icon pairing: since a version-bump finding is a Suggestion, not a Must Fix (Step 2 item 5), that row is prefixed 🟡 whenever the version has fallen behind `origin/dev` or was gratuitously double-bumped, and prefixed ✅ otherwise — it is never prefixed with the Must-Fix stop-sign icon.
   - **Suggestions** (`### 🟡 Suggestions`): Specific code references or line numbers where concrete code-quality or design improvements are suggested — findings about the artifact being merged (the diff itself, including its version field). Prefix each suggestion line with 🟡. If none, render `### Suggestions` with `✅ None`.
     - **Exclusion of PR/Issue-Body Prose**: A finding about the wording of the PR's own description or a linked issue's body — the Step 2 item 11 class — is **never** a Suggestion. It goes under `### 🔵 Nits` below, so a reader can tell at a glance that fixing it means editing a description, not pushing a commit. Everything the Step 2 item 5 version-bump carve-out and the Step 2 item 8 Playwright E2E coverage suggestion produce stays here under Suggestions: both are findings about the artifact being merged, not about prose.
     - **Exclusion of Process & Git Mechanics Trivia**: This section is strictly for code-relevant improvement suggestions tied directly to the diff under review. It **never** carries process/mechanics trivia, speculative workflow commentary, or git/semver heads-ups that are not defects in the PR itself.
       - **Never post cross-PR version-bump collision warnings** (e.g. noting that another open PR shares the same semver target and might merge first) or git workflow lectures — those describe another PR's state, not a defect in the diff under review.
       - These trivia items are **dropped, not redirected** — they go unreported everywhere, under Suggestions and under Nits alike. Nits is not an overflow bin for what this exclusion removes; it holds the Step 2 item 11 body-prose class and nothing else.
       - A version-bump irregularity found *within the PR under review* is different: Step 2 item 5 evaluates that PR's own commits and reports both a gratuitous double bump and a version that fails to strictly exceed `origin/dev` as a Suggestion, so either belongs in this section as a real, permitted finding.
   - **Nits** (`### 🔵 Nits`): Cosmetic, non-blocking findings about the PR's own description or a linked issue's body — the Step 2 item 11 class ("Issue Body & PR Body Prose (Never a Must Fix)"): stale, incomplete, or drifted Summary, Non-goals, acceptance-criteria wording, "Files changed" lists, and "How to test locally" / test-plan narration. **Placed directly beneath `### 🟡 Suggestions`** in the post body, as the last section. Prefix each nit line with 🔵. If none, render `### Nits` with `✅ None`.
     - **Scope, exactly**: this section holds the Step 2 item 11 body-prose class and nothing else. A finding about the code, the tests, or the version field is a Suggestion (or a Must Fix), not a Nit.
     - **Never a merge blocker**: like a Suggestion, a Nit never produces `**🛑 Changes Requested**` on its own, and it is never restated in a later post.
     - **Fixed by editing text, not by pushing code**: a Nit is cleared with `gh pr edit --body` or an issue-body edit, which is precisely why it does not share a section with findings that require a commit.

   **Example — initial post (post #1), re-review with one remaining blocker and two now-fixed
   findings.** Note that the only thing between the verdict line and `### 🛑 Must Fix Items` is the
   heading itself, that `### Changes Since Last Review` sits after the Must Fix section, not before
   it, that `### 🔵 Nits` sits last, directly beneath `### 🟡 Suggestions`, and that no row here
   mentions CircleCI — this post is content-only:

   ````md
   ## PR Review Summary
   **🛑 Changes Requested**

   ### 🛑 Must Fix Items
   - 🛑 `handleHttpReq` swallows a rejected promise on network timeout, so a timed-out request never surfaces a failure and the cron job hangs silently (`src/uptime/cron.ts:42`).

   ### Changes Since Last Review
   - ✅ Fixed: the missing unit test for `handleHttpReq` — added in `test/uptime.test.ts`.
   - ✅ Fixed: the stale Non-goals bullet in the linked issue — raised as a Nit last review, since edited away.

   ### Checklist Verification
   - **Mergeability**: ✅ No conflicts with `dev`.
   - **Semver Bump**: 🟡 `deno.json` version does not strictly exceed `origin/dev` (see Suggestions).
   - **Snyk**: ✅ Clean.
   - **Scope**: ✅ Matches linked issue.

   ### 🟡 Suggestions
   - 🟡 Version bump — `deno.json`'s version does not strictly exceed `origin/dev`'s current tip (Step 2 item 5).

   ### 🔵 Nits
   - 🔵 The PR body's "How to test locally" block names a worktree path that no longer exists — fix with `gh pr edit --body`; no commit needed.
   ````

   **Example — Step 4's single follow-up for the same PR, once CircleCI resolves failing.** It
   carries the updated verdict and the CircleCI failure, and nothing else: no Checklist
   Verification block, no repeat of post #1's other Must Fix items, and — in this example, since
   the only failing job is not the version-bump job — no Suggestions section either. **There is no
   `### 🔵 Nits` section here, and there never is in a Step 4 follow-up**: post #1 already carried
   the body-prose nit shown above, a CircleCI result is never body prose, and nothing from post #1
   is restated. The
   swallowed-rejection blocker from post #1 is still outstanding and still blocks the merge, which
   is why the verdict stays red — but it is not restated here, because post #1 already said it. The
   CircleCI job failing here ("Format check") is unrelated to the version bump, so per Step 4 item 5
   it adds its own Must Fix line rather than going under Suggestions:

   ````md
   <!-- post #2 (Step 4, CircleCI failure follow-up) via deno task post-pr-comment -->
   ## PR Review Summary
   **🛑 Changes Requested**

   ### 🛑 Must Fix Items
   - 🛑 CircleCI "Format check" is failing — `deno fmt --check` found unformatted files in `src/uptime/cron.ts`.
   ````

   **Example — the same PR when CircleCI resolves passing.** There is no second post. Post #1 is
   the whole review, and its verdict is final.
3. Write the finished review body to a scratch file (e.g. `/tmp/pr-review-<Repo>-<pr-num>.md` — never inside the repo, per AGENTS.md convention), then post it with the guarded command — the only route to `gh pr review` on either agent surface (web-jam-tools#685), passing the `HEAD_SHA` recorded in Step 1 item 2 so a force-push landing mid-review is caught rather than silently posted (web-jam-tools#825):
   ```sh
   deno task post-pr-review --repo <Owner/Repo> --pr <pr-num> --body-file <scratch_review_file> --head-sha <HEAD_SHA>
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
   `scripts/gh-write/guard.ts`. When `--head-sha` is passed and it no longer matches the PR's live
   head — a force-push landed between fetching the diff in Step 1 and this post — the command
   **refuses to post** (exit 1, naming both the supplied and the live head SHA) rather than letting
   a stale review occupy the already-reviewed slot and block the corrected re-review
   (web-jam-tools#825). On that refusal, re-run this review's Step 1 against the new head and post
   again — there is no other recovery path. A transient network failure (e.g. an `i/o timeout` against the
   GitHub API, the actual failure mode measured posting a review to
   `WebJamApps/JaMmusic#1324 "Remove the localhost:7000 BackendUrl default and hardcoded credentials
   from vite.config.ts"` on 2026-08-20) is retried automatically rather than surfaced on the first
   attempt.

   If the command itself reports a real failure (not the already-reviewed skip, which is success),
   fix the underlying problem and re-run it — there is no fallback path to hand off to a different
   session.

### Step 4: CircleCI Resolution

Runs strictly after Step 3's initial post (post #1) is live — never before it, never interleaved
with it. This step produces at most one post, and only when CircleCI does not pass: if CircleCI
resolves green, the review is already complete and nothing further is posted.

1. **Check CircleCI status once**:
   ```sh
   gh pr checks <pr-num> --repo WebJamApps/<Repo>
   ```
2. **Already resolved (pass or fail) at this check**: skip polling entirely — proceed to item 4 or
   item 5 below according to whatever this single check returned.
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
     wakeups, report "CircleCI still pending after N minutes", and proceed to item 5 below with
     CircleCI unresolved. This cap bounds `ScheduleWakeup` re-checks only; it is not a licence to
     fall back to a blocking Bash sleep loop.
   - **Antigravity/agy**: agy has no confirmed equivalent to `ScheduleWakeup`. Fall back to a
     bounded check-then-sleep loop: check every ~60 seconds, capped at ~15 minutes total, then
     report "CircleCI still pending after N minutes" and stop rather than looping forever.
     **This fallback is an unverified best guess, not a confirmed agy capability** — flag it for
     correction if agy turns out to have a native scheduling equivalent, and prefer that instead
     once confirmed.
4. **CircleCI resolved passing → post nothing.** The review is finished at post #1, whose verdict
   is already the final verdict. Do not post a confirmation, a checklist restatement, or a
   verdict-only comment. Report the green result to Josh in chat and stop.
5. **CircleCI resolved failing, or still unresolved once its poll cap is hit** (Claude Code's
   ~30-minute `ScheduleWakeup` cap, or agy's ~15-minute check-then-sleep cap — whichever surface is
   running) **→ post exactly one follow-up**, via `deno task post-pr-comment` — never
   `deno task post-pr-review` again for this PR (see item 6 below). Write a scratch file (e.g.
   `/tmp/pr-review-<Repo>-<pr-num>-ci.md` — never inside the repo, per AGENTS.md convention).

   - **Version-bump-only carve-out**: `Version bump check (PR branches only)` failing is `dev`
     moving under an open PR, not a defect the review's judgment adds anything to — CircleCI already
     reports it deterministically and a rebase clears it (same reasoning as Step 2 item 5). When it
     is the **only** failing (or still-unresolved) job, the follow-up reports it under
     `### 🟡 Suggestions`, not Must Fix, and the verdict does not go red on it alone — post
     `**✅ Approved**` unless post #1 already reported an unrelated Must Fix, in which case repeat
     post #1's verdict line verbatim.
   - **Any other failing job — alone or mixed with a failing version-bump job**: keeps today's
     behavior. The non-version-bump job(s) drive `**🛑 Changes Requested**` and a `### 🛑 Must Fix
     Items` line each. A concurrently-failing version-bump job does not add a second Must Fix line —
     fold it into the same follow-up as a `### 🟡 Suggestions` line instead, per the carve-out above.

   Carry only the `## PR Review Summary` header, the verdict line, and the applicable section(s)
   (`### 🛑 Must Fix Items` and/or `### 🟡 Suggestions`), one line per job. `### 🔵 Nits` is not on
   that list and never is — see Step 3's ruling on why a follow-up has no Nit to report:
   - Must Fix line: `🛑 Failing: <job name and failure detail>` if it resolved red, or `🛑 Still
     pending after N minutes — could not confirm passing status, verify manually before merge` if
     the poll cap was hit with that job still unresolved (an unresolved CI status is treated as
     blocking, never as silently passing).
   - Suggestions line (version-bump job only): `🟡 CircleCI "<job name>" is failing — <detail>`.

   **It carries nothing else.** No Checklist Verification block, no `**CircleCI**` row, no
   `### 🔵 Nits` section, no repeat of post #1's other Must Fix items or Nits, no narration of what
   changed. Post #1 already carries the
   review; this post exists solely to add the CircleCI result(s) that post #1 could not know about.
   Any finding from post #1 that is still outstanding stays outstanding without being restated here.

   ```sh
   deno task post-pr-comment --repo <Owner/Repo> --pr <pr-num> --body-file <scratch_ci_file>
   ```
6. **`deno task post-pr-review` is never called a second time for the same PR.** Its guard
   (`scripts/gh-write/guard.ts`) skips posting a second review at the same head SHA (no
   double-post, exit 0), so a second `post-pr-review` call would silently no-op. The failure
   follow-up above goes through `scripts/post-pr-comment.ts` instead, which carries no same-SHA
   guard and is built for exactly this repeat-posting case.

### A found defect is fixed before merge — never deferred

**"Fix it later", "merge anyway", "not a blocker, ship it" and "we can follow up in another issue" are NOT available outcomes of a review.** A defect the review found is a defect the review is responsible for getting fixed while the PR is still open — that is the entire point of reviewing before merge rather than after.

This binds the reviewing model AND the session relaying the review to Josh:

- **Never recommend merging a PR with a known unfixed defect in the code or artifact being merged**, however small, and never soften a real finding into a "nice to have" so that it can be waved through. If it is wrong, it is Must Fix or it is not a finding at all. This binary applies to defects in the code/artifact being merged, with two named exceptions — not a precedence rule, since each is a distinct case the binary was never meant to cover:
  - Issue-body or PR-body description prose is never a Must Fix, handled instead under Step 2's item 11 ("Issue Body & PR Body Prose (Never a Must Fix)") and reported under `### 🔵 Nits` — never under `### 🟡 Suggestions`.
  - A version-bump irregularity within the PR under review — either a version that fails to
    strictly exceed `origin/dev`, or a gratuitous double bump — is a Suggestion, not a Must Fix, per
    Step 2 item 5. CircleCI's version-bump gate still deterministically blocks the merge on a stale
    version regardless of what the review says; the review's severity reflects that a reviewer's
    judgment adds nothing to what CI already reports and a rebase already clears.
- **Never propose a follow-up issue as the answer to a defect found in the PR under review.** A new issue is where NEW work goes, not where this PR's known problems are parked.
- **A defect in the artifact being merged is fixed in THAT PR**, not in a later one — including when the artifact is a skill, a doc, or a rule rather than code.
- Size is not a reason to defer. "One line" and "no behavioural effect" are arguments for fixing it now, because it is cheap, not for postponing it.

The reviewing model reports; it does not apply the fix itself. It names the defect, says plainly that it blocks merge, and the fix goes back to the PR's own lane on the PR's own branch.
