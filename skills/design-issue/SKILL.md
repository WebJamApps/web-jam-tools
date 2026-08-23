---
name: design-issue
description: Design-then-issue-plan workflow prior to filing GitHub issues. Design work runs through this skill. Never dispatches (ends at "the issues exist").
metadata:
  version: v1
  publisher: josh
---

# /design-issue — design-then-issue-plan workflow prior to filing GitHub issues

`/design-issue` turns a problem into an approved design, and then into the right set of GitHub issues — the phase *before* filing. `/file-issue` already owns filing a single issue and is unchanged.

Design work does not happen in plain chat. The moment a conversation turns into design — options, trade-offs, decisions worth recording — the session runs `/design-issue` and works inside it. That single rule is what lets the design machinery live in the skill instead of in memory, loading only when design is actually happening.

**ABSOLUTE STANDING RULE:** The skill **NEVER dispatches.** It ends at "the issues exist". It never spawns a build agent, hands work to a lane, starts a worktree, or runs `/work-issue`.

---

## Workflow Phases

### Phase 1 — Design (Opus / Flash High for simple Bug or Task)

With no argument, the skill scans all 8 active repos for open issues labeled `Needs Design` and offers them as candidates. Josh picks; the skill never picks for him.

1. **Establish the theme and milestone.** `<Theme>` matches the GitHub milestone — read the live milestone list, never assume a fixed set. Create the design document at `~/Dropbox/web-jam-llms/<Theme>/<topic>-design-<YYYY-MM-DD>.md`, creating the theme folder if the milestone has none yet.
2. **Record what Josh asked for verbatim**, and the existing ground the work sits on.
3. **Put every decision to Josh one at a time** — applying the Decision-Readiness rule below — and write his answer into the document as he gives it, never batched at the end. An item is decided only when he rules on THAT item by name.
4. **Verify facts rather than asserting them**, and record what was verified and how. Where a premise turns out to be false, the body records the corrected fact in present tense and the falsified premise goes in the decision-record appendix — never a "this turned out to be false" note in the body. Recording an unverified load-bearing premise is NOT sufficient to reach Gate 1 — every load-bearing premise must be resolved and proven, not merely logged as an unknown or caveat, before presenting the design for Gate 1 approval.
5. **Reconcile edits continuously.** Apply the Edit-Reconciliation rule after any passage replacement.
6. **GATE 1 — stop.** Render the design to a standalone HTML file via `scripts/render_design_doc.ts` (layout rules applied) and verify it via headless screenshot. The headless screenshot only proves the layout isn't broken to the agent — it does not put the document in front of Josh. Once verified, open it for him with the literal command:

   ```sh
   DISPLAY="${DISPLAY:-:0}" google-chrome "file:///home/joshua/Dropbox/web-jam-llms/<Theme>/<topic>-design-<YYYY-MM-DD>.html" >/dev/null 2>&1 &
   ```

   Run in the background (trailing `&`, streams redirected) so it does not block the session even when no Chrome process is already running — with a cold Chrome, `google-chrome` becomes the browser process itself and would otherwise hold the inherited stdout/stderr pipes open, stalling the call until timeout even though the tab opened fine. Target the active user desktop display explicitly with `DISPLAY="${DISPLAY:-:0}"` so the browser launch opens the tab in Josh's active session across both Claude Code and agy/Antigravity surfaces, preventing silent failure when invoked from subshells or background tasks where `DISPLAY` is mismatched or unset. It opens a tab in Josh's existing Chrome session (or starts one) and returns immediately. The path is the same `~/Dropbox/web-jam-llms/<Theme>/…` directory the document was created in at step 1, written out in full — `~` does not expand inside a quoted `file://` URL, so use the expanded absolute form, never a literal `~`. A correct result is Chrome opening or focusing a tab showing the rendered design document. Only then present the design and wait for Josh's explicit approval. No writes to GitHub before Gate 1.

### Decision-Readiness Rule
A decision is not ready to put to Josh until two conditions are met:
1. **The mechanism is explained** in Josh's terms before the question — every component the question turns on, described plainly, including machinery discovered mid-session that Josh has never seen.
2. **Every option carries what it actually costs** — what happens in this session, what work it creates, what it collides with, what it risks, and what it gives up.
3. **The recommendation comes last** — after both the mechanism and the options' costs, never instead of them and never before them.

#### Failure Shapes Ruled Out:
- **The bare fork:** Two labeled options and an "I lean 1" with nothing under either.
- **The incomplete set:** Naming two options while a third and better one goes unwritten.
- **The unexplained mechanism:** A question resting on machinery Josh has never seen.
- **The buried premise:** A question whose real subject is a fact discovered mid-answer, presented as an aside rather than the thing being decided.
- **The jargon barrier & academic framing:** Using specialized academic, educational, theoretical, or institutional vocabulary (e.g. "pedagogy", "learner diagnostics", "pedagogical assessment", "fine-motor coordination", "chirality", "topological isomorphism") or framing everyday human activities as formal educational/evaluative testing instead of plain, tangible physical terms (e.g. "left-over-right vs. right-over-left", "showing someone", "kids / small hands", "looking at the knots side-by-side"). Every concept and interaction must be described in plain, everyday conversational language anyone can follow without academic pretension.

The test is Josh's reply: if it comes back as *"I need more details to decide"* or *"I am confused"*, the question was defective, and the repair belongs in the question rather than in a follow-up patching around it.

### Edit-Reconciliation Rule
Replacing a paragraph is not the complete edit. An edit is finished only when the text around it has been re-read and reconciled:
- After any replacement, read the paragraph before and the paragraph after in full.
- Confirm the passage makes each point exactly once, contains no duplicate conclusions, and still argues in one consistent direction.
- A patch applied without reading its neighboring paragraphs is not done.

### Phase 2 — The Issue Plan (Opus / Flash High)

