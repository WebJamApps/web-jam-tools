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
   ~/WebJamApps/web-jam-tools/scripts/handle-gemini-tasks.sh --setup-only
   ```

   To run a specific `agy`-labeled GitHub issue instead of the next queue line,
   pass it as an argument, e.g.:

   ```
   ~/WebJamApps/web-jam-tools/scripts/handle-gemini-tasks.sh --setup-only CollegeLutheran#123
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

3. Work **entirely inside `REPO_DIR`**: cd there first; every file edit, command,
   and commit happens in that directory. Read and follow that repo's `AGENTS.md`
   (or `GEMINI.md`) for its conventions.

4. Implement the task from the TASK PROMPT. Commit incrementally with clear,
   conventional messages as you go.

5. Before declaring done, run the repo's lint and test commands and fix issues
   until both pass. Find the exact script names in the repo's AGENTS.md/GEMINI.md
   and its `package.json` "scripts" (commonly `npm run lint` and `npm test`; some
   repos use `npm run test:lint` and `npm run test:unit`).

6. Do **not** switch branches or add dependencies. When lint and tests are green,
   finish by opening a draft PR — run:

   ```
   ~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh --author "agy — <the model you are running as>"
   ```

   It pushes the branch and opens a draft PR based on `dev` with `Closes #N` baked
   in (web-jam-tools#49). Never run `gh pr create` directly. Then summarize what
   changed and confirm lint and tests are green. Josh reviews the diff and flips the
   draft → ready on GitHub; he also deletes the queue line after accepting the work.
