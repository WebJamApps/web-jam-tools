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

## 1. Flash/agy dispatch (frontend/UI work)

Flash work is executed by the Antigravity CLI (`agy`) via the wrapper script
`~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh`. There are two entry
points depending on whether the task already has a GitHub issue — **never do
both** for the same task (a GitHub issue is itself the dispatch record; don't
also mirror it into the queue file, see the `github-issue-not-queue-line` memory).

**A. GitHub issue already exists, labeled `Flash`:**

```sh
~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --headless "<Repo>#<issue-num>"
# e.g.
~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --headless "CollegeLutheran#123"
```

`--headless` must come **before** the issue argument (the script parses leading
flags first). Headless auto-approves tools and walks the model fallback chain
unattended — use it when dispatching from inside a Claude Code session with no
one watching a REPL. Drop `--headless` only if Josh himself wants to drive the
agy REPL interactively.

**B. No issue yet — a quick task not worth a full issue:**

Append one line to the queue file, format `<repo-name>: <task description>`:

```sh
printf '%s\n' "CollegeLutheran: <precise task — name the exact button/function/flow>" >> ~/Dropbox/web-jam-llms/agy-tasks.txt
~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --headless
```

The wrapper picks the **first** non-comment, non-blank line in the queue file, so
only append when it's fine for this task to run next. The task line must be
**unambiguous against the actual code** — "could this wording point to more than
one button/function/flow in that repo?" If yes, name the exact one (see the
`agy-task-lines-must-be-unambiguous` memory — a vague line like "add a spinner
when I submit the news" silently landed on the wrong button because agy can't
ask a clarifying question mid-run).

**What the script does either way:** checks out latest `dev`, branches
`agy/<issue#>-<slug>` (or `agy/<slug>` for queue-line tasks), composes a prompt
wrapping the task in standing rules (commit incrementally, run this repo's real
lint/test scripts, finish with a draft PR via `create-draft-pr.sh`), then runs
`agy` on the most capable currently-available model. It refuses a dirty working
tree and never edits the queue file itself — delete the queue line yourself once
you've accepted the resulting PR.

## 2. Per-tier subagent prompt templates (Haiku / Sonnet / Opus)

Dispatch these via the `Agent` tool (`model: "haiku"` / omit for session default /
`model: "opus"`). A fresh subagent has none of this session's context, so the
prompt must be self-contained: repo path, branch, commit format, the version-bump
rule, and an explicit report-back list. Fill in the placeholders; don't paste them
literally.

The templates below say `package.json` "version" — that's correct for the Node
repos (CollegeLutheran, JaMmusic, web-jam-back, AppersonAuto, WebJamSocketCluster).
`web-jam-tools` itself is Deno: swap in `deno.json` "version" and note that its
bump is enforced automatically by a pre-push hook (`~/.claude/hooks/`), not a rule
the subagent has to self-police.

### Haiku — mechanical / gh / research

```
You are doing mechanical work in the <repo> repo at ~/WebJamApps/<repo>.

Task: <one precise, unambiguous instruction — name the exact file/field/function/gh command>

Rules:
- Do not make design decisions. If the task is ambiguous (could point to more than
  one file/function/flow), STOP and report the ambiguity instead of guessing.
- If this involves a code change: work on branch claude/<issue#>-<slug> off latest
  dev. Commit with a clear message ending exactly:
    Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>
- Do NOT bump the package.json version — that happens once per PR, not per commit
  (skip entirely if this is a follow-up commit to an already-open PR).

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
- <If this is a follow-up commit to an already-open PR #N: DO NOT bump the
  package.json version — it was already bumped once for this PR. Only bump on
  the PR's first commit.>

Rules:
- Commit incrementally with clear messages ending exactly:
    Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Find this repo's real lint + test scripts (AGENTS.md / package.json "scripts" —
  commonly `npm run lint` + `npm test`, some repos use `npm run test:lint` /
  `npm run test:unit`) and get both green before finishing.
- <If opening a new PR:> When done, run (never call `gh pr create` directly):
    ~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
      --author "Claude Code — Sonnet 5" \
      --summary "<bulleted, filled in by you>" \
      --test-plan "<exact commands + expected result>" \
      --test-evidence "<the actual lint+test output you saw>" \
      [--closes]   # only if this PR fully completes the issue

Report back:
- Summary of what changed, bulleted
- The real lint/test output (this is what feeds --test-evidence — don't paraphrase it)
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
- <If this is a follow-up commit to an already-open PR #N: DO NOT bump the
  package.json version — only the PR's first commit bumps it.>

Rules:
- Commit incrementally with clear messages ending exactly:
    Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
- Find this repo's real lint + test scripts (AGENTS.md / package.json "scripts")
  and get both green before finishing.
- Where there's a genuine design choice, make it and say why in the summary —
  don't ask a follow-up question you could resolve yourself with repo context.
- <If opening a new PR:> When done, run (never call `gh pr create` directly):
    ~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
      --author "Claude Code — Opus 4.8" \
      --summary "<bulleted, filled in by you>" \
      --test-plan "<exact commands + expected result>" \
      --test-evidence "<the actual lint+test output you saw>" \
      [--closes]

Report back:
- Summary of what changed AND the reasoning behind any judgment call, bulleted
- The real lint/test output (feeds --test-evidence — don't paraphrase it)
- Any open questions or things you couldn't verify
```

## Non-goals (don't do these here)

- Don't repeat the Opus/Sonnet/Haiku/Flash/Fable routing table — that's
  `docs/ai-team-playbook.md` (migrating there from global CLAUDE.md per
  web-jam-tools#115; link there, don't duplicate).
- Don't add a queue line for work that already has a GitHub issue.
- Don't invent a version-bump command — WebJamApps repos bump `package.json`
  "version" (or `deno.json` for web-jam-tools) by hand, once per PR (see the
  `one-semver-bump-per-pr` memory).
