---
name: flash-issues
description: Scan OPEN issues across the front-end repos for Flash-lane work, auto-label any issue missing a model label, and fully regenerate a priority/dependency-ordered `flash-issues.md` so Josh can run agy interactively himself when Claude is out of tokens. Manual only — invoked as `/flash-issues`, never auto-runs. The invoking session never scans/labels/writes itself — it dispatches ONE Haiku subagent to do the whole run and relays its report. Output defaults to `~/Dropbox/web-jam-llms/flash-issues.md`, replaced (never appended) on every run.
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

## Execution model — dispatch to Haiku, never run inline

`/flash-issues` is almost always invoked in a Fable/Opus session, but the
work itself (`gh label list` / `gh issue list` scanning, mechanical
triage-labeling, dependency reading, file writing) is exactly the mechanical
work the team's standing routing rule says goes to the cheapest capable
model. **The invoking session does not execute Steps 1–8 itself, no matter
how quick it looks.**

Instead:

1. Launch exactly **one** subagent via the `Agent` tool with `model: "haiku"`,
   passing the self-contained prompt in "Dispatch prompt template" below
   verbatim (it's written to need no context from this conversation — the
   subagent has none).
2. Wait for the subagent's report (the Step 9 format baked into the
   template).
3. Relay that report to Josh essentially as-is: counts, what got newly
   labeled, numbered-list count vs. Blocked count.
4. **Flagged items are pending decisions, not report trivia.** After
   delivering the run summary, present them in their own clearly-titled
   section — never a trailing paragraph under other status, never buried.
   Then walk them **one at a time**: ask Josh about the first, wait for his
   answer, then move to the next. The run is not complete while a flagged
   decision sits unanswered and unparked — either Josh decides it now or
   explicitly parks it; "he'll get to it" is not resolution.

Never run the `gh` scans, triage, or file write yourself in the invoking
session "to save a round trip" — that's the exact expensive-token-burn this
defect fix exists to close off.

## Dispatch prompt template (pass verbatim to the `Agent` tool)

Fill in nothing — this prompt is complete as written. Pass it as the `prompt`
argument with `subagent_type` omitted/general-purpose and `model: "haiku"`.

````
You are doing mechanical GitHub scanning/labeling work — no code changes, no
repo checkout needed beyond `gh` calls. Task: regenerate the Flash-lane
worklist file that Josh (the product owner) reads by hand to run agy himself
when Claude is out of tokens.

## Scope — these five repos, exactly these slugs

WebJamApps/JaMmusic
WebJamApps/CollegeLutheran
WebJamApps/AppersonAuto
WebJamApps/TimShermanMusic
WebJamApps/HenricksonForSalem

(TimShermanMusic and HenricksonForSalem are each one word, mixed case.)

## Step 1 — read each repo's real label set (don't hardcode spellings)

Model-tier labels are NOT spelled the same in every repo. For each repo run:

  gh label list --repo WebJamApps/<repo> --json name -q '.[].name'

Use the actual returned names for the rest of this run — don't assume any
prior run's spellings still hold. As of the last check: JaMmusic,
CollegeLutheran, AppersonAuto, and HenricksonForSalem split Flash into
`Flash Med` / `Flash High`; TimShermanMusic has a single `Flash` label with
no split. The model-tier label family to recognize in any repo: `Haiku`,
`Sonnet`, `Opus`, `Fable`, and whichever Flash spelling(s) that repo has.

## Step 2 — list open issues per repo

  gh issue list --repo WebJamApps/<repo> --state open --limit 200 \
    --json number,title,labels,body,url

## Step 3 — classify every open issue

For each issue:

- Already has a Flash-tier label (`Flash` / `Flash Med` / `Flash High`,
  whatever that repo calls it) → Flash-lane candidate, go to Step 4. Record
  which tier label it already carries.
- Already has a different model label (`Haiku` / `Sonnet` / `Opus` /
  `Fable`) → not in scope, skip entirely. Don't relabel, don't second-guess
  a prior triage decision.
