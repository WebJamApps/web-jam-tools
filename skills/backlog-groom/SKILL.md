---
name: backlog-groom
description: Audit all 8 active WebJamApps repos for model-label drift, native dependency & Blocked label drift, executable issue spec quality, untyped issues, milestone coverage drift, and stale issues. Use when auditing repository backlogs for drift, stale issues, or spec quality across WebJamApps.
---

# backlog-groom — cross-repo backlog health audit

Audits all 8 active WebJamApps repositories for backlog drift, label hygiene, dependency alignment, issue spec executability, untyped issues, milestone coverage drift, and stale/completed issues.

Josh types `/backlog-groom` (or on Codex `$backlog-groom`).
Josh can name a focus milestone for that run: `/backlog-groom focus <milestone>` (and on Codex `$backlog-groom focus <milestone>`, e.g. `/backlog-groom focus gig-outreach` and `$backlog-groom focus gig-outreach`). The focus milestone is passed to the ranking for that run only.

**Strict Interactive Gate:** This skill NEVER makes unilateral edits on GitHub. It writes its findings to `~/Dropbox/web-jam-llms/backlog-groom-report.md`, presents a numbered table of findings to Josh in chat, and **WAITS for explicit per-item approval** before executing any label edits, issue edits, or closures on GitHub.

## Which Model Does the Run

Which model does the run depends on the model the session is on:

| Tool | The session is on | Who does the run |
|---|---|---|
| Claude Code | Opus | a Sonnet helper the session starts |
| Claude Code | Sonnet or Haiku | the session itself |
| agy | Flash | the session itself |
| Codex | Astra | a Sol helper the session starts |
| Codex | Sol or Luna | the session itself |

The run is the reading, the checking, the report, and the edits. A session that hands the run to a helper does three things itself and nothing more: it starts the helper; it shows Josh the table the helper returns; and it passes his approvals back to the helper, which makes the edits. The helper runs at high effort, as every model does.

The session learns which model it is on from `deno task running-model`, never from its own account of itself. When that command cannot tell, the session hands the run to the helper its tool would use for the expensive model: Sonnet on Claude Code, Sol on Codex. On agy there is one model, so the session does the run.

On Claude Code, dispatch that helper with `Agent(model: "sonnet")`. On Codex, start a helper with Sol named in the request.

## Repositories in Scope (8)

1. `WebJamApps/web-jam-tools`
2. `WebJamApps/JaMmusic`
3. `WebJamApps/CollegeLutheran`
4. `WebJamApps/AppersonAuto`
5. `WebJamApps/web-jam-back`
6. `WebJamApps/WebJamSocketCluster`
7. `WebJamApps/TimShermanMusic`
8. `WebJamApps/HenricksonForSalem`

## Audit Categories

The audit inspects every open issue across all 8 repositories against six core categories:

### 1. Model-Label Drift
- **Missing Model Label:** Issue has no model-tier label from `skills/fix-labels/model-labels.json`, unless it is a `Josh` manual step.
- **Multiple Model Labels:** Report two or more model labels as drift only when they are not the allowed pair in `~/Dropbox/web-jam-llms/Token_Savings/model-tier-order-design-2026-10-02.md`, "How the order is used". The allowed pair is valid and must not be reduced to one label.
- **Retired / Deprecated Labels:** Issue carries retired or non-canonical model labels (e.g. old `Flash-lane`, `GPT-4`, `Claude-2` or mismatched tier spellings).

### 2. Native Dependencies & Blocked Label Drift
- **Stale Blocks:** Issue is labeled `Blocked` (or has body text indicating blocked status), but all referenced blocking issues in native GitHub dependencies (`blocked_by` API) or external prerequisites are already `CLOSED` / satisfied.
  - **Body Reconciliation Required:** A `Blocked` label removal is never proposed on its own when the issue body carries gating prose. The finding must propose removing the `Blocked` label AND reconciling the body together as one approvable item.
  - **Gating Prose Markers:** Targets gating prose such as a `## Blocked` or `## Depends on` section, a lock emoji marker (e.g. ⛔ or 🔒), `"do not start"`, `"must be merged first"`, `"BLOCKED on"`, or equivalents.
  - **Satisfied Prerequisite Replacement Format:** The dependency survives as a satisfied-prerequisite note that names the blocker as `repo#number "title"` and records its closure (e.g. `*Prerequisite web-jam-back#990 "Add PATCH /venue/:id (the honest verb for our partial-merge update)" is closed.*`); only the stop order is removed. The dependency fact is preserved, never deleted.
  - **Preserving Unproven Preconditions:** Any precondition the body carries that the blocker's closed state does not prove (such as requiring an endpoint or backend change to be deployed to production rather than merely merged) must be kept as an explicit first step for whoever starts the issue, rather than dropped with the section.
