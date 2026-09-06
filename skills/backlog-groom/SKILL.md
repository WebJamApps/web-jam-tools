---
name: backlog-groom
description: Audit all 8 active WebJamApps repos for model-label drift, native dependency & Blocked label drift, executable issue spec quality, untyped issues & native Epic type desync, milestone coverage drift, and stale/duplicate/completed issues. Writes report to ~/Dropbox/web-jam-llms/backlog-groom-report.md, presents findings as a table, and WAITS for Josh's explicit per-item approval before making any GitHub edits.
---

# backlog-groom — cross-repo backlog health audit

Audits all 8 active WebJamApps repositories for backlog drift, label hygiene, dependency alignment, issue spec executability, untyped issues, milestone coverage drift, and stale/completed issues.

**Strict Interactive Gate:** This skill NEVER makes unilateral edits on GitHub. It writes its findings to `~/Dropbox/web-jam-llms/backlog-groom-report.md`, presents a numbered table of findings to Josh in chat, and **WAITS for explicit per-item approval** before executing any label edits, issue edits, or closures on GitHub.

## Execution Model

- **Delegated Scan & Analysis:** Step 1 (Scan & Collect) and Step 2 (Analyze & Categorize) MUST be delegated to a single subagent running on **Flash Med** or **Haiku** to conserve token quota.
- **Report & Summary Output:** The delegated subagent performs all cross-repo `gh` lookup calls, writes the detailed report to `~/Dropbox/web-jam-llms/backlog-groom-report.md`, and returns ONLY the final findings table, per-repo untyped summary ratios, and per-repo missing milestone summary ratios back to the primary session.
- **Primary Session Presentation:** The primary session renders the findings table to Josh and handles interactive approval and execution.

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
- **Missing Model Label:** Issue has no model-tier label (`Haiku`, `Sonnet`, `Opus`, `Fable`, `Flash`, `Flash Med`, `Flash High`, `Flash Low`) assigned.
- **Multiple Model Labels:** Issue carries more than one model-tier label simultaneously (e.g. both `Sonnet` and `Flash Med`).
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

---

## Workflow & Execution Steps

### Step 1: Scan & Collect (Delegated to Subagent)
1. Fetch all open issues for each of the 8 repos using `gh issue list` and `gh api`.
2. Retrieve native `Priority`, `Type`, `issue_field_values`, and native dependencies (`blocked_by` API) for candidate issues.
3. Exclude issues marked with the gray `parked` label (these are intentionally parked by Josh and skipped).

### Step 2: Analyze & Categorize (Delegated to Subagent)
1. Evaluate each issue against the 6 audit categories above.
2. Formulate concrete, actionable proposed fixes for each finding (e.g. "Add label `Flash High`", "Remove redundant `Blocked` label (native dependencies govern blocking)", "Remove `Blocked` label & reconcile body (replace gating prose with satisfied prerequisite note and preserve unproven preconditions)", "Remove self-blocking dependency via deno task unblock-issue --repo <repo> --issue <n> --blocker <m>", "Set native Type to `Task`", "Set Milestone to `v1.2`", "Apply `Needs Design` label", "Close as duplicate of #45").
3. Calculate per-repo untyped issue ratios (e.g. "web-jam-tools: 38 of 44 open issues untyped") and missing milestone ratios (e.g. "web-jam-tools: 12 of 44 open issues have no milestone").

### Step 3: Write Report File (Delegated to Subagent)
Write the full audit report to `~/Dropbox/web-jam-llms/backlog-groom-report.md` (replacing any existing file). Include an ISO timestamp, summary counts, untyped ratios, and missing milestone ratios per repo, and detailed findings.

### Step 4: Present Findings Table in Chat (Primary Session)
Render a clear, numbered Markdown table in chat along with per-repo untyped ratios and missing milestone ratios:

| # | Repo | Issue | Category | Finding / Drift | Proposed Action |
|---|------|-------|----------|-----------------|-----------------|
| 1 | JaMmusic | #102 | Model Label Drift | Missing model label | Apply `Flash High` label |
| 2 | JaMmusic | #1243 | Dependency Drift | Labeled `Blocked` & body says "do not start", but blocker web-jam-back#990 "Add PATCH /venue/:id (the honest verb for our partial-merge update)" is CLOSED | Remove `Blocked` label & reconcile body (note web-jam-back#990 closed; preserve deploy step) |
| 3 | CollegeLutheran | #88 | Spec Quality | Body relies on "see comment for details" | Recommend spec inline edit or `Needs Design` |
| 4 | web-jam-tools | #380 | Untyped Issue | Native Type is unset | Set native Type to `Task` |
| 5 | HenricksonForSalem | #12 | Milestone Drift | Milestone is unset | Set Milestone to "Launch Prep" |
| 6 | web-jam-tools | #753 | Self-Blocking Dependency | Issue is blocked by its parent #737 | Remove self-blocking dependency via `deno task unblock-issue --repo WebJamApps/web-jam-tools --issue 753 --blocker 737` |

If no drift is found across all repos, report that the backlog is 100% clean.

### Step 5: Await Explicit Approval & Execute
- **STOP and wait for Josh's response.**
- Accept selective approvals (e.g., "approve 1, 2", "all except 3", "yes to all").
- Execute ONLY approved actions on GitHub via `gh issue edit --milestone "<name>"`, `gh issue edit`, `gh label`, etc.
- Never touch unapproved items.
