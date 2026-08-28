---
name: flash-issues
description: Scan OPEN issues across all 8 active WebJamApps repos for Flash-lane work, auto-label any issue missing a model label, detect in-flight open PR review status and outstanding Must Fix items, and fully regenerate a priority/dependency-ordered `flash-issues.md` via `deno task flash-issues` so Josh can run agy interactively himself when Claude is out of tokens. Manual only — invoked as `/flash-issues`, never auto-runs. The invoking session never scans/labels/writes itself — it dispatches ONE Flash High subagent to run `deno task flash-issues` and relays its report. Output defaults to `~/Dropbox/web-jam-llms/flash-issues.md`, replaced (never appended) on every run.
---

# flash-issues — regenerate the Flash-lane worklist

Josh sometimes needs to run `agy` himself, by hand, with no Claude session
available (out of tokens). This skill produces the list he reads off of:
every open Flash-lane issue across all 8 active WebJamApps repos, in priority order,
with dependency ordering respected — so he can pick the next one and dispatch
it interactively without Claude in the loop.

This skill only **reads and labels** GitHub issues and **writes** the output
file deterministically via `deno task flash-issues`. It never dispatches `agy`, never comments on issues, never closes
anything, and never touches any repo's code.

## Invocation

`/flash-issues` only. Never triggered automatically (no session-start hook,
no schedule) — this is a manual worklist refresh Josh asks for.

## Execution model — dispatch to Flash High, never run inline

`/flash-issues` is almost always invoked in a Fable/Opus session, but the
work itself (`gh label list` / `gh issue list` scanning, mechanical
triage-labeling, dependency reading, file writing) is executed deterministically by running
`deno task flash-issues` in `web-jam-tools` (or `deno run -A ~/WebJamApps/web-jam-tools/src/flash-issues/cli.ts`). Flash High is the chosen tier for this run. **The invoking
session does not execute Steps 1–9 itself, no matter how quick it looks.**

Instead:

1. Launch exactly **one** subagent based on host surface:
   - **Claude Code surface:** `Agent(subagent_type: "general-purpose", model: "haiku")`
   - **Antigravity (`agy`) surface:** `invoke_subagent(TypeName: "self", Role: "Flash Issues Runner", Model: "inherit")`
   passing the self-contained prompt in "Dispatch prompt template" below verbatim.
2. Wait for the subagent to execute `deno task flash-issues` and return its report.
3. Relay that report to Josh essentially as-is: counts, what got newly
   labeled, fix-bucket count (changes requested vs. CI failing) vs. numbered-list count vs. In Flight awaiting-review count vs. Blocked count.
4. **Never block chat on flagged items.** They live in the output file's
   "Needs Josh's review" section (Step 9), not in a chat Q&A. State the
   count and point at the file — "N issues need your review, see the
   bottom of flash-issues.md" — and move on. Josh reviews them on his own
   time; no agent waits on an answer.

Never run the `gh` scans, triage, or file write yourself in the invoking
session "to save a round trip" — that's the exact expensive-token-burn this
defect fix exists to close off.

## Dispatch prompt template (pass verbatim to the `Agent` / `invoke_subagent` tool)

Fill in nothing — this prompt is complete as written. Pass it as the `prompt` argument:
- **Claude Code surface:** `Agent(subagent_type: "general-purpose", model: "haiku", prompt: ...)`
- **Antigravity (`agy`) surface:** `invoke_subagent(TypeName: "self", Role: "Flash Issues Runner", Model: "inherit", Prompt: ...)`

````
You are running the deterministic Flash worklist regeneration task.
Execute `deno task flash-issues` in `~/WebJamApps/web-jam-tools` (or `deno run -A ~/WebJamApps/web-jam-tools/src/flash-issues/cli.ts`) to regenerate the Flash-lane worklist file that Josh (the product owner) reads by hand to run agy himself when Claude is out of tokens. Report back the output summary.

If needed for manual reference, the complete deterministic workflow implemented by `deno task flash-issues` is:

## Implementation approach — REST issue payload, not search qualifiers

Priority, Issue Type, and topic used to live on labels; they now live on
native GitHub metadata (org `Priority`/`Type` fields, per-repo Milestones,
native issue dependencies) — model-lane labels (`Haiku`/`Sonnet`/`Opus`/
`Flash Med`/`Flash High`/`Flash Low`) are the only labels this skill still
reads or writes.

