---
name: fix-labels
description: Recurring GitHub issue-label AND topic-milestone drift-detector across the active WebJamApps repos. Computes label drift (missing / misnamed / miscolored / wrong-repo / non-canonical) by diffing each repo's actual labels against skills/fix-labels/labels.yaml in code (`deno task fix-labels:diff`), with blast radius per label, and milestone-name drift (missing / misspelled / non-canonical) the same way (`deno task fix-labels:milestone-diff`). Waits for Josh's per-item approval, then applies only what he approved. Manual only — `/fix-labels`, never auto-runs. Interactive, hard-gated to Haiku (same pattern as handle-gmails), does NOT dispatch a subagent. A clean workspace reports "no changes"; re-run anytime to catch drift that accumulates over time.
---

# fix-labels — canonical GitHub label + topic-milestone drift-detector

A **recurring** drift-detector, not a one-time cleanup. Every run computes each repo's label drift
against `labels.yaml` — in code, via `deno task fix-labels:diff`, not by eye — and each repo's
topic-milestone drift the same way, via `deno task fix-labels:milestone-diff` (web-jam-tools#300).
It reports what has drifted (with blast radius on anything destructive), waits for Josh's per-item
approval, then applies only the approved changes and re-scans to confirm the apply actually
worked. A clean workspace reports "no changes." Re-run anytime — drift accumulates as repos pick
up ad hoc labels or milestones between runs.

`web-jam-tools#300`: topic labels (`gig-outreach`, plus a `backup-restore` label kept by hand) were
pruned from `labels.yaml` in favor of per-repo MILESTONES — see the design amendment on
web-jam-tools#287 "fix-labels skill expanded / corrected" (2026-07-29). No custom GitHub issue
field renders when it's unset, so none was ever a writable surface for Josh by hand; a milestone
is the only surface that is both always-visible-when-unset and writable in the UI. Because
cross-repo topic matching is by **exact milestone name**, a typo or a missing milestone silently
splits or hides a topic — that's what `fix-labels:milestone-diff` guards against.

`web-jam-tools#263`: an earlier version of this skill asked the model to eyeball ~150 name/color
pairs across 8 repos in prose. That run reported all 8 repos clean while four real defects
survived — a `blocked` label that existed miscolored got reported (and applied) as "missing", two
priority labels stayed miscolored because they were never flagged, a front-end repo's `Flash`
split lost half its replacement pair, and `Flash High`'s wrong color went unnoticed in all 5
front-end repos. The diff is now computed by `src/fix-labels/diff.ts`, unit-tested against exactly
those four defects (`test/fix_labels_diff.test.ts`) so they can't silently regress.

## ⛔ Model gate — MUST be on Haiku (do this FIRST)

This is mechanical, high-volume `gh label` / `gh issue list` / `gh api .../milestones` scanning
across the active repos, so it must run on the cheapest tier that can do it: **Haiku**. A skill
cannot switch the session model itself, so the **very first action of this skill is to check the
running model** — before scanning any repo:

- **If the model is NOT Haiku** (e.g. Opus, Sonnet): do **not** scan anything. Stop immediately and
  tell Josh, verbatim:
  > ⛔ /fix-labels must run on Haiku to keep this cheap. Please switch models first — type
  > `/model haiku` — then re-run `/fix-labels`.

  Then **STOP and wait.** Do not proceed until the session is on Haiku.
- **If the model IS Haiku:** proceed with the flow below.

This skill runs **interactively, directly on the session — it does NOT dispatch a subagent.** Unlike
`flash-issues` (which dispatches to Sonnet), `/fix-labels` is cheap enough at Haiku scale to run
inline, and its approve/veto-per-label flow needs a live conversation with Josh anyway.

Optional, implementer's discretion, not required for this issue: a hard `PreToolUse` hook mirroring
`hooks/haiku-only-gmail-gate.sh` could deny `gh label` create/edit/delete calls unless the session
is on Haiku, as belt-and-suspenders on top of the soft gate above. Not built here — this issue is
the skill file only.

## Trigger

`/fix-labels` only. Manual invocation, never automatic — no session-start hook, no schedule.

## The canonical schema — `labels.yaml` is the single source of truth

Every canonical label name, hex color, which repos carry it, and every canonical topic milestone
lives in [`labels.yaml`](./labels.yaml) beside this file, parsed by `src/fix-labels/diff.ts`
(`deno task fix-labels:diff`) and `src/fix-labels/milestone-diff.ts`
(`deno task fix-labels:milestone-diff`). This skill file never restates those name/hex pairs or
topic names — one source of truth, not two that can drift apart.

Shape, for orientation (see `labels.yaml` for the actual current values):

- **Model-tier** — `Haiku` / `Sonnet` / `Opus` / `Fable` across all 8 repos; `Flash Med` /
  `Flash High` / `Flash Low` additionally in the 5 front-end repos only. `Fable` is retired/dormant
  and marked `neverDelete` in the schema — the scripted diff never proposes removing it, in any
  repo.
- **Status** — `parked` / `Josh` / `Blocked`, across all 8 repos. `Blocked` (capital B, `B60205`) is
  the at-a-glance signal for a currently-unworkable issue, used ALONGSIDE native GitHub
  issue-dependency links (the real relationship) — never a substitute for them, and never the other
  way around. Restored canonical by `web-jam-tools#329` "Restore the Blocked label as canonical in
  labels.yaml — it was pruned in a batch Josh never ratified, and he wants it alongside native
  dependencies" after the lowercase `blocked` was pruned without his agreement (below); do not prune
  it again.
- **Everything else** — any label not in `labels.yaml`'s `labels:` list is non-canonical, unless
  it's on that repo's `keep:` list (Josh-vetoed keepers, so he never has to re-veto the same label
  forever — currently empty; see `labels.yaml` for the up-to-date list).

`web-jam-tools#300` pruned priority labels (`Top Priority`/`High Priority`/`Low Priority` → native
`Priority` issue field), topic labels (`gig-outreach`, and the `backup-restore` and
`timshermanmusic` keep-list entries → per-repo milestones, below), and `bug`/`enhancement` (→ native
issue Types) from `labels.yaml` — they now surface as ordinary non-canonical delete candidates
rather than canonical entries. Deleting them from GitHub itself is a separate, deliberate step:
web-jam-tools#299 "Delete replaced labels org-wide, after migration". That same batch also pruned
lowercase `blocked` (→ "native issue dependencies") — Josh never ratified that one specifically;
`web-jam-tools#329` restored it as canonical `Blocked` (capital B, see above). The old lowercase
`blocked` spelling stays retired and is still a non-canonical delete candidate if it ever turns up
live.

Repo classes (also in `labels.yaml`, under `repoClasses:`):

| Class             | Repos                                                                        |
| ----------------- | ----------------------------------------------------------------------------- |
| **Front-end (5)** | JaMmusic, CollegeLutheran, AppersonAuto, TimShermanMusic, HenricksonForSalem |
| **Other (3)**     | web-jam-back, WebJamSocketCluster, web-jam-tools                             |

All 8 together are "all repos" below. Full slugs are `WebJamApps/<repo>` for every `gh --repo` call.

## Canonical topic milestones — `labels.yaml`'s `milestoneTopics:`

`web-jam-tools#300`: topics (formerly the `gig-outreach` label and the hand-kept `backup-restore`
and `timshermanmusic` labels) now live as per-repo **milestones**, matched cross-repo by **exact
name** — see the design amendment on web-jam-tools#287 "fix-labels skill expanded / corrected"
(2026-07-29). Canonical topics currently in use, per `labels.yaml`'s `milestoneTopics:` (see that
file for the current values — not restated here):