- **Redundant Blocked Label:** Issue has native `blocked_by` dependencies registered AND carries the `Blocked` label. Because native GitHub dependencies (`blocked_by`) are the single source of truth for issue-to-issue blocking, applying the `Blocked` label to an issue with native dependencies is redundant and creates maintenance overhead. Propose removing the redundant `Blocked` label while keeping the native dependency intact.
- **Uncited Dependencies:** Issue body mentions dependency conditions (e.g. "depends on #123") that are not registered in native GitHub issue dependencies (`blocked_by` API). Propose linking the dependency natively without adding the `Blocked` label.
- **Self-Blocking Dependency:** An OPEN issue whose native `blocked_by` dependencies include its own parent or another ancestor (e.g. a child blocked by its parent Epic). Because an Epic closes only when its children close, an issue blocked by its own ancestor can never start and the ancestor can never close. Propose removing the self-blocking link using `deno task unblock-issue --repo <owner/repo> --issue <n> --blocker <m>` (applied only on Josh's per-item approval).

### 3. Executable Issue Spec Checks (Non-Epic Issues) & Needs Design Awareness
- For non-`Epic` issues, verify whether the issue body provides a self-contained, executable specification for automated agent implementation.
- Flag unresolvable or lazy pointer phrases that require human context or reading comment threads:
  - `"see comment"` / `"read comment first"`
  - `"as discussed in"` / `"per the discussion"`
  - `"in the epic"` / `"see epic for details"`
  - `"as noted below"` (without explicit inline specs)
- **`Needs Design` Awareness:** For Epics or sub-issues that are not fully designed yet or require design clarification, recommend applying the canonical `Needs Design` status label or triaging/re-labeling to `Opus` for human design clarification rather than forcing immediate execution.

### 4. Native Issue Types, Epic & Untyped Issue Detection
- **Untyped Issue Detection:** Flag every OPEN issue with an unset native `Type` field (i.e. native `Type` is missing/null/empty). Report the per-repo untyped ratio (e.g. "web-jam-tools: 38 of 44 open issues untyped") and provide suggested native types (`Task`, `Bug`, `Feature`, `Epic`) for each untyped issue based on context.
- **Native Epic Type Checks:** Verify that parent tracking issues or feature umbrellas have their native GitHub `Type` field set to `Epic`.
- **Sub-Issue Desync:** Verify native parent/child sub-issue relationships. Flag child issues whose parent Epic is `CLOSED` but child remains `OPEN` without context, or child issues listed in Epic descriptions that are not linked natively.

### 5. Stale / Duplicate / Completed Issues
- **Completed Issues:** Open issue whose linked pull request is already merged or whose stated acceptance criteria are fully satisfied in code.
- **Duplicate Issues:** Open issues with duplicate titles, overlapping scopes, or identical requirements across the same repo.
- **Stale Issues:** Open issues untouched for extended periods with no activity, pending external feedback, or superseded by newer architectural changes.

### 6. Milestone Coverage Drift
- **Missing Milestone Detection:** Flag every OPEN, non-`parked` issue whose native GitHub `milestone` field is null.
- **Suggested Milestone Heuristics (in priority order):**
  1. If the issue is a native sub-issue of an Epic that already has a Milestone assigned, suggest that parent Epic's Milestone.
  2. Otherwise, match the issue's title and body theme against the titles and descriptions of the repo's open Milestones.
  3. If no Epic parent exists and no clear theme match exists, suggest `"no fitting milestone — leave unassigned"` rather than guessing.

### 7. Priority

The level each issue carries, checked against the spread with a focus milestone named for the run:
- **Seventh Check (Priority):** Evaluates open issues against target level shares and calls the ranking entry point `deno task backlog-groom:rank` (via `deno task backlog-groom:rank --repo <repo> --judgments <file.json> [--focus <milestone>]`), reading judgments stored in `/tmp/backlog-groom`.
- **Focus Argument:** Takes `focus <milestone>` in the call (`/backlog-groom focus gig-outreach`, and `$backlog-groom focus gig-outreach` on Codex) and passes it to the ranking for that run only.
- **One Batch per Repository:** Proposed Priority moves are shown as one batch for each repository.
- **Where Rules Live (No Restatement):** The skill does not restate the level tests, the shares or the ranking:
  - what each Priority level means is in "Priority Levels" in `~/Dropbox/web-jam-llms/Token_Savings/design-issue-file-issue-design-2026-08-23.md` (the design-issue and file-issue design);
  - the shares, the ranking, and the focus are in "The Priority check" in `~/Dropbox/web-jam-llms/Token_Savings/backlog-groom-design.md` (the backlog-groom design).
- **Model Judgment on Two Facts:** The model doing the run judges the two facts no GitHub field records:
  1. something live is broken, exposed or losing data;
  2. it is a defect that costs something every time it is hit.
  The model hands the ranking a yes or a no for each (as `liveBroken` and `costlyDefect` in the judgments JSON), and gives its reason in one line beside every move it proposes.
- **Setting Approved Levels:** Sets approved levels with `deno task edit-issue --priority <Level>` and reads back the set value.

---

## Workflow & Execution Steps

The session or helper selected by the table in "Which Model Does the Run" performs Steps 1–3 and the approved actions in Step 5. The primary session presents the findings and receives Josh's approvals; when a helper is selected, it passes those approvals back to that helper.

### Step 1: Scan & Collect
1. Fetch all open issues for each of the 8 repos using `gh issue list` and `gh api`.
2. Retrieve native `Priority`, `Type`, `issue_field_values`, and native dependencies (`blocked_by` API) for candidate issues.
3. Exclude issues marked with the gray `parked` label (these are intentionally parked by Josh and skipped).

### Step 2: Analyze & Categorize
1. Evaluate each issue against the 6 audit categories above.
2. Formulate concrete, actionable proposed fixes for each finding (e.g. "Add label `Flash`", "Remove redundant `Blocked` label (native dependencies govern blocking)", "Remove `Blocked` label & reconcile body (replace gating prose with satisfied prerequisite note and preserve unproven preconditions)", "Remove self-blocking dependency via deno task unblock-issue --repo <repo> --issue <n> --blocker <m>", "Set native Type to `Task`", "Set Milestone to `v1.2`", "Apply `Needs Design` label", "Close as duplicate of #45").
3. Calculate per-repo untyped issue ratios (e.g. "web-jam-tools: 38 of 44 open issues untyped") and missing milestone ratios (e.g. "web-jam-tools: 12 of 44 open issues have no milestone").
4. For Priority, the model doing the run judges the two facts no GitHub field records (something live is broken; a defect that costs something every time it is hit), hands the ranking a yes or a no for each, and gives its reason in one line beside every move it proposes, calling `deno task backlog-groom:rank --repo <repo> --judgments <file.json> [--focus <milestone>]`.

### Step 3: Write Report File
Write the full audit report to `~/Dropbox/web-jam-llms/backlog-groom-report.md` (replacing any existing file). Include an ISO timestamp, summary counts, untyped ratios, and missing milestone ratios per repo, and detailed findings.

### Step 4: Present Findings Table in Chat (Primary Session)
Render a clear, numbered Markdown table in chat along with per-repo untyped ratios and missing milestone ratios:

| # | Repo | Issue | Category | Finding / Drift | Proposed Action |
|---|------|-------|----------|-----------------|-----------------|
| 1 | JaMmusic | #102 | Model Label Drift | Missing model label | Apply `Flash` label |
| 2 | JaMmusic | #1243 | Dependency Drift | Labeled `Blocked` & body says "do not start", but blocker web-jam-back#990 "Add PATCH /venue/:id (the honest verb for our partial-merge update)" is CLOSED | Remove `Blocked` label & reconcile body (note web-jam-back#990 closed; preserve deploy step) |
| 3 | CollegeLutheran | #88 | Spec Quality | Body relies on "see comment for details" | Recommend spec inline edit or `Needs Design` |
| 4 | web-jam-tools | #380 | Untyped Issue | Native Type is unset | Set native Type to `Task` |
| 5 | HenricksonForSalem | #12 | Milestone Drift | Milestone is unset | Set Milestone to "Launch Prep" |
| 6 | web-jam-tools | #753 | Self-Blocking Dependency | Issue is blocked by its parent #737 | Remove self-blocking dependency via `deno task unblock-issue --repo WebJamApps/web-jam-tools --issue 753 --blocker 737` |

If no drift is found across all repos, report that the backlog is 100% clean.
Proposed Priority moves are shown as one batch for each repository.

### Step 5: Await Explicit Approval & Execute
- **STOP and wait for Josh's response.**
- Accept selective approvals (e.g., "approve 1, 2", "all except 3", "yes to all").
- Execute ONLY approved actions on GitHub through the guarded commands: `deno task edit-issue` for a label, a milestone, or a body (and its `--priority <Level>` flag for a Priority level), and `deno task unblock-issue` for a dependency that blocks an issue on its own parent.
- Never touch unapproved items.

## Description Detail & Triggers

Audit all 8 active WebJamApps repos for model-label drift, native dependency & Blocked label drift, executable issue spec quality, untyped issues & native Epic type desync, milestone coverage drift, and stale/duplicate/completed issues. Writes report to ~/Dropbox/web-jam-llms/backlog-groom-report.md, presents findings as a table, and WAITS for Josh's explicit per-item approval before making any GitHub edits.
