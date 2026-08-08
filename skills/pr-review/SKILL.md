---
name: pr-review
description: Cross-model PR review pipeline where Flash High reviews Sonnet PRs, and Sonnet reviews Flash PRs. Triggered via `/pr-review <Repo>#<pr-num>` or `/pr-review` (auto-detects open PRs by the opposite model tier). Audits PR diff against issue acceptance criteria, scope, single semver bump, package-lock engine alignment (--ignore-scripts), test evidence integrity, and AGENTS.md guardrails, posting structured feedback via `gh pr review --comment`.
metadata:
  version: v1
  publisher: josh
---

# pr-review — cross-model pull request review pipeline

This skill provides a systematic pipeline for automated cross-model pull request reviews across WebJamApps repositories.

## Purpose & Model Pairing

Cross-model review pair matrix:
- **Flash High** (`Gemini 3.6 Flash (High)`) reviews PRs authored by **Sonnet** (`Claude Code — Sonnet 5`).
- **Sonnet** (`Claude Code — Sonnet 5`) reviews PRs authored by **Flash** (`agy — Gemini 3.6 Flash`).
- **Opus** and **Josh** may invoke `/pr-review` if desired, or review PRs in their own custom/human way without using the skill.

Cross-model review ensures fresh perspective and catches model-specific blind spots before Josh does final human review and merge.

## Trigger & Invocation

- **Named mode**: `/pr-review <Repo>#<pr-num>` (e.g. `/pr-review web-jam-tools#363` or `https://github.com/WebJamApps/web-jam-tools/pull/363`).
- **Auto-detect mode**: `/pr-review` (with no arguments).
  - Queries open draft/ready PRs across WebJamApps repositories using `gh pr list`.
  - Inspects PR attribution (`🤖 Work by ...` or branch prefix / `--author` flag) to identify candidate PRs authored by the opposite tier.
  - Automatically selects the oldest un-reviewed PR authored by the opposite tier.

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
1. Fetch PR details, metadata, and mergeability:
   ```sh
   gh pr view <Repo>#<pr-num> --json number,title,body,author,headRefName,baseRefName,state,isDraft,mergeable,mergeStateStatus
   ```
2. Fetch PR status checks (CircleCI, Snyk, etc.):
   ```sh
   gh pr checks <Repo>#<pr-num>
   ```
3. Fetch the PR diff:
   ```sh
   gh pr diff <Repo>#<pr-num>
   ```
4. If the PR references a GitHub issue (e.g., `Closes #N` or `Part of #N`), fetch the issue description and acceptance criteria:
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

1. Synthesize review findings into a structured review comment.
2. Format feedback with clear section headers:
   - **PR Review Summary**: Overall status (`Approved` if clean / `Changes Requested` if any Must Fix item or blocking defect exists).
   - **Must Fix Items**: List any CircleCI failures, Snyk security failures, merge conflicts, or blocking bugs. If none, state "None".
   - **Checklist Verification**: Status of mergeability, CI health, Snyk audits, scope, semver bump, package-lock engine alignment, test evidence, and guardrails.
   - **Actionable Feedback & Suggestions**: Specific code references or line numbers where changes or improvements are suggested.
3. Post comment via `gh pr review`:
   ```sh
   gh pr review <Repo>#<pr-num> --comment --body-file <scratch_review_file>
   ```
   *(Note: Review comments provide feedback for the PR author and Josh. Final PR merge remains under Josh's approval.)*
