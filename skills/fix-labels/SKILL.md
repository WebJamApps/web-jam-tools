---
name: fix-labels
description: Recurring GitHub issue-label drift-detector across the 8 active WebJamApps repos. Compares each repo's current labels against a fixed canonical schema baked into this file, reports drift (missing / misnamed / miscolored / wrong-repo / non-canonical) with blast radius per label, waits for Josh's per-item approval, then applies only what he approved. Manual only — `/fix-labels`, never auto-runs. Interactive, hard-gated to Haiku (same pattern as handle-gmails), does NOT dispatch a subagent. A clean workspace reports "no changes"; re-run anytime to catch drift that accumulates over time.
---

# fix-labels — canonical GitHub label drift-detector

A **recurring** drift-detector, not a one-time cleanup. Every run compares each repo's current
labels against the fixed canonical schema below, reports what has drifted (with blast radius on
anything destructive), waits for Josh's per-item approval, then applies only the approved changes. A
clean workspace reports "no changes." Re-run anytime — drift accumulates as repos pick up ad hoc
labels between runs.

## ⛔ Model gate — MUST be on Haiku (do this FIRST)

This is mechanical, high-volume `gh label` / `gh issue list` scanning across 8 repos, so it must run
on the cheapest tier that can do it: **Haiku**. A skill cannot switch the session model itself, so
the **very first action of this skill is to check the running model** — before scanning any repo:

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

## Repo classes

| Class             | Repos                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| **Front-end (5)** | JaMmusic, CollegeLutheran, AppersonAuto, TimShermanMusic, HenricksonForSalem |
| **Other (3)**     | web-jam-back, WebJamSocketCluster, web-jam-tools                             |

All 8 together are "all repos" below unless a schema row says otherwise. Full slugs are
`WebJamApps/<repo>` for every `gh --repo` call.

## The canonical schema (master list)

This is the single source of truth this skill enforces. One canonical name and one canonical color
per label, applied uniformly across every repo that should carry it.

### Model-tier — all 8 repos

| Label    | Color      | Hex       |
| -------- | ---------- | --------- |
| `Haiku`  | green      | `#0E8A16` |
| `Sonnet` | blue       | `#1D76DB` |
| `Opus`   | purple     | `#B392F0` |
| `Fable`  | orange-red | `#D93F0B` |

`Fable` is retired/dormant but **kept** in every repo in case the model returns — never a delete
candidate.

### Model-tier — front-end 5 repos ONLY

| Label        | Color  | Hex       |
| ------------ | ------ | --------- |
| `Flash Med`  | gold   | `#FBCA04` |
| `Flash High` | orange | `#E67E22` |

These do **not** belong in the 3 "other" repos. Consequences:

- TimShermanMusic's single `Flash` label → split into `Flash Med` + `Flash High` (propose create
  both, propose remove the old `Flash`).
- The single `Flash` label in web-jam-back / WebJamSocketCluster / web-jam-tools → delete candidate
  (not part of the canonical schema for those 3 repos at all).

### Priority — all 8 repos (title case)

| Label           | Color     | Hex       |
| --------------- | --------- | --------- |
| `Top Priority`  | black     | `#000000` |
| `High Priority` | dark red  | `#B60205` |
| `Low Priority`  | pale pink | `#F9D0C4` |

Renames every existing variant to these exact names: all-caps `TOP PRIORITY` (JaM, wjb) →
`Top Priority`; bare `High` / `Low` (wjt) → `High Priority` / `Low Priority`. Create where missing.

### Status — all 8 repos

| Label     | Color      | Hex       |
| --------- | ---------- | --------- |
| `blocked` | bright red | `#E11D21` |
| `parked`  | gray       | `#C2C2C2` |

`blocked` currently exists in only 3 repos with 3 different colors; `parked` exists in the 5
front-end repos. Both become uniform, present, and this color, in all 8.

### gig-outreach — 4 booking-epic repos ONLY

| Label          | Color | Hex       | Repos                                                      |
| -------------- | ----- | --------- | ---------------------------------------------------------- |
| `gig-outreach` | teal  | `#006B75` | JaMmusic, web-jam-back, WebJamSocketCluster, web-jam-tools |

Not the client sites (CollegeLutheran, AppersonAuto, TimShermanMusic, HenricksonForSalem) —
`gig-outreach` in any of those 4 is a wrong-repo removal candidate.

### GitHub defaults — all 8 repos

| Label         | Color      | Hex       |
| ------------- | ---------- | --------- |
| `bug`         | rose red   | `#D73A4A` |
| `enhancement` | light cyan | `#A2EEEF` |

Keep **only** `bug` and `enhancement`, at GitHub's standard colors. Every other GitHub default —
`documentation`, `question`, `duplicate`, `good first issue`, `help wanted`, `invalid`, `wontfix` —
is a **delete candidate**; Josh doesn't use them.

### Everything else

Any label not on this master list — repo-specific one-offs like `codex`, `agents`, or anything else
that isn't in one of the tables above — is a **delete candidate**, reported at report-out for Josh
to approve or veto per label. Nothing here is assumed; every non-canonical label gets its own line
in the report.

