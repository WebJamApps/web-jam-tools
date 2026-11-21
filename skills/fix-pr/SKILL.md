---
name: fix-pr
description: Fix a WebJamApps pull request that cannot merge (behind dev, conflicts, version, format, lint, tests, Must Fix items) on the model set in this terminal, then push once with a signed comment. Typed /fix-pr <repo>#<number>, a PR link, or a bare number; $fix-pr on Codex.
metadata:
  version: v1
  publisher: josh
---

# fix-pr — fix one pull request on the model set in this terminal

Requirements: `~/Dropbox/web-jam-llms/Token_Savings/fix-pr-design-2026-10-10.md`. This file is the
run procedure for Claude Code, agy (Antigravity) and Codex, and it names the design section behind
each part rather than repeating it. If the two ever disagree, stop and tell Josh; never pick one.

## Starting a run

The call names exactly one pull request. On Codex the skill is spelled `$fix-pr`. Any other words in
the call are directions to this run, for example a request for a helper or to wait for the build.

## Who fixes

Design section: "Which model does the fix".

- Whatever model runs this session does the work. Never compare it with the pull request's author,
  never sort the failure by kind, and never consult the tier order.
- A helper exists only when the call asks for one by model. It does steps 1 to 5; this session keeps
  step 6, since only the session Josh typed into may push. The comment then names the helper.
  - Claude Code: start it with the Agent tool, naming the model.
  - Codex: ask for a helper on the named model.
  - agy: the run stays in this session, on a model "The agy model guard" in
    `~/Dropbox/web-jam-llms/Token_Savings/model-tier-order-design-2026-10-02.md` permits. A request
    for a helper on a different model ends the run before any edit, saying fix-pr never opens a
    second agy process or hands its push right to another conversation.
- Edits: the edit gate in `~/Dropbox/web-jam-llms/AI_Misbehaves/delegation-gate-design.md`, section
  "Opus coding and Josh’s choice of Fable", governs; fix-pr grants nothing extra.

## Steps

Design section: "What happens when Josh types it".

1. **Read.**
   - `gh pr view <number> --repo WebJamApps/<Repo> --json number,url,state,headRefName,baseRefName,isCrossRepository,mergeable,mergeStateStatus,reviews`.
   - Stop and refuse when it is not open, when its head is `dev` or `main`, or when
     `isCrossRepository` is true.
   - CI: take the build number from the CircleCI link in
     `gh pr checks <number> --repo WebJamApps/<Repo>`, fetch
     `https://circleci.com/api/v1.1/project/github/WebJamApps/<Repo>/<build>`, and read the
     `output_url` of every action flagged `failed`. Load `CIRCLECI_TOKEN` from the environment
     inside a script file, never on a command line.
   - Review: the Must Fix items in the latest review carrying `## PR Review Summary`.
   - If none of this shows a problem, report that and end without changes.
2. **Fix** in a `/tmp` worktree of the branch, never the canonical clone:
   `git -C ~/WebJamApps/<Repo> fetch origin dev <branch>`, then
   `git -C ~/WebJamApps/<Repo> worktree add -B <branch> /tmp/fix-pr-<number> origin/<branch>`.
   Rebase onto `origin/dev`, settle conflicts, bump the version again under the rule kept in
   `skills/pr-review/SKILL.md`, and repair formatting, lint, tests and every Must Fix item.
3. **Check** with the same checks that repository's CI runs. Any check still failing ends the run
   with no push; say which one and why.
4. **agy only: `/learn`.** Run `/learn`; if it edits the repository's `AGENTS.md`, commit that alone
   on the branch as `chore: fold /learn updates into AGENTS.md`. No edit means no commit. Claude
   Code and Codex skip this step.
5. **Comment file** under `/tmp`, covering what "The comment" asks for and ending with the
   signature.
6. **Push once** from the worktree:

   ```sh
   deno task --config ~/WebJamApps/web-jam-tools/deno.json push --repo-dir "$PWD" --fix-comment /tmp/fix-pr-<number>-comment.md
   ```

   Append `--force-with-lease` after the file when step 2 rebased. If the push succeeds but posting
   fails, the command prints a `deno task post-pr-comment` line; run that line, which only posts.
7. **Report**: the pull request link, commits pushed, fixes made, and the CI build link from that
   push. Waiting for the build happens only on request; then report its outcome, quoting the failed
   step's output if it failed.

This run pushes a single time. A red build afterwards is Josh's to act on: no retry and no second
model. A new call is a new run.

## agy and `/learn`

Design section: "Learning from the fix on agy". `/learn` runs only on a fix that passed step 3 and
is about to be pushed. Its commit rides in the run's one push, is listed in the comment, and is
never pushed alone or given its own pull request. It runs whoever authored the pull request. Claude
Code and Codex have no equivalent.

## Pushing

Design section: "The push". The push command recognises a fix run from Josh's typed call and then
needs no terminal confirmation for `--force-with-lease`. It refuses a fix-run push with no
`--fix-comment`. If it cannot read the session, the typed call or the pull request, it treats the
run as an ordinary push. Never push by any other route.

## The comment

Design section: "The comment". The file says why the pull request could not merge, what was fixed
(naming the review finding each Must Fix answer resolves), which commits were pushed (the `/learn`
commit included on agy), which checks ran with their results, and anything left unfixed with the
reason. Its final line is the signature, `🤖 Fixed by <tool> — <model>`. The push command fills in
the model the tool recorded for this session or its helper; a model's description of itself never
counts. An empty file, a file without the signature, or a signature alone is refused before pushing.

## Refusals

Design section: "What it refuses to do". In short: no choosing or ranking models, no retry or
hand-off after a red build, no helper Josh did not request, no push without its comment, no separate
`/learn` push or pull request, no signature other than the recorded one, no force push outside the
named pull request's branch, no unreadable record taken as consent, no pushing `dev` or `main`, no
plain `--force`, no branch deletion, no merging, readying or closing, and no reviewing.

## Per tool

Design section: "Both surfaces — Claude Code, agy and Codex".

|                   | Claude Code                     | agy                                            | Codex                       |
| ----------------- | ------------------------------- | ---------------------------------------------- | --------------------------- |
| Call              | `/fix-pr`                       | `/fix-pr`                                      | `$fix-pr`                   |
| Linked at         | `~/.claude/skills`              | `~/.gemini/config/plugins/webjam-tasks/skills` | `~/.codex/skills`           |
| Helper on request | Agent tool with the model named | none; the run ends before edits                | a helper on the model named |
| `/learn`          | skipped                         | step 4                                         | skipped                     |
