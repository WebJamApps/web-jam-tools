---
name: flash-issues
description: Scan OPEN issues across the front-end repos for Flash-lane work, auto-label any issue missing a model label, and fully regenerate a priority/dependency-ordered `flash-issues.md` so Josh can run agy interactively himself when Claude is out of tokens. Manual only — invoked as `/flash-issues`, never auto-runs. Output defaults to `~/Dropbox/web-jam-llms/flash-issues.md`, replaced (never appended) on every run.
---

# flash-issues — regenerate the Flash-lane worklist

Josh sometimes needs to run `agy` himself, by hand, with no Claude session
available (out of tokens). This skill produces the list he reads off of:
every open Flash-lane issue across the front-end repos, in priority order,
with dependency ordering respected — so he can pick the next one and dispatch
it interactively without Claude in the loop.

This skill only **reads and labels** GitHub issues and **writes** the output
file. It never dispatches `agy`, never comments on issues, never closes
anything, and never touches any repo's code.

## Invocation

`/flash-issues` only. Never triggered automatically (no session-start hook,
no schedule) — this is a manual worklist refresh Josh asks for.

## Scope — the five front-end repos

```
WebJamApps/JaMmusic
WebJamApps/CollegeLutheran
WebJamApps/AppersonAuto
WebJamApps/TimShermanMusic
WebJamApps/HenricksonForSalem
```

These are the exact slugs (verified via `gh repo list WebJamApps` —
`TimShermanMusic` and `HenricksonForSalem` are each one word, mixed case).
If Josh has added a new front-end repo since this was written and asks why
it's missing, that's a real gap — add it to the list above in the same PR
that fixes it, don't work around it in memory.

## Step 1 — read each repo's real label set (don't hardcode spellings)

Model-tier labels are **not** spelled the same in every repo:

```sh
gh label list --repo WebJamApps/<repo> --json name -q '.[].name'
```

Run this once per repo per invocation and use the actual returned names for
the rest of the run. As of this writing: `JaMmusic`, `CollegeLutheran`,
`AppersonAuto`, and `HenricksonForSalem` split Flash into `Flash Med` /
`Flash High`; `TimShermanMusic` has a single `Flash` label with no split.
Do not assume any of that stays true — re-check every run.

The model-tier label family to recognize: `Haiku`, `Sonnet`, `Opus`, `Fable`,
and whichever Flash spelling(s) that repo has (`Flash`, or `Flash Med` +
`Flash High`).

## Step 2 — list open issues per repo

```sh
gh issue list --repo WebJamApps/<repo> --state open --limit 200 \
  --json number,title,labels,body,url
```

## Step 3 — classify every open issue

For each issue:

- **Already has a Flash-tier label** (`Flash` / `Flash Med` / `Flash High`,
  whatever that repo calls it) → Flash-lane candidate, go to Step 4.
- **Already has a different model label** (`Haiku` / `Sonnet` / `Opus` /
  `Fable`) → not this skill's concern, skip it entirely. Don't relabel,
  don't second-guess a prior triage decision.
- **Has no model label at all** → triage it now, using the team's routing
  conventions (see `docs/ai-team-playbook.md` and the model-routing memory —
  this skill does not repeat the full table):
  - `Haiku` — mechanical/one-off (lookups, single-field edits, typo/data fixes)
  - `Sonnet` — ordinary contained coding (a fix/feature across a few files)
  - `Opus` — genuine multi-file judgment/design
  - `Fable` — architecture/specs/requirements framing
  - `Flash` (Med/High if the repo splits it) — frontend/UI coding, which is
    most issues in these five repos since they're all front-end apps. Pick
    Med vs High **at triage** (agy has no dynamic thinking to pick for
    itself): Med is the default lane; use High only when the issue reads as
    a harder/riskier UI task (non-trivial state, layout, or interaction
    logic — not a one-line style tweak).

  Apply the chosen label:
  ```sh
  gh issue edit <number> --repo WebJamApps/<repo> --add-label "<label>"
  ```
  If the label you applied is Flash-tier, this issue is now also a
  Flash-lane candidate — carry it into Step 4.

## Step 4 — pool the Flash-lane candidates

Collect every Flash-lane candidate (pre-existing + newly labeled in Step 3)
from all five repos into one list. Each entry needs: repo, issue number,
title, URL, body text (for dependency/priority reading), and whether the
repo has a Flash Med/High split.

## Step 5 — read dependencies

