# Agent Instructions for WebJamApps

This file contains instructions and context for every AI agent (Claude Code, agy/Antigravity, and
any other assistant) working in this workspace.

<!-- CROSS-AI-HARD-RULES-START -->
## OPERATIONAL HARD RULES (apply to any AI taking action on Josh's behalf)

- CALENDAR CONFLICT: never schedule over an existing event without Josh's explicit override.
- EMAIL: always DRAFT, never send. Save as Gmail draft for Josh's review.
- FILES: never create a version-suffixed copy. Edit the master.
- Never contact venues, churches, or other third parties directly — Josh handles all outreach.
- **STATE VERIFICATION**: Before any suggestion, to-do item, or "ready for you" claim about a
  PR/issue/CI/deploy, run a fresh liveness check in that same turn (e.g.
  `gh pr view --json state,mergedAt` / `gh issue view --json state`). If state ≠ OPEN, it is done:
  drop it silently. `mergeable: UNKNOWN/null` on a PR usually means merged/closed — never read it as
  "the API is slow" and never advise merging without confirming state=OPEN. An inconclusive check is
  not a completed check: use a definitive fallback (local `git merge-tree`, `statusCheckRollup`) or
  say plainly that you could not verify — never hand Josh a verification step the agent can run
  itself.
- **ONE REPO, ONE SESSION**: never edit a repo another AI session is actively working (Josh,
  2026-07-11). Before branching or editing, check `git status -sb` — a non-`dev` branch or dirty
  tree means another session likely has the repo in flight. Hand the change to that session/lane
  (route via Josh) or ask Josh first. A separate worktree or non-colliding branch does NOT make
  concurrent edits OK — parallel semver bumps and surprise PRs still collide.
- **MAX 2 CONCURRENT WORKSTREAMS PER TERMINAL**: Two live background jobs (e.g. a subagent + a
  headless agy dispatch) is the cap. When a THIRD thread (new discussion, dispatch, or background
  job) starts in the same session, the agent must WARN Josh first and propose a separate terminal —
  never comply silently. Origin: 2026-07-16, Claude A froze mid-permission-prompt while running a
  Sonnet subagent + a headless agy dispatch plus a new discussion; recovery required keystroke
  injection from another session.
- **ISSUE CITATIONS ALWAYS CARRY REPO + NUMBER + TITLE**: Every mention of a GitHub issue or PR — in
  chat, in a commit message, in an issue/PR body, in a memory or queue file — must be written as
  `repo#number "title"`, e.g.
  `web-jam-back#998 "email subject or title still not easy for  me to see its target venue"`. **`#`
  followed by digits is an ILLEGAL token in anything Josh reads.** There is no exception for a
  repeat mention, a list item, a parenthetical, "the one I just named", or a closing one-line offer.
  If you don't know the title, look it up (`gh issue view N --repo R --json title`) before writing
  the sentence — never emit a bare number as a placeholder. If the full citation is too verbose,
  shorten to the TITLE, never to the number. The violation is almost always the LAST sentence of a
  message (the "want me to do X?" offer, written after the careful part), so re-read the finished
  message and check every `#` before sending. Josh has asked for this five times (2026-07-24 →
  2026-07-29); he reads these on a phone with many numbers in flight and a bare number costs him a
  lookup every time.
- **NO AGENT CONNECTS A NEW ACCOUNT, CREDENTIAL, OR MCP SERVER WITHOUT AUTHORIZATION:** No agent
  adds a connector, account, credential, or MCP server to any Claude or Flash surface without Josh's
  explicit authorization naming it. Discovering that something _could_ be connected is never
  permission to connect it. This applies to new OAuth grants, new MCP servers, new API tokens, and
  widening the scope of an existing connection. Origin (2026-07-30, Josh): _"it should NEVER have
  something else that I have not authorized."_ See web-jam-tools#324 "No agent connects a new
  account, credential, or MCP server without Josh's explicit authorization — add the rule and audit
  where it can be mechanically enforced" for the enforcement-surface audit.
- **NO AI CLOSES OR REOPENS A GITHUB ISSUE AUTONOMOUSLY:** No agent may close (`gh issue close`) or
  reopen (`gh issue reopen`) any GitHub issue without Josh's explicit authorization in chat naming
  that specific issue. Always ask Josh for permission first before executing any issue close or reopen
  command.
