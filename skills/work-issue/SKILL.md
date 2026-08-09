---
name: work-issue
description: Start a model-labeled coding task under Claude Code or Antigravity. Use when the user types /work-issue <Repo>#<issue-num> (or alias /next <Repo>#<issue-num>) (named mode), or /work-issue with no argument (auto-pick mode, reads ~/Dropbox/web-jam-llms/haiku-issues.md or flash-issues.md based on agent surface to resolve the next actionable issue), or says "work-issue", "next", "next task", or "start the next task". Fetches the target GitHub issue, sets up a fresh git branch off dev, and implements it in that repo.
metadata:
  version: v1
  publisher: josh
aliases:
  - /next
  - next
---

# /work-issue — run a model-labeled coding task (Claude Code & Antigravity)

> **Alias**: `/next` (and phrases like `next`, `next task`, `start the next task`) is preserved as an active alias for `/work-issue`.

This skill is installed across all agent surfaces (Claude Code, Antigravity/agy) and model tiers (Haiku, Flash, Sonnet, Opus). It delegates the deterministic setup (issue fetch + git branching) to a
shell script, then you (the agent) do the actual coding inside this same session.
Dispatch is always against a concrete GitHub issue (web-jam-tools#249 removed the
older stateful queue-file mode). There are two ways to arrive at that issue:

- **`/work-issue Repo#123`** (or `/next Repo#123`, named mode) — the issue is given explicitly. Read the GitHub issue's model tier label (`Haiku`, `Flash Med`, `Flash High`, `Sonnet`, `Opus`) to determine agent delegation or session execution (valid for both Claude Code and Antigravity), then go straight to "## Steps" below.
- **`/work-issue`** (or `/next`, no argument, auto-pick mode) — read-only resolve the next
  actionable issue from `~/Dropbox/web-jam-llms/haiku-issues.md` (when invoked via Claude Code / Haiku) or `~/Dropbox/web-jam-llms/flash-issues.md` (when invoked via Antigravity / Flash / agy), then hand off
  to the same "## Steps" flow below. See "## No-argument mode" first.

## Triggers & Aliases
- Primary Command: `/work-issue`
- Preserved Aliases: `/next`, `next`, `next task`, `start the next task`, `work-issue`

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
4. **Ensure author alignment**: Ensure the final `--author` passed to `create-draft-pr.sh` strictly matches the executing model tier (e.g., `--author "Antigravity — Gemini 3.6 Flash (Medium)"` for Flash Med subagents, or `--author "Claude Code — Haiku 3.5"` for Haiku subagents).

## No-argument mode — auto-pick worklist based on agent surface

Use this when the user types `/work-issue` (or `/next`) with no argument, or says "work-issue" / "next" /
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
3. Walk the extracted list top-to-bottom. For each `Repo#num`, test it in order
   and pick the **first** one that passes BOTH checks:
   - **Still open**:
     `gh issue view <num> --repo WebJamApps/<Repo> --json state -q .state`
     returns `OPEN`. (Skips anything closed/merged even if the file is stale.)
   - **Not already started** — neither of these is true:
     - an OPEN PR already references it:
       ```
       gh pr list --repo WebJamApps/<Repo> --state open --json headRefName,body \
         --jq '.[] | select((.body // "") | test("(?i)(closes|part of)\\s+#<num>([^0-9]|$)")) | .headRefName'
       ```
       returns something (this mirrors the same PR-matching pattern
       `handle-agy-tasks.sh` uses for its own resume detection); OR
     - a dispatch branch already exists for it — check both the naming
       prefixes `handle-agy-tasks.sh` actually creates/resumes
       (`agy/<num>-*` from headless dispatch, `gemini/<num>-*` from an
       interactive agy run):
       ```
       git -C ~/WebJamApps/<Repo> for-each-ref --format='%(refname:short)' \
         "refs/heads/agy/<num>-*" "refs/heads/gemini/<num>-*"
       git -C ~/WebJamApps/<Repo> ls-remote --heads origin \
         "agy/<num>-*" "gemini/<num>-*"
       ```
       (the second command catches a branch that only exists on the remote,
       not yet fetched locally) returns something.

   Skip any item failing either check and move to the next line.
4. If a candidate passes both checks, that's the pick. Resolve it to
   `Repo#num` and continue at **step 1 of "## Steps" below** — i.e. run
   `~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --setup-only <Repo>#<num>`
   and follow steps 2 onward exactly as written for the named-issue flow.
5. If you reach the end of the list with no candidate passing (every item is
   closed or already in flight), stop and tell Josh: "every item in <filename>'s runnable list is closed or already in flight — re-run the corresponding worklist skill to refresh it." Do not improvise a substitute list, and do not fall back to the Blocked or Needs-review sections.

Never write to the worklist files (`haiku-issues.md` or `flash-issues.md`) in this mode — they are read-only input.

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
   4. `Gemini 3.6 Flash (High)`

   There are only **two independent quota pools** (verified — web-jam-tools#79):
   `{Claude Opus/Sonnet}` and `{Gemini Pro/Flash}`. `GPT-OSS 120B` shares Claude's
   pool, so it is **not** a usable fallback (it's dead whenever Claude is) and is
   excluded from the chain. Failover only ever crosses Claude ↔ Gemini.

   **Classification Rules (in priority order):**
   * **Explicit Override**: If the user passed an explicit model name when invoking `/work-issue` (or `/next`), use it and skip classification.
   * **Task-Line Tag**: If the TASK PROMPT contains an explicit tag (e.g., `[media]`, `[junior]`, `[simple]`) or a model name, this tag wins.
   * **Hard Media Override**: If the task involves audio/video files (`.mp3`, `.wav`, `.m4a`, `.mp4`, `.mov`, `.webm`, etc.), it **MUST** go to `Gemini 3.1 Pro (High)`. Claude cannot ingest these. (*Note: `.svg` is NOT media, it is XML/markup, so it rides the difficulty ladder.*)
   * **Difficulty Routing**:
     * *Trivial / Junior-dev*: (rename, one-liner, simple mechanical edit, simple image/PDF read) → `Gemini 3.6 Flash (High)` (or `Gemini 3.1 Pro (High)` for image/PDF reads).
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
     --closes   # include ONLY if this PR fully completes the issue; omit for a partial PR
   ```

   The script is the single source of truth (web-jam-tools#49) and **refuses to open a
   PR with an empty or placeholder description** (web-jam-tools#77) — so `--summary`,
   `--test-plan`, and `--test-evidence` are required. By default it references the issue
   (`Part of #N`); `--closes` makes it the completing PR (`Closes #N`). Never run
   `gh pr create` directly. Josh reviews the diff and flips the draft → ready on GitHub.

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
```" \
  --closes
`````