- Has no model label at all → triage it now using these routing
  conventions (the team's standing model-routing rules; full detail in this
  repo's docs/ai-team-playbook.md if you have repo access and want more
  context, but this is enough to decide):
    - Haiku — mechanical/one-off (lookups, single-field edits, typo/data
      fixes)
    - Sonnet — ordinary contained coding (a fix/feature across a few files)
    - Opus — genuine multi-file judgment/design
    - Fable — architecture/specs/requirements framing
    - Flash (Med/High if the repo splits it) — frontend/UI coding, which is
      most issues in these five repos since they're all front-end apps.
      Pick Med vs High AT TRIAGE (agy has no dynamic thinking to pick for
      itself): Med is the default lane; use High only when the issue reads
      as a harder/riskier UI task (non-trivial state, layout, or
      interaction logic — not a one-line style tweak).

  BEFORE applying a label, check whether this issue is actually a clean
  triage call. If it is NOT — the issue doesn't clearly read as codework
  (e.g. it's a question, a discussion, an ops/manual task), OR it looks like
  a duplicate of another open issue, OR it looks like it may already be
  done (body/title suggests completed work, or a linked PR looks merged) —
  DO NOT GUESS. Do not apply any label and do not add it to the candidate
  pool. Instead add it to a "Flagged for Josh" list you'll include in your
  final report, with the issue reference and a one-line reason. This is a
  hard rule, not a suggestion — an uncertain guess here is worse than
  leaving it unlabeled for a human to look at.

  Otherwise, apply the chosen label:

    gh issue edit <number> --repo WebJamApps/<repo> --add-label "<label>"

  If the label you applied is Flash-tier, this issue is now also a
  Flash-lane candidate — carry it into Step 4, and record which tier.

## Step 4 — pool the Flash-lane candidates

Collect every Flash-lane candidate (pre-existing + newly labeled in Step 3)
from all five repos into one list. Each entry needs: repo, issue number,
title, URL, body text (for dependency/priority reading), and its Flash tier
label (`Flash`, `Flash Med`, or `Flash High` — exactly as that repo spells
it).

## Step 5 — read dependencies

For each candidate, read its body (and skim comments if the body is thin)
for dependency signals: explicit phrases ("depends on", "blocked by",
"requires", "after #", "upstream of"), cross-issue references (#123 or
Repo#123), and a `blocked` / `dependencies` label if the repo has one.
There's no consistent machine-readable convention across these repos — this
is a judgment read of the issue text, not a fixed regex.

A dependency can point at:
- another Flash-lane candidate in this pool — fine, handle via ordering
  (Step 6).
- an issue already closed — not a live blocker, ignore it.
- an issue that's open but NOT Flash-workable (labeled Sonnet / Opus /
  Haiku / Fable, or in a non-front-end repo like web-jam-back) — this
  candidate cannot run yet. Route it to the Blocked section (Step 7), not
  the numbered list.
- an open Flash-lane issue that, for whatever reason, isn't going into this
  file — treat the same as "not Flash-workable right now" and block it,
  with the reason named.

## Step 6 — order the runnable list

Among candidates with no blocking dependency (or whose only dependencies
are themselves in this pool):

1. Priority labels first, where the repo has one (e.g. JaMmusic's
   `TOP PRIORITY`). Not every repo has a priority label — most don't.
2. Where no priority label exists, use judgment from the issue content:
   bugs/breakage generally outrank polish, and a clearer/better-specified
   issue is easier for agy to execute unattended than a vague one — prefer
   ordering agy toward issues it can actually finish.
3. Dependency ordering wins over priority ordering. If issue B depends on
   issue A and both are in the runnable list, A must appear before B
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

Path: ~/Dropbox/web-jam-llms/flash-issues.md — fully overwrite it every
run. It's a regenerated snapshot, not a log: never append, never merge with
the previous version's ordering.

Every entry — in BOTH the numbered list and the Blocked section — MUST end
with its Flash tier in parentheses, exactly as that repo spells it
(`Flash`, `Flash Med`, or `Flash High`). Josh uses this to know whether to
run agy with the plain default chain or override it with
AGY_MODELS='Gemini 3.5 Flash (High)'.

Output template:

# Flash-lane issues

_Regenerated by /flash-issues — do not hand-edit, next run replaces this file._

Last updated: <ISO 8601 UTC timestamp of this run>

1. [CollegeLutheran#123](https://github.com/WebJamApps/CollegeLutheran/issues/123) — Add mobile nav collapse toggle (Flash Med)
2. [JaMmusic#1220](https://github.com/WebJamApps/JaMmusic/issues/1220) — Venue picker: filter list by metro (Flash Med)
3. [JaMmusic#1221](https://github.com/WebJamApps/JaMmusic/issues/1221) — Venue picker: wire selection to gig form (Flash High, depends on JaMmusic#1220 above)

## Blocked (not runnable by Flash)

- [AppersonAuto#88](https://github.com/WebJamApps/AppersonAuto/issues/88) — Inventory filter UI (Flash Med) — blocked: depends on AppersonAuto#85 (Sonnet, backend endpoint not built)

Every list line is: full https://github.com/WebJamApps/<repo>/issues/<n>
link, repo-prefixed reference (Repo#n) as the link text, em dash, title,
then the Flash tier in parentheses (plus the blocked-reason clause for
Blocked entries). Keep titles as GitHub has them — don't paraphrase.

## Report back (this is what you hand back to the invoking session)

- Repos scanned, total open issues seen, how many were already Flash-tier
  vs. newly triaged.
- Every issue you newly labeled and what you labeled it.
- Count in the numbered list vs. count in the Blocked section.
- The full "Flagged for Josh" list from Step 3, if non-empty — each item
  with its issue reference and the one-line reason you didn't guess.
- Confirmation the file was written to
  ~/Dropbox/web-jam-llms/flash-issues.md.
````

## Non-goals

- The invoking session never runs Steps 1–8 itself — that's the whole point
  of this fix. If you catch yourself about to run a `gh label list` or
  `gh issue list` call inline for this skill, stop and dispatch instead.
- Never dispatches `agy` / `handle-agy-tasks.sh` — that's Josh's manual next
  step once he has the list, or the `delegate` skill when Claude is doing it.
- Never relabels an issue that already has a model label, even if the
  triage looks wrong — flag a mislabel to Josh in the chat summary instead
  of silently overriding a prior decision.
- Never comments on, closes, or edits anything about an issue besides adding
  a missing model label.
- Never guesses on an issue that isn't clearly codework, looks like a
  duplicate, or looks already-done — that's a hard flag-to-Josh case, not a
  best-effort label.
- Doesn't repeat the Haiku/Sonnet/Opus/Fable/Flash routing table — that
  lives in `docs/ai-team-playbook.md`; this skill only applies it.