- `gig-outreach` — JaMmusic, web-jam-back, web-jam-tools, WebJamSocketCluster.
- `backup-restore` — web-jam-tools.
- `timshermanmusic` — web-jam-back, JaMmusic, WebJamSocketCluster.

`deno task fix-labels:milestone-diff` fetches each listed repo's actual milestones
(`gh api repos/WebJamApps/<repo>/milestones`) and classifies every mismatch:

1. **Missing** — a repo that should carry a topic milestone doesn't have one → propose **create**.
2. **Misspelled** — an existing milestone is a case-variant or a close typo (small edit distance) of
   a canonical topic name → propose **rename**, preserving every issue's existing milestone
   association (a rename, not a delete+create).
3. **Non-canonical** — a milestone that doesn't match any canonical topic name at all, OR matches a
   canonical name but in a repo that topic isn't designated for → flagged for Josh's review. This
   skill never auto-deletes or auto-renames a non-canonical milestone away — Josh decides case by
   case (it could be a genuine release milestone, not a topic typo).

## Flow

1. **Model gate** (above) — confirm Haiku before anything else.
2. **Run both tasks.**
   ```
   deno task fix-labels:diff
   deno task fix-labels:milestone-diff
   ```
   The first shells out to `gh label list --repo WebJamApps/<repo> --json name,color` for all 8
   repos, diffs each repo's actual labels against `labels.yaml` **in code** (`classifyRepoDrift` in
   `src/fix-labels/diff.ts`), and computes blast radius for every proposed remove/delete line. The
   second shells out to `gh api repos/WebJamApps/<repo>/milestones` for the repos named in
   `labels.yaml`'s `milestoneTopics:`, and diffs actual milestone names against the canonical topic
   list **in code** (`classifyMilestoneDrift` in `src/fix-labels/milestone-diff.ts`). No eyeballing,
   no comparison in prose — the tasks compute the diff, the model never compares lists by reading
   them side by side.
