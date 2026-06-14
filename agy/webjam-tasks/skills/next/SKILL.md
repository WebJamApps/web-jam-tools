---
name: next
description: Start the next queued coding task. Use when the user types /next, or says "next", "next task", or "start the next task". Pulls the first task from the agy-tasks queue (or a named agy-labeled issue), sets up a fresh git branch off dev, and implements it in that repo.
metadata:
  version: v1
  publisher: josh
---

# /next — run the next queued coding task

This skill delegates the deterministic setup (queue parsing + git branching) to a
shell script, then you (the agent) do the actual coding inside this same session.

## Steps

1. Run this shell command and read its stdout:

   ```
   ~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --setup-only
   ```

   To run a specific `agy`-labeled GitHub issue instead of the next queue line,
   pass it as an argument, e.g.:

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
   exits non-zero (dirty tree, missing repo, empty queue), stop and report its error
   to the user — do not improvise.

3. **Select the appropriate model:** Before implementing, classify the task to determine the most cost-effective model that can succeed. Switch to it by outputting the slash command exactly like `/model "Model Name"` on a new line and wait for the switch to complete.

   **Model Chain (Most to least capable):**
   1. `Claude Opus 4.6 (Thinking)`
   2. `Claude Sonnet 4.6 (Thinking)`
   3. `Gemini 3.1 Pro (High)`
   4. `Gemini 3.5 Flash (High)`
   5. `GPT-OSS 120B (Medium)` — last-resort fallback only (lowest quality); a working model beats a stalled task. Do **not** select it via difficulty routing.

   **Classification Rules (in priority order):**
   * **Explicit Override**: If the user passed an explicit model name when invoking `/next`, use it and skip classification.
   * **Task-Line Tag**: If the TASK PROMPT contains an explicit tag (e.g., `[media]`, `[junior]`, `[simple]`) or a model name, this tag wins.
   * **Hard Media Override**: If the task involves audio/video files (`.mp3`, `.wav`, `.m4a`, `.mp4`, `.mov`, `.webm`, etc.), it **MUST** go to `Gemini 3.1 Pro (High)`. Claude cannot ingest these. (*Note: `.svg` is NOT media, it is XML/markup, so it rides the difficulty ladder.*)
   * **Difficulty Routing**:
     * *Trivial / Junior-dev*: (rename, one-liner, simple mechanical edit, simple image/PDF read) → `Gemini 3.5 Flash (High)` (or `Gemini 3.1 Pro (High)` for image/PDF reads).
     * *Ordinary Coding*: → `Claude Sonnet 4.6 (Thinking)`.
     * *Complex / Multi-file / Real Judgment*: (including complex SVG/diagram tasks) → `Claude Opus 4.6 (Thinking)`.
   * **Tie-breaker**: If classification is genuinely ambiguous, default to `Claude Opus 4.6 (Thinking)`.

   **Rate-limit Fallback**: If the switch to your chosen model fails (e.g., rate limit), fall back to the next-capable available model in the chain — down to `GPT-OSS 120B (Medium)` as the final rung before giving up.

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
     --author "agy — <the model you are running as>" \
     --summary "<what changed and why>" \
     --test-plan "<exact commands to verify + expected result>" \
     --test-evidence "<the actual lint + test output you saw, confirming both ran green>" \
     --closes   # include ONLY if this PR fully completes the issue; omit for a partial PR
   ```

   The script is the single source of truth (web-jam-tools#49) and **refuses to open a
   PR with an empty or placeholder description** (web-jam-tools#77) — so `--summary`,
   `--test-plan`, and `--test-evidence` are required. By default it references the issue
   (`Part of #N`); `--closes` makes it the completing PR (`Closes #N`). Never run
   `gh pr create` directly. Josh reviews the diff and flips the draft → ready on GitHub;
   he also deletes the queue line after accepting the work.