7. **Propose the plan table**, applying the epic heuristic and the Flash High size checklist:

   | # | Proposed title | Epic / child of | Model tier | Priority | Repo | Tests | Closes when |
   |---|---|---|---|---|---|---|---|

8. **Split out manual steps as pairs**, grouped by gate position in the dependency chain. Manual documentation / UI inspection (e.g. verifying generated Markdown/HTML in Google Chrome) and live demonstration / procedure walkthroughs (e.g. executing real-world steps with a learner or external party) are distinct verification surfaces and must be split into separate standalone pairs/issues. **Issue & Document Title Rule for Manual Steps:** Never include personal names (e.g. "Josh:") in issue titles or document titles. Issue titles must be professional, action-oriented, and role-agnostic (e.g. "Manual verification: ...", "Verification: ..."), with ownership designated exclusively by the `Josh` label or assignment, never embedded as a name prefix.
9. **Determine the dependency chain** across the planned issues and record it. Where an issue's deliverable is a pointer — "point X at Y" — the plan **names Y concretely**, because an unnamed target hides an ordering: if Y turns out to be something another planned issue creates, the two issues are not independent, and the implementer picks the target after the chain was already declared. Where a load-bearing proof requires implementation work to obtain, sequence that proof FIRST in the dependency chain — never leave it as a late acceptance criterion whose failure would invalidate everything already built on it.
10. **List every `Needs Design` label change as its own named item** — each removal carrying its 4-part reason.
11. **GATE 2 — stop.** Present the plan and wait for Josh's explicit issue plan approval. No creating, editing, or labeling issues before Gate 2. Gate 2 approval of the plan authorizes the `Needs Design` label removals listed in the plan. Nothing is filed to GitHub until Gate 2 passes.

   **Write the issue-approval token upon Gate 2 approval:** The moment Josh explicitly approves the plan table, write the issue-approval token for the planned repo and exact titles (via `scripts/write_issue_approval_token.ts`) so subsequent `mcp__*__issue_write` and `mcp__*__sub_issue_write` calls pass `hooks/require-approval-token-on-issue-write.sh` without repetitive authorization prompts:

   ```sh
   deno run --allow-env --allow-read --allow-write scripts/write_issue_approval_token.ts \
     --session-id "<session-id>" \
     --repo "<owner/repo>" \
     --title "<exact title 1>" \
     --title "<exact title 2>"
   ```

   The token records the approving session's id, the target `owner/repo`, the exact approved titles, and a bounded expiry (default 4 hours) at `$HOME/.claude/state/issue-approval-token.json` (honoring `ISSUE_APPROVAL_TOKEN_PATH`).

### Phase 3 — Filing (Sonnet subagent / Flash High session)

Filing delegates to a subagent only when delegating moves the work down a tier (Opus design hands off to a Sonnet subagent; agy already on Flash High files directly itself with no self-delegation). The subagent or session receives the approved plan table and the design document path. It files and reports; it builds nothing.

12. **File in plan order — the epic first, then each child** — invoking `/file-issue` once per issue so the filing rules and their enforcing hook apply to every one. Attach each child to its parent as it goes; the ordering is forced by the parent/child link.

    **Cross-repo children.** GitHub sub-issues exist only within a single repository. Attach every same-repo child natively and do NOT restate it in the epic body — GitHub already renders that list. Name ONLY the cross-repo children in the epic body, under their own heading, and cite each as `repo#number "title"`. Never both: each child appears in exactly one place, or the epic drifts from its own child list.
