---
name: pr-review
description: Cross-model PR review pipeline where Flash High reviews Sonnet PRs, and Sonnet reviews Flash PRs. Triggered via `/pr-review <Repo>#<pr-num>` or `/pr-review` (auto-detects open PRs by the opposite model tier). Audits PR diff against issue acceptance criteria, scope, single semver bump, package-lock engine alignment (--ignore-scripts), test evidence integrity, and AGENTS.md guardrails, posting structured feedback via `gh pr review --comment`.
metadata:
  version: v2
  publisher: josh
---

# pr-review — cross-model pull request review pipeline

This skill provides a systematic pipeline for automated cross-model pull request reviews across WebJamApps repositories.

## Purpose & Model Pairing

Cross-model review pair matrix:
- **Flash High** (`Gemini Flash (High)`) reviews PRs authored by **Sonnet** (`Claude Code — Sonnet 5`).
- **Sonnet** (`Claude Code — Sonnet 5`) reviews PRs authored by **Flash** (`agy — Gemini Flash`).
- **Opus** and **Josh** may invoke `/pr-review` if desired, or review PRs in their own custom/human way without using the skill.

Cross-model review ensures fresh perspective and catches model-specific blind spots before Josh does final human review and merge.

## Trigger & Invocation

- **Named mode**: `/pr-review <Repo>#<pr-num>` (e.g. `/pr-review web-jam-tools#363` or `https://github.com/WebJamApps/web-jam-tools/pull/363`).
- **Auto-detect mode**: `/pr-review` (with no arguments).
  - Sweeps open draft/ready PRs across all eight active WebJamApps repositories (see the canonical repo list in [`skills/flash-issues/SKILL.md`](../flash-issues/SKILL.md) under "Scope — all eight active repos, exactly these slugs").
  - Matches candidate Flash-authored PRs across **both** Flash tiers: `Gemini Flash (Medium)` and `Gemini Flash (High)` as spelled in the `ROSTER` array in `scripts/create-draft-pr.sh` (e.g. matching `Gemini Flash (Medium)` and `Gemini Flash (High)` in the PR body trailer `🤖 Work by ...` or `--author` attribution).
  - Determines review status for each candidate PR using the head-SHA comparison from Step 1's "Already-Reviewed Check":
    - Compares the commit SHA of the newest automated review (`reviews | map(select((.body // "") | test("(?i)## PR Review Summary"))) | last | .commit.oid`) against the PR's current head commit SHA (`commits | last | .oid`).
    - If equal (`head_sha == last_review_sha`), mark as `reviewed at current head`. Already-reviewed PRs are included in the pick-list rather than filtered out.
    - If no prior automated review exists or if new commits have been pushed since the last automated review (`head_sha != last_review_sha`), mark as `needs review`.
  - Builds and displays a numbered pick-list table carrying per row: repo, PR number, PR title, author tier (`Gemini Flash (Medium)` / `Gemini Flash (High)`), age in days, draft/ready state, and review status.
  - **Stops and waits for Josh**: The skill STOPS and waits for Josh to choose a PR by number from the numbered pick-list before fetching, posting, or beginning any review. It **never** silently auto-selects a PR.
  - **Empty result handling**: If no open Flash-authored PRs exist across any of the eight active repositories, reports plainly that no open Flash-authored PRs were found (e.g., *"No open Flash-authored (`Gemini Flash (Medium)` or `Gemini Flash (High)`) PRs found across the eight active WebJamApps repositories."*) and stops immediately, without falling through to named mode.

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
   gh pr view <Repo>#<pr-num> --json number,title,body,author,headRefName,baseRefName,state,isDraft,mergeable,mergeStateStatus,reviews,commits
   ```
2. **Already-Reviewed Check**:
   - Filter `reviews` for automated reviews carrying the `## PR Review Summary` header:
     ```sh
     gh pr view <Repo>#<pr-num> --json reviews,commits \
       --jq '{last_review_sha: (.reviews | map(select((.body // "") | test("(?i)## PR Review Summary"))) | last | .commit.oid), head_sha: (.commits | last | .oid)}'
     ```
   - Compare the commit SHA of the newest automated review (`last_review_sha` from `.commit.oid`) against the PR's current head commit SHA (`head_sha` from `.commits | last | .oid`).
   - If equal (and a prior automated review exists at that SHA), stop and report to Josh that the PR was already reviewed at that SHA with no new commits, and post NO review comment.
   - If new commits exist after the newest review (or if the PR has no prior automated reviews), proceed with the review. When re-reviewing after new commits, state that the review evaluates the delta since the previous review.
