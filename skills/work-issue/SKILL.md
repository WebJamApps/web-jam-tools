---
name: work-issue
description: Start a model-labeled coding task under Claude Code or Antigravity. Use when the user types /work-issue <Repo>#<issue-num> (named mode), or /work-issue with no argument (auto-pick mode, reads ~/Dropbox/web-jam-llms/haiku-issues.md or flash-issues.md based on agent surface to resolve the next actionable issue), or says "work-issue", "next", "next task", or "start the next task". An Epic resolves to its startable children for Josh to choose from rather than being implemented directly. Before any code is written, checks the issue against the requirements document it cites and stops to report if the two disagree. Fetches the target GitHub issue, sets up a fresh git branch off dev, and implements it in that repo.
metadata:
  version: v3
  publisher: josh
aliases:
  - next
---

# /work-issue — run a model-labeled coding task (Claude Code & Antigravity)

This skill is installed across all agent surfaces (Claude Code, Antigravity/agy) and model tiers (Haiku, Flash, Sonnet, Opus). It delegates the deterministic setup (issue fetch + git branching) to a
shell script, then you (the agent) do the actual coding inside this same session.
Dispatch is always against a concrete GitHub issue (web-jam-tools#249 removed the
older stateful queue-file mode). There are two ways to arrive at that issue:

- **`/work-issue Repo#123`** (named mode) — the issue is given explicitly. Read the GitHub issue's model tier label (`Haiku`, `Flash Med`, `Flash High`, `Sonnet`, `Opus`) to determine agent delegation or session execution (valid for both Claude Code and Antigravity), then run the pre-checks below before "## Steps".
- **`/work-issue`** (no argument, auto-pick mode) — read-only resolve the next
  actionable issue from `~/Dropbox/web-jam-llms/haiku-issues.md` (when invoked via Claude Code / Haiku) or `~/Dropbox/web-jam-llms/flash-issues.md` (when invoked via Antigravity / Flash / agy), then hand off
  to the same flow below. See "## No-argument mode" first.

**Whichever route got you here, three pre-checks run before any branch is created or any code is
written**, and they run for a named issue and an auto-picked one alike:

1. **"## Epics — resolve to a child"** — an epic is a container with no diff of its own; it resolves
   to its startable children for Josh to pick from.
2. **"## Blocked-drift check"** — an issue carrying the `Blocked` label whose blockers are all closed (or has none) has drifted; stop and report rather than silently proceeding or assuming blocked.
3. **"## Design-sync check"** — an issue that contradicts the requirements document it cites is
   defective, and working it bakes the defect into a PR. Stop and report instead.

## Triggers & Aliases
- Primary Command: `/work-issue`
- Preserved Aliases: `next`, `next task`, `start the next task`, `work-issue`

## Model Label Check & Approval

When `work-issue` begins an issue (`<Repo>#<num>`):
1. **Read the GitHub issue's model label**: Read the issue's model tier label (`Haiku`, `Flash Med`, `Flash High`, `Sonnet`, `Opus`).
2. **Determine Agent Delegation vs Execution**:
   - Under **Claude Code** (e.g., Opus/Sonnet interactive session): If the issue is labeled `Haiku` or `Sonnet`, delegate execution to a subagent matching the labeled tier per delegation rules.
   - Under **Antigravity** (e.g., Flash High interactive session): If the issue is labeled `Flash Med`, automatically delegate execution down to a `Flash Med` subagent.
   - If the active session tier matches the issue's model label, execute the task directly in the current session.
3. **Prompt for approval before overruling**: If the active session tier differs from the issue's model label and the session intends to overrule the label rather than delegating down, prompt Josh for explicit approval in chat before executing:
   ```bash
   gh issue edit <num> --repo WebJamApps/<Repo> --add-label <NewTier> --remove-label <OldTier>
   ```
4. **Ensure author alignment**: Ensure the final `--author` passed to `create-draft-pr.sh` strictly matches the executing model tier (e.g., `--author "Antigravity — Gemini Flash (Medium)"` for Flash Med subagents, or `--author "Claude Code — Haiku 3.5"` for Haiku subagents).

