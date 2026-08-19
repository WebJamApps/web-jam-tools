# Agent Instructions for WebJamApps

This file contains instructions and context for every AI agent (Claude Code, agy/Antigravity, and
any other assistant) working in this workspace.

## Cross-AI hard rules

The cross-AI hard rules that bind every agent on every surface are NOT duplicated here. They live
in exactly one file: `docs/cross-ai-rules.md` in the **`web-jam-tools` repository**, which normally
sits alongside this repository — `../web-jam-tools/docs/cross-ai-rules.md`, and on Josh's laptop
`/home/joshua/WebJamApps/web-jam-tools/docs/cross-ai-rules.md`.

Read that file before acting. If you cannot find it, STOP and say so — do not proceed without the
rules and do not reconstruct them from memory or from this file.

## Read also

- [docs/ai-team-playbook.md](docs/ai-team-playbook.md) — the current AI team, what each tier is best
  at, how work hands off, and where Josh approves.
- [docs/cross-ai-rules.md](docs/cross-ai-rules.md) — cross-AI operational rules (voice rules, file
  placement, protected files, canonical task queues, memory hygiene) that apply to every AI on the
  team. Its **FE/BE COUPLING** section covers the backward-compat/expand-contract rule for shared
  BE/FE contracts and the `FE-couples:`/`Coupling-override:` conventions — read it before shipping a
  front-end half of coupled work.
- [docs/playwright-mcp.md](docs/playwright-mcp.md) — setup and operational guidelines for using
  Playwright MCP server (`@playwright/mcp`) to debug production websites.
- [docs/agy-hooks.md](docs/agy-hooks.md) — the agy (Antigravity/Flash) PreToolUse/PostToolUse hook
  contract as measured, the translation shim that makes hooks actually enforce there, and the
  Antigravity Gmail MCP setup + send/delete fence built on top of it.

## Workspace Overview

- **Root Directory:** `/home/joshua/WebJamApps`
- **Primary Projects:** JaMmusic, AppersonAuto, CollegeLutheran, web-jam-back, WebJamPg, etc.
- **Tools Repo:** `web-jam-tools` (this repository)

## Collaboration Rules

1. **Rclone Mount:** Google Drive is mounted at `~/gdrive` via a systemd user service
   (`rclone-gdrive.service`).
2. **Coding Standards:** Refer to individual project `AGENTS.md`/`CLAUDE.md` files (if present) for
   specific technology stacks.
3. **Repository Purpose:** `web-jam-tools` serves as a central hub for shared configurations,
   documentation of system setups, and general workspace memory.
4. **No Merging to DEV:** AI agents are **NOT** allowed to merge PR changes to the `dev` or `main`
   branches. The user acts as the mandatory human-in-the-loop reviewer and is responsible for all
   merges.
5. **Isolated Worktree & Branch Discipline:** For tasks in `web-jam-tools`, always work out of an isolated git worktree. When task execution completes, ensure the main local repository working tree remains checked out on `dev` and is never left switched to a feature branch (note: this rule is specific to `web-jam-tools` and differs from UI projects).
6. **PreToolUse Hook Path Fencing:** When implementing PreToolUse path/repo fencing hooks, do not treat a non-git working directory as an implicit trusted repository root. Fail closed on non-git directories so writes to sensitive paths (such as `~/.claude/CLAUDE.md`) remain blocked even when a session is opened at home or outside a git repository.
7. **Multi-Repo Dispatch Target Repo Override:** `scripts/handle-agy-tasks.sh` supports `--repo <Name>` and `AGY_TARGET_REPO=<Name>` to dispatch an issue filed in one repository (e.g. `web-jam-tools#505`) against a different target working repository (e.g. `JaMmusic`), setting `REPO_DIR` and worktree paths to that target repo while keeping the branch name derived from the issue.
8. **Non-UI Task Land Opt-Out (`--no-land`):** `scripts/handle-agy-tasks.sh` supports `--no-land` to skip checking the feature branch out into the developer's main repository clone after PR creation, keeping non-UI work (backend, docs, tooling, config) from moving the local checkout away from `dev`.
9. **Skill Renames & Stale Symlink Pruning:** `skills/issue-design/` is renamed to `skills/design-issue/` and `skills/draft-issue/` is renamed to `skills/file-issue/`. `deno task install-skills` (`scripts/install-skills.ts`) includes an automatic prune path to remove dangling symlinks pointing to deleted skill directories in both `~/.claude/skills` and `~/.gemini/config/plugins/webjam-tasks/skills` while leaving `*.bak-*` directories untouched.