3. Fetch PR status checks (CircleCI, Snyk, etc.):
   ```sh
   gh pr checks <Repo>#<pr-num>
   ```
4. Fetch the PR diff:
   ```sh
   gh pr diff <Repo>#<pr-num>
   ```
5. If the PR references a GitHub issue (e.g., `Closes #N` or `Part of #N`), fetch the issue description and acceptance criteria:
   ```sh
   gh issue view <Repo>#<issue-num>
   ```

### Step 2: Audit Checklist

Review the PR diff, description, checks, and mergeability against these mandatory audit criteria:

1. **Merge Conflicts (Must Fix)**:
   - Check `mergeable` status and `mergeStateStatus` from Step 1.
   - If the PR has merge conflicts with the base branch (`dev` / `main`), report it as a **Must Fix** item requiring a rebase or conflict resolution before merging.

2. **CircleCI & Automated Build Health (Must Fix)**:
   - Inspect status checks from `gh pr checks`.
   - If CircleCI (`ci/circleci: build` or equivalent pipeline) is failing, report the failure details as a **Must Fix** item.

3. **Snyk Security Audits (Must Fix)**:
   - Inspect status checks from `gh pr checks` for Snyk security failures (`security/snyk`, `snyk-code`, etc.).
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
   - The version must be bumped exactly once per PR on its first commit.
   - Verify follow-up commits do not re-bump the version, and that the version is not unchanged from the merge-base with `dev`.

6. **Package-Lock Engine Alignment**:
   - When bumping Node.js version in `package.json` `engines`, verify `package-lock.json` root engine definition was updated using `npm install --package-lock-only --ignore-scripts` (or `npm install --ignore-scripts`) so both files stay in sync without running unverified postinstall scripts.