3. **Present both reports.** Present the full label report and the full milestone report before
   asking for any approval; don't drip items one at a time.
4. **Approve/veto per item.** Ask Josh to approve or veto each proposed change (label AND
   milestone) — he can approve a whole repo's block at once ("all good for JaMmusic") or call out
   individual line items to skip. Nothing applies until approved. **Never auto-apply anything** —
   not even an "obviously safe" create, and never act on a milestone flagged NON-CANONICAL/REVIEW
   without Josh's explicit call on what to do with it.
5. **Apply** only what was approved, using the mechanics below.
6. **Re-scan (mandatory).** Re-run both tasks after applying, and report **that** output to Josh —
   never a replay of the apply log's `echo` lines. Expected result: an empty drift list except for
   lines Josh explicitly vetoed (those are expected to resurface — say so). Anything else — a line
   that should have been applied still showing up, an apply that silently failed — is a **failed
   run** and must be reported as one, not glossed over.
7. If a repo has zero drift on the re-scan, report "no changes" for it — don't omit it silently;
   Josh should see every repo was actually checked.

## Drift types (the task classifies every mismatch as one of these, every run)

1. **Missing** — a canonical label that should exist in this repo isn't present → propose **create**
   (`gh label create`).
2. **Misnamed** — an actual label matches a known alias of a canonical label (e.g. `TOP PRIORITY`,
   bare `High`, per `labels.yaml`'s `aliases:`) → propose **rename** (`gh label edit`). A rename
   preserves every issue's existing label association — nothing gets un-tagged.
3. **Miscolored** — the canonical label is present with the right name but the wrong color → propose
   **recolor** (`gh label edit`). A label that exists under the right name is ALWAYS miscolored, not
   missing, even if its color is badly wrong — this is exactly the case (`blocked` in
   CollegeLutheran) that the eyeballed version of this skill got wrong.
4. **Wrong-repo placement** — a canonical label is present in a repo that shouldn't carry it (e.g.
   `Flash Med`/`Flash High`/`Flash Low` in a non-front-end repo) → propose **remove**
   (`gh label delete`, this repo only — the label stays canonical elsewhere).