- **STANDING AGENT CREDENTIAL CLASSIFICATION RULE (MACHINE-CONSUMED VS HUMAN-CONSUMED):** Whenever
  an agent encounters or generates a new credential, account identifier, or token, the agent must
  **STOP and prompt Josh to classify it** as either machine-consumed (e.g. `GITHUB_TOKEN`,
  `GEMINI_API_KEY`, `HEROKU_API_KEY`, `CIRCLECI_TOKEN`, `DENO_DEPLOY_TOKEN` stored in shell rc or
  secret store) or human-consumed (e.g. `webjam.claude@gmail.com` stored in KeePass only) BEFORE
  storing, exporting, or configuring it in any shell profile, `.env` file, or configuration file.
  Human-consumed credentials belong in KeePass only and must never be exported to shell profiles or
  stored in application configuration files (web-jam-tools#344 "Human-only credentials register and
  guard hook").
- **NO AI DELETES OR FORCE-PUSHES A REMOTE BRANCH, EVER, WITHOUT AN EXPLICIT IMPERATIVE FROM JOSH
  NAMING THAT BRANCH.** "The PR is merged" is NOT such an instruction — it states a fact, it does
  not authorize deleting anything. Local branch cleanup after a merge (deleting a LOCAL branch with
  `git branch -d`/`-D`, `git fetch --prune` to prune stale local remote-tracking refs) remains
  permitted and unchanged — this rule narrows that standing post-merge cleanup habit to local
  branches only, it does not remove it or require re-approval for it. Enforced by three independent
  layers: a harness `permissions.deny` block on the ways `git push`/`git branch` can delete or
  clobber a remote ref (`--delete`/`-d`, empty-source colon refspecs,
  `--force`/`-f`/`--force-with-lease`, `--mirror`, `--prune`, and `git branch -D`/`--delete --force`
  against a `remotes/` ref — installed via `scripts/install-hooks.sh` in this repo), a GitHub
  ruleset restricting deletions on the branches agents create (`claude/**`, `agy/**`, `dev`, `main`
  — Josh-only UI work, see web-jam-tools#308 "Remote branches can be deleted by an agent with no
  authorization — advisory guard does not block (3 layers: deny rules, GitHub ruleset, HARD
  RULES)"), and this HARD RULE. Origin: 2026-07-29, an agent deleted
  `claude/cross-ai-rules-issue-citation-hard-rule` from `web-jam-tools` immediately after Josh
  merged web-jam-tools#307 "Add ISSUE CITATIONS hard rule to operational rules" — Josh had only said
  the PR was merged, never authorized a deletion, and the `PreToolUse` guard that fired was advisory
  text an agent could rationalize past.
- **REAPER RECORDING SESSIONS & RATE LIMIT SAFETY:** When running REAPER music recording sessions
  via Reaper MCP:
  1. REAPER DAW, audio interfaces, recorded WAV audio stems, and `.RPP` project files live locally
     on the user's computer and are 100% safe from rate limit interruptions.
  2. Google does NOT broadcast an advance warning gauge prior to hitting temporary hourly rate
     limits (`429 Rate Limit Exceeded`).
  3. Use **`Flash Med`** for routine, high-volume REAPER operations (`transport_play`,
     `transport_stop`, `track_create`, volume/pan tweaks, clip splits) to preserve hourly token
     headroom.
  4. Reserve **`Flash High`** for complex multi-track creative mixing, sidechain routing, and
     intricate composition passes.
  5. Always execute a project save (`project_save`) before running large multi-step automated
     sequences.
- **MAIN BRANCH PRs MUST ORIGINATE FROM DEV:** Across all 8 active WebJamApps repos, any PR
  targeting `main` must originate from `dev` as its head branch (`dev` → `main`). Feature branches
  (`gemini/*`, `claude/*`, `feat/*`, `fix/*`) must target `dev` as their base branch. Direct PRs
  from feature branches to `main` are strictly forbidden and blocked by CI and script guardrails
  (web-jam-tools#351 "all 8 active github repos - their main branch only accepts PR requests from
  their dev branch").
- **MULTI-REPO ISSUES STAY OPEN UNTIL ALL REPOS ARE COMPLETE:** When an issue explicitly covers
  multiple repositories (e.g. "all 8 active github repos"), no single PR in one repository may pass
  `--closes` or claim the issue is completed. PRs in individual repos must use `--part-of` so the
  tracking issue remains OPEN until the final repository's PR is merged.
- **POST-MERGE MANUAL STEPS AND THE `--no-close` FLAG:** When an issue has any acceptance criterion
  requiring a manual step after the merge — an installer run, a session restart, a scheduled/cron
  cycle, a prod deploy, a third-party dashboard change — the PR must use `--no-close` (with an
  optional reason via `--no-close-reason "<text>"` or `--no-close-reason-file PATH`) when opening or
  updating the PR using `scripts/create-draft-pr.sh`. The issue is closed by hand once those
  post-merge steps are verified.
  - **PR-open-time test:** Before opening a PR, check: _does any acceptance criterion require
    something an implementing agent cannot do from a branch?_ If yes, pass `--no-close`.
  - **Verification command:** To verify that a PR does not close its linked issue, run:
    ```bash
    gh pr view <N> --repo WebJamApps/<repo> --json closingIssuesReferences
    ```
    An **empty array** (`[]`) in `closingIssuesReferences` is the only valid proof that GitHub will
    not auto-close the issue on merge. Body text prose alone is NOT proof, because GitHub parses the
    keyword rather than prose.
- **THE `Blocked` LABEL IS CANONICAL — NATIVE ISSUE DEPENDENCIES DO NOT REPLACE IT.** Josh wants
  BOTH: native GitHub issue-dependency links (the real relationship between issues) AND the
  `Blocked` label (capital B, hex `B60205`, `repos: all` in `skills/fix-labels/labels.yaml`) as the
  at-a-glance signal that makes an unworkable issue obvious in a plain list view without opening
  each issue. They do different jobs: use a native dependency whenever a **specific issue** blocks
  the work — it names which one, renders in the Issues list, and clears itself on close. Use the
  `Blocked` label whenever the work is unworkable **for any reason**, including the many with no
  issue to point at (a vendor, a credential Josh must generate, a physical action). Native
  dependencies cannot express that case at all, which is why the label is not redundant. No agent
  may prune `Blocked` from `labels.yaml` (or delete it live) on the theory that native dependencies
  made it redundant — that is exactly what happened once already: `blocked` (lowercase) was removed
  in commit 7d2523d as part of a nine-label prune shipped for web-jam-tools#300, justified as "->
  native issue dependencies," and Josh never actually agreed to that one — it rode along in a batch
  whose headline was about priority labels. web-jam-tools#329 "Restore the Blocked label as
  canonical in labels.yaml — it was pruned in a batch Josh never ratified, and he wants it alongside
  native dependencies" restored it. See `skills/fix-labels/labels.yaml`'s `Blocked` entry for the
  full rationale.
- **RESTRICTED LAPTOP DROPBOX SCOPE & SECURITY GUARDRAILS:** Access to `~/Dropbox` on the laptop is
  restricted to three approved top-level folders: `joshandmariamusic`, `web-jam-llms`, and
  `mark_henrickson`. All other top-level `~/Dropbox/*` folders — including `Dropbox/WebJamApps` —
  are explicitly denied in `permissions.deny` via `install-hooks.sh` for file tools (`Read`, `Edit`,
  `Write`) and Dropbox MCP mutation tools (`delete`, `move`). Note: Deny rules on file tools do not
  constrain raw Bash commands (which use string-pattern matching for Bash permission rules), serving
  as an operational guardrail rather than an absolute security boundary (web-jam-tools#321 "Add the
  laptop Dropbox deny list, verify Flash confinement, and document the restricted scope").
- **APPROVAL IS PER GATE.** Approval of a design is not approval to file the tracking issue.
  Approval of an issue is not approval to dispatch. Each gate needs its own imperative from Josh
  naming that step. An agent writes the issue body to a file (or shows it in chat) and waits; the
  `gh issue create` call (or MCP `issue_write` create) follows only the words "file it" (or
  equivalent). A dispatch (spawning a subagent, an agy/Flash handoff) follows only an explicit
  instruction to dispatch. A single "go" is ambiguous across gates and must never be read as
  covering more than one — the expensive, hard-to-reverse half (issue noise, spawned tokens) is
  always the later gate, so collapsing gates fails in the direction that costs the most. Origin:
  2026-08-07, during web-jam-tools#426 "/handle-gmails: add recognizers that propose the follow-up
  work an email implies, plus a per-session PR that teaches the skill what it learned" design, an
  agent treated Josh's single approval of a three-item plan as covering the design, the issue
  filing, AND the dispatch — announcing "filing the tracking issue, then dispatching to Sonnet"
  before either gate had its own go-ahead. Josh stopped it at the draft stage. See web-jam-tools#433
  "gate issue creation and dispatch mechanically, and write the approval-is-per-gate rule" for the
  mechanical half of this fix (ask-rules on `gh issue create` and MCP `issue_write` create,
  installed via `scripts/install-hooks.sh`).
- **ACCURATE TEST ASSERTIONS FOR NEWLY IMPLEMENTED FEATURES:** When writing unit tests for new
  features or CLI flags (such as mode-modifying flags like `--update` or `--no-close`), test
  assertions must explicitly verify the specific mode indicator or feature-specific output (e.g.
  asserting `DRY RUN (UPDATE` or exact flag output) to prove the feature took effect, rather than
  relying only on assertions shared with default paths.
- **DESIGN WORK RUNS THROUGH `/issue-design`:** Design work — options, trade-offs, decisions worth
  recording — does not happen in plain chat. The moment a conversation turns into design, invoke
  `/issue-design` and work inside it.
<!-- CROSS-AI-HARD-RULES-END -->

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

## Opening pull requests (all WebJamApps repos)

Finish a coding task by running the shared script — never `gh pr create` directly. This applies
**however the task was started** (via `/work-issue` / `/next` or just told to work an issue ad-hoc).
Put your summary and the **real test output** IN THE PR via the flags — not only in the chat reply:

```
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
  --author "<tool> — <model>" \
  --summary "<what changed and why>" \
  --test-plan "<exact commands to verify + expected result>" \
  --closes   # include ONLY if this PR fully completes the issue; omit for a partial PR
```

`--summary` and `--test-plan` are **required** — the script **refuses to open a PR with an empty or
placeholder description** (web-jam-tools#77).

`--test-evidence` is **OPTIONAL and normally omitted.** Always run the suites and confirm they pass
before opening the PR, but do **not** paste unit-test runner output into the body — the numbers are
noise to the reviewer, and CI already reports pass/fail. Reserve the flag for evidence CI cannot
show: a manual reproduction, a `curl` response, or a described screenshot. A PR with no "Test
evidence" section is correct, and a reviewer must never raise a finding about its absence. It always
opens a **draft** PR based on **`dev`**, with the issue number derived from the
`<lane>/<issue#>-<slug>` branch name (or explicit `--issue` flag, which supports full URLs,
`OWNER/REPO#N`, or bare `#N`/`N` and formats cross-repo closing lines as `Closes OWNER/REPO#N`) and
a footer naming the tool + model (hard invariants — no flag overrides them). By default it
references the issue (`Part of #N` or `Part of OWNER/REPO#N`); pass `--closes` to make it the
completing PR (`Closes #N` or `Closes OWNER/REPO#N`). Josh alone reviews and flips draft → ready.
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
```" \
  --closes
````

### PR version-bump convention

Every PR must bump the version once, on its first commit — `deno.json` in this repo (e.g.
`"version": "1.26.x"`). CI's "Version bump check (PR branches only)" gate blocks PRs whose version
is unchanged from the merge-base with `dev`. Always bump `deno.json` on the first commit of any new
PR branch in `web-jam-tools` to prevent CircleCI gate failures. When invoking `create-draft-pr.sh`,
pass multi-line or rich markdown values using `--summary-file`, `--test-plan-file`, and
`--test-evidence-file` pointing to files (e.g. in scratch/) to prevent shell argument escaping or
flattening issues.

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
  - Redirect large multi-line summaries, test plans, and evidence to scratch files
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
    `--author "Antigravity — Gemini 3.6 Flash (Medium)"` for Flash Med subagents) when calling
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
  argument to `deno deploy` (e.g. `deno deploy . --org webjamapps --app web-jam-uptime --prod`).
  NEVER pass an individual file path like `src/uptime/cron.ts` as the positional root argument
  because Deno Deploy will set `/tmp/build/src` as the working directory, isolating it from root
  project files (`deno.json`, `./monitor.ts`) and causing builds to hang or fail looking for
  dependencies.
- **Entrypoint Configuration in `deno.json`**: Entrypoint must be configured inside `deno.json`
  under `"deploy": { "entrypoint": "src/uptime/cron.ts" }`. Do NOT pass `--entrypoint` to
  `deno deploy` (without `create`), as `--entrypoint` is only a subcommand flag for
  `deno deploy create`.
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