13. **Each body carries only scope, build mechanics and repo facts**, plus a pointer to the design document and the instruction to STOP if that path cannot be read. No requirement text is restated.
14. **Set the native issue type on every filing call** — the parent named in the plan table's `Epic / child of` column files as `--type Epic`, and every child files as its own planned type (`Task`, `Bug` or `Feature`) via `scripts/create-issue.ts --type <Type>` or GitHub MCP `issue_write`. (Note: `gh issue create` has no `--type` flag).
15. **Set the native Priority field** via GitHub MCP `issue_write` → `issue_fields` (or `scripts/create-issue.ts --priority <Level>`). (`gh` CLI cannot set a native field).
16. **Apply the native dependency (`blocked_by`) to anything not yet startable** — link native dependencies for issue-to-issue blockers without adding the `Blocked` label. Apply the `Blocked` label ONLY for external, non-GitHub prerequisites (assets, vendor delays, physical actions; web-jam-tools#725).
17. **If any issue fails to file, stop.** Report which issues exist and which do not, by repo + number + title. No silent retries, no carrying on with the rest.
18. **Report what was filed to Josh in the conversation.** The design document is never edited to record filing status — the filed issues themselves, cited by repo + number + title, are the record of what happened.

### Phase 4 — End-of-Run Memory Consume/Delete

When a run finishes, the skill reads the memory surfaces for rules that fire only while it or `/file-issue` is running, and presents them as **one table, all at once**, with a disposition each. Approval is given to the batch rather than item by item.

| Disposition | What it means | What has to be true |
|---|---|---|
| **Consume** | The rule moves into a skill body and leaves memory | The rule fires only while the skill runs, and the target skill is named |
| **Delete** | The rule leaves memory and nothing is added | The reason names where the rule already lives, or says why it is obsolete. A rule recorded nowhere is never a delete |
| **Split or stay** | Josh rules on it | The file is partly skill-scoped and partly not, and contains no guard rule; the skill never silently splits a rule in half |
| **Not a candidate** | The file never reaches the table | It carries a guard rule — an approval gate, a deletion guard, a credential or spend rule. It stays in memory whole |
| **Stay** | Nothing happens | The rule fires outside the skill too |

#### Memory Consumption Guard Rails:
- **Guard rules are NEVER candidates.** A guard rule (an approval gate, a deletion guard, a credential rule, an authorization-to-spend rule) must fire in sessions that act without loading the skill. Guard rules are never offered as consume, never offered as delete, and never split; they stay in memory whole and are omitted from the table entirely.
- **Executed by script, never by hand.** The file surgery is performed by `scripts/consume_memory_rules.ts` in `web-jam-tools` (dry-run by default, moves to trash never `rm`, byte-verifies captures against the design document appendix, strips removed slugs from `MEMORY.md`, and reports dangling links).

---

## The Two Approval Gates

| Gate | The skill waits for | It must not, before that gate | When it passes |
|---|---|---|---|
| 1 — design | Josh's explicit approval of the design document | write anything to any GitHub issue | proceed to Phase 2 planning (the approval itself lives in the conversation, never written into the design document) |
| 2 — plan | Josh's explicit approval of the issue plan table | create, edit or label any issue | write the issue-approval token (`scripts/write_issue_approval_token.ts`), authorize removing the `Needs Design` labels listed in the approved plan, and proceed to Phase 3 filing |

Nothing is filed to GitHub until GATE 2 passes.

A third gate — dispatch — exists as a standing rule and is not this skill's to hold, because the skill never dispatches at all.

---

## What It Refuses to Do

These are properties of the skill, written as explicit refusals:

| It refuses to | Because |
|---|---|
| write anything to a GitHub issue before GATE 1 | the design gate is real or it is decoration |
| present Gate 1 while a load-bearing assumption the design's mechanism depends on is unverified | recording an unknown is not resolving it; an unproven mechanism is not an approved design |
| create, edit or label an issue before GATE 2 | the plan gate, likewise |
| post design content as an issue comment, ever | comments are not a temp location |
| restate requirement text in an issue body | one fact, one place; a paraphrase drifts immediately |
| remove a `Needs Design` label without an ask carrying its reason | only Josh can say a design is done |
| add `Needs Design` to anything in the approved executable set | it must not become a stub factory |
| put a manual step inside an agent's execution issue | manual steps get their own `Josh` issue |
| combine artifact/doc/UI review and live procedure walkthroughs into a single manual issue | inspecting rendered artifacts in Google Chrome and executing live procedures with learners or external parties are distinct verification surfaces with different gates and acceptance criteria |
| hand Josh a step with no script, no exact click path, or no numbered runbook | every manual step handed to Josh (in chat or issue, pre- or post-Gate 1) requires a numbered runbook at `~/Dropbox/web-jam-llms/<Theme>/<topic>-josh-steps-<date>.md` |
| narrate its own revision history in the body — "what changed", "why this was withdrawn", "an earlier version said", a changelog, before/after framing | the document states the current design as though it had always been the design; superseded reasoning lives only in the decision-record appendix |
| record the skill's own workflow state in the body — a Status line, a gate/approval state, "nothing filed", "design complete" | that describes where the skill's process has got to, not the system being designed; gate state lives in the conversation and in the issues the run produces |
| **dispatch — spawn a build agent, hand work to a lane, start a worktree, run `/work-issue`** | absolute standing rule |
| offer dispatch as a next step in the same breath as reporting what it filed | same rule, quieter failure |
| leave superseded drafts, renamed artifacts, or obsolete intermediate runbook files behind in Dropbox upon deliverable finalization | destination folders must contain only active, canonical deliverables to prevent the accumulation of stale working duplicates |

---

## How Issues Are Shaped

### Epic or Flat

Propose an **epic with children** when the work spans more than one repo, needs more than three issues, or has halves proved by different kinds of evidence. Otherwise propose a **flat set**, or a single issue.

Never propose an epic that is only a container. The heuristic test is whether there is a shared artifact the children point at (not whether the children share a cause). A design run supplies exactly such an artifact (the design document itself) by construction, so an epic produced by a design run is never "only a container" regardless of whether the underlying defects are related. An epic carries the shared context its children point at and closes when its children close. If the only thing an epic would add is a title, the plan is a flat set.

The heuristic only proposes. The plan table is the gate, so a wrong call is caught there.

### Sized for Flash High

Non-epic issues default to **`Flash High`** as the implementation tier. Sizing is governed by the reviewer's burden in one sitting (Josh's per-sitting review burden) rather than raw file count. An issue is Flash-High-sized when all of these hold:

- one repo;
- one layer — frontend or backend, not both;
- roughly 600 changed lines or fewer (additions + deletions), excluding lockfiles and generated files;
- no schema or data migration;
- acceptance criteria provable by running that repo's own test / lint / build commands.

Anything over the line is split into multiple issues, and **every split carries its dependencies** — linked natively via GitHub issue dependencies (`blocked_by`), without adding the redundant `Blocked` label.

### Closeable, Always

Every issue must be closeable. A non-epic closes when its work is done; **an epic closes when its children close.** Epics are not implementable but they are closeable when their sub-issues are done. Perpetual trackers remain banned.

### Proved by Something

The `Tests` column states what proves each issue — unit tests, a Playwright e2e spec, a full-stack run, or none — and why. The skill proposes; Josh rules per issue at GATE 2. It never silently drops coverage and never forces it.

