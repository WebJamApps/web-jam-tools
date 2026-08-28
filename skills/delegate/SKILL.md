---
name: delegate
description: Local dispatch mechanics for handing work to a cheaper tier — the exact commands to hand a frontend/UI task to Flash via agy/Antigravity, and self-contained subagent prompt templates for Haiku/Sonnet/Opus. Does NOT decide which tier a task belongs to (that routing table lives in docs/ai-team-playbook.md, migrating from global CLAUDE.md per web-jam-tools#115) — this skill only fires once a tier is chosen, so the mechanics of the handoff are never skipped. Triggered when a Fable/Opus session is about to do mechanical or contained-coding work itself, or Josh/the session says "delegate" or "hand off".
---

# delegate — dispatch mechanics (not routing)

This skill exists because the routing tiers were well documented but the **handoff
commands** weren't written anywhere executable, so the main session kept quietly
doing mechanical work inline instead of dispatching it. Once you've decided a task
belongs to Flash/Haiku/Sonnet/Opus (see `docs/ai-team-playbook.md` for the routing
table — this skill does not repeat it), use the matching section below.

> "Doing mechanical work inline" above means *sizeable* work that was skipped —
> not every small command. Dispatch vs. inline is judged by output volume and
> duration, not task category: dispatch heavy/log-noisy jobs (test suites, builds,
> migrations, multi-file scans), but do a handful-of-commands job with trivial
> output inline — a cold subagent's fixed startup cost can exceed the work itself.
> See the "Dispatch vs. inline" bullet in `docs/ai-team-playbook.md`.

## 1. Flash/agy dispatch (frontend/UI & Antigravity work)

Flash work is executed by the Antigravity CLI (`agy`) via the wrapper script
`~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh`. Dispatch is
**GitHub-issues-only** — the task must already exist as a GitHub issue labeled
`Flash High` or `Flash Med` before you dispatch it. (A queue-file entry point — appending a line to
`~/Dropbox/web-jam-llms/agy-tasks.txt` — used to exist as a shortcut for quick
tasks with no issue; Josh retired it and deleted the file, since it let a
session dispatch work with no durable record — see web-jam-tools#249. A quick
task not worth a full write-up still gets a GitHub issue first, just a short
one.)

**Environment (web-jam-tools#439):** the wrapper launches the `agy` binary
itself with an explicitly constructed environment — `HOME`, `PATH`, `USER`,
`AGY_MODELS`, `FORCED_PR_AUTHOR` only, never your full inherited shell
environment. This is deliberate: a subagent's own shell tool call once read
`GH_TOKEN` and Dropbox credentials out of an inherited environment and sent
them to Google's API mid-run (web-jam-tools#282 section D, 2026-08-07).
Dispatch through this script — never a raw `agy --model ... -p "..."` call —
to keep that scrubbing in place.

```sh
~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --headless "<Repo>#<issue-num>"
# e.g.
~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --headless "CollegeLutheran#123"
```

`--headless` must come **before** the issue argument (the script parses leading
flags first). Headless auto-approves tools and walks the model fallback chain
unattended — use it when dispatching from inside a session with no
one watching a REPL. Drop `--headless` only if Josh himself wants to drive the
agy REPL interactively. The issue argument is required — a no-arg invocation
fails with a usage message instead of running anything.

**Non-UI tasks and `--no-land` (web-jam-tools#513):**
By default, `handle-agy-tasks.sh` checks out the created feature branch into the developer's main repository clone (`~/WebJamApps/<repo>`) after PR creation so UI changes are immediately ready for local inspection and browser testing. For non-UI work (backend, tooling, documentation, and config tasks), pass `--no-land` before the issue argument to skip checking out the branch into the main clone, preventing the local checkout from switching away from `dev`:

```sh
~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --headless --no-land "<Repo>#<issue-num>"
# e.g.
~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --headless --no-land "web-jam-tools#567"
```

**Dispatching `agy` via a thin Haiku subagent (Claude Code):**
In Claude Code sessions, rather than running `handle-agy-tasks.sh` directly in a blocking Bash tool call in the main session, dispatch the script via a thin Haiku subagent (`Agent` tool with `model: "haiku"`). This offloads the long-running command execution and allows Josh to see status and progress in the session UI.

- **Strict constraint — dispatch-and-report only:** The Haiku subagent wrapper exists strictly to run the dispatch command, wait for it to exit, and report the result (exit status, stdout summary, and PR URL) back to the parent session. It is **forbidden** from reading or analyzing the issue, modifying code files, running tests/linters, or reviewing the resulting PR. `handle-agy-tasks.sh` and the child `agy` instance handle the entire task lifecycle; performing task work in the wrapper duplicates effort and pays twice for the same tokens.

Example subagent prompt for Haiku agy dispatch:

```
You are a thin dispatch runner.

Task: Run the following command in Bash, wait for completion, and report back the resulting PR URL and status:
  ~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --headless [--no-land] "<Repo>#<issue-num>"

Strict rules:
- Dispatch-and-report ONLY.
- Do NOT read the issue, do NOT edit files, do NOT run tests or linters, and do NOT review the PR.
- Report back the exact script output, exit status, and created PR URL.
```

**Default Tier & Bidirectional Delegation Flexibility:**
Josh defaults to **`Flash High`** (`Gemini Flash (High)`) as the primary interactive model tier in `agy`. Delegation is flexible and works in both directions:
- **Automatic Delegation on "Go" (`Flash High` → `Flash Med`)**: When discussing an issue interactively on `Flash High`, once requirements and steps are aligned and Josh gives the go-ahead ("go", "proceed", "start", "work issue #X"), the `Flash High` session is **forbidden** from executing file edits or running test suites directly for tasks/issues labeled `Flash Med` or `Haiku`. It MUST automatically delegate contained coding tasks down to a `Flash Med` subagent (`handle-agy-tasks.sh` or `invoke_subagent` with `Model: "inherit"`) as its very first tool call. Do NOT wait for Josh to explicitly ask for delegation — initiate subagent handoff automatically upon approval.
- **Exception — trivial edits**: the primary session may make the edit directly, without `invoke_subagent`, only when **all** of these hold: it touches **one file**; it changes **no behaviour** (documentation, comment, or a single config value); and it is **under ~20 changed lines**. The session must say, in the same turn, that it is taking the exception and why. "I already have the context", "it would be faster", and "writing the brief costs as much as the work" are **not** exceptions — the three conditions above are the whole test. Rationale: delegation pays when the work is bigger than the brief; below that line the session pays to write a self-contained specification, waits for a round trip, then reviews the result, for an edit smaller than the specification. The three conditions are a mechanical proxy for that, chosen because they are auditable from the outside and a cost estimate is not.
- **Delegating up (`Flash Med` → `Flash High` / `Sonnet` / `Opus`)**: When running on `Flash Med`, delegate multi-file judgment, complex refactors, or UI design work up to `Flash High`, `Sonnet`, or `Opus`.

**Setting explicit model chains via `AGY_MODELS`:**
The default fallback chain runs `Gemini 3.7 Flash (High)|Gemini 3.7 Flash (Medium)`. To target a specific tier directly, set `AGY_MODELS`:

```sh
# Force Flash High default:
AGY_MODELS='Gemini 3.7 Flash (High)' \
  ~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --headless "<Repo>#<issue-num>"

# Force Flash Med delegation:
AGY_MODELS='Gemini 3.7 Flash (Medium)' \
  ~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --headless "<Repo>#<issue-num>"
```

The value is pipe-separated (model names contain spaces, so pipes — not spaces —
separate them; a single name needs no pipe). HFS#26 was labeled Flash High but ran on Medium when `AGY_MODELS` was omitted, 2026-07-09.

**Headless completion is driven, not one-shot.** agy's `-p` mode can end its
turn before a long multi-step task is actually finished — it exits 0 with work
uncommitted, no tests run, no PR opened (this bit us three times in a row on
JaMmusic#1162). So a zero exit from `-p` is never treated as "done" by itself:
`--headless` runs each turn with `--dangerously-skip-permissions --print-timeout
60m`, then checks REAL completion — does `gh pr list --head "$BRANCH"` show a
draft PR for the branch? If not, the SAME model is re-invoked with a "resume and
finish" prompt (told to check `git status`/`git log dev..HEAD` and pick up where
it left off) instead of the script moving on. A turn that exits **non-zero**
(not just "finished without a PR") is what triggers falling back to the next
model in the chain — and that next model gets its own driven rounds too.
`AGY_MAX_ROUNDS` (env, default 4) bounds total rounds spent across *all* models
combined, so a stuck model can't loop forever; on exhaustion the script prints a
loud failure block including `git status --short` so you can see the WIP left
behind. Don't assume a single `-p` invocation completes a task — the loop is
what makes headless dispatch reliable, not the one-shot call.

## 2. Per-tier subagent prompt templates (Haiku / Sonnet / Opus)

Dispatch these via the `Agent` tool (`model: "haiku"` / omit for session default /
`model: "opus"`). A fresh subagent has none of this session's context, so the
prompt must be self-contained: repo path, branch, commit format, the version-bump
rule, and an explicit report-back list. Fill in the placeholders; don't paste them
literally.

**If the authoritative spec for a task lives in a GitHub issue COMMENT** (not the
issue body — e.g. the design got settled through back-and-forth in the comment
thread), the dispatching parent MUST inline that spec text into the prompt's
`Task:` field. Never pass a bare issue number expecting the sub-agent to
reconstruct it from the issue plus its comments — a sub-agent dispatched via the
`Agent` tool doesn't fetch the issue at all; it only ever sees what's in the
prompt.

The templates below say `package.json` "version" — that's correct for the Node
repos (CollegeLutheran, JaMmusic, web-jam-back, AppersonAuto, WebJamSocketCluster).
`web-jam-tools` itself is Deno: swap in `deno.json` "version" and note that its
bump is enforced automatically by a pre-push hook (`~/.claude/hooks/`), not a rule
the subagent has to self-police.

### PR-review dispatch nudge (parent-side, before dispatching)

> Before dispatching a subagent to run `/pr-review` (e.g. the Flash-reviews-Sonnet /
> Sonnet-reviews-Flash cross-model pairing), know that the subagent **cannot** post
> its finished review itself — Agent-tool subagents don't inherit this session's
> `permissions.allow` list and dead-end on `gh pr review --comment` with no human
> present to approve it (harness limitation, not a WebJamApps settings gap; see
> `skills/pr-review/SKILL.md` Step 3 for the citations). The subagent will write
> the finished review to a scratch file and hand you back its path — **you** (the
> orchestrating session) post it via `gh pr review --comment --body-file <path>`
> once it reports back. Don't wait on the subagent in the meantime.

### Coupling nudge (parent-side, before dispatching)

> Before dispatching an issue with a `FE-couples: <repo>#NNN` line, dispatch
> **both** lanes — Sonnet (BE) and Flash (FE #NNN) — never the BE half alone.
> The coupled BE change must reach `main` via a `dev→main` PR (the merge-gate
> check blocks direct promotion until FE #NNN is merged to its `main`).

See `docs/cross-ai-rules.md` § FE/BE COUPLING for the full rule (backward-compat/
expand-contract, the `FE-couples:`/`Coupling-override:` conventions, and the
merge gate) — this is the decision point where a parent session must catch it,
before either lane is sent off.

### Mandatory: PR attribution & conventions block

Every generated dispatch prompt (Haiku/Sonnet/Opus, and the agy prompt in
section 1) MUST include this block, filled in for the executing model — it is
not optional boilerplate to trim:

```
PR attribution & conventions:
- Finish by running the SHARED script (works from ANY repo — it lives in
  web-jam-tools, do NOT go looking for it inside the target repo; a past agent
  wrongly concluded it "doesn't exist" because it searched the wrong repo):
    ~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh --author "<tool> — <the model actually doing the work>"
- If you must fall back to `gh pr create --draft --base dev` directly, the PR
  body MUST end with the line `🤖 Work by <tool> — <model>`, naming the model
  that actually did the work — NEVER the generic "🤖 Generated with Claude
  Code" tagline. Josh tracks per-model PR quality via this footer; a miss here
  is a real regression (it happened on web-jam-back#892, 2026-07-02).
- Commit trailers (`Co-Authored-By:`) name the model actually doing the work,
  not a different one.
- **One semver version bump per PR, on the first commit only** — `deno.json` for
  web-jam-tools, `package.json` for JS/TS repos (JaMmusic, web-jam-back,
  CollegeLutheran, AppersonAuto, TSM, HFS). The CI "Version bump check" gate blocks
  PRs whose version is unchanged from the merge-base with `dev`. Follow-up commits
  to an already-open PR keep the same version.
```

### Mandatory (code-change dispatches): Dispatch checkpoint (loss prevention)

Code-change dispatches (anywhere a branch gets created) additionally carry this
shared mechanism, on top of the conventions block above. It exists because a
sub-agent's work has two layers, and only one of them survives a dead session on
its own:

- **Layer 1 (code)** survives on disk once committed — a branch plus incremental
  `git commit`/`git push` protects it, nothing more is needed.
- **Layer 2 (knowledge — what was done, decided, or left)** lives only in the
  sub-agent's context. If the parent dies before the sub-agent relays its final
  report (e.g. an account usage-cap cutoff), Layer 2 is gone even though Layer 1
  is safely pushed. This mechanism addresses Layer 2.
- **Key insight:** a usage-cap cutoff kills the SUB-AGENT too, mid-work — not
  just the parent. A scheme that writes the "report" only as the sub-agent's
  LAST action never runs in the worst case. Capture has to be INCREMENTAL,
  landing somewhere that survives independently of either agent's context: the
  PR body.

**The mechanism:**

1. The DISPATCHING PARENT fills a **Plan checklist** into the dispatch prompt —
   the parent already knows the plan, so this is the reliable "intent" half, and
   it scaffolds the sub-agent's job down to "keep status honest" rather than
   "invent a tracking format."
2. The sub-agent, EARLY — right after creating the branch and making the first
   commit — opens a draft PR whose body is this checkpoint template:

```
## Dispatch checkpoint (auto — do not delete)
**Issue:** #NNN   **Branch:** claude/nnn-x   **Model:** <model>
**Resume:** checkout branch, read CURRENT STATUS, continue from first unchecked step

### CURRENT STATUS
⏳ starting

### Plan
- [ ] step 1 …
- [ ] step 2 …
- [ ] step 3 …

### Decisions / blockers
(sub-agent appends one line each as they happen)
```

3. **Cadence — exactly two triggers** (keep it lean; ~3-6 cheap writes total for
   a typical dispatch):
   - **Step completed** → tick its box and overwrite `CURRENT STATUS` with the
     next step.
   - **Decision or blocker** → append one line under "Decisions / blockers".
4. **Cost levers:** OVERWRITE the bounded `CURRENT STATUS` line — never grow it
   into a log. Milestone cadence is per checklist step, NOT per file edit. Do NOT
   add a separate "checkpoint before every risky step" rule — a risky step is
   just its own checklist item, already covered by trigger 1 above.

**Interaction with create-draft-pr.sh:** the script supports two modes
(web-jam-tools#236) — default CREATE (`gh pr create`, refuses if a PR already
exists for the branch) and `--update` (`gh pr edit` on the branch's existing
PR). Both run through the exact same guard pipeline — author roster, the #77
empty/placeholder check, the unbulleted-summary check, the #190
recognizable-test-evidence check, the #152 suite-invocations-only test-plan
check, the raw-HTML-tag check — so the checkpoint flow uses ONE script for
both ends of the PR's life instead of a hand-written `gh pr edit` that would
silently skip all of that at the moment it matters most:

- **Early open — CREATE mode.** Run create-draft-pr.sh (no `--update`) right
  after the branch, first commit, and push, passing the Plan checklist itself
  as `--summary` (its `- [ ]` lines satisfy the bulleted-summary check), a
  short honest `--test-plan` describing what you intend to verify (non-suite
  prose clears the exercise-the-change check), and for `--test-evidence` an
  honest, not-yet-done line that still contains the word `Tests:` so it clears
  the recognizable-output check without inventing a result — e.g. `"Tests:
  not yet run — this is the initial checkpoint; real evidence lands at
  finalize."` Never fake pass/fail counts here; the guard only cares that the
  section names itself as test output, and the real numbers arrive at
  finalize below. This preserves every create-time guard (draft + base dev,
  author-roster check, `Closes #NNN`, attribution footer, raw-HTML-tag check)
  at the moment the checkpoint PR is born.
- **Cadence updates — plain edits, not the script.** Every checklist tick and
  "Decisions / blockers" line after that is `gh pr edit <num> --body-file
  <path>` — these are lightweight status pokes, not a finished deliverable
  description, so they don't need to clear the script's content guards; that's
  what finalize is for.
- **Finalize — `create-draft-pr.sh --update` on the SAME PR**, with the REAL
  `--summary` / `--test-plan` / `--test-evidence` / `--author` (and `--part-of`
  if applicable) — replacing the checkpoint scaffolding with bulleted `##
  Summary`, an exercise-the-change `## How to test locally`, real pass/fail
  `## Test evidence`, `Closes #NNN`, and the `🤖 Work by <tool> — <model>`
  footer, with every guard re-firing on the real final content. This
  supersedes the "Finish by running create-draft-pr.sh" line in the
  conventions block above for dispatches using this mechanism — that line now
  means "run it once more, with `--update`."

**Applies to:** the Sonnet, Opus, and Haiku **code-change** templates below
(anywhere a branch gets created). It's moot for a pure research/lookup Haiku
task that creates no branch — there's no Layer-1/Layer-2 split to protect there,
so skip the whole mechanism.

### Mandatory (code-change dispatches that can touch a backend): backward-compat contract check

If the change touches a shared BE/FE contract (a required field, a validation
rule, or a request/response shape a front-end consumes), it must stay
additive/non-breaking until the front-end ships — see `docs/cross-ai-rules.md`
§ FE/BE COUPLING for the full expand-contract rule and the venue-address
example of what breaks when it's skipped.

### Haiku — mechanical / gh / research

```
You are doing mechanical work in the <repo> repo at ~/WebJamApps/<repo>.

Task: <one precise, unambiguous instruction — name the exact file/field/function/gh command>

<If this involves a code change, give the sub-agent a Plan checklist here (2-5
steps) — see the "Dispatch checkpoint" subsection above; skip this whole block
for a pure research/lookup task that creates no branch.>

Rules:
- Do not make design decisions. If the task is ambiguous (could point to more than
  one file/function/flow), STOP and report the ambiguity instead of guessing.
- If this involves a code change: work on branch claude/<issue#>-<slug> off latest
  dev. Commit with a clear message ending exactly:
    Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>
  Follow the "Dispatch checkpoint" subsection above for the whole PR lifecycle:
  open the checkpoint draft PR early (right after branch + first commit + push,
  via create-draft-pr.sh CREATE mode), keep it updated at each of the two
  triggers via `gh pr edit`, and finalize the SAME PR at the end via
  create-draft-pr.sh `--update` — never open a second PR. (Skip this
  checkpoint step entirely for a pure research/lookup task that creates no
  branch.)
- Do NOT bump the package.json version — that happens once per PR, not per commit
  (skip entirely if this is a follow-up commit to an already-open PR).
- Follow the "Backward-compat contract check" subsection above if this touches
  a shared BE/FE contract.

<Mandatory PR attribution & conventions block from above, filled in for
"Claude Code — Haiku 4.5">

Report back:
- What you found/changed, bulleted
- Exact commands run + their output
- Anything you stopped on instead of guessing
```

### Sonnet — ordinary contained coding

```
You are doing ordinary coding work in the <repo> repo at ~/WebJamApps/<repo>.

Task: <what and why, 2-4 sentences of context>

Setup:
- Repo: ~/WebJamApps/<repo>
- Branch: claude/<issue#>-<slug> (create off latest dev if it doesn't exist)
- Plan checklist (fill this in — feeds the "Dispatch checkpoint" subsection
  above): <2-5 steps>
- <If this is a follow-up commit to an already-open PR #N: DO NOT bump the
  package.json version — it was already bumped once for this PR. Only bump on
  the PR's first commit.>

Rules:
- Commit incrementally with clear messages ending exactly:
    Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Follow the "Dispatch checkpoint" subsection above for the whole PR lifecycle:
  open the checkpoint draft PR early (right after branch + first commit + push,
  via create-draft-pr.sh CREATE mode per that subsection's recipe), keep it
  updated at each of the two triggers via `gh pr edit`, and finalize the SAME
  PR at the end via create-draft-pr.sh **--update** — never open a second PR.
  (Skip entirely if this is a follow-up commit to an already-open checkpoint
  PR — just keep updating it, and let whichever dispatch finishes the work run
  the `--update` finalize.)
- Find this repo's real lint + test scripts (AGENTS.md / package.json "scripts" —
  commonly `npm run lint` + `npm test`, some repos use `npm run test:lint` /
  `npm run test:unit`) and get both green before finishing.
- Follow the "Backward-compat contract check" subsection above if this touches
  a shared BE/FE contract.
- To finalize the checkpoint PR at the end, run:
    ~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh --update \
      --author "Claude Code — Sonnet 5" \
      --summary "<bulleted, filled in by you>" \
      --test-plan "<exercise-the-change steps, not just suite invocations —
        web-jam-tools#152: UI -> exact manual steps; backend/API -> runnable
        curl + expected response; docs/tooling -> the command that shows the
        change took effect>" \
      --test-evidence "<the actual lint+test output you saw>"
  This re-runs the full guard pipeline on the real content and replaces the
  checkpoint scaffolding in place — never a hand-written `gh pr edit` for this
  step.

<Mandatory PR attribution & conventions block from above, filled in for
"Claude Code — Sonnet 5">

Report back:
- Summary of what changed, bulleted
- The real lint/test output (this is what feeds the finalized Test evidence — don't paraphrase it)
- Any open questions or things you couldn't verify
```

### Opus — complex coding / multi-file judgment

```
You are doing complex/multi-file coding work in the <repo> repo at ~/WebJamApps/<repo>.

Task: <what and why, plus the judgment call(s) involved — why this isn't
routine enough for Sonnet>

Setup:
- Repo: ~/WebJamApps/<repo>
- Branch: claude/<issue#>-<slug> (create off latest dev if it doesn't exist)
- Plan checklist (fill this in — feeds the "Dispatch checkpoint" subsection
  above): <2-5 steps>
- <If this is a follow-up commit to an already-open PR #N: DO NOT bump the
  package.json version — only the PR's first commit bumps it.>

Rules:
- Commit incrementally with clear messages ending exactly:
    Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
- Follow the "Dispatch checkpoint" subsection above for the whole PR lifecycle:
  open the checkpoint draft PR early (right after branch + first commit + push,
  via create-draft-pr.sh CREATE mode per that subsection's recipe), keep it
  updated at each of the two triggers via `gh pr edit`, and finalize the SAME
  PR at the end via create-draft-pr.sh **--update** — never open a second PR.
  (Skip entirely if this is a follow-up commit to an already-open checkpoint
  PR — just keep updating it, and let whichever dispatch finishes the work run
  the `--update` finalize.)
- Find this repo's real lint + test scripts (AGENTS.md / package.json "scripts")
  and get both green before finishing.
- Follow the "Backward-compat contract check" subsection above if this touches
  a shared BE/FE contract.
- Where there's a genuine design choice, make it and say why in the summary —
  don't ask a follow-up question you could resolve yourself with repo context.
- To finalize the checkpoint PR at the end, run:
    ~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh --update \
      --author "Claude Code — Opus 4.8" \
      --summary "<bulleted, filled in by you>" \
      --test-plan "<exercise-the-change steps, not just suite invocations —
        web-jam-tools#152: UI -> exact manual steps; backend/API -> runnable
        curl + expected response; docs/tooling -> the command that shows the
        change took effect>" \
      --test-evidence "<the actual lint+test output you saw>"
  This re-runs the full guard pipeline on the real content and replaces the
  checkpoint scaffolding in place — never a hand-written `gh pr edit` for this
  step.

<Mandatory PR attribution & conventions block from above, filled in for
"Claude Code — Opus 4.8">

Report back:
- Summary of what changed AND the reasoning behind any judgment call, bulleted
- The real lint/test output (feeds the finalized Test evidence — don't paraphrase it)
- Any open questions or things you couldn't verify
```

## Non-goals (don't do these here)

- Don't repeat the Opus/Sonnet/Haiku/Flash/Fable routing table — that's
  `docs/ai-team-playbook.md` (migrating there from global CLAUDE.md per
  web-jam-tools#115; link there, don't duplicate).
- Don't invent a version-bump command — WebJamApps repos bump `package.json`
  "version" (or `deno.json` for web-jam-tools) by hand, once per PR (see the
  `one-semver-bump-per-pr` memory).