For each candidate, read its body (and skim comments if the body is thin)
for dependency signals: explicit phrases ("depends on", "blocked by",
"requires", "after #", "upstream of"), cross-issue references (`#123` or
`Repo#123`), and a `blocked` / `dependencies` label if the repo has one.
There's no consistent machine-readable convention across these repos —
this is a judgment read of the issue text, not a fixed regex.

A dependency can point at:
- **another Flash-lane candidate in this pool** — fine, handle via ordering
  (Step 6).
- **an issue already closed** — not a live blocker, ignore it.
- **an issue that's open but NOT Flash-workable** (labeled `Sonnet` /
  `Opus` / `Haiku` / `Fable`, or in a non-front-end repo like
  `web-jam-back`) — this candidate cannot run yet. Route it to the Blocked
  section (Step 7), not the numbered list.
- **an open Flash-lane issue that, for whatever reason, isn't going into
  this file** (shouldn't normally happen, but if it does) — treat the same
  as "not Flash-workable right now" and block it, with the reason named.

## Step 6 — order the runnable list

Among candidates with no blocking dependency (or whose only dependencies are
themselves in this pool):

1. Priority labels first, where the repo has one (e.g. JaMmusic's
   `TOP PRIORITY`). Not every repo has a priority label — most don't.
2. Where no priority label exists, use judgment from the issue content:
   bugs/breakage generally outrank polish, and a clearer/better-specified
   issue is easier for agy to execute unattended than a vague one — prefer
   ordering agy toward issues it can actually finish.
3. **Dependency ordering wins over priority ordering.** If issue B depends
   on issue A and both are in the runnable list, A must appear before B
   regardless of B's priority label. Never list a dependency after its
   dependent.

Number the result 1, 2, 3, … — plain sequential numbering, not per-repo
grouping.

## Step 7 — build the Blocked section

Every candidate identified as blocked in Step 5 goes here instead, each with
a one-line reason naming the blocking issue and why Flash can't clear it
(e.g. "depends on web-jam-back#812 (Sonnet, backend endpoint not built)").
No further ordering is required within this section — a plain list is fine.

## Step 8 — regenerate the output file (replace, never append)

Default path: `~/Dropbox/web-jam-llms/flash-issues.md`. This repo's
skills don't currently support a per-run path override for their primary
output file (`handle-agy-tasks.sh`'s queue path is the same pattern — a
documented hardcoded default), so this path is fixed; if Josh ever wants an
override, that's a follow-up issue, not something to invent here.

**Fully overwrite the file every run** — it is a regenerated snapshot, not a
log. Never append, never merge with the previous version's ordering.

### Output template

```markdown
# Flash-lane issues

_Regenerated by /flash-issues — do not hand-edit, next run replaces this file._

Last updated: 2026-07-20T18:04:00Z

1. [CollegeLutheran#123](https://github.com/WebJamApps/CollegeLutheran/issues/123) — Add mobile nav collapse toggle
2. [JaMmusic#1220](https://github.com/WebJamApps/JaMmusic/issues/1220) — Venue picker: filter list by metro
3. [JaMmusic#1221](https://github.com/WebJamApps/JaMmusic/issues/1221) — Venue picker: wire selection to gig form (depends on JaMmusic#1220 above)

## Blocked (not runnable by Flash)

- [AppersonAuto#88](https://github.com/WebJamApps/AppersonAuto/issues/88) — Inventory filter UI — blocked: depends on AppersonAuto#85 (Sonnet, backend endpoint not built)
```

Every list line is: full `https://github.com/WebJamApps/<repo>/issues/<n>`
link, repo-prefixed reference (`Repo#n`) as the link text, em dash, title.
Keep titles as GitHub has them — don't paraphrase.

## Step 9 — report back to Josh

Short summary in chat: how many repos/issues scanned, how many issues were
newly labeled (and what they were labeled), how many Flash-lane issues
landed in the numbered list vs. the Blocked section. Don't dump the whole
file into chat — it's already saved to Dropbox.

## Non-goals

- Never dispatches `agy` / `handle-agy-tasks.sh` — that's Josh's manual next
  step once he has the list, or the `delegate` skill when Claude is doing it.
- Never relabels an issue that already has a model label, even if the
  triage looks wrong — flag a mislabel to Josh in the chat summary instead
  of silently overriding a prior decision.
- Never comments on, closes, or edits anything about an issue besides adding
  a missing model label.
- Doesn't repeat the Haiku/Sonnet/Opus/Fable/Flash routing table — that
  lives in `docs/ai-team-playbook.md`; this skill only applies it.
