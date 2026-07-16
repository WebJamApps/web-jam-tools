---
name: draft-pr
description: Open a pull request the WebJamApps way — always draft, always based on dev, closing the issue on merge (Closes #N by default; Part of #N with --part-of for partial PRs and standing run-log/epic issues). Use this to finish ANY coding task in a WebJamApps repo instead of calling `gh pr create` directly. Triggered when the user says "open a PR", "draft PR", "finish the task", or when you've completed a coding task on a feature branch.
metadata:
  version: v1
  publisher: josh
---

# draft-pr — finish a coding task by opening a draft PR

Never call `gh pr create` directly in a WebJamApps repo. Finish coding tasks by
running the shared script, which is the single source of truth for PR creation (see
the full invocation under "How to run it" — `--summary`, `--test-plan`, and
`--test-evidence` are **required**).

It **always** produces a draft PR based on `dev` and an attribution footer — neither
can be overridden. By default the PR **closes the issue on merge** (`Closes #N`); pass
`--part-of` only when the issue must stay open (a partial PR, or a standing
run-log/epic issue like a venue-mining run log). It **refuses to open a PR with an empty or
placeholder description** (web-jam-tools#77). Josh alone reviews and flips draft →
ready on GitHub.

## Before you run it

1. You are on a feature branch named `claude/<issue#>-<slug>` (the issue number in
   the branch is how the script derives the issue reference). If your branch lacks the
   number, pass `--issue N` explicitly. **An issue is OPTIONAL** (2026-07-03): with no
   issue resolvable, the PR simply has no Closes line and its title falls back to the
   last commit subject — NEVER create an issue just to satisfy the script.
2. Everything is committed (clean working tree) and lint + tests are green.

## How to run it

Pass your actual model in `--author` so Josh can track per-model quality, and fill
the body sections via flags:

```
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
  --author "Claude Code — Opus 4.8" \
  --summary "What changed and why, in 2–4 sentences." \
  --test-plan "Exact commands to run + expected result." \
  --test-evidence "The actual lint + test output you saw, confirming both ran green." \
  --screenshots "Only for UI-visible changes; omit the flag otherwise." \
  --part-of   # include ONLY if the issue must stay open (partial PR / run-log / epic)
```

- `--author` is **required** and must name a model on the script's roster
  (web-jam-tools#190) — off-roster names (e.g. a confabulated checkpoint) are
  refused with the valid list printed. `FORCED_PR_AUTHOR` in the environment
  overrides `--author` entirely; `handle-agy-tasks.sh` sets it so headless/
  interactive agy runs never depend on a model correctly naming itself.
- `--summary`, `--test-plan`, and `--test-evidence` are **required** — the script
  refuses to open a PR with an empty or placeholder description (web-jam-tools#77).
  Put your summary and the real test output IN THE PR via these flags, not only in
  the chat reply. Two more content checks (web-jam-tools#190): `--summary` is
  refused if it has zero markdown bullet lines (a run-on paragraph doesn't count),
  and `--test-evidence` is refused if it has no recognizable test-runner output
  (a prose paraphrase like "all tests passed" doesn't count — paste the actual
  runner output).
- Closing is the default: the body reads `Closes #N`, so the issue auto-closes when
  Josh merges the PR into dev. Pass `--part-of` (body reads `Part of #N`) ONLY when
  the issue must stay open: a partial PR, or a standing run-log/epic issue.
  (`--closes` is a deprecated no-op, still accepted.)
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
- **Test plan substance (web-jam-tools#135)** → a green test suite is a gate, never
  the whole plan. Also include steps that exercise the CHANGE itself:
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
Expect: all tests green. Then exercise the change per Test plan substance above." \
  --test-evidence "```
ok | 42 passed | 0 failed
```"
`````

## What the script refuses to do (and why that's correct — don't work around it)

It exits non-zero when: `--author` is missing or off-roster; any of `--summary`/
`--test-plan`/`--test-evidence` is missing or left as a placeholder; `--summary`
has no bullet lines; `--test-evidence` has no recognizable test-runner output;
body text contains raw HTML-like tags outside backticks (GitHub strips them
silently — the "wrap every `<tag>` in backticks" rule above is now machine-
enforced); you're on `dev`/`main`; the working tree is dirty; the repo has no
`dev` branch; a resolved issue is missing or closed; or `--part-of` is passed
without a resolvable issue. If it refuses, fix the underlying condition — do
not fall back to `gh pr create`.