`field.Priority:<value>` and `type:<value>` are confirmed-live `gh search
issues` qualifiers (verified with a discriminating control: a nonsense value
returns `[]`, a real value returns real, non-free-text-matching hits) — but
this skill does NOT use search for per-candidate reads. Instead, every
Flash-lane candidate gets one `gh api repos/{o}/{r}/issues/{n}` call
(Step 5), because that single REST payload already contains Priority
(`issue_field_values`), Type (`type.name`), and the dependency count
(`issue_dependencies_summary`) together — cheaper than several targeted
searches per issue — and REST is index-free/immediate, so there's no ~15–40s
search-index lag to design around. Topic (Milestone) comes for free off the
Step 2 issue-list call. Search remains the right tool for bulk cross-repo
discovery (e.g. `/fix-labels`' milestone-consistency check), just not for
this skill's per-issue reads.

## Scope — all eight active repos, exactly these slugs

WebJamApps/web-jam-tools
WebJamApps/JaMmusic
WebJamApps/CollegeLutheran
WebJamApps/AppersonAuto
WebJamApps/web-jam-back
WebJamApps/WebJamSocketCluster
WebJamApps/TimShermanMusic
WebJamApps/HenricksonForSalem

(WebJamSocketCluster, TimShermanMusic, and HenricksonForSalem are mixed case.)

## Step 1 — read each repo's real label set (don't hardcode spellings)

Model-tier labels are NOT spelled the same in every repo. For each repo run:

  gh label list --repo WebJamApps/<repo> --json name -q '.[].name'

Use the actual returned names for the rest of this run — don't assume any
prior run's spellings still hold. As of the last check: JaMmusic,
CollegeLutheran, AppersonAuto, and HenricksonForSalem split Flash into
`Flash Med` / `Flash High`; TimShermanMusic has a single `Flash` label with
no split. The model-tier label family to recognize in any repo: `Haiku`,
`Sonnet`, `Opus`, `Fable`, and whichever Flash spelling(s) that repo has.

## Step 2 — list open issues and open PRs per repo

For each repo, list open issues:

  gh issue list --repo WebJamApps/<repo> --state open --limit 200 \
    --json number,title,labels,body,url,milestone

And list open PRs (one call per repo returning PR metadata, review history, commits, decision status, and CI check status):

  gh pr list --repo WebJamApps/<repo> --state open \
    --json number,headRefName,body,url,title,reviews,commits,reviewDecision,statusCheckRollup

`milestone` is the topic/area signal (the old `Area` custom field was
deleted; topics now live in per-repo Milestones, name-identical across
repos — `gig-outreach`, `backup-restore`, etc.). It's read here for free,
alongside the same call that already reads labels — no extra request. This
skill doesn't gate Flash-lane candidacy on topic, so it's carried through
purely for context in the output (Step 9), not used as a filter.

Open PRs are scanned to detect in-flight candidate issues that already have
an active PR, determine their CI check status and automated review status (including outstanding Must Fix items),
and categorize them into actionable fix work vs. pending review. This remains exactly
one `gh pr list` call per repo — never make per-PR follow-up API calls.

## Step 3 — classify every open issue

For each issue, FIRST check for the `parked` label (gray, "Parked by Josh -
agents and skills skip this issue entirely") or the `Josh` label ("personal items
get Josh and NO model tier — human task, not for AI Agent"). If either label is
present, skip this issue COMPLETELY: no triage, no label changes, not in
any output section — exactly like an issue carrying a non-Flash model
label. This is how Josh's personal items and needs-review decisions persist
between runs instead of evaporating (`Josh` and `parked` are the fixes).

THEN, for every issue that isn't parked or labeled `Josh`, check its body (case-insensitive)
for an explicit do-not-dispatch marker: ⛔, "BLOCKED — do not build yet",
"Do not start until…", or equivalent wording.

- **Unconditional / external marker** — nothing to check, no issue
  reference (e.g. "⛔ waiting on final logo files from Josh", "do not
  build yet — assets pending from the photographer"). This issue goes
  straight to the Blocked section (Step 7) with that marker's stated
  reason — ALWAYS, even if it already carries a Flash-tier label. Do not
  label it, do not touch its existing labels, do not treat it as a normal
  candidate. Skip the rest of this step for it.
- **Conditional marker citing an issue reference** (e.g. "Do not start
  until wjb#987 is merged/deployed") — do NOT auto-block. Resolve the
  referenced issue right now:
  `gh issue view <n> --repo WebJamApps/<repo> --json state`. If
  it's CLOSED, the condition is satisfied — the marker is cleared, and
  this issue continues through normal classification below as if the
  marker weren't there. If it's still OPEN, this issue IS blocked — route
  it to the Blocked section (Step 7) with the resolved reference and its
  verified state as the reason, same as any other dependency-block.
  (Live failure: #1241/#1242 got marker-blocked on wjb#987 which was
  already CLOSED — the condition had been satisfied and nobody checked.)
- **Decision-log / discussion citation, not a dependency** — a body
  citation like "decisions on web-jam-back#923" or "see the discussion on
  #200" is a pointer to WHERE a decision was recorded, not something this
  issue depends on. Never treat a decision-record or discussion-log
  reference as a blocker, conditional or not. (Live failure: #1195/#1196
  got blocked on wjb#923, which is a decision log, not a dependency.)

Otherwise, for each issue:

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
    - Opus — genuine multi-file judgment/design, or under-specified codework (empty or title-only body) that requires design discussion
    - Fable — architecture/specs/requirements framing
    - Flash (Med/High if the repo splits it) — full-stack coding across all 8
      active repos. Pick Med vs High AT TRIAGE (agy has no dynamic thinking to
      pick for itself): High is the default lane; use Med only for genuinely
      trivial edits (a one-line change, a single-field data or typo fix, a
      link update) — anything with non-trivial state, layout, complex logic,
      or multi-layer API work goes to High.

  Note: under-specified codework (empty or title-only body) must always be
  triaged as `Opus` so it flags for design discussion rather than being
  auto-Flashed.

  BEFORE applying a label, check whether this issue is actually a clean
  triage call. If it is NOT — the issue doesn't clearly read as codework
  (e.g. it's a question, a discussion, an ops/manual task), OR it looks like
  a duplicate of another open issue, OR it looks like it may already be
  done (body/title suggests completed work, or a linked PR looks merged) —
  DO NOT GUESS. Do not apply any label and do not add it to the Flash-lane
  candidate pool. Instead add it to a "Needs review" list, each entry
  carrying a concrete recommendation (e.g. "recommend: close as duplicate
  of CollegeLutheran#45", "recommend: keep open unlabeled — human task, not
  codework"). This list becomes the output file's bottom section (Step 9),
  not a chat report — this is a hard rule, not a suggestion: an uncertain
  guess here is worse than surfacing it for a human to decide.

  Concrete non-codework examples — these are HUMAN tasks, never label them,
  always route to Needs review: "record and publish these songs" is a
  recording/performance task, not code. "Get Spotify to fix their wrong
  artist listing" is contacting an external company's platform, not code.
  Any issue whose actual ask is a phone call, an email, manual data entry,
  or someone else's dashboard/CMS is a human task regardless of which repo
  it's filed in — a full-stack repo still carries plenty of non-codework
  asks; don't default to Flash just because an issue is filed there.

  If you reach the end of this step with an EMPTY Needs review list, treat
  that as suspicious, not a clean bill of health. A backlog of any real
  size almost always has at least one ambiguous, duplicate-looking, or
  already-done-looking issue — re-check the issues you almost flagged
  before reporting zero.

  Otherwise, apply the chosen label:

    gh issue edit <number> --repo WebJamApps/<repo> --add-label "<label>"

  If the label you applied is Flash-tier, this issue is now also a
  Flash-lane candidate — carry it into Step 4, and record which tier.

## Step 4 — pool the Flash-lane candidates & detect in-flight issues

Collect every Flash-lane candidate (pre-existing + newly labeled in Step 3)
from all 8 active repos into one list. Each entry needs: repo, issue number,
title, URL, milestone (if any, from Step 2 — for output context only), and
its Flash tier label (`Flash`, `Flash Med`, or `Flash High` — exactly as
that repo spells it).

For each candidate issue `<repo>#<num>`, check whether an open PR from
Step 2 in the same repo is currently in flight for it:

- PR body matches `(?i)(closes|part of)\s+#<num>([^0-9]|$)`
- OR PR `headRefName` starts with `agy/<num>-*`, `gemini/<num>-*`, or
  `claude/<num>-*` (e.g. `agy/<num>-<slug>`, `gemini/<num>-<slug>`,
  `claude/<num>-<slug>`).

If an open PR matches:
- Mark this candidate issue as **in-flight** (record the matching PR's number,
  URL, and branch `headRefName`).
- Compute the PR's CI check status and review state directly from the Step 2 payload:
  - **CI status**: Check `statusCheckRollup`. Count checks where conclusion or state indicates failure (`FAILURE` or `ERROR`).
  - **Review status**: Reference the "Already-Reviewed Check" in `skills/pr-review/SKILL.md` to
    determine if an automated review exists for the current head commit
    (filter `reviews` for comments matching `(?i)## PR Review Summary` and verify
    if `commit.oid` == `commits | last | .oid`).
    - If a current automated review exists for the head commit SHA:
      - Derive the Must Fix count from the review body: count lines prefixed `🛑`
        under `### 🛑 Must Fix Items`, with `✅ None` counting as zero.
  - Classify the in-flight PR into one of two buckets:
    - **Fix bucket (`## Fix your open PRs first`)** — actionable author fix work required:
      1. `changes requested: <N> must fix` — a current automated review exists with one or more Must Fix items (or `reviewDecision == "CHANGES_REQUESTED"` / contains `**🛑 Changes Requested**`).
      2. `CI failing` — failing or error checks exist in `statusCheckRollup` and no review has been completed yet (or prior to clean review).
    - **Awaiting review (`## In Flight (Pending PR Review)`)** — waiting on review or Josh merge:
      1. Unreviewed with green CI — zero failing checks in `statusCheckRollup` and no current automated review for the head commit SHA.
      2. Clean approved review — current automated review contains `**✅ Approved**` with zero Must Fix items, and CI checks are green (waiting on Josh to merge).
- In-flight issues are excluded from the numbered runnable list (Step 6). Candidates in the fix bucket route to the `## Fix your open PRs first` section (rendered above the numbered list in Step 7), while candidates awaiting review route to the `## In Flight (Pending PR Review)` section (Step 7).

## Step 5 — read Priority, Type, and dependencies (native metadata, not labels)

For each Flash-lane candidate, fetch its full REST payload once — this one
call returns everything else this step needs, no body-text phrase-matching
and no `Blocked` label to read (native dependencies are the single source of truth
for issue-to-issue blocking without expecting `Blocked` labels):

  gh api repos/WebJamApps/<repo>/issues/<n>

From the response:

- **Priority** — the entry in `.issue_field_values[]` whose
  `issue_field_name` is `"Priority"`; its value is
  `.single_select_option.name`. If `issue_field_values` is empty or has no
  `Priority` entry, the priority is **Medium** — blank means Medium, never
  ask Josh to set it, never write it.
- **Type** — `.type.name` (`Bug` / `Feature` / `Task` / `Epic`, or `null` if
  unset). Used only as an ordering tie-break in Step 6 — this skill has
  never gated Flash-lane candidacy on Type and doesn't start now.
- **Dependency count** — `.issue_dependencies_summary.total_blocked_by`. If
  it's `0`, this candidate has no blockers — skip straight to Step 6.

If `total_blocked_by` > 0, fetch the actual blockers with one more call:

  gh api repos/WebJamApps/<repo>/issues/<n>/dependencies/blocked_by

This returns a full issue object for every direct blocker — `state`,
`number`, `repository.full_name`, `title`, `labels[]`, all inline, no
further lookups needed. For each blocker:

- `state == "closed"` — not a blocker, full stop. A closed dependency is
  NEVER a blocker no matter how the candidate's body phrased the
  relationship. Ignore it.
- `state == "open"` and it's itself a Flash-lane candidate in this run's
  pool (same repo + number as a Step 4 entry) — a same-pool dependency,
  handle it via ordering only (Step 6); it does not route this candidate to
  Blocked.
- `state == "open"` and it is NOT a Flash-lane candidate in the pool (a
  different model label read straight off its own `labels[]`, or it lives
  outside this pool) — this candidate cannot run yet. Route it to the
  Blocked section (Step 7), naming the blocker (`Repo#n`) and the reason
  taken from its own `labels[]` (e.g. "Sonnet, backend endpoint not
  built") — no extra `gh issue view` call, the label is already in this
  response.

Because `blocked_by` reports each direct blocker's own live `state`, there
is no chain to walk and nothing to cascade: if a blocker is itself blocked,
that surfaces naturally when *it* gets processed as its own candidate (or,
if it isn't in the pool, its own state is all this candidate needs). Never
mark an issue blocked "because its dependency is blocked" as a shortcut
through unfetched data — the direct blocker's own `state` on this call is
the only thing that decides. (This closes off the failure class from the
label-era version of this skill, where web-jam-back#983/#987/#980 were
marked as blockers while CLOSED and the error cascaded — native
dependencies always report the blocker's live state directly, so there's
nothing left to go stale.)

Body text is still read for the ⛔ / do-not-dispatch marker check (Step 3)
and for Needs-review judgment calls — this step only changes how
*dependency* and *priority* signals are sourced.

## Step 6 — order the runnable list

Among Flash-lane candidates that are **not in flight** (no open PR from Step 4)
and have no blocking dependency (or whose only dependencies are themselves in
this pool):

1. Native **Priority** first (read in Step 5): `Urgent` > `High` > `Medium`
   (blank) > `Low`. Every repo has this — it's an org-level field, not a
   per-repo label.
2. Within the same Priority tier, native **Type** (Step 5) breaks the tie:
   `Bug` outranks everything else. If neither candidate has a Type set,
   fall back to judgment from the issue content — a clearer/better-specified
   issue is easier for agy to execute unattended than a vague one; prefer
   ordering agy toward issues it can actually finish.
3. Dependency ordering wins over Priority/Type ordering. If issue B depends
   on issue A and both are in the runnable list, A must appear before B
   regardless of B's Priority or Type. Never list a dependency after its
   dependent.

Number the result 1, 2, 3, … — plain sequential numbering, not per-repo
grouping.

## Step 7 — build the Fix your open PRs first, In Flight, and Blocked sections

### Fix your open PRs first section (`## Fix your open PRs first`)

Flash-lane candidates detected in Step 4 as having an open PR in the fix bucket land here. This section is rendered **above** the numbered runnable list in the final output file so that required author fixes are prioritized before starting net-new tasks.

Entries in this section are classified by reason:
- **Changes requested**: A current automated review exists with one or more Must Fix items (or `**🛑 Changes Requested**` / `CHANGES_REQUESTED` status).
  Format: `- [Repo#<num>](<issueUrl>) — <title> (<Tier>[, milestone: <name>]) — PR: [Repo#<prNum>](<prUrl>) (<headRefName>) — changes requested: <N> must fix — [review](<reviewUrl>)`
  (If the specific review URL is not isolated, link `[review](<prUrl>)`).
- **CI failing**: The PR has failing or error checks in `statusCheckRollup` with no automated review completed yet.
  Format: `- [Repo#<num>](<issueUrl>) — <title> (<Tier>[, milestone: <name>]) — PR: [Repo#<prNum>](<prUrl>) (<headRefName>) — CI failing — [review](<prUrl>)`

### In Flight section (`## In Flight (Pending PR Review)`)

Flash-lane candidates detected in Step 4 as having an open PR that is merely awaiting review land here (rendered below the numbered runnable list).

Two states land here:
- **Unreviewed (green CI)**: Open PR with passing CI checks and no current automated review for its latest commit.
  Format: `- [Repo#<num>](<issueUrl>) — <title> (<Tier>[, milestone: <name>]) — PR: [Repo#<prNum>](<prUrl>) (<headRefName>)`
- **Reviewed & approved**: Open PR with a clean approved review and zero Must Fix items (waiting on Josh to merge).
  Format: `- [Repo#<num>](<issueUrl>) — <title> (<Tier>[, milestone: <name>]) — PR: [Repo#<prNum>](<prUrl>) (<headRefName>) — reviewed — approved`

These issues are actively in review or waiting to merge; excluding them from the runnable list prevents duplicate dispatch or wasted tokens.

### Blocked section (`## Blocked (not runnable by Flash)`)

Two kinds of entry land here:
- Dependency-blocked candidates from Step 5 — one-line reason naming the
  VERIFIED-open blocking issue and why Flash can't clear it (e.g. "depends
  on web-jam-back#812 (Sonnet, backend endpoint not built)"). Never an
  unverified reason — if the blocker's `state` didn't come back `"open"` on
  the Step 5 `dependencies/blocked_by` call, it doesn't go here.
- Marker-blocked issues from Step 3 (an explicit ⛔/do-not-dispatch marker
  in the body) — one-line reason quoting or paraphrasing that marker (e.g.
  "issue body: BLOCKED — do not build yet, waiting on final logo files
  from Josh"). These can land here even though they already carry a
  Flash-tier label — the marker overrides normal Flash-lane routing.

No further ordering is required within these sections — plain lists are fine.

## Step 8 — reconcile: verify nothing was silently dropped

Before writing anything, every open issue seen in Step 2 must land in
EXACTLY ONE bucket:

- the Fix your open PRs first section (Step 7)
- the numbered runnable list (Step 6)
- the In Flight (awaiting review) section (Step 7)
- the Blocked section (Step 7)
- the Needs review section (Step 3)
- skipped — carries a non-Flash model label (Step 3)
- skipped — carries the `parked` or `Josh` label (Step 3)

Count each bucket, per repo and overall, and sum them. The sum MUST equal
the total open-issue count from Step 2. If it doesn't, an issue fell
through the cracks — find it and file it in its correct bucket before
writing anything. Do NOT write the output file (Step 9) until the counts
reconcile. (Live failure: JaMmusic#555 was silently dropped from every
section on a prior run — it wasn't in the runnable list, Blocked, Needs
review, or accounted for as skipped.) Carry this accounting into the
Report Back section below.

## Step 9 — regenerate the output file (replace, never append)

Path: ~/Dropbox/web-jam-llms/flash-issues.md — fully overwrite it every
run. It's a regenerated snapshot, not a log: never append, never merge with
the previous version's ordering.

Every entry — in the Fix your open PRs first section, the numbered runnable list, the In Flight section, and the
Blocked section — MUST end with its Flash tier in parentheses, exactly as that
repo spells it (`Flash`, `Flash Med`, or `Flash High`). Josh uses this to know
whether to run agy with the plain default chain or override it with
AGY_MODELS='Gemini 3.7 Flash (High)'. If the issue carries a Milestone
(Step 2), add `, milestone: <name>` inside the same parentheses — omit the
clause entirely when there's no Milestone, don't write "milestone: none".

Output template:

# Flash-lane issues

_Regenerated by /flash-issues — do not hand-edit, next run replaces this file._

Last updated: <ISO 8601 UTC timestamp of this run>

## Fix your open PRs first

- [JaMmusic#1215](https://github.com/WebJamApps/JaMmusic/issues/1215) — Gig list sorting (Flash Med, milestone: gig-outreach) — PR: [JaMmusic#1218](https://github.com/WebJamApps/JaMmusic/pull/1218) (`agy/1215-gig-list-sorting`) — changes requested: 2 must fix — [review](https://github.com/WebJamApps/JaMmusic/pull/1218)
- [AppersonAuto#90](https://github.com/WebJamApps/AppersonAuto/issues/90) — Fix date picker (Flash Med) — PR: [AppersonAuto#92](https://github.com/WebJamApps/AppersonAuto/pull/92) (`agy/90-fix-date-picker`) — CI failing — [review](https://github.com/WebJamApps/AppersonAuto/pull/92)

1. [CollegeLutheran#123](https://github.com/WebJamApps/CollegeLutheran/issues/123) — Add mobile nav collapse toggle (Flash Med)
2. [JaMmusic#1220](https://github.com/WebJamApps/JaMmusic/issues/1220) — Venue picker: filter list by metro (Flash Med, milestone: gig-outreach)
3. [JaMmusic#1221](https://github.com/WebJamApps/JaMmusic/issues/1221) — Venue picker: wire selection to gig form (Flash High, milestone: gig-outreach, depends on JaMmusic#1220 above)

## In Flight (Pending PR Review)

- [WebJamSocketCluster#45](https://github.com/WebJamApps/WebJamSocketCluster/issues/45) — Reconnect backoff timer (Flash Med) — PR: [WebJamSocketCluster#48](https://github.com/WebJamApps/WebJamSocketCluster/pull/48) (`agy/45-reconnect-backoff`)
- [TimShermanMusic#66](https://github.com/WebJamApps/TimShermanMusic/issues/66) — Slideshow transition (Flash Med) — PR: [TimShermanMusic#67](https://github.com/WebJamApps/TimShermanMusic/pull/67) (`agy/66-slideshow-transition`) — reviewed — approved

## Blocked (not runnable by Flash)

- [AppersonAuto#88](https://github.com/WebJamApps/AppersonAuto/issues/88) — Inventory filter UI (Flash Med) — blocked: depends on AppersonAuto#85 (Sonnet, backend endpoint not built)

## Needs Josh's review (no agent will touch these until you decide)

- [TimShermanMusic#57](https://github.com/WebJamApps/TimShermanMusic/issues/57) — Update booking email — recommend: close as duplicate of TimShermanMusic#52
- [HenricksonForSalem#31](https://github.com/WebJamApps/HenricksonForSalem/issues/31) — Confirm venue contact list with Mark — recommend: keep open unlabeled — human task, not codework

Every list line is: full https://github.com/WebJamApps/<repo>/issues/<n>
link, repo-prefixed reference (Repo#n) as the link text, em dash, title,
then the Flash tier in parentheses (plus the PR info clause for In Flight
entries, or the blocked-reason clause for Blocked entries). Keep titles as
GitHub has them — don't paraphrase.

The "Needs Josh's review" section is different: no Flash tier (these got
no model label at all), and the trailing clause is always a concrete
recommendation instead of a tier/blocked-reason. These issues are excluded
from the numbered list, In Flight section, and Blocked section — they're not
Flash-lane candidates, they're undecided. Rebuild this section fresh every run
same as the rest of the file: an item Josh has since resolved (labeled, closed,
whatever) just won't re-trigger the flag next time and drops out on its own.

## Report back (this is what you hand back to the invoking session)

- Repos scanned, total open issues and open PRs seen, how many were already Flash-tier
  vs. newly triaged.
- Every issue you newly labeled and what you labeled it.
- Count in the Fix your open PRs first section (broken down by changes requested vs. CI failing) vs. the numbered list vs. the In Flight (awaiting review) section (unreviewed vs. approved) vs. the Blocked section vs.
  the "Needs Josh's review" section vs. skipped-parked/Josh vs. skipped-other-model-label —
  just the counts for the review section and skipped buckets, not the lists
  (they're already in the file, or need no listing).
- The Step 8 reconciliation: total open issues seen vs. the sum of all seven
  buckets. Confirm they match, or state what you found missing and where
  you filed it before writing.
- Confirmation that Priority, Type, and dependencies were read from each
  candidate's REST issue payload (Step 5) — not from any label — and that
  topic came from Milestone (Step 2), not from a label.
- Confirmation that open PRs were scanned per repo (Step 2) with CI status and review status (including Must Fix counts) detected, and in-flight issues with open PRs were routed to their appropriate sections (Fix your open PRs first vs. In Flight awaiting review).
- Confirmation the file was written to
  ~/Dropbox/web-jam-llms/flash-issues.md.
````

## Non-goals

- The invoking session never runs Steps 1–9 itself — that's the whole point
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
  duplicate, or looks already-done — no label, no candidate-pool entry,
  goes to the file's "Needs Josh's review" section with a recommendation
  instead of a best-effort label.
- Never blocks the chat run on flagged items — no Q&A, no waiting for an
  answer. They're reviewed from the file on Josh's own schedule.
- Never suggests an in-flight issue with an open PR in the numbered runnable list — in-flight
  issues route to the dedicated `## Fix your open PRs first` or `## In Flight (Pending PR Review)` sections.
- Never marks an issue blocked on an unverified reference — for a Step 3
  conditional marker, `gh issue view --json state` the specific reference
  first; for Step 5 dependencies, the native `blocked_by` payload's own
  `state` field is the check. A closed reference is never a blocker no
  matter how the issue text or dependency graph phrases it.
- Never reads or writes a priority label, topic label, `bug`/`enhancement`
  label, or a `Blocked` label. Priority and Type come from each candidate's
  REST issue payload (Step 5), topic from Milestone (Step 2), and blocking
  from native dependencies (Step 5) — native dependencies are the single source of
  truth for issue-to-issue blocking without expecting `Blocked` labels. Model-lane labels
  (`Haiku`/`Sonnet`/`Opus`/`Flash Med`/`Flash High`/`Flash Low`) are the
  only labels this skill still touches.
- Never treats "record and publish", "get <company> to fix their listing",
  or any other manual/external-platform ask as codework just because it's
  filed in a frontend repo.
- Never touches a `parked` issue — no triage, no label, no output section.
  It's Josh's way of parking a decision on GitHub instead of chat, and it
  must persist run to run, not evaporate the moment it goes unlabeled.
- Never writes the output file before the Step 8 reconciliation count
  matches — a dropped issue is a bug, not an acceptable gap.
- Doesn't repeat the Haiku/Sonnet/Opus/Fable/Flash routing table — that
  lives in `docs/ai-team-playbook.md`; this skill only applies it.