## Flow

1. **Model gate** (above) — confirm Haiku before anything else.
2. **Scan.** For each of the 8 repos, run:
   ```
   gh label list --repo WebJamApps/<repo> --json name,color
   ```
   Use the actual returned names/colors — don't assume a prior run's spellings still hold.
3. **Diff against the canonical schema** (below, per drift type) to build one drift list per repo.
4. **Report.** Present every proposed change, grouped by repo, in the Report format below — every
   remove/delete line carries its blast radius (see "Blast radius" below). Present the full report
   before asking for any approval; don't drip items one at a time.
5. **Approve/veto per item.** Ask Josh to approve or veto each proposed change — he can approve a
   whole repo's block at once ("all good for JaMmusic") or call out individual line items to skip.
   Nothing applies until approved. **Never auto-apply anything** — not even an "obviously safe"
   create.
6. **Apply** only what was approved, using the mechanics below.
7. **Confirm.** After applying, report back per-repo what actually changed (created / renamed /
   recolored / removed / deleted), and note anything Josh vetoed so it's clear it will resurface
   next run.
8. If a repo has zero drift, report "no changes" for it — don't omit it silently; Josh should see
   every repo was actually checked.

## Drift types (report each, every run)

For each repo, walk the canonical schema against that repo's actual labels and classify every
mismatch as one of:

1. **Missing** — a canonical label that should exist in this repo isn't present → propose **create**
   (`gh label create`).
2. **Misnamed** — a label exists that's clearly the canonical concept under a different name (e.g.
   `TOP PRIORITY`, bare `High`, `Flash` where the canonical split is `Flash Med`/`Flash High`) →
   propose **rename** (`gh label edit`). A rename preserves every issue's existing label association
   — nothing gets un-tagged.
3. **Miscolored** — the canonical label is present with the right name but the wrong color → propose
   **recolor** (`gh label edit`).
4. **Wrong-repo placement** — a canonical label is present in a repo that shouldn't carry it (e.g.
   `Flash Med`/`Flash High` in a non-front-end repo, `gig-outreach` on a client site) → propose
   **remove** (`gh label delete`, this repo only — the label stays canonical elsewhere).
5. **Non-canonical** — any label not on the master list at all (including GitHub defaults beyond
   `bug`/`enhancement`) → propose **delete** (`gh label delete`).

### Blast radius (mandatory for every remove/delete)

Before Josh can approve any **remove** or **delete**, show how many open issues in that repo
currently carry the label — deleting (or removing from that repo) a label un-tags every issue that
had it:

```
gh issue list --repo WebJamApps/<repo> --label "<label>" --state open --json number -q 'length'
```

Show this count inline on the proposed line, e.g.
`remove "Flash" from web-jam-back — 3 open issues
carry this label`. Never propose a remove/delete
line without this count already computed and shown.

## Report format

```
## fix-labels report — <ISO 8601 UTC timestamp>

### JaMmusic
- CREATE `blocked` (#E11D21) — missing
- RENAME `TOP PRIORITY` → `Top Priority` (color also updates to #000000)
- DELETE `codex` — non-canonical — 2 open issues carry this label

### web-jam-back
- CREATE `Top Priority` (#000000) — missing
- REMOVE `Flash` — wrong-repo (not canonical for this repo) — 5 open issues carry this label
- DELETE `wontfix` — non-canonical GitHub default — 0 open issues carry this label

### CollegeLutheran
no changes

...
```

One block per repo, always present (even "no changes"), so Josh sees every repo was actually checked
this run.

## Apply mechanics

- **Rename / recolor**:
  ```
  gh label edit --repo WebJamApps/<repo> "<old name>" --name "<new name>" --color "<hex, no #>"
  ```
  Preserves every issue's existing label association.
- **Create (missing)**:
  ```
  gh label create --repo WebJamApps/<repo> "<name>" --color "<hex, no #>"
  ```
- **Delete (approved removals/non-canonical only)**:
  ```
  gh label delete --repo WebJamApps/<repo> "<name>" --yes
  ```
  Only after the blast radius was shown for that specific label and Josh approved it.

Apply strictly in the order Josh approved; if he vetoes one line in a repo's block, apply the rest
of that block and skip only the vetoed line.

## Non-goals

- Never runs unprompted — manual `/fix-labels` invocation only.
- Never dispatches a subagent — runs inline on the gated Haiku session.
- Never auto-applies anything, including creates that look obviously safe.
- Never deletes or removes a label without first computing and showing its blast radius.
- Never touches `Fable` — retired/dormant, but always kept.
- Never adds `Flash Med`/`Flash High`/`gig-outreach` outside their scoped repo lists above.
- Never invents a new label name or color outside the canonical schema in this file — if a repo has
  a label that doesn't map cleanly to any schema row, it's a non-canonical delete candidate, not a
  judgment call to reclassify on the fly.
- Never edits code, comments on issues, or touches anything besides `gh label` state.