## Startability test

An issue `<Repo>#<num>` is **startable** when it passes all four checks below:

1. **Still open**:
   ```bash
   gh issue view <num> --repo WebJamApps/<Repo> --json state -q .state
   ```
   returns `OPEN`. (Skips anything closed or merged.)

2. **Not blocked (actual blocker state outranks label)**:
   - **Native dependencies**: Query `blocked_by` dependencies via API:
     ```bash
     gh api repos/WebJamApps/<Repo>/issues/<num>/dependencies/blocked_by \
       --jq '.[] | select(.state == "OPEN") | "\(.repository.full_name)#\(.number) \(.state) — \(.title)"'
     ```
     Every native `blocked_by` dependency must be CLOSED (the query above returns no output).
   - **Body-named prerequisites**: Every prerequisite issue cited in the issue body must be CLOSED:
     ```bash
     gh issue view <n> --repo WebJamApps/<Repo> --json state -q .state
     ```
     returns `CLOSED`.
   - **Precedence rule**: The blocker's actual state is the truth and the label is a hint. Where they disagree, the label is what is wrong. The `Blocked` label alone does NOT veto startability if all native and body blockers are CLOSED (or none exist). If an issue carries the `Blocked` label but has zero open blockers, it is startable but triggers the **Blocked-drift check** below before implementation.
   - If any native blocker or body prerequisite is OPEN, the issue is **blocked by `<repo#number "title">`**.