## Opening pull requests (all WebJamApps repos)

Finish a coding task by running the shared script — never `gh pr create` directly. This applies
**however the task was started** (via `/work-issue` or just told to work an issue ad-hoc).
Put your summary and the **real test output** IN THE PR via the flags — not only in the chat reply:

```
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
  --author "<tool> — <model>" \
  --summary "<what changed and why>" \
  --test-plan "<exact commands to verify + expected result>" \
  --part-of   # include ONLY if the issue must stay open (partial PR / run-log / epic)
```

`--summary` and `--test-plan` are **required** — the script **refuses to open a PR with an empty or
placeholder description** (web-jam-tools#77).

`--test-evidence` is **OPTIONAL and normally omitted.** Always run the suites and confirm they pass
before opening the PR. If included, test evidence must accurately reflect a complete run on the current
commit — never stale or partial runs. Reserve the flag for evidence CI cannot show: a manual
reproduction, a `curl` response, or a described screenshot. A PR with no "Test
evidence" section is correct, and a reviewer must never raise a finding about its absence. It always
opens a **draft** PR based on **`dev`**, with the issue number derived from the
`<lane>/<issue#>-<slug>` branch name (or explicit `--issue` flag, which supports full URLs,
`OWNER/REPO#N`, or bare `#N`/`N` and formats cross-repo closing lines as `Closes OWNER/REPO#N`) and
a footer naming the tool + model (hard invariants — no flag overrides them). By default the PR
closes the issue on merge (`Closes #N` or `Closes OWNER/REPO#N`); pass `--part-of` only when the
issue must stay open (`Part of #N` or `Part of OWNER/REPO#N` for a partial PR, or a standing
run-log/epic issue). (`--closes` is a deprecated no-op, still accepted.) Josh alone reviews and flips draft → ready.
See `skills/draft-pr/SKILL.md`.

### PR body formatting (do this every time)

The script drops your `--summary` / `--test-plan` / `--test-evidence` values **verbatim** under
their headers — it does not reformat them, so professional formatting is the **caller's** job. Fill
every flag with proper markdown:

- **Summary** → **bullet points**, one change per bullet — never a single run-on sentence.
- **Shell commands** → a fenced `` ```sh `` code block, never inline prose.
- **HTML or code** → wrap every `<tag>`, snippet, or symbol in backticks or a fenced block so GitHub
  renders it literally. Never pass a raw `<sup>35</sup>`-style tag as prose — GitHub renders or
  swallows it and garbles the body.
- **Before/after** → add a short before → after snippet when it aids clarity.

Example of a well-formed call (bulleted summary, fenced commands + output):

````
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
  --author "<tool> — <model>" \
  --summary "- Add X so Y works
- Refactor Z to stop duplicating W" \
  --test-plan "Run:
```sh
npm test
```
Expect: lint + unit green." \
  --test-evidence "```
ok | 42 passed | 0 failed
```"
````

### PR version-bump convention

Every PR must bump the version once, on its first commit — `deno.json` in this repo (e.g.
`"version": "1.26.x"`). CI's "Version bump check (PR branches only)" gate blocks PRs whose version
is unchanged from the merge-base with `dev`. Always bump `deno.json` on the first commit of any new
PR branch in `web-jam-tools` to prevent CircleCI gate failures. When updating or rebasing an open PR
branch after other PRs have merged to `dev`, verify that `HEAD`'s version remains strictly greater
than `origin/dev`'s current version (e.g. `git show origin/dev:deno.json`), and bump again on the fix
commit if `origin/dev` has moved ahead. When invoking `create-draft-pr.sh`, pass multi-line or rich
markdown values using `--summary-file`, `--test-plan-file`, and `--test-evidence-file` pointing to
temporary files in /tmp/ (e.g. /tmp/pr-summary.md) — never create scratch files or scratch/
directories inside the repo to prevent shell argument escaping or flattening issues.

## CI gate (web-jam-tools)

Every PR runs a CircleCI **quality + security gate** (`.circleci/config.yml`), required-green on
`dev` via branch protection. Run the **same checks locally before pushing** — "green locally" ==
"green in CI":

```
deno task check      # type check
deno task lint
deno task fmt:check   # formatting (deno task fmt to auto-fix)
deno task test        # unit tests
deno task audit       # Trivy: dependency CVEs (HIGH/CRITICAL fail) + secret scan
deno task sast        # Semgrep: static analysis of src/
```

**Before pushing:** run `deno task fmt` to auto-fix any formatting issues. A local pre-push hook
(`fmt-push-guard.sh`) blocks pushes with unformatted files; this line is an advisory backup.

`audit` and `sast` run via **Docker** (so they're identical locally and in CI) — Docker must be
available. `audit` bridges Deno's npm deps to a `package-lock.json` (Trivy can't read `deno.lock`);
JSR deps are not covered. SAST findings are **refactored, not suppressed**. Deploy on merge to
`main` is added in web-jam-tools#69.

## Quota & Token Hygiene

- **Sliding Window Quota Preservation:** Google Antigravity (`agy`) tracks model token usage on a
  rolling 5-hour sliding window. To avoid triggering 3+ hour rate limit resets during long or
  multi-repo tasks:
  - Keep command outputs compact: avoid printing thousands of lines of raw test logs directly into
    main turn outputs.
  - Redirect large multi-line summaries, test plans, and evidence to temporary files in /tmp/
    (`--summary-file`, `--test-plan-file`, `--test-evidence-file`) when calling
    `create-draft-pr.sh`.
  - Delegate mechanical sub-tasks or heavy lookups to cheaper subagents (`Flash Med` or `Haiku`)
    when operating interactively on `Flash High`.
  - **Automatic Flash Med Subagent Handoff on "Go":** Once requirements and implementation steps are
    aligned interactively on `Flash High`, the primary session is **forbidden** from executing file
    edits or running test suites directly for tasks/issues labeled `Flash Med` (or `Haiku`). Upon
    receiving user approval ("go", "proceed", "start"), the primary session's very first tool call
    MUST be `invoke_subagent` (model `flash`) to delegate contained execution work (coding, running
    test suites, branch/PR creation) down to a `Flash Med` subagent.
  - **Exception — trivial edits.** The primary session may make the edit directly, without
    `invoke_subagent`, only when **all** of these hold: it touches **one file**; it changes **no
    behaviour** (documentation, comment, or a single config value); and it is **under ~20 changed
    lines**. The session must say, in the same turn, that it is taking the exception and why. "I
    already have the context", "it would be faster", and "writing the brief costs as much as the
    work" are **not** exceptions — the three conditions above are the whole test. Rationale:
    delegation pays when the work is bigger than the brief; below that line the session pays to
    write a self-contained specification, waits for a round trip, then reviews the result, for an
    edit smaller than the specification. The three conditions are a mechanical proxy for that,
    chosen because they are auditable from the outside and a cost estimate is not.
  - **Subagent PR Author Accuracy:** When delegating execution tasks down to a subagent, instruct
    the subagent to pass `--author` matching its actual model tier (e.g.
    `--author "Antigravity — Gemini Flash (Medium)"` for Flash Med subagents) when calling
    `create-draft-pr.sh`.

## System Setup

- **OS:** Ubuntu
- **Node.js:** v24.18.1 (LTS)
- **Rclone:** Configured for Google Drive (`gdrive:`)
- **Persistence:** Systemd user services managed via `systemctl --user`

## API Integrations

The status of Google Drive/Docs/Sheets/Slides/Calendar/Tasks/Gmail integrations available to AI
assistants is tracked privately, NOT in this public repo:
`~/Dropbox/web-jam-llms/Access_Controls/api-integrations-2026-07-31.md`. Update that file (and the
dated note in Drive `My Drive / GEMINI / API_Integration_Status_*.md`) when integration state
changes. If you cannot read that path, STOP and say so rather than guessing.

## Production Monitoring

Uptime monitoring for production websites is managed via `deno task monitor:uptime`
(`src/uptime/cli.ts`) and 24/7 Deno Deploy edge cron `deno task monitor:cron` (`src/uptime/cron.ts`
using `Deno.cron`). See [docs/uptime-monitoring.md](docs/uptime-monitoring.md) for full guide,
target list, deployment steps, and verification procedures.

- **Monitored Targets:**
  - `https://joshandmariamusic.com` (HTTP 200)
  - `https://www.joshandmariamusic.com` (HTTP 200 / redirect)
  - `https://web-jam.com` (HTTP 200)
  - `https://web-jam.com/music` (Content-aware check: HTTP 200 AND presence of music content
    elements)
  - `https://collegelutheran.org` (HTTP 200)
- **Alerting & Credentials:**
  - Reads `GMAIL_USER` and `GMAIL_APP_PASSWORD` environment variables.
  - Sends detailed failure alert emails to `joshua.v.sherman@gmail.com` and
    `chemmariasherman@gmail.com` via Nodemailer on failure.
  - Silent on success (exits with code 0).
- **Deno Deploy 24/7 Schedules:**
  - `Deno.cron("WebJam Production Uptime Check", "*/30 * * * *", ...)` runs every 30 minutes 24/7
    (silent on success, email on failure).
  - `Deno.cron("WebJam Production Daily Heartbeat", "0 12 * * *", ...)` runs daily at 8:00 AM EDT
    (12:00 UTC) sending a self-health confirmation email to `joshua.v.sherman@gmail.com` and
    `chemmariasherman@gmail.com`.

## Deno Deploy CLI & Runtime Rules

- **Root Directory Positional Argument**: Always pass `.` (workspace root) as the positional root
  argument to `deno deploy` (e.g. `deno deploy . --config deno.uptime.json --prod`).
  NEVER pass an individual file path like `src/uptime/cron.ts` as the positional root argument
  because Deno Deploy will set `/tmp/build/src` as the working directory, isolating it from root
  project files (`deno.json`, `./monitor.ts`) and causing builds to hang or fail looking for
  dependencies.
- **Entrypoint Configuration in Isolated Configs**: Entrypoint and app metadata must be configured inside
  isolated `deno.<service>.json` config files (e.g. `deno.uptime.json`, `deno.devotional.json`)
  under `"deploy": { "org": "webjamapps", "app": "...", "entrypoint": "...", "exclude": [...] }`
  and passed via `--config deno.<service>.json`. Do NOT pass `--entrypoint` to `deno deploy`
  (without `create`), as `--entrypoint` is only a subcommand flag for `deno deploy create`.
- **Deno Deploy Dynamic Containers Require `Deno.serve`**: In dynamic mode
  (`--runtime-mode dynamic`), entrypoint scripts must include a `Deno.serve` listener guarded by
  `import.meta.main` (e.g.
  `if (import.meta.main && typeof Deno !== "undefined" && typeof Deno.serve === "function") Deno.serve(...)`).
  Without `Deno.serve`, scripts containing only `Deno.cron` exit immediately after top-level
  execution, causing Deno Deploy to report `The revision failed`.
- **Token Security**: `DENO_DEPLOY_TOKEN` secrets are permanently masked in Deno Console and
  CircleCI (`xxxxn9p8`). To align local CLI and CircleCI tokens, generate a fresh token in Deno
  Console (`https://console.deno.com/account/tokens`), export locally
  (`export DENO_DEPLOY_TOKEN="..."`), and update CircleCI via `circleci envvar create`.
- **Pre-Push Formatting Check**: ALWAYS run `deno task fmt` AND verify `deno task fmt:check` passes
  100% green before pushing EVERY commit (including minor test additions, bug fixes, or
  documentation updates). Pushing without running `deno task fmt` can cause subtle formatting drift
  (such as trailing newlines or quote style changes) that breaks CircleCI's strict `Format check`
  gate.

- **Endpoint Test Coverage & Coverage Gate**: When adding or updating HTTP endpoint routes or branch
  logic in Deno modules (e.g. `src/uptime/cron.ts`), always export testable handler functions (like
  `handleHttpReq`) and add corresponding unit tests in `test/*.test.ts` covering endpoints and error
  paths. Uncovered HTTP endpoints lower module line coverage and can cause overall repository
  coverage to drop below CircleCI's strict 90% line-coverage threshold
  (`[coverage] FAIL: all-files line coverage < 90% threshold`).

## Language & Runtime Standardization

- **Language & Runtime Standardization**: All helper scripts, hooks, tools, and utilities in
  `web-jam-tools` (and TypeScript repos) must be written in Deno/TypeScript. Do NOT introduce Python
  scripts; prefer Deno/TypeScript for all workspace helpers and hook parsers.
- **Path Traversal & Identifier Validation in Automation Scripts**: Any script constructing
  filesystem paths from input plan identifiers, slugs, or keys (e.g., in memory/rule migrations or CLI
  utilities) MUST validate each identifier against a strict safe alphanumeric pattern (e.g.,
  `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`) to prevent directory traversal and accidental reads/writes/trashes
  outside the target directory.
- **Native Issue Field Updates & Issue Creation**: When updating native issue fields or relationships in GitHub:
  - **Priority Field**: Set via GraphQL mutation `updateIssueFieldValue(input: { issueId, issueField: { fieldId: "IFSS_kgDOADumRA", singleSelectOptionId } })`. Option global node IDs for `WebJamApps`: Urgent (`IFSSO_kgDOAGhNuA`), High (`IFSSO_kgDOAGhNuQ`), Medium (`IFSSO_kgDOAGhNug`), Low (`IFSSO_kgDOAGhNuw`).
  - **Type Field**: Set via GraphQL mutation `updateIssue(input: { id: issueId, issueTypeId })` with `issueTypeId` resolved from `repository.issueTypes`.
  - **Parent Issue Link**: Set via GraphQL mutation `addSubIssue(input: { issueId: parentNodeId, subIssueId: childNodeId })`.
  - **Helper Script**: Always use `scripts/create-issue.ts` (or `deno task create-issue`), which automates creation, labels, milestone, native Type, Priority, parent link, and attribute verification in one place.
  - **Designed Issues with Paired Manual Steps Become Parent Epics**: When `/design-issue` resolves an existing issue into paired implementation and Josh manual verification tasks, convert the target designed issue into native type `Epic` (via GraphQL `updateIssue` with the repo's `Epic` `issueTypeId`), file the executable coding work as a child `Task` sub-issue attached under that Epic, and file the paired `Josh` manual verification task as a child `Task` sub-issue attached under that same Epic (marked `Blocked` on the coding child).
  - **Manual Step Issue & Document Title Rule**: Never prefix issue titles or runbook document titles with personal names (e.g. do NOT name an issue "Josh: ..."). Use professional, action-oriented titles like `Manual verification: ...` or `Verification: ...`. Ownership and responsibility are designated exclusively by the `Josh` label or assignees, never by embedding a personal name in the issue or document title.
- **Version Scrubbing & Generic Comment Descriptions**: When executing version-migration tasks with explicit grep-to-zero requirements (such as removing retired model version strings), ensure all decorative occurrences—including header comments, rejection bullet lists, and example command strings—describe requirements generically (e.g., "every Flash slug below the 3.7 floor") rather than retaining or reintroducing retired version literals in comments.
- **GitHub CLI `gh pr view --json reviews` Schema**: In GitHub CLI (`gh`), review commit SHAs are located at `.commit.oid` (e.g. `.reviews[].commit.oid`), NOT at a top-level `.commit_id`. When querying reviews via `gh pr view --json reviews`, always extract `.commit.oid` to obtain the commit SHA.
- **Distinguishing Automated vs. Manual PR Reviews**: When inspecting PR reviews to determine whether an automated review (e.g. `/pr-review`) has already evaluated a PR, do not treat any review at the head SHA as an automated review. Because both human and bot reviews may post under the developer's identity, always filter reviews by their signature header (e.g., `## PR Review Summary`) to avoid incorrectly skipping automated reviews due to ad-hoc human review comments.
- **Config & Skill Reconciliation in Symlink Installers**: When installer scripts symlink live environment paths (e.g. `~/.gemini/config/mcp_config.json` or `~/.claude/skills/*`) to repo-mastered files, they must preserve pre-existing real files not just by backing them up to `.bak-*`, but by actively reconciling and copying any local-only entries/keys into the repo master before replacing the destination with the symlink, regardless of whether the repo master already exists. Furthermore, candidate reconciled configurations must be validated for secrets/credentials in-memory before modifying the repository master file on disk, ensuring secrets never touch tracked files on refusal.

## Batch Email & Outreach Dispatch Safety

- **Batch Email & Outreach Dispatch Safety**: When implementing real outbound email or batch outreach commands (like `--send`), always provide explicit recipient filtering/exclusion options (`--venues`, `--skip`) so the user can selectively dispatch only approved candidates, ensuring code strictly supports the human-approval safety guarantees described in skill documentation.

