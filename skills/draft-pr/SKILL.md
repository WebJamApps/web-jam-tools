---
name: draft-pr
description: Open a pull request the WebJamApps way — always draft, always based on dev, closing the issue on merge (Closes #N by default; Part of #N with --part-of for partial PRs, standing run-log/epic issues, and hook issues that must be confirmed firing before closing). Use this to finish ANY coding task in a WebJamApps repo instead of calling `gh pr create` directly. Triggered when the user says "open a PR", "draft PR", "finish the task", or when you've completed a coding task on a feature branch.
metadata:
  version: v1
  publisher: josh
---

# draft-pr — finish a coding task by opening a draft PR

Never call `gh pr create` directly in a WebJamApps repo. Finish coding tasks by
running the shared script, which is the single source of truth for PR creation (see
the full invocation under "How to run it" — `--summary` and `--test-plan` are
**required**; `--test-evidence` is optional and normally omitted).

It **always** produces a draft PR based on `dev` and an attribution footer — neither
can be overridden. By default the PR **closes the issue on merge** (`Closes #N`); pass
`--part-of` only when the issue must stay open (a partial PR, a standing run-log/epic
issue like a venue-mining run log, or a hook issue that must remain open until installed
and confirmed firing — see `docs/cross-ai-rules.md`).

Post-merge manual steps are governed by the POST-MERGE MANUAL STEPS rule in
`docs/cross-ai-rules.md` — read it there rather than relying on a summary here.
In short: the step becomes its own `Josh` issue, so the agent's PR closes its own
issue normally, and `--no-close` is reserved for a criterion that genuinely cannot
be split out.

It **refuses to open a PR with an empty or placeholder description** (web-jam-tools#77).
Josh alone reviews and flips draft → ready on GitHub.

## Before you run it

1. You are on a feature branch named `claude/<issue#>-<slug>` (the issue number in
   the branch is how the script derives the issue reference). If your branch lacks the
   number, pass `--issue N` explicitly (supports full URLs like `https://github.com/OWNER/REPO/issues/N`,
   `OWNER/REPO#N`, and bare `#N`/`N` — cross-repo issues format as `Closes OWNER/REPO#N` on merge).
   **An issue is OPTIONAL** (2026-07-03): with no issue resolvable, the PR simply has no Closes line
   and its title falls back to the last commit subject — NEVER create an issue just to satisfy the script.
2. Everything is committed (clean working tree) and lint + tests are green.
3. **Version bump:** On the PR's first commit, bump the version once in `deno.json`
   (web-jam-tools) or `package.json` (other repos). The CI "Version bump check" gate
   blocks PRs with no version change from the merge-base with `dev`. Follow-up commits
   to an already-open PR keep the same version.
4. **In-range dependency updates & security fixes:** `npm audit fix` (Node repos) and
   `deno outdated --update` restricted to minor/patch (Deno repos) are allowed and encouraged
   inside the working PR — they stay within the project's declared semver range, and the
   PR's own test plan is where a reviewer sees the result. (Major upgrades and fixes requiring
   breaking changes belong in their own follow-on issue, never smuggled into a feature PR).

## How to run it

Pass your actual model in `--author` so Josh can track per-model quality, and fill
the body sections via flags:

```
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
  --author "Claude Code — Opus 4.8" \
  --summary "What changed and why, in 2–4 sentences." \
  --test-plan "Exact commands to run + expected result." \
  --screenshots "Only for UI-visible changes; omit the flag otherwise." \
  --part-of   # include ONLY if the issue must stay open (partial PR / run-log / epic)
```

- `--author` is **required** and must name a model on the script's roster
  (web-jam-tools#190) — off-roster names (e.g. a confabulated checkpoint) are
  refused with the valid list printed. `FORCED_PR_AUTHOR` in the environment
  overrides `--author` entirely; `handle-agy-tasks.sh` sets it so headless/
  interactive agy runs never depend on a model correctly naming itself.
- `--summary` and `--test-plan` are **required** — the script refuses to open a PR
  with an empty or placeholder description (web-jam-tools#77). Put your summary IN
  THE PR via these flags, not only in the chat reply. One more content check
  (web-jam-tools#190): `--summary` is refused if it has zero markdown bullet lines
  (a run-on paragraph doesn't count).
- `--test-plan` (or `--test-plan-file`) is **sourced from the closing issue's `## How to test locally` section**,
  corrected to what was actually run, rather than written from scratch. The issue holds the intent,
  written at design time by whoever understood how the change should be proved; the PR holds what the
  implementer actually ran. (The script continues to require `--test-plan` and refuses placeholder or
  suite-invocation-only values — web-jam-tools#77, web-jam-tools#152).
- `--test-evidence` is **OPTIONAL and normally omitted.** Always run the suites and
  confirm they pass before opening the PR — but do **not** paste unit-test runner
  output into the body. The numbers are noise to the reviewer, and CI already
  reports pass/fail. Reserve the flag for evidence CI cannot show: a manual
  reproduction, a `curl` response, or a described screenshot. A PR with no "Test
  evidence" section is correct, and a reviewer must never raise a finding about its
  absence. If you do pass it, it is still refused when it contains no recognizable
  output at all (a prose paraphrase like "all tests passed" doesn't count).
- **An issue is OPTIONAL — never create one just to open a PR.** The script resolves
  an issue number from the branch name (`<lane>/<issue#>-<slug>`) first, then from
  `--issue N`. If neither yields a number, the PR simply opens with no `Closes` line
  and takes its title from the last commit subject. That is a supported, normal PR.
  An issue becomes **mandatory only** when you pass `--part-of` or `--no-close`,
  because both flags write a line naming an issue (`Part of #N`, `Refs #N`) and
  cannot be written without one.
- Closing is the default: the body reads `Closes #N`, so the issue auto-closes when
  Josh merges the PR into dev. Pass `--part-of` (body reads `Part of #N`) when the issue
  must stay open: a partial PR, a standing run-log/epic issue, or a hook issue (hook PRs
  never close on merge because the hook must be installed and confirmed firing first —
  see `docs/cross-ai-rules.md`). **Issues labeled `Josh` are manual human steps / verification runs and must never be auto-closed by an agent PR (`create-draft-pr.sh` refuses `Closes #N` on `Josh`-labeled issues and requires `--part-of` or `--no-close`, web-jam-tools#848).** Pass `--no-close` (and optional `--no-close-reason` /
  `--no-close-reason-file`) when the PR must not close the issue on merge per the rule
  in `docs/cross-ai-rules.md`. (`--closes` is a deprecated no-op, still accepted.)
- `--screenshots` is for UI-visible changes only; omit the flag to omit the section.

## PR body formatting (do this every time)

The script drops your `--summary` / `--test-plan` / `--test-evidence` values
**verbatim** under their headers — it does not reformat them, so professional
formatting is the **caller's** job. One machine-enforced exception (web-jam-tools#150):
a `--test-evidence` value containing no ``` fence at all is auto-wrapped in one
before the body is composed (raw console output otherwise garbles markdown —
`====` separator lines render as giant H1s). A value with any existing fence
passes through unchanged, so fence it properly yourself anyway. Fill every flag
with proper markdown:

- **Summary** → **bullet points**, one change per bullet — never a single run-on
  sentence.
- **Shell commands** → a fenced ` ```sh ` code block, never inline prose.
- **HTML or code** → wrap every `<tag>`, snippet, or symbol in backticks or a fenced
  block so GitHub renders it literally. Never pass a raw `<sup>35</sup>`-style tag as
  prose — GitHub renders or swallows it and garbles the body.
- **Before/after** → add a short before → after snippet when it aids clarity.
- **Test plan substance (web-jam-tools#135)** → source `--test-plan` from the closing issue's
  `## How to test locally` section, corrected to what was actually executed. A green test suite
  is a gate, never the whole plan. Also include steps that exercise the CHANGE itself:
  - UI change → exact manual steps: the command to start the app (e.g. `npm run dev`),
    the route/page to open, what to click or type, and the visible result to expect.
  - Backend/API change → runnable requests: `curl` command(s) (or an equivalent
    Postman-ready request description) with the expected status + response body.
  - Docs/tooling-only change → the command or review step that shows the change took
    effect (run the changed script once and state its expected output).

Example of a well-formed call (bulleted summary, fenced commands + output):

`````
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
  --author "Claude Code — Opus 4.8" \
  --summary "- Add X so Y works
- Refactor Z to stop duplicating W" \
  --test-plan "Run:
```sh
deno task test
```
Expect: all tests green. Then exercise the change per Test plan substance above."
`````

Note there is no `--test-evidence` here — that is the normal shape. Run the suites,
confirm green, and leave the flag off.

## What the script refuses to do (and why that's correct — don't work around it)

It exits non-zero when: `--author` is missing or off-roster; either of `--summary`/
`--test-plan` is missing or left as a placeholder; `--summary`
has no bullet lines; a `--test-evidence` that was supplied has no recognizable
test-runner output (omitting the flag entirely is fine);
`--test-plan` is only test-suite invocations (`npm test`, `deno task test`,
`vitest`, `eslint`, ...) with nothing exercising the CHANGE itself — the "Test
plan substance" rule above is now machine-enforced (web-jam-tools#152); body
text contains raw HTML-like tags outside backticks (GitHub strips them
silently — the "wrap every `<tag>` in backticks" rule above is now machine-
enforced); you're on `dev`/`main`; the working tree is dirty; the repo has no
`dev` branch; an issue number WAS resolved (from the branch name or `--issue`)
but that issue does not exist or is not OPEN — this is not a requirement that
a PR have an issue, only that a named one be real and open; or `--part-of` /
`--no-close` is passed with no resolvable issue. If it refuses, fix the
underlying condition — do not fall back to `gh pr create`.

## Consumed rules

### dispatch-prompts-fence-test-evidence

**Changed 2026-08-07** by web-jam-tools#422 "create-draft-pr.sh: omit unit test suite log
output requirement from PR descriptions" (commit `91644b7`):

- `--test-evidence` / `--test-evidence-file` is now **OPTIONAL**. Do not paste unit-test
  suite log output into a PR body — Josh had it removed to simplify the description.
- The web-jam-tools#190 "recognizable test-runner output" check is **deleted** from
  `scripts/create-draft-pr.sh`; a paraphrase or an omitted section no longer fails the guard.
- Still REQUIRED (web-jam-tools#77): `--summary` (must have ≥1 markdown bullet) and
  `--test-plan` (must exercise the change, not just list `npm test` — web-jam-tools#152).

**Why:** CI already runs and reports the suite; duplicating its log in the PR body is noise.

**How to apply:** dispatch prompts should tell the agent to write multi-line sections to a
temp `.md` file and pass `--summary-file` / `--test-plan-file` (headless `-p` flattens
newlines in shell args) — and should NOT ask for suite output. If evidence is genuinely
worth including (a screenshot, output that exercises the change), it is auto-fenced by the
script (web-jam-tools#150), so raw `====` coverage banners can no longer render as H1s —
the original 2026-07-11 failure on web-jam-back PR #935 is fixed at the script level.

### pr-attribution-work-by-model

Josh flagged (2026-07-02): web-jam-back PR #892 was built by Sonnet but its footer said the generic "🤖 Generated with [Claude Code](https://claude.com/claude-code)" — wrong per convention.

**Why:** the repo convention (`web-jam-tools/scripts/create-draft-pr.sh`, REQUIRED `--author` flag) puts `🤖 Work by <tool> — <model>` (e.g. "Claude Code — Sonnet 5", "agy — Flash Medium") in the PR footer so Josh can track per-model quality. The generic harness tagline defeats that.

**How to apply:** when Fable/Opus writes a dispatch prompt that ends in a PR, instruct the subagent to either (a) use `~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh --author "<tool> — <its real model>"` (it's a SHARED script in web-jam-tools, run from any repo — a Haiku agent once concluded it "doesn't exist" because it looked only inside web-jam-back), or (b) if falling back to `gh pr create`, end the body with `🤖 Work by <tool> — <model>` naming the model actually doing the work — NOT the generic tagline, and NOT Fable's name. Do not retro-edit existing PRs unless Josh asks (he explicitly declined a fix for #892). Bake this into the delegate skill templates when it's next revised.

### one-semver-bump-per-pr

A PR carries exactly ONE semver bump (e.g. 2.9.15 → 2.9.16). Follow-up commits pushed to an already-open PR must NOT each re-bump the version.

**Why:** Josh flagged a PR that went 2.9.15 → 2.9.18 in one PR — I'd bumped on every push (feature commit, then a CI tweak, then a security fix) because the PreToolUse semver hook reminds on each push. The hook's intent is "the PR's change is versioned," not "increment on every push."

**SEMVER TRAP — read the current version from `origin/dev`, NEVER from the working checkout.**
The main clone often sits on a long-merged or unrelated branch, so its `deno.json` /
`package.json` can be several versions behind. This bit two dispatches in one session
(2026-07-30): the checkout read `1.22.0` while `origin/dev` was already at `1.23.1`, so both
dispatch prompts carried stale bump targets — one agent caught it independently, the other had to
be corrected mid-flight. Always run `git show origin/dev:deno.json` (or `:package.json`) before
naming a bump target in a dispatch prompt. Two PRs cut from the same base will also collide on
the same next version — re-read `origin/dev` and take the next free one when CI's version-bump
gate complains.

**How to apply:** Bump once when the PR's first commit lands. On later pushes to the same branch/PR, leave the version unchanged (the hook reminder is satisfied by the already-bumped version). Only bump again for a genuinely separate PR. If a PR has already over-bumped, reset it to a single bump (correcting an unmerged version is fine — not a published downgrade). Relates to the never-commit-to-dev and git-feature-branch-and-semver rules.
