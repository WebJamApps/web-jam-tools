---
name: backlog-groom
description: Audit all 8 active WebJamApps repos for model-label drift, native dependency & Blocked label drift, executable issue spec quality, native Epic type & sub-issue desync, and stale/duplicate/completed issues. Writes report to ~/Dropbox/web-jam-llms/backlog-groom-report.md, presents findings as a table, and WAITS for Josh's explicit per-item approval before making any GitHub edits.
---

# backlog-groom — cross-repo backlog health audit

Audits all 8 active WebJamApps repositories for backlog drift, label hygiene, dependency alignment, issue spec executability, and stale/completed issues.

**Strict Interactive Gate:** This skill NEVER makes unilateral edits on GitHub. It writes its findings to `~/Dropbox/web-jam-llms/backlog-groom-report.md`, presents a numbered table of findings to Josh in chat, and **WAITS for explicit per-item approval** before executing any label edits, issue edits, or closures on GitHub.

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

The audit inspects every open issue across all 8 repositories against five core categories:

### 1. Model-Label Drift
- **Missing Model Label:** Issue has no model-tier label (`Haiku`, `Sonnet`, `Opus`, `Fable`, `Flash`, `Flash Med`, `Flash High`, `Flash Low`) assigned.
- **Multiple Model Labels:** Issue carries more than one model-tier label simultaneously (e.g. both `Sonnet` and `Flash Med`).
- **Retired / Deprecated Labels:** Issue carries retired or non-canonical model labels (e.g. old `Flash-lane`, `GPT-4`, `Claude-2` or mismatched tier spellings).

### 2. Native Dependencies & Blocked Label Drift
- **Stale Blocks:** Issue is labeled `Blocked` (or has body text indicating blocked status), but all referenced blocking issues in native GitHub dependencies (`blocked_by` API) or body text are already `CLOSED`.
- **Missing Blocked Label:** Issue has active, OPEN native blockers (`blocked_by` API) or un-met conditional markers, but lacks the `Blocked` label.
- **Uncited Dependencies:** Issue body mentions dependency conditions (e.g. "depends on #123") that are not registered in native GitHub issue dependencies (`blocked_by` API).

### 3. Executable Issue Spec Checks (Non-Epic Issues)
- For non-`Epic` issues, verify whether the issue body provides a self-contained, executable specification for automated agent implementation.
- Flag unresolvable or lazy pointer phrases that require human context or reading comment threads:
  - `"see comment"` / `"read comment first"`
  - `"as discussed in"` / `"per the discussion"`
  - `"in the epic"` / `"see epic for details"`
  - `"as noted below"` (without explicit inline specs)
- Recommend either updating the issue body with inline requirements or triaging/re-labeling to `Opus` / `Fable` for human design clarification.

### 4. Native Epic Type & Sub-Issue Desync
- **Native Epic Type Checks:** Verify that parent tracking issues or feature umbrellas have their native GitHub `Type` field set to `Epic`.
- **Sub-Issue Desync:** Verify native parent/child sub-issue relationships. Flag child issues whose parent Epic is `CLOSED` but child remains `OPEN` without context, or child issues listed in Epic descriptions that are not linked natively.

### 5. Stale / Duplicate / Completed Issues
- **Completed Issues:** Open issue whose linked pull request is already merged or whose stated acceptance criteria are fully satisfied in code.
- **Duplicate Issues:** Open issues with duplicate titles, overlapping scopes, or identical requirements across the same repo.
- **Stale Issues:** Open issues untouched for extended periods with no activity, pending external feedback, or superseded by newer architectural changes.

---

## Workflow & Execution Steps

### Step 1: Scan & Collect
1. Fetch all open issues for each of the 8 repos using `gh issue list` and `gh api`.
2. Retrieve native `Priority`, `Type`, `issue_field_values`, and native dependencies (`blocked_by` API) for candidate issues.
3. Exclude issues marked with the gray `parked` label (these are intentionally parked by Josh and skipped).

### Step 2: Analyze & Categorize
1. Evaluate each issue against the 5 audit categories above.
2. Formulate concrete, actionable proposed fixes for each finding (e.g. "Add label `Flash Med`", "Remove label `Blocked`", "Close as duplicate of #45", "Set native Type to Epic").

### Step 3: Write Report File
Write the full audit report to `~/Dropbox/web-jam-llms/backlog-groom-report.md` (replacing any existing file). Include an ISO timestamp, summary counts per repo, and detailed findings.

### Step 4: Present Findings Table in Chat
Render a clear, numbered Markdown table in chat:

| # | Repo | Issue | Category | Finding / Drift | Proposed Action |
|---|------|-------|----------|-----------------|-----------------|
| 1 | JaMmusic | #102 | Model Label Drift | Missing model label | Apply `Flash Med` label |
| 2 | web-jam-back | #450 | Dependency Drift | Labeled `Blocked`, but blocker #412 is CLOSED | Remove `Blocked` label |
| 3 | CollegeLutheran | #88 | Spec Quality | Body relies on "see comment for details" | Recommend spec inline edit |

If no drift is found across all repos, report that the backlog is 100% clean.

### Step 5: Await Explicit Approval & Execute
- **STOP and wait for Josh's response.**
- Accept selective approvals (e.g., "approve 1, 2", "all except 3", "yes to all").
- Execute ONLY approved actions on GitHub via `gh issue edit`, `gh label`, etc.
- Never touch unapproved items.