Where a repo has no working e2e stack, the skill says so plainly rather than proposing coverage that cannot run, and names the issue that would unblock it (for example, JaMmusic#1282 and JaMmusic#1283 blocked on Atlas test connection string).

Regression matters as much as the new feature, and a full-stack test must be runnable locally, not only in CircleCI.

---

## Manual Steps & Verification Pairs

Every manual step handed to Josh — whether handed over interactively in chat or filed as a GitHub issue, and whether occurring before or after Gate 1 — **must always have a numbered runbook file** created at:

```
~/Dropbox/web-jam-llms/<Theme>/<topic>-josh-steps-<date>.md
```

There are **no carve-outs** for steps handed over in chat rather than filed as issues, and **no carve-outs** for steps that occur before Gate 1.

### Separate Verification Surfaces (No Composite Manual Issues)

Manual artifact / documentation / UI inspection (e.g., verifying generated Markdown/HTML or live web UIs in Google Chrome) and live demonstration / procedure walkthroughs (e.g., executing real-world instructional steps with a learner or external party) are fundamentally distinct verification surfaces with different execution contexts, timelines, and acceptance criteria.

- **NEVER combine artifact/doc/UI inspection and live procedure walkthroughs into a single composite `Josh` issue.**
- They must always be planned and filed as separate, standalone `Josh` manual verification issues, each with its own distinct runbook path and close criteria.
- **Example precedent:** In web-jam-tools#614 ("what is the best way to show a person how to tie a shoe string and relate this to granny knots"), manual visual inspection of the generated documentation in Google Chrome was improperly combined with the live shoelace tying teaching walkthrough into a single issue (web-jam-tools#622 "Manual verification: verify shoelace reference guide in Google Chrome"). Under this rule, documentation/UI review in Google Chrome and real-world instructional walkthroughs with learners must always be planned and filed as distinct standalone `Josh` issues.

### Runbook Format Requirements

Every runbook file must follow this exact format:
- **Professional, role-agnostic title:** Never include personal names (e.g. do NOT use `# Josh Walkthrough Runbook: ...`). Use action-oriented titles like `# Walkthrough Runbook: ...` or `# Manual Verification Runbook: ...`.
- **Sequential step numbering:** Steps must be explicitly numbered sequentially (`## STEP 1`, `## STEP 2`, ...).
- **Literal commands:** Every shell command, script invocation, or path must be written out completely as a literal command snippet (no placeholders or fuzzy instructions).
- **What each step proves:** Explain explicitly what each step tests or proves.
- **What a correct result looks like:** State clearly the exact expected output, exit status, or visible behavior confirming success.
- **One action per step, one surface per step:** see `docs/cross-ai-rules.md` § POST-MERGE MANUAL STEPS BECOME THEIR OWN `Josh` ISSUE.
- **No conflating internal verification assertions with the human walkthrough script:** A runbook for a human task (e.g. demonstrating a skill, testing a UI, conducting a live walkthrough) must contain ONLY the actual steps of that activity. Never inject automated test assertions, shell commands (e.g. `test -f ... && grep ...`), or repo verification steps into a human walkthrough script. Technical verification of files or artifacts belongs in the PR test plan or issue acceptance criteria, never as a step in a human walkthrough.
- **Never let a result depend on default tool-output rendering.** When a step's pass/fail turns on what the agent actually read or ran, the runbook must do BOTH: turn the expanded view on explicitly in the launch command (for Claude Code, `claude --verbose`), AND include a separate step that asks the agent directly, e.g. "Which exact file paths did you read to answer that?". Collapsed output renders as a summary line such as `Read 1 file` with no path, which makes the run ungradeable.
- **Pruning intermediate runbooks upon unification:** When manual verification runbooks are merged into unified deliverables or consolidated into primary reference guides, any standalone intermediate runbook files (`.md` and `.html`) must be deleted from `~/Dropbox/web-jam-llms/<Theme>/` to avoid leaving orphaned verification drafts behind.

Manual steps never live inside an agent's execution issue. They are **grouped by gate position** — steps needed before the same agent issue share one `Josh` issue; steps at different points in the chain are separate issues. A step that gates nothing is still its own issue.

**Issue & Runbook Title Rule for Manual Steps:**
Never prefix issue titles or runbook document titles with a personal name (e.g. do NOT name an issue "Josh: ..."). Use professional, action-oriented titles like "Manual verification: ..." and use the `Josh` label exclusively to designate responsibility.

**Every manual step is a pair:**

| | Issue A — the agent's | Issue B — the manual verification pair |
|---|---|---|
| **Scriptable** | `Flash High`. Build `<path>` script and write the run instruction to `~/Dropbox/web-jam-llms/<Theme>/<topic>-josh-steps-<YYYY-MM-DD>.md` — exact literal commands, directory, what each step proves, expected result, and why he is running it. Closes when the script merges and doc exists. | `Josh` label. Titled "Manual verification: <action>" (never prefixed with "Josh:"). **Points at** that path (`~/Dropbox/web-jam-llms/<Theme>/<topic>-josh-steps-<YYYY-MM-DD>.md`), never restates it, explains WHY, and says STOP if the path cannot be read. Closes when he confirms he ran it. |
| **UI / Doc Review** | `Flash High`. Investigate the live UI or generate documentation/artifacts and write the inspection instruction to `~/Dropbox/web-jam-llms/<Theme>/<topic>-josh-steps-<YYYY-MM-DD>.md` — exact click path or document inspection steps in Google Chrome. Closes when the doc exists. | `Josh` label. Titled "Manual verification: <action>" (never prefixed with "Josh:"). **Points at** that path, never restates it, explains WHY, and says STOP if the path cannot be read. Closes when he confirms he inspected them in Google Chrome. |
| **Live Procedure / Walkthrough** | `Flash High`. Author the procedure walkthrough guide / instructional runbook at `~/Dropbox/web-jam-llms/<Theme>/<topic>-josh-steps-<YYYY-MM-DD>.md`. Closes when the runbook exists. | `Josh` label. Titled "Manual verification: <action>" (never prefixed with "Josh:"). **Points at** that path, never restates it, explains WHY, and says STOP if the path cannot be read. Closes when he confirms he executed the live demonstration/walkthrough with the learner or external party. |

Artifact/doc review and live procedure walkthroughs are distinct pairs and must NEVER be collapsed into a single composite pair or issue. Issue B is always linked via native GitHub dependency (`blocked_by`) on issue A, without the redundant `Blocked` label (the `Blocked` label is reserved exclusively for external non-GitHub blockers; web-jam-tools#725). A step that can be neither scripted nor performed in a UI is the one case that is a lone `Josh` issue.

This replaces the old "Josh's run is an Epic checkbox" rule and `--part-of` convention for post-merge manual steps: a remaining manual step becomes its own issue, so the agent's PR closes the agent's issue normally.

### Designed Issues with Paired Manual Steps Become Parent Epics

When `/design-issue` resolves an existing issue into paired implementation and Josh manual verification tasks:
1. **Convert the target designed issue into native type `Epic`** (via GraphQL `updateIssue` with the repo's `Epic` `issueTypeId`).
2. **File the executable coding work as a child `Task` sub-issue** attached under that Epic.
3. **File the paired `Josh` manual verification step as a child `Task` sub-issue** attached under that same Epic (natively linked via `blocked_by` dependency to the coding child, without the `Blocked` label).
4. **Author the parent Epic body with the sub-issue list and closing criteria** ("Closes when all sub-issues close").

---

## The `Needs Design` Label

**Finding.** With no argument the skill scans all 8 active repos for open `Needs Design` issues and offers them as candidates.

**Adding — automatic, inside one guard rail.** The skill may add the label to an existing issue too under-specified to plan against, and to a follow-up it knowingly defers to a later design run. It may never add it to anything in the approved plan's executable set. A deferred stub still needs exactly one model label to pass `hooks/require-model-label-on-issue-create.sh`, so it goes out as `Opus` + `Needs Design`.

**Removing — never automatic, and the ask carries its reason.** Only Josh can say that a design is completed or not. The plan presented at Gate 2 lists every `Needs Design` label to be removed, each with its 4 parts, every time:

1. the issue, cited as `repo#number "title"`;
2. **why the design work that label asked for is now done** — naming the design document and the issues filed from it;
3. anything it did **not** resolve;
4. an actual question asking Josh to confirm.

Gate 2 approval of the plan authorizes those removals, executed in the filing phase alongside the issues. An unlisted label is not approved and stays on. The skill still never asserts a design is complete on its own (wording like "design complete, removing the label" is a defect), still never removes a label that was not listed, and still never adds `Needs Design` to anything in the approved executable set. If Josh declines, the skill does not re-ask in the same run.

---

## Design Document Conventions

### Where Design Documents Live

```
~/Dropbox/web-jam-llms/<Theme>/<topic>-design-<YYYY-MM-DD>.md
```

`<Theme>` matches the GitHub milestone. Read the live milestone list from GitHub before creating. Create the theme folder if the milestone has none yet.

### Document Lifecycle & Reference Instructions

- **No automatic lifecycle for design documents.** The skill never archives, moves or deletes a design document, and neither does `/memory-cleanup`. Design documents (`<topic>-design-<YYYY-MM-DD>.md`) are permanent architectural records until Josh deletes them. A missing design document is a normal state, not drift.
- **Instruction for issues pointing at doc.** Every issue pointing at a design document carries the instruction to **STOP and say so if the path cannot be read** — never to reconstruct requirements from the issue body, from comments, or from guesswork.
- **Distinction between permanent design documents and working deliverables:** While design documents are preserved as permanent historical records, working deliverables, guides, and runbooks evolve across design and implementation and require active cleanup to avoid leaving superseded drafts behind.

#### Deliverable Lifecycle & Intermediate Draft Pruning

- **Prune Superseded Working Drafts:** When deliverables, guides, or runbooks are renamed, restructured, or unified during design or implementation (e.g. `shoelace-guide-granny-knots.md` → `shoelace-tying-guide.md`, or merging standalone runbooks into a unified guide), agents MUST actively delete the superseded intermediate drafts (`.md` and `.html`) from `~/Dropbox/web-jam-llms/<Theme>/` rather than leaving stale duplicates.
- **Post-Completion Folder Audit:** Before declaring deliverables complete or closing a parent Epic, agents MUST audit the target destination folder in `~/Dropbox/web-jam-llms/<Theme>/` to ensure only the active, canonical final deliverables remain, preventing the accumulation of stale working files.

### Writing Style

- **The document states what the thing IS.** Present tense, design first. A reader who has never seen the conversation should be able to read it top to bottom and know what is being built.
- **The decision history goes in an appendix**, as one row per decision with its outcome — never interleaved with the design. This also binds the document's OWN revision history: where the design changed direction, the body records the CURRENT design as though it had always been the design, and the abandoned alternative goes in the appendix as the rejected option of the decision that rejected it — never narrated in the body, in any of the phrasings ruled out under "What It Refuses to Do" above.
- **The document never records the skill's own process state.** That describes where the `/design-issue` run has got to, not the system being designed; that state lives in the conversation and in the issues the run produces, per the phrasings ruled out under "What It Refuses to Do" above.
- **Never a bare label in the body.** No "per D-7" or "R-39"; labels exist so the decision table has stable row names, and nowhere else.
- **Josh's own words are preserved where they are load-bearing** — his ruling is the authority, and a paraphrase is weaker than his actual sentence.
- **Explicitly identify and prove load-bearing assumptions BEFORE consolidation.** A load-bearing assumption is one where, if false, the design does not work. The design run must explicitly identify every load-bearing assumption and prove each one before consolidation — not record it as a caveat. Where an assumption cannot be proved, the design must be presented as CONTINGENT and explicitly not approvable — naming the proof that would settle it and what happens to the design under each outcome — never presented as ready for Gate 1 approval. Where the proof requires implementation work to obtain, the skill requires that proof be sequenced FIRST in the plan, never left to a late acceptance criterion whose failure would invalidate everything already built on it.
- **Consolidation happens BEFORE Gate 1, never after.** During the conversation the document accretes as decisions are made. Before GATE 1 the skill rewrites it into design-first shape. Josh never reviews a working draft.
- **Pre-Gate-1 test:** a reader who has never seen the conversation must not be able to tell, from the body, that the design ever said anything different, or that any approval workflow exists.

**Standard Document Shape:**
1. What it is — one section, opening directly with what the thing is. No status block, no preamble of any kind.
2. The workflow.
3. The gates, and what the thing refuses to do.
4. The rules that shape its output.
5. Where things live; what stays out of scope.
6. Appendices — rules absorbed, what Josh asked for verbatim, the decision record.

---

## Which Model Runs What & Design Tiers

| Phase / Scope | Tier | Why |
|---|---|---|
| Simple `Bug` or `Task` Design | Flash High | Contained judgment about one repo's own behavior; cost-effective default |
| Complex Design (`Feature`, `Epic`, multi-repo, multi-issue, or arguable scope) | Opus | Architectural reasoning and deep system judgment; the reason the skill exists |
| Filing (Opus design run) | Sonnet subagent | Mechanical, but bodies must be self-contained and correctly cited |
| Filing (agy / Flash High design run) | Flash High (session) | Already on Flash High — files directly itself (no self-delegation to save a cold start) |

### Design Tiers
- **`Flash High` is the default design tier for a single genuinely simple `Bug` or `Task`.** A one-issue Bug or Task design is a contained judgment about one repo's own behavior.
- **`Opus` keeps everything else:** new `Feature` issues, `Epic` designs, cross-repo work, multi-issue plans with dependency chains, and any `Bug` or `Task` whose scope is arguable.

### Delegation Rules for Filing
- Filing delegates to a subagent **only when delegating moves the work down a tier**.
- An **Opus** design session hands filing to a **Sonnet** subagent.
- An **agy** session already running on **Flash High** files the issues itself without delegating: spawning a subagent on the tier you are already running costs a cold start and re-derived context to save nothing.

---

## What Stays Out

- Building anything it designed.
- Maintaining dependency or `Blocked` state after filing — `/backlog-groom` is the maintainer of record for that drift.
- Tracking live priority after filing — native Priority field owns it.
- Archiving or deleting design documents — Josh alone.

---

## Consumed rules

### a-ruling-becomes-an-issue-same-session

**STRICT (Josh, 2026-08-05):** *"things like this need to be filed as actionable work so they do
not get lost !"*

When Josh makes a decision, **file the GitHub issue in the same session**. Writing it into a
Dropbox record, a design doc, or a memory file is **not** tracking it.

**Why:** the issue is the unit of work in this system — it carries the model label that routes it
to a lane, it is the ONLY thing `handle-agy-tasks.sh` can dispatch against (issue number and
nothing else), and it can be **closed**, which is the completion signal. A decision living only
in a document has none of that. It surfaces only if someone happens to re-read the document and
remembers.

Josh's own words when he caught this: *"so how do I know that I need to do something if there is
nothing asking me or tracking it then?"* — and the honest answer was that he would not.

**The precedent that proves it.** The credentials register, `docs/josh-manual-controls.md`, and
the credential-classification rule were all marked "deferred to a follow-up" in the permission
epic — in the issue body, in a comment, and in another sub-issue's non-goals. **No follow-up was
ever filed.** They were deferred to nowhere and would have vanished when the epic closed. One of
them existed *precisely because* "a control that lives only in a closed issue disappears." They
survived only because a staleness sweep happened to catch them, becoming web-jam-tools#344
"Human-only credentials register, its hard-blocking guard, and the two documentation rules
deferred out of the permission epic".

**AN EPIC IS NOT ACTIONABLE WORK (Josh, 2026-08-05: *"ugg the epic is not actionable work"*).**
Never park a to-do on an epic body. Actionable work goes in **a new issue, or an existing
NON-epic issue** — an epic is a container for sub-issues, not a backlog. Filing it on the epic
looks like tracking and is not: it carries no routing label of its own, it cannot be dispatched,
and it disappears when the epic closes.

**How to apply:**
- Josh rules on something → file the issue that session, with exactly one model label. Do not
  report the decision as "settled and recorded" when only a document was written.
- Needs to be tracked but isn't its own piece of work? Attach it to the **non-epic** issue that
  actually acts on it — e.g. accretion counts belong on the manual-steps issue that performs the
  reset, not on the epic that describes the problem.
- Especially when the work is **Josh's own manual steps** — those must be tracked in an issue,
  never left in a chat or a doc. See [[manual-steps-go-in-issues]].
- The document keeps the reasoning; the issue is the tracking surface. Link them both ways.
- The related standing rule already in `docs/cross-ai-rules.md` covers "deferred to a follow-up
  requires the follow-up to exist". **This is the wider case it does not cover:** a decision that
  was *made and recorded*, not deferred — and it went untracked anyway.

Related: [[design-record-approve-then-dispatch]], [[github-issues-must-be-closeable]],
[[artifacts-must-be-traceable-to-decisions]], [[ai-bot-github-account-proposal]].

### checkbox-means-fully-settled

Josh (2026-07-31): *"i'm not checking boxes until we have both audited, decided, and issue filed
for implementation (or not if we decided not to)"*.

On any audit/review issue where a checkbox tracks Josh's sign-off on a finding, a tick means ALL
THREE are true:

1. **Audited** — the finding is investigated and written up.
2. **Decided** — Josh has made the call on what to do about it.
3. **Tracked** — an issue exists for the implementation, OR the decision was explicitly "don't
   implement" / the work is already shipped, and that is recorded.

**Why:** a box that means only "Josh read it" loses the actionable item. He reads a finding, agrees
it matters, ticks it — and the work silently evaporates because nothing tracks it. The tick is the
closing of a loop, not an acknowledgement of reading. This is the same failure class as
[[artifacts-must-be-traceable-to-decisions]] and [[github-issues-must-be-closeable]].

**How to apply:** never offer to tick a box on the strength of "you've now seen it". Before
offering, check leg 3 exists — if the decision has not been written into the implementation issue
yet, say so and offer to record it FIRST, then tick. And never tick a box unprompted: only Josh
authorizes a specific box, per the standing rule on the issue itself. See
[[session-checkpoint-claude-misbehaves-milestone]] for the live example (web-jam-tools#324's
7-finding audit).

### one-decision-at-a-time

During discuss-first / requirements / design conversations, present exactly ONE decision per turn, with enough detail for Josh to decide it on its own. Do not bundle multiple questions into a single message.

**Why:** In a design discussion about a session-checkpoint skill (2026-06-17), I repeatedly asked 2–3 questions at once and offered finished multi-part drafts. Josh got frustrated ("I need these choices one at a time and with enough detail for me to decide... you are asking me multiple things here and getting both of us confused") and made me back up to the beginning. Batching questions stalls progress and confuses both sides.

**How to apply:** One focused question per turn → give the trade-offs/recommendation → wait for the answer → then the next question. When recapping, it's fine to summarize the whole settled design, but end with a single open question. Pairs with the global CLAUDE.md "discuss first" rule (don't grep his repos to ground a discussion — ask him; he knows his apps). Settled requirements then get filed as a GitHub issue and the source line removed from his task list.

**Reply length in design mode (2026-07-17, gig-venue vetting/design session):** even when each turn ends with one question, a long multi-topic reply is still "too much at one time" — Josh said "we have to slow down… I want to delve into each item so we are sure to get a full design," and a completed action (Stave & Cork fix) got lost inside a long design reply so he asked whether it ever happened. In design mode: SHORT replies, ONE topic per turn, and when an action was executed, state its result in the first line, visually separate from discussion.

**When he says he's confused / needs more info (2026-06-17, CD Baby discussion):** do NOT just re-ask the question. Stop and explain the full end-to-end landscape in plain, non-jargon terms first — give him the mental map (how the whole process works, what depends on what) — then collapse the choice to a clear recommendation rather than another multi-option fork. He often can't pick between options until he understands the terrain they sit in. [[laptop-local-environment]]

**Applies to investigation/report-back turns too, and a trailing "still outstanding" list is a violation (2026-07-25, JaMmusic#1264 dispatch prep):** I ended several report-back turns with a recommendation PLUS a bulleted tail of 2–3 unresolved threads ("still outstanding: reopen #235 or file fresh… plus your call on the WJSC blocker"), reasoning that they were threads Josh had already opened so re-raising them was just bookkeeping. It isn't — Josh: "one decision at a time please, too many at once and I cannot do a good job discerning the information." Carrying open threads is MY job, not his: park them in the checkpoint memory and surface exactly one when it becomes the next thing in the critical path. Never re-list open questions as a reminder footer. When several are genuinely pending, pick the one that unblocks the most and ask only that.

**Applies to SESSION OPENINGS — the backlog dump is the same violation (2026-08-04, first session back after a 3-day token outage):** Josh said hello, I read the resume doc and the live checkpoints and opened with a state-of-play containing a 4-item "waiting on you" list, a 1-item "waiting on me", AND a caveat that ~12 other live checkpoints existed and might have moved. Josh: *"this week we are not going to be working chaotically… we will tackle and focus systematically on problem you will not dump everything on me all once."* Reading every LIVE checkpoint at session start and reporting the union of them is not diligence — it hands him the whole backlog to triage, which is MY job. **On resume: read the resume doc, verify anything genuinely urgent (a live outage), then surface ONE thing — the next item the doc itself names — and hold everything else.** The checkpoints exist so open threads live in a file instead of in his head; quoting them all back at him defeats their purpose.

**A "separately, and not part of that decision…" tail is the SAME violation, no matter how it is framed (2026-08-08, the memory-index/CLAUDE.md design issue):** I asked the one real decision (split the work into two issues or keep it as one), then appended a second ask — "want me to file the backup defect?" — plus three numbered blockers, two half-descriptions and a paragraph of tension-naming. Josh: *"you are giving me TOO much again in a single chat message, i need ONE decision at a time and with enough details for me to decide please."* **Explicitly labelling a second question as separate does not make it free — it is still a second thing to hold.** And "enough detail to decide" means detail about THE ONE CHOICE, not surrounding context: cut the diagnosis, cut the blocker list, cut the discovered-defect report, keep the options and the recommendation. Everything held back goes in the checkpoint memory and gets surfaced when it is next in the critical path.

**It binds in OPS/review turns too, where I had been treating it as a design-mode rule (2026-08-08, the two `/pr-review` dispatches):** relaying two finished PR reviews, I sent multi-part messages — verdict + ranked findings + a cross-PR observation + a merge-order recommendation + an offer to file an issue — and Josh: *"i am totally confused you are giving me way too much all at the same time, give me one thing at a time and with enough details for me to make a decision now (and we really need to work on your communication skills)."* A report-back is not exempt because "he asked for the results": the deliverable is ONE decision he can act on, with the detail needed to act, and everything else held. When two reviews finish, relay the one that is next in the critical path — not both, not a synthesis of both.

**Applies to go/confirm moments too, not just design (2026-07-22, wjt#236 dispatch):** NEVER append a second question to a "say go and I'll dispatch" (or any confirm) turn. I ended a dispatch-confirm with a bonus "…also, want a body note, yes/no?" — Josh's terse "A" then couldn't map cleanly to two questions, so I over-asked for re-confirmation and annoyed him ("you got confused?"). His terse one-word replies ("A", "go") ARE confirmations — read them as such. One ask per turn, full stop: a confirmation turn carries the confirmation and nothing else; hold any secondary question for after.

### detailed-manual-instructions

When a task needs Josh to do something manual — set env/config vars, generate a credential, click through a dashboard, run a CLI command — **give detailed, concrete, numbered instructions**, not a passive hand-wave like "set `GMAIL_IMAP_*` and `ANTHROPIC_API_KEY`".

**Why:** a vague ask dumps the "how" back on Josh and wastes his time; he wants to follow steps, not reverse-engineer them.

**How to apply:**
- **ONE step at a time** (Josh's explicit ask, 2026-07-01, repeated with "!!" after I bundled a wizard into numbered substeps): a "step" = ONE action/click/command per message, even inside a single dashboard wizard — then wait for his "done"/result before the next. Never a numbered list of actions to execute. Steps may take him a while (e.g. on the Tim-site project he KeePasses each credential AND Slacks it to Tim for his KeePass); be patient, don't nudge or pile on.
- **Each step MUST be fully self-contained — NEVER tell him to scroll up / go find earlier content** (Josh, 2026-07-05, angry "!!" after I told him to "scroll up in this chat to find the gray box"). If a step needs text/a URL/a value, PUT IT INLINE in that same message. He should never have to hunt for anything.
- **NEVER use vague verbs like "paste the block in" / "set that" / "add it there"** (same 2026-07-05 session — "what is 'paste the block in' ????"). Every step spells out literally: exactly what to select, exactly what to press to copy/paste (Ctrl+C / ⌘+C, Ctrl+V / ⌘+V), exactly which field, exactly which button. Assume zero prior context about "the block" or "the text" — name and show it in that step.
- **Number the steps against a known total** ("Step 2 of 6") so he can see where he is, and end each with the single action + "reply done for the next step."
- **During manual steps, do NOT use AskUserQuestion / forced-choice popups** (Josh, 2026-07-05: "please stop forcing me to make decisions during our manual steps so I can easily ask questions or correct you when you give me the wrong directions"). Keep it plain conversational prose so he can freely reply "done", ask a question, or correct a wrong instruction. Ask any needed clarifier as a normal sentence, not a popup.
- **Don't describe how the text/UI *looks* on my end** (the "gray box" that didn't exist on his terminal view, 2026-07-05). His renderer differs. Mark boundaries with plain in-band characters (dashed lines, START/END markers) and refer to the literal first/last words, never to visual styling like "the gray box" or "the highlighted part."
- **Never assume Josh is willing to buy/pay for anything.** Flag any cost / paid-account / purchase requirement UP FRONT, before he starts the setup, and present it as an explicit choice — e.g. "the AI-suggestion piece needs a paid Anthropic account ($5 min); the rest is free." Josh was (rightly) annoyed 2026-06-27 to hit an Anthropic "buy credits" wall mid-setup with no warning. Always state the dollar cost AND whether there's a free alternative path before he begins.
- Verify the specifics first (which account, app name, exact config var names, which Heroku app) before writing the steps — don't make him guess.
- **Multi-account dashboards: step 1 is ALWAYS "confirm the account picker shows <account>"** (2026-07-07, Cloudflare: Josh landed on Tim's account and nearly did the HenricksonForSalem Pages setup there — he caught it, not me). Cloudflare/Google/Heroku dashboards remember the last-used account; never assume the login landed on the right one.
- Dashboard UIs drift (Cloudflare's Create page 2026-07-01: no Pages tab, entry is a bottom-line "Looking to deploy Pages? Get started" link). When a click path might be stale, ASK what's on his screen and steer from his answer instead of asserting a path from docs/memory. New-website runbook lives in a web-jam-tools playbook issue.
- **NO side-quest tool calls during manual walkthroughs** (Josh, 2026-07-10, Snyk cleanup: I ran gh repo checks + a GitHub-wide search to "verify before delete" — "please stop, i did not ask you to do this and you are confusing me and eating tokens !"): while he's driving a dashboard, my job is steer-from-his-screen ONLY. No verification lookups, no issue filing, no memory-trail polishing mid-flow unless he asks — raw tool output also lands in his chat and confuses the walkthrough. If a check seems genuinely needed before an irreversible step, ASK in one sentence whether he wants it checked.
- **"One step at a time" includes NAVIGATION** (Josh, 2026-07-10, Cloudflare Account API Tokens: I said "Manage Account → Account API Tokens" and he replied "from here I do not know how to navigate to what you are saying above !?"): a condensed breadcrumb path is NOT a step. Getting to the right screen is its own step (or steps), with the exact starting point (a direct deep-link URL whenever one exists), which sidebar/menu to look in, and where on the screen the item sits. Never compress navigation into "→" chains.
- **Never present guessed UI labels as fact** (Josh's explicit complaint 2026-07-03, Deno console: I asserted "avatar → Account settings → Access Tokens" and "Settings → Deploy from GitHub" for an EA console I'd never seen; the real dialogs differed and he had to improvise twice). For a UI I cannot see: either ask what's on his screen FIRST, or clearly mark the path as a best guess with a fallback ("if you don't see X, tell me what sections you do see"). Guessed-but-confident beats nothing only when labeled as a guess.
- Spell out each step: exact URL, exact button/menu path, exact shell command with the real values/flags filled in.
- **ALWAYS hand him the command itself — never just "go run it yourself"** (Josh, 2026-08-01: *"when you prompt Josh to run something be nice to me and give me the command as well please"*). Any time I hand an action back to him — a manual step, a guard that blocks an agent, a "you'll need to do this" — the exact, copy-pasteable command goes in the same message, with real app/branch/file names substituted, not placeholders. This binds MACHINE-GENERATED text too: a hook that denies a command and tells Josh to run it must embed the ready-to-run command in its deny message, not just name the tool.
- **The `!` prefix does NOT isolate a secret.** Claude Code's `! <command>` runs in THIS session, so the command text and its output land in the transcript exactly as if an agent ran it. For anything touching a credential (`heroku config:get`, `heroku config:set`, `heroku auth:token`), the instruction must say **a separate terminal outside Claude Code** — never `!`. Guard messages must say so explicitly or an agent will helpfully suggest `!` and reintroduce the leak.
- Include how to verify it worked (a command + expected output).
- Pair with [[remind-save-secrets-to-keepass]] whenever a step reveals a credential.

Related: [[verify-state-before-suggesting]].