3. **Not already in flight (with resume carve-out for fix-bucket PRs)**:
   - Check if an OPEN PR references it:
     ```bash
     gh pr list --repo WebJamApps/<Repo> --state open --json headRefName,body,reviews,commits,statusCheckRollup \
       --jq '.[] | select((.body // "") | test("(?i)(closes|part of)\\s+#<num>([^0-9]|$)"))'
     ```
   - **Fix-bucket resume carve-out**: If an OPEN PR exists for this issue, check whether it belongs to the **fix bucket** — having changes requested (one or more Must Fix items in its current automated review) or failing CI checks (`statusCheckRollup` has failures/errors). If so, the skill proceeds in **resume mode** rather than stopping:
     - No new branch is cut off `dev`.
     - It relies on the resume mechanism in `scripts/handle-agy-tasks.sh` (which auto-detects an existing branch or open PR for the issue and resumes the PR's head branch).
   - **Awaiting review (non-startable)**: If the OPEN PR is merely awaiting review (green CI with no review, or a clean approved review), the issue remains **non-startable** ("already in flight"). Stop and report that PR review or merge is pending.
   - For net-new issues with no open PR, verify no dispatch branch exists for it locally or on remote (`agy/<num>-*` from headless dispatch, `gemini/<num>-*` from interactive agy):
     ```bash
     git -C ~/WebJamApps/<Repo> for-each-ref --format='%(refname:short)' \
       "refs/heads/agy/<num>-*" "refs/heads/gemini/<num>-*"
     git -C ~/WebJamApps/<Repo> ls-remote --heads origin \
       "agy/<num>-*" "gemini/<num>-*"
     ```
     returns nothing (unless in resume mode for an existing branch).

4. **Not already done (completion detection)**:
   - **Signal 1 (Merged or closed PR)**: Query for merged or closed PRs whose body references the issue with `Closes` or `Part of`:
     ```bash
     gh pr list --repo WebJamApps/<Repo> --state merged --json headRefName,body \
       --jq '.[] | select((.body // "") | test("(?i)(closes|part of)\\s+#<num>([^0-9]|$)")) | .headRefName'
     ```
     If a merged or closed PR already addressed the issue, the issue is **appears already done: verify and close** (not startable).
   - **Signal 2 (Concrete mechanically checkable end state)**: When the issue's acceptance criteria name a concrete, mechanically checkable end state — a filesystem path that must exist or must not exist (e.g. `test -d /path` or `test -f /path`), or a deterministic command whose exit status decides the matter — verify that state directly.
     - *Priority for `Josh`-labeled manual steps*: `Josh`-labeled manual steps never produce a PR, so Signal 1 can never detect them. Prioritize checking their concrete end states directly (e.g. verifying an obsolete backup directory was deleted).
     - *Bounded scope*: Only mechanically checkable criteria are verified directly. Do not attempt open-ended verification of arbitrary prose criteria, keeping check costs flat.
   - If either signal indicates completion, the issue is classified as **appears already done: verify and close**.
   - **Read-only rule**: This check is strictly read-only. It never closes an issue, comments on an issue, or edits a label on its own. It reports the completion evidence and lets Josh verify and close it.

## No-argument mode — auto-pick worklist based on agent surface

Use this when the user types `/work-issue` with no argument, or says "work-issue" / "next" /
"next task" / "start the next task" without naming an issue.

Determine which worklist file to read based on your agent surface:
- **Claude Code (Haiku session)**: Read `~/Dropbox/web-jam-llms/haiku-issues.md`.
- **Antigravity (Flash / agy session)**: Read `~/Dropbox/web-jam-llms/flash-issues.md`.

This mode is **read-only** against the target worklist file — never edit
that file. It only resolves a concrete `Repo#num`, then continues at step 1 of
"## Steps" below exactly as if that issue had been named — everything from
there on (setup, model selection, coding, PR) is identical and unmodified.

### Resolution steps

1. Select the target worklist file based on the active agent surface:
   - When running under **Claude Code** (Haiku), select `~/Dropbox/web-jam-llms/haiku-issues.md`.
   - When running under **Antigravity** (Flash / agy), select `~/Dropbox/web-jam-llms/flash-issues.md`.
   Read the selected worklist file. If it's missing, empty, or has no numbered items, stop and tell Josh: "<filename> is missing/empty — run the corresponding worklist skill first." Do not improvise a substitute list.
2. Parse **only** the numbered runnable list at the top of the file — the
   `N. [Repo#num](...) — title (Model)` lines that appear **above** the
   `## Blocked` heading. Ignore the `## Blocked` and `## Needs Josh's review`
   sections (and anything else) entirely. Extract, in file order, each line's
   `Repo` and issue `num`.
3. Walk the extracted list top-to-bottom. For each `Repo#num`, evaluate it using the **Startability test** above and pick the **first** one that is startable (still open, not blocked by any open native or body prerequisite, not already in flight, and not already done).

   Skip any item that is closed, blocked by an open dependency, already in flight, or appears already done, and move to the next line.
4. If a candidate passes, that is the pick. Resolve it to `Repo#num` and continue to the pre-checks (Blocked-drift check and Design-sync check) and step 1 of "## Steps" below — i.e. run `~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --setup-only <Repo>#<num>` and follow steps 2 onward exactly as written for the named-issue flow.
5. If you reach the end of the list with no candidate passing (every item is closed, blocked, already in flight, or appears already done), stop and tell Josh: "every item in <filename>'s runnable list is closed, blocked, already in flight, or appears already done — re-run the corresponding worklist skill to refresh it." Do not improvise a substitute list, and do not fall back to the Blocked or Needs-review sections.

Never write to the worklist files (`haiku-issues.md` or `flash-issues.md`) in this mode — they are read-only input.

## Epics — resolve to a child, never implement the epic itself

Run this **before** anything else, as soon as an issue is named.

```bash
gh issue view <num> --repo WebJamApps/<Repo> --json title,body --jq .title
gh api repos/WebJamApps/<Repo>/issues/<num> --jq '.type.name // "none"'
```

If the native issue type is **`Epic`**, do NOT set up a branch and do NOT try to implement it. An
epic is a container: it has no diff of its own and closes only when its children close. Instead:

1. **Run the design-sync check below against the EPIC ITSELF, first.** An epic drifts from its
   requirements document exactly as a child does, and it drifts worse: it is long-lived, it is where
   people read for context, and nothing forces anyone back to it once the children are filed. This
   is not hypothetical — on 2026-08-13 an epic was found still describing its mechanism as
   undecided and its key measurement as unperformed, a day after both were settled in the document,
   while every one of its children was in sync. Checking only children would have missed it.
   If the epic is out of sync, stop and report before listing anything.
3. List its children and their state:

   ```bash
   gh api repos/WebJamApps/<Repo>/issues/<num>/sub_issues \
     --jq '.[] | "\(.number)\t\(.state)\t[\(.labels | map(.name) | join(","))]\t\(.title)"'
   ```

4. For each OPEN child, work out its status using the **Startability test** above:
   - Check native `blocked_by` dependencies and body-named prerequisites.
   - Check if an open PR or dispatch branch exists.
   - Check if the child appears already done (via merged PR or concrete mechanically checkable acceptance criteria).
   - (Remember: the `Blocked` label alone does not veto startability; actual blocker state is the truth.)
5. Report the children to Josh as a numbered list, marking each:
   - **startable** (or **startable (blocked drift: carries Blocked label with 0 open blockers)**),
   - **blocked by `<repo#number "title">`** (if any native blocker or body prerequisite is OPEN),
   - **already in flight** (if an open PR or dispatch branch exists), or
   - **appears already done: verify and close** (if a merged PR references it or concrete acceptance criteria are already satisfied).
   Cite every issue as `repo#number "title"` — a bare number is unusable.
6. **Stop and let Josh choose which child to work.** Do not auto-pick, and never pick more than one:
   sibling children of one epic frequently touch the same repo, and two agents in one repo collide.
7. Once he names a child, restart this skill from the top with that child as the target. The
   pre-checks (Blocked-drift check and Design-sync check) run again, this time against the child — the epic passing does not vouch for its children, and a child passing does not vouch for the epic. Both are checked, always.

If the type is anything other than `Epic`, continue.

## Blocked-drift check — run BEFORE working the issue

An issue can carry a stale `Blocked` label after all its blockers have closed, or carry the label when no native dependencies or body prerequisites ever existed. Because the blocker's actual state outranks the label (the blocker state is the truth and the label is a hint), the label alone does not prevent the issue from being worked, but the disagreement is drift that must be brought to Josh's attention before proceeding.

1. Check if the target issue carries the `Blocked` label:
   ```bash
   gh issue view <num> --repo WebJamApps/<Repo> --json labels --jq '.labels[].name'
   ```
2. If `Blocked` is present:
   - Query native `blocked_by` dependencies:
     ```bash
     gh api repos/WebJamApps/<Repo>/issues/<num>/dependencies/blocked_by \
       --jq '.[] | "\(.repository.full_name)#\(.number) \(.state) — \(.title)"'
     ```
   - Check any prerequisites cited in the issue body.
3. Evaluate for drift:
   - If there are **OPEN** native blockers or **OPEN** body prerequisites: The issue is genuinely blocked. Stop and report the blocker(s) (`<repo#number "title">`) to Josh.
   - If **ALL** native blockers and body prerequisites are **CLOSED** (or **NONE** exist): The issue carries the `Blocked` label despite having zero open blockers. This is **blocked drift**.
4. If blocked drift is detected:
   - **Stop and report the drift to Josh**: Report that `<Repo>#<num> "<title>"` carries the `Blocked` label, but all native and body blockers are closed (or none exist).
   - Show the blocker state receipts.
   - Ask Josh for confirmation before proceeding to create a branch or implement the issue.
   - **Do NOT silently proceed** and do NOT silently ignore the label.
   - **Once Josh confirms the drift**, remove the stale `Blocked` label from the target issue (the child, if `/work-issue` was invoked against an Epic and resolved to a child — never the Epic, never any sibling) before continuing to the Design-sync check and Steps:
     ```bash
     gh issue edit <num> --repo WebJamApps/<Repo> --remove-label Blocked
     ```
     Only remove the label after Josh's confirmation — never before, never silently.
5. If no `Blocked` label is present (and no open blockers exist):
   - Continue to the Design-sync check.

This check is read-only up to the point of Josh's confirmation of blocked drift. The only write it may ever perform is removing that one stale `Blocked` label from the target issue after he confirms — it never edits dependencies, issue bodies, any other label, or any issue other than the target. Bulk/sweep drift repair across the backlog remains the job of `/backlog-groom`; it is not the only path for the single issue in front of you.

## Design-sync check — run BEFORE working the issue

An issue can go stale when the requirements document it was written from changes and the issue is
never updated. That has happened: an issue's acceptance criteria contradicted its own cited design
section, an agent followed the issue rather than the document, and it wrote to a file outside every
git repository to satisfy a criterion that should not have existed. Catch it here, before any code
is written.

1. Read the target issue body and look for a `## Design reference` block naming a requirements
   document and section(s).
   - **No such block** — say so plainly ("this issue cites no design document, so it cannot be
     checked for drift") and continue. Do not invent a document to check against.
2. Read the cited document at the cited sections. **If the path cannot be read, STOP and say so.**
   Do not proceed on the issue body alone — the whole point of the pointer is that the document, not
   the issue, carries the requirements.
3. Compare the issue's `## What this builds` items and its acceptance criteria against those
   sections. You are looking for one thing: **does the issue assert something the document
   contradicts, or require something the document says is out of scope?**
4. Report the result before doing any work:
   - **In sync** — one line saying so, then continue to Steps.
   - **Out of sync** — stop. Report each conflict as a table: what the issue says, what the document
     says, and which section. Then ask Josh whether to fix the issue first. **Do not pick a side and
     do not proceed** — if the two disagree, that is a defect in the issue, and working it either way
     bakes the defect into a PR.
5. Only after Josh says the issue is correct (or has had it corrected) do you continue to Steps.

This check is read-only. It never edits the issue or the document on its own.

## Steps

1. Run this shell command (with the target issue the user named) and read
   its stdout:

   ```
   ~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --setup-only CollegeLutheran#123
   ```

2. The script prints a block like:

   ```
   === GEMINI-TASK READY ===
   REPO_DIR: /home/joshua/WebJamApps/<repo>
   BRANCH: gemini/<slug>
   === TASK PROMPT (implement this) ===
   <the task + standing rules>
   === END TASK ===
   ```

   The branch is **already created and checked out** off fresh `dev`. If the script
   exits non-zero (dirty tree, missing repo, bad/missing issue argument), stop and
   report its error to the user — do not improvise.

3. **Perform Model Label Check & Model Selection:** Before implementing:
   - Perform the **Model Label Check**:
     1. Read the GitHub issue's model label (`Flash Med`, `Flash High`, `Haiku`, `Sonnet`, `Opus`).
     2. Compare the issue's model label against the active executing session tier.
     3. If the active session tier differs from the issue's model label and the session intends to overrule the label, prompt Josh for explicit approval in chat before executing `gh issue edit <num> --repo WebJamApps/<Repo> --add-label <NewTier> --remove-label <OldTier>`.
     4. Ensure the final `--author` passed to `create-draft-pr.sh` strictly matches the executing model tier.
   - Classify the task to determine the most cost-effective model that can succeed. Switch to it by outputting the slash command exactly like `/model "Model Name"` on a new line and wait for the switch to complete.

   **Model Chain (Most to least capable):**
   1. `Claude Opus 4.6 (Thinking)`
   2. `Claude Sonnet 4.6 (Thinking)`
   3. `Gemini 3.1 Pro (High)`
   4. `Gemini Flash (High)`

   There are only **two independent quota pools** (verified — web-jam-tools#79):
   `{Claude Opus/Sonnet}` and `{Gemini Pro/Flash}`. `GPT-OSS 120B` shares Claude's
   pool, so it is **not** a usable fallback (it's dead whenever Claude is) and is
   excluded from the chain. Failover only ever crosses Claude ↔ Gemini.

   **Classification Rules (in priority order):**
   * **Explicit Override**: If the user passed an explicit model name when invoking `/work-issue`, use it and skip classification.
   * **Task-Line Tag**: If the TASK PROMPT contains an explicit tag (e.g., `[media]`, `[junior]`, `[simple]`) or a model name, this tag wins.
   * **Hard Media Override**: If the task involves audio/video files (`.mp3`, `.wav`, `.m4a`, `.mp4`, `.mov`, `.webm`, etc.), it **MUST** go to `Gemini 3.1 Pro (High)`. Claude cannot ingest these. (*Note: `.svg` is NOT media, it is XML/markup, so it rides the difficulty ladder.*)
   * **Difficulty Routing**:
     * *Trivial / Junior-dev*: (rename, one-liner, simple mechanical edit, simple image/PDF read) → `Gemini Flash (High)` (or `Gemini 3.1 Pro (High)` for image/PDF reads).
     * *Ordinary Coding*: → `Claude Sonnet 4.6 (Thinking)`.
     * *Complex / Multi-file / Real Judgment*: (including complex SVG/diagram tasks) → `Claude Opus 4.6 (Thinking)`.
   * **Tie-breaker**: If classification is genuinely ambiguous, default to `Claude Opus 4.6 (Thinking)`.

   **Rate-limit Fallback**: If the switch to your chosen model fails (e.g., rate limit), fall back to the next-capable available model in the chain. Because Claude and Gemini are the only two pools, this effectively means: if a Claude model is walled, cross to Gemini (and vice versa).

4. Work **entirely inside `REPO_DIR`**: cd there first; every file edit, command,
   and commit happens in that directory. Read and follow that repo's `AGENTS.md`
   (or `GEMINI.md`) for its conventions.

5. Implement the task from the TASK PROMPT. Commit incrementally with clear,
   conventional messages as you go.

6. Before declaring done, run the repo's lint and test commands and fix issues
   until both pass. Find the exact script names in the repo's AGENTS.md/GEMINI.md
   and its `package.json` "scripts" (commonly `npm run lint` and `npm test`; some
   repos use `npm run test:lint` and `npm run test:unit`).

7. Do **not** switch branches or add dependencies. When lint and tests are green,
   finish by opening a draft PR. **Your summary and the real test output go IN THE
   PR, not only in this chat reply** — pass them as flags so the PR description is
   complete:

   ```
   ~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
     --author "<Surface> — <Model>" \
     --summary "<what changed and why>" \
     --test-plan "<exact commands to verify + expected result>" \
     --test-evidence "<the actual lint + test output you saw, confirming both ran green>" \
     --part-of   # include ONLY if the issue must stay open (partial PR / run-log / epic)
   ```

   The script is the single source of truth (web-jam-tools#49) and **refuses to open a
   PR with an empty or placeholder description** (web-jam-tools#77) — so `--summary`,
   `--test-plan`, and `--test-evidence` are required. By default the PR closes the issue
   on merge (`Closes #N`); pass `--part-of` ONLY when the issue must stay open (`Part of #N`
   for a partial PR, or a standing run-log/epic issue). (`--closes` is a deprecated no-op,
   still accepted.) Never run `gh pr create` directly. Josh reviews the diff and flips the draft → ready on GitHub.

## PR body formatting (do this every time)

The script drops your `--summary` / `--test-plan` / `--test-evidence` values
**verbatim** under their headers — it does not reformat them, so professional
formatting is **your** job. Fill every flag with proper markdown:

- **Summary** → **bullet points**, one change per bullet — never a single run-on
  sentence.
- **Shell commands** → a fenced ` ```sh ` code block, never inline prose.
- **HTML or code** → wrap every `<tag>`, snippet, or symbol in backticks or a fenced
  block so GitHub renders it literally. Never pass a raw `<sup>35</sup>`-style tag as
  prose — GitHub renders or swallows it and garbles the body.
- **Before/after** → add a short before → after snippet when it aids clarity.

Example of a well-formed call (bulleted summary, fenced commands + output):

`````
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
  --author "<Surface> — <Model>" \
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
`````
