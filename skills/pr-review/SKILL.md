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

### Step 1: Fetch PR Details and Context
1. Fetch PR details and metadata:
   ```sh
   gh pr view <Repo>#<pr-num> --json number,title,body,author,headRefName,baseRefName,state,isDraft
   ```
2. Fetch the PR diff:
   ```sh
   gh pr diff <Repo>#<pr-num>
   ```
3. If the PR references a GitHub issue (e.g., `Closes #N` or `Part of #N`), fetch the issue description and acceptance criteria:
   ```sh
   gh issue view <Repo>#<issue-num>
   ```

### Step 2: Audit Checklist

Review the PR diff and description against these mandatory audit criteria:

1. **Issue Acceptance Criteria & Scope**:
   - Does the diff fulfill all requirements and acceptance criteria stated in the linked issue?
   - Is the PR tightly scoped to the issue task? Are there any out-of-scope files, unintended refactors, or stray code additions?

2. **Single Semver Version Bump per PR**:
   - Check `package.json` (or `deno.json` for `web-jam-tools`).
   - The version must be bumped exactly once per PR on its first commit.
   - Verify follow-up commits do not re-bump the version, and that the version is not unchanged from the merge-base with `dev`.

3. **Package-Lock Engine Alignment**:
   - When bumping Node.js version in `package.json` `engines`, verify `package-lock.json` root engine definition was updated using `npm install --package-lock-only --ignore-scripts` (or `npm install --ignore-scripts`) so both files stay in sync without running unverified postinstall scripts.

4. **Test Evidence & Test Plan Integrity**:
   - Inspect the PR body `--test-evidence` section. It must contain actual, recognizable test runner output (e.g., `ok | 42 passed | 0 failed`), not generic prose (web-jam-tools#190).
   - Inspect the `--test-plan` section. It must contain concrete steps exercising the change itself (UI manual steps, runnable `curl` commands, or tooling commands), not just suite invocations like `npm test` or `deno task test` (web-jam-tools#152).

5. **AGENTS.md Guardrails Audit**:
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
   - **PR Review Summary**: Overall status (Approved / Changes Requested / Comment).
   - **Checklist Verification**: Status of scope, semver bump, package-lock engine alignment, test evidence, and guardrails.
   - **Actionable Feedback & Suggestions**: Specific code references or line numbers where changes are needed.
3. Post comment via `gh pr review`:
   ```sh
   gh pr review <Repo>#<pr-num> --comment --body-file <scratch_review_file>
   ```
   *(Note: Review comments provide feedback for the PR author and Josh. Final PR merge remains under Josh's approval.)*