7. **Test Plan Integrity**:
   - **Test evidence is OPTIONAL, and pasted suite logs are not wanted.**
     `scripts/create-draft-pr.sh` treats `--test-evidence` as optional by design — unit-test
     runner output in a PR body is noise to the reviewer it is meant to inform. **Never raise a
     finding because the "Test evidence" section is absent, thin, or omits suite numbers**, and
     never ask an author to paste `deno task test` / `npm test` output. Confirm the suites ran by
     checking CI instead: `gh pr checks <Repo>#<pr-num>`.
   - If a Test evidence block *is* present it must not be fabricated, but a missing or partial one
     is not a defect and must not be reported as one.
   - Inspect the `--test-plan` section. It must contain concrete steps exercising the change itself (UI manual steps, runnable `curl` commands, or tooling commands), not just suite invocations like `npm test` or `deno task test` (web-jam-tools#152).

8. **AGENTS.md Guardrails Audit**:
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

### Step 3: Post Review Feedback

1. Synthesize review findings into a structured review comment using severity icons so merge blockers and check statuses are immediately recognizable without reading full prose.
2. Format feedback with clear section headers and severity icons:
   - **PR Review Summary**: Overall status (`**✅ Approved**` if clean / `**🛑 Changes Requested**` if any Must Fix item or blocking defect exists).
   - **Must Fix Items** (`### 🛑 Must Fix Items`): List any CircleCI failures, Snyk security failures, merge conflicts, or blocking bugs. Prefix each individual must-fix finding line with 🛑. If none, render `### Must Fix Items` with `✅ None` (never render a stop sign for an empty Must Fix section).
   - **Checklist Verification**: Status of mergeability, CI health, Snyk audits, scope, semver bump, package-lock engine alignment, test evidence, and guardrails. Place the severity icon (✅ or 🛑) immediately after the bold check label and colon on each line (e.g. `- **Mergeability**: ✅ ...`, `- **CircleCI**: 🛑 ...`).
   - **Actionable Feedback & Suggestions** (`### 🟡 Actionable Feedback & Suggestions`): Specific code references or line numbers where changes or improvements are suggested. Prefix each suggestion line with 🟡. If none, render `### Actionable Feedback & Suggestions` with `✅ None`.
3. Write the finished review body to a scratch file (e.g. `/tmp/pr-review-<Repo>-<pr-num>.md` — never inside the repo, per AGENTS.md convention), then post it:
   ```sh
   gh pr review <Repo>#<pr-num> --comment --body-file <scratch_review_file>
   ```
   *(Note: Review comments provide feedback for the PR author and Josh. Final PR merge remains under Josh's approval.)*

   **Who runs this command depends on how this skill is being run — read this before posting:**

   - **Running interactively as the top-level session** (Josh invoked `/pr-review` directly, or
     Opus/a top-level Sonnet/Flash session is running it inline): post directly with the command
     above. Nothing below applies.
   - **Running as an Agent-tool-dispatched subagent** (a parent session used the `Agent` tool to
     hand this whole `/pr-review` run to a subagent — per this skill's "Purpose & Model Pairing"
     section above): **do NOT attempt to run `gh pr review --comment` yourself.** This is a
     known Claude Code harness limitation, not a WebJamApps settings gap and not something
     `scripts/install-hooks.sh` can fix: Agent-tool subagents run in an independent permission
     context and do not inherit the parent session's `~/.claude/settings.json`
     `permissions.allow` list, even for entries like `Bash(gh pr review *)` that are already
     approved at the top level. A dispatched subagent has no human present to answer the resulting
     interactive prompt, so the write silently dead-ends. Anthropic has confirmed this is
     intentional (subagents get independent, stricter-by-default permissions) and closed the
     inheritance requests as not planned:
     [anthropics/claude-code#37730](https://github.com/anthropics/claude-code/issues/37730),
     [anthropics/claude-code#37442](https://github.com/anthropics/claude-code/issues/37442).
     Instead:
     1. Write the finished review body to the scratch file as in step 3 above.
     2. In your final report back to the orchestrating session, state plainly that the review is
        complete and give the **absolute path** to that scratch file — do not attempt the post and
        report the review as **written and awaiting posting**, never as posted.
     3. The **orchestrating session** (which has its own, already-approved permission context)
        reads that file and runs the `gh pr review --comment --body-file` command itself.
   - If you cannot tell which of the two cases you're in, attempt the post — and if it is denied,
     fall back to the file handoff above. A denied attempt costs nothing but the fallback you would
     have taken anyway; a review that silently never landed on GitHub is a dead-ended dispatch that
     looks like it worked.

### A found defect is fixed before merge — never deferred

**"Fix it later", "merge anyway", "not a blocker, ship it" and "we can follow up in another issue" are NOT available outcomes of a review.** A defect the review found is a defect the review is responsible for getting fixed while the PR is still open — that is the entire point of reviewing before merge rather than after.

This binds the reviewing model AND the session relaying the review to Josh:

- **Never recommend merging a PR with a known unfixed defect in it**, however small, and never soften a real finding into a "nice to have" so that it can be waved through. If it is wrong, it is Must Fix or it is not a finding at all.
- **Never propose a follow-up issue as the answer to a defect found in the PR under review.** A new issue is where NEW work goes, not where this PR's known problems are parked.
- **A defect in the artifact being merged is fixed in THAT PR**, not in a later one — including when the artifact is a skill, a doc, or a rule rather than code.
- Size is not a reason to defer. "One line" and "no behavioural effect" are arguments for fixing it now, because it is cheap, not for postponing it.

The reviewing model reports; it does not apply the fix itself. It names the defect, says plainly that it blocks merge, and the fix goes back to the PR's own lane on the PR's own branch.