5. **Non-canonical** — any label not in `labels.yaml` at all — including every GitHub default
   label, a legacy label like a single `Flash` where the canonical split is `Flash Med`/`Flash
   High`/`Flash Low`, and (as of web-jam-tools#300) the pruned `Top Priority`/`High
   Priority`/`Low Priority`/`bug`/`enhancement`/`blocked`/`gig-outreach` labels if still present on
   a repo — propose **delete** (`gh label delete`), unless it's on that repo's `keep:` list.

### Blast radius (mandatory for every remove/delete)

`deno task fix-labels:diff` computes this automatically for every proposed remove/delete line by
running, per label:

```
gh issue list --repo WebJamApps/<repo> --label "<label>" --state open --json number -q 'length'
```

The count is already in the task's report output — never propose a remove/delete line without it,
and never let the model guess or skip it.

## Report format

```
## fix-labels report — <ISO 8601 UTC timestamp>

### JaMmusic
- CREATE `Flash Low` (#FEF2C0) — missing
- RECOLOR `parked` #0206d8 → #C2C2C2 — miscolored
- DELETE `codex` — non-canonical — 2 open issues carry this label

### web-jam-back
- DELETE `Top Priority` — non-canonical — 3 open issues carry this label
- REMOVE `Flash Med` — wrong-repo (not canonical for this repo) — 5 open issues carry this label
- DELETE `wontfix` — non-canonical GitHub default — 0 open issues carry this label

### CollegeLutheran
no changes

...
```

One block per repo, always present (even "no changes"), so Josh sees every repo was actually checked
this run. This is exactly what `deno task fix-labels:diff` prints — relay it, don't retype it.

The milestone report follows the same one-block-per-repo shape, scoped to the repos named in
`labels.yaml`'s `milestoneTopics:`:

```
## fix-labels milestone report — <ISO 8601 UTC timestamp>

### JaMmusic
no changes

### web-jam-back
- RENAME milestone `Gig-Outreach` → `gig-outreach` — misspelled

### web-jam-tools
- CREATE milestone `backup-restore` — missing
- REVIEW milestone `v2-release` — non-canonical, not on the topic list
```

This is exactly what `deno task fix-labels:milestone-diff` prints — relay it, don't retype it.

## Apply mechanics

**Never suppress stderr or ignore exit status on any `gh label` call — `2>/dev/null` is banned on
every one.** Check the exit status of every `gh label create` / `edit` / `delete` invocation. A
`create` that fails because the label already exists is not a no-op to hide — it's proof the
report was wrong (the label existed, miscolored or not, rather than being genuinely missing), and
must be surfaced to Josh, loudly, not swallowed. This is exactly the secondary fault
(web-jam-tools#263) that let a failed `blocked` create in CollegeLutheran get reported as success.

- **Rename / recolor**:
  ```
  gh label edit --repo WebJamApps/<repo> "<old name>" --name "<new name>" --color "<hex, no #>"
  ```
  Preserves every issue's existing label association. Check the exit status; report any failure.
- **Create (missing)**:
  ```
  gh label create --repo WebJamApps/<repo> "<name>" --color "<hex, no #>"
  ```
  Check the exit status; report any failure — do not redirect stderr away from view.
- **Delete (approved removals/non-canonical only)**:
  ```
  gh label delete --repo WebJamApps/<repo> "<name>" --yes
  ```
  Only after the blast radius was shown for that specific label and Josh approved it. Check the
  exit status; report any failure.

Apply strictly in the order Josh approved; if he vetoes one line in a repo's block, apply the rest
of that block and skip only the vetoed line.

### Milestone apply mechanics (web-jam-tools#300)

`gh` has no built-in `gh milestone` subcommand, so every milestone mutation goes through `gh api`.
Same rule as labels: never suppress stderr or ignore exit status; a `create` that fails because the
milestone already exists must be surfaced, not swallowed.

- **Create (missing)**:
  ```
  gh api repos/WebJamApps/<repo>/milestones -f title="<canonical name>"
  ```
- **Rename (misspelled)**: milestones are identified by number, not name — look it up from the
  drift item (`fetchActualMilestones`/`classifyMilestoneDrift` already attach it), then:
  ```
  gh api -X PATCH repos/WebJamApps/<repo>/milestones/<number> -f title="<canonical name>"
  ```
  Preserves every issue's existing milestone association — nothing gets un-tagged.
- **Non-canonical / REVIEW**: this skill takes **no automated action** here — deleting or renaming
  a milestone Josh hasn't specifically approved is out of scope for this skill (and deleting
  milestones from GitHub is out of scope for web-jam-tools#300 entirely). Report it and wait for
  Josh's explicit instruction on what, if anything, to do with it.

## Non-goals

- Never runs unprompted — manual `/fix-labels` invocation only.
- Never dispatches a subagent — runs inline on the gated Haiku session.
- Never auto-applies anything, including creates that look obviously safe.
- Never deletes or removes a label without first computing and showing its blast radius.
- Never touches `Fable` — retired/dormant, but always kept.
- Never adds `Flash Med`/`Flash High`/`Flash Low` outside their scoped repo list (frontend) above.
- Never invents a new label name/color or topic milestone name outside the canonical schema in this
  file — if a repo has a label or milestone that doesn't map cleanly to any schema entry, it's a
  non-canonical candidate, not a judgment call to reclassify on the fly.
- Never deletes or renames a milestone flagged non-canonical without Josh's explicit per-item call
  — this skill has no automated milestone-delete action at all, approved or not.
- A mass org-wide cleanup of the labels web-jam-tools#300 pruned from canon is a separate,
  deliberate step — web-jam-tools#299 "Delete replaced labels org-wide, after migration" — not
  something this skill's normal per-label approve/apply flow should be used to bulk-drive.
- Never edits code, comments on issues, or touches anything besides `gh label`/milestone state.
