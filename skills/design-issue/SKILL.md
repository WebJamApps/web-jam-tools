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

**A target issue's body is read before anything else, and what it says is scope.** When the skill is invoked on a named issue, reading that issue's body in full is its first act — before the epic check, before the label checks, before its children are enumerated. Any directive there enters the run's scope and appears as a row in the Gate 2 plan table, where removing it costs Josh one word. Because nothing is written to GitHub before Gate 2, including named scope is free and reversible, so the skill never argues for exclusion and never requires a second ask. The document's verbatim appendix carries the target issue's directive lines, and the checker fails a document that names a target issue while carrying none — a rule to read the body is unfalsifiable, whereas a document that must quote what the body said either quotes it or fails.

1. **Establish the theme and milestone.** `<Theme>` matches the GitHub milestone — read the live milestone list, never assume a fixed set. **Resume rather than restart:** Before creating a design document, look in the theme folder for an existing `<topic>-design-*.md` and continue from its decision record; a run that wants a fresh document says so. Otherwise create the design document at `~/Dropbox/web-jam-llms/<Theme>/<topic>-design-<YYYY-MM-DD>.md`, creating the theme folder if the milestone has none yet.
   - **Automatic Feature Matching & Canonical Document Discovery:** When invoked on an Epic or feature, run `deno task design:candidates --epic <citation>` (or `deno task design:match-design "<topic>"`) to automatically scan `~/Dropbox/web-jam-llms/<Theme>/` (and adjacent theme directories) for pre-existing canonical design documents (`<topic>-design-*.md` or `<topic>-skill-design-*.md`) before creating a new document.
   - **Propose Major Revision to Existing Document:** If a matching canonical document exists for the feature/skill, the skill automatically resolves to that existing document and proposes a **Major Revision**, updating the specification in-place rather than spawning a new standalone file.
   - **Refusal of Redundant Parallel Documents:** The skill strictly refuses to create redundant parallel design documents (such as `*-phase-2-design-*.md` or disconnected parallel files) for a feature that already has a canonical design document. Gate 1 (`runGate1`) actively enforces this check in code and refuses to render or open any document that duplicates a pre-existing canonical topic.
2. **Record what Josh asked for verbatim**, and the existing ground the work sits on.
3. **Put every decision to Josh one at a time** — applying the Decision-Readiness rule below — and write his answer into the document as he gives it, never batched at the end. An item is decided only when he rules on THAT item by name.
4. **Verify facts rather than asserting them**, and record what was verified and how. Where a premise turns out to be false, the body records the corrected fact in present tense and the falsified premise goes in the decision-record appendix — never a "this turned out to be false" note in the body. Recording an unverified load-bearing premise is NOT sufficient to reach Gate 1 — every load-bearing premise must be resolved and proven, not merely logged as an unknown or caveat, before presenting the design for Gate 1 approval.
5. **Reconcile edits continuously.** Apply the Edit-Reconciliation rule after any passage replacement.
6. **Record revision in `## Revision History` table before Gate 1 (web-jam-tools#892):** When revising an existing design document, add the `## Revision History` table if absent, and append exactly one row for that Epic or Issue before Gate 1:

   ```markdown
   ## Revision History

   | Version | Date | Epic / Issue | Summary |
   |---|---|---|---|
   | 1.0.0 | 2026-08-16 | [issue title](url) | One line saying what this revision covers. |
   | 1.1.0 | 2026-09-02 | [issue title](url) | One line saying what this revision covers. |
   ```

   - **One row per Epic or standalone Issue:** Exactly one version bump for that whole piece of work no matter how many individual decisions it contained.
   - **Child issues of an Epic do not get their own row:** Work done under an Epic rolls up into that Epic's existing row: the summary widens by a clause if needed and the date advances to the latest revision, but the version does not bump again. A new row and new version bump happen only when a different Epic, or a standalone Issue outside any Epic, changes the document.
   - **Required columns:** `Version`, `Date`, and a summary column are required; extra columns may be present. Versions are semantic (`MAJOR.MINOR.PATCH`) and dates are ISO (`YYYY-MM-DD`). Rows run oldest to newest. Issues are linked by title rather than by bare number.
7. **GATE 1 — stop.** Render the design to a standalone HTML file via `scripts/render_design_doc.ts` (layout rules applied) and verify it via headless screenshot. The headless screenshot only proves the layout isn't broken to the agent — it does not put the document in front of Josh. Once verified, open it for him with the literal command:

   ```sh
   DISPLAY="${DISPLAY:-:0}" google-chrome "file:///home/joshua/Dropbox/web-jam-llms/<Theme>/<topic>-design-<YYYY-MM-DD>.html" >/dev/null 2>&1 &
   ```

   Run in the background (trailing `&`, streams redirected) so it does not block the session even when no Chrome process is already running — with a cold Chrome, `google-chrome` becomes the browser process itself and would otherwise hold the inherited stdout/stderr pipes open, stalling the call until timeout even though the tab opened fine. Target the active user desktop display explicitly with `DISPLAY="${DISPLAY:-:0}"` so the browser launch opens the tab in Josh's active session across both Claude Code and agy/Antigravity surfaces, preventing silent failure when invoked from subshells or background tasks where `DISPLAY` is mismatched or unset. It opens a tab in Josh's existing Chrome session (or starts one) and returns immediately. The path is the same `~/Dropbox/web-jam-llms/<Theme>/…` directory the document was created in at step 1, written out in full — `~` does not expand inside a quoted `file://` URL, so use the expanded absolute form, never a literal `~`. A correct result is Chrome opening or focusing a tab showing the rendered design document. Only then present the design and wait for Josh's explicit approval. No writes to GitHub before Gate 1.

### Automatic Feature Matching & Major Revision Protocol

When `/design-issue` or `design:candidates` runs on an Epic or feature whose topic already has a canonical design document in `~/Dropbox/web-jam-llms/<Theme>/`:
1. **Automatic Discovery & Resolution:** Before creating a new file, run `deno task design:candidates --epic <citation>` or `deno task design:match-design "<topic>"` to locate the pre-existing canonical design document (`<topic>-design-*.md` or `<topic>-skill-design-*.md`) across the theme directory (and adjacent theme directories). The command resolves to the canonical document rather than spawning a new standalone file.
2. **Propose Major Revision:** The skill prompts to conduct a Major Revision to the existing document, preserving it as the single source of truth for the feature.
3. **Major Revision Workflow (In-Place Updates):**
   - **Record New Revision Row:** Adds or updates the `## Revision History` table before Gate 1, appending a new row for the Epic or standalone Issue (incrementing the version, e.g. 1.1.0 → 2.0.0 for major updates or new epics, recording the current date, linking the Epic/Issue title, and summarizing key enhancements).
   - **Update Architecture, ERD & Decisions In-Place:** Reconciles and rewrites the Architecture, ERD, Decisions Record, and `## Both surfaces` sections in-place so the document reads cohesively as though it had always been the design.
   - **Preserve Single Source of Truth:** Retains a single canonical document for the feature, eliminating documentation fragmentation across disconnected files.
4. **Refusal of Parallel Files:** The skill strictly refuses to create redundant parallel design documents (such as `*-phase-2-design-*.md`) for the same feature. Gate 1 (`runGate1`) actively enforces this check in code and throws an error if an older canonical document exists for the topic.

### Decision-Readiness Rule
A decision is not ready to put to Josh until these conditions are met:
1. **Exactly ONE decision per turn** — present one focused question per turn, with enough detail for Josh to decide it on its own. Do not bundle multiple questions into a single message, and do not append a trailing "still outstanding" list or secondary questions (even framed as "separately, and not part of that decision...").
2. **The mechanism is explained** in Josh's terms before the question — every component the question turns on, described plainly, including machinery discovered mid-session that Josh has never seen.
3. **Every option carries what it actually costs** — what happens in this session, what work it creates, what it collides with, what it risks, and what it gives up.
4. **The recommendation comes last** — after both the mechanism and the options' costs, never instead of them and never before them.

#### Failure Shapes Ruled Out:
- **The bare fork:** Two labeled options and an "I lean 1" with nothing under either.
- **The incomplete set:** Naming two options while a third and better one goes unwritten.
- **The unexplained mechanism:** A question resting on machinery Josh has never seen.
- **The buried premise:** A question whose real subject is a fact discovered mid-answer, presented as an aside rather than the thing being decided.
- **The bundled question / multi-decision dump:** Asking 2–3 questions at once, appending bonus asks ("…also, want a body note?"), or attaching a backlog dump / trailing list of unresolved threads to a report-back or confirm turn.
- **The jargon barrier & academic framing:** Using specialized academic, educational, theoretical, or institutional vocabulary (e.g. "pedagogy", "learner diagnostics", "pedagogical assessment", "fine-motor coordination", "chirality", "topological isomorphism") or framing everyday human activities as formal educational/evaluative testing instead of plain, tangible physical terms (e.g. "left-over-right vs. right-over-left", "showing someone", "kids / small hands", "looking at the knots side-by-side"). Every concept and interaction must be described in plain, everyday conversational language anyone can follow without academic pretension.

#### Communication Rules in Design Mode:
- **Short replies, ONE topic per turn:** When an action was executed, state its result in the first line, visually separate from discussion.
- **When he says he is confused / needs more info:** Do NOT just re-ask the question. Stop and explain the full end-to-end landscape in plain, non-jargon terms first — give him the mental map (how the whole process works, what depends on what) — then collapse the choice to a clear recommendation.
- **On resume:** Read the resume doc, verify anything genuinely urgent (a live outage), then surface ONE thing — the next item the doc itself names — and hold everything else.
- **Report-backs and confirmation turns:** Relay ONE actionable decision with the detail needed to act. Never append secondary questions or multi-topic lists to a confirmation or report-back turn.

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

   - **Issue Titles for Project Manager Audience**: Proposed titles in the plan table must be written for a project manager audience (professional, concise, action-oriented, and unambiguous), include the skill or feature scope prefix where applicable (e.g. `skills/file-issue: ...`, `model/venue: ...`), and cite the parent Epic where applicable.

8. **Split out manual steps as pairs**, grouped by gate position in the dependency chain. Manual documentation / UI inspection (e.g. verifying generated Markdown/HTML in Google Chrome) and live demonstration / procedure walkthroughs (e.g. executing real-world steps with a learner or external party) are distinct verification surfaces and must be split into separate standalone pairs/issues. **Issue & Document Title Rule for Manual Steps:** Never include personal names (e.g. "Josh:") in issue titles or document titles. Issue titles must be professional, action-oriented, and role-agnostic (e.g. "Manual verification: ...", "Verification: ..."), with ownership designated exclusively by the `Josh` label or assignment, never embedded as a name prefix.
9. **Determine the dependency chain** across the planned issues and record it. Where an issue's deliverable is a pointer — "point X at Y" — the plan **names Y concretely**, because an unnamed target hides an ordering: if Y turns out to be something another planned issue creates, the two issues are not independent, and the implementer picks the target after the chain was already declared. Where a load-bearing proof requires implementation work to obtain, sequence that proof FIRST in the dependency chain — never leave it as a late acceptance criterion whose failure would invalidate everything already built on it.
10. **List every `Needs Design` label change as its own named item** — each removal carrying its 4-part reason.
11. **Reconcile stale issue bodies and `Needs Design` label removals together in the same run — never separately.** Removing the `Needs Design` label and rewriting the issue's stale body sections happen in the same run — never separately (striking questions the design document answers, repointing design references, and reconciling scope against the approved plan). An issue is not done being designed while its own body still asks questions the design document has answered or points at the wrong document. Use `deno task design:stale-bodies` (`web-jam-tools#746`) to find stale sections.
12. **GATE 2 — stop.** Present the plan and wait for Josh's explicit issue plan approval. No creating, editing, or labeling issues before Gate 2. Gate 2 approval of the plan authorizes the `Needs Design` label removals listed in the plan. Nothing is filed to GitHub until Gate 2 passes.

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

13. **File in plan order — the epic first, then each child** — invoking `/file-issue` once per issue so the filing rules and their enforcing hook apply to every one. Attach each child to its parent as it goes (and cite the parent Epic in the child issue body); the ordering is forced by the parent/child link.

    **Cross-repo children.** GitHub sub-issues exist only within a single repository. Attach every same-repo child natively and do NOT restate it in the epic body — GitHub already renders that list. Name ONLY the cross-repo children in the epic body, under their own heading, and cite each as `repo#number "title"`. Never both: each child appears in exactly one place, or the epic drifts from its own child list.
14. **Each body carries only scope, build mechanics and repo facts**, plus a pointer to the design document and the instruction to STOP if that path cannot be read. No requirement text is restated.
15. **Set the native issue type on every filing call** — the parent named in the plan table's `Epic / child of` column files as `--type Epic`, and every child files as its own planned type (`Task`, `Bug` or `Feature`) via `scripts/create-issue.ts --type <Type>` or GitHub MCP `issue_write`. (Note: `gh issue create` has no `--type` flag).
16. **Set the native Priority field** via GitHub MCP `issue_write` → `issue_fields` (or `scripts/create-issue.ts --priority <Level>`). (`gh` CLI cannot set a native field).
17. **Apply the native dependency (`blocked_by`) to anything not yet startable** — link native dependencies for issue-to-issue blockers via `scripts/create-issue.ts --blocked-by <issue_num>` (or `deno task create-issue --blocked-by <issue_num>`) without adding the `Blocked` label. Note: setting a dependency on the issue's own parent or ancestor is refused. Apply the `Blocked` label ONLY for external, non-GitHub prerequisites (assets, vendor delays, physical actions; web-jam-tools#725).
18. **If any issue fails to file, stop.** Report which issues exist and which do not, by repo + number + title. No silent retries, no carrying on with the rest.
19. **Report what was filed to Josh in the conversation.** The design document is never edited to record filing status — the filed issues themselves, cited by repo + number + title, are the record of what happened.

### Phase 4 — End-of-Run Memory Consume/Delete (Claude Code only; skipped on agy)

**Surface scope:** Phase 4 runs on Claude Code only. It reads Claude Code's private memory directory (`~/.claude/projects/-home-joshua/memory/`) to decide which rules move into a skill body, and agy has no such directory. On agy, Phase 4 is skipped entirely, rather than silently doing nothing.

When a run finishes on Claude Code, the skill reads the memory surfaces for rules that fire only while it or `/file-issue` is running, and presents them as **one table, all at once**, with a disposition each. Approval is given to the batch rather than item by item.

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
| create a redundant parallel design document (e.g. `*-phase-2-design-*.md`) for a feature or skill that already has a canonical design document in `~/Dropbox/web-jam-llms/<Theme>/` | fragments feature documentation across multiple files and causes architectural drift; updates must be conducted as Major Revisions to the existing canonical document in-place |
| post design content as an issue comment, ever | comments are not a temp location |
| restate requirement text in an issue body | one fact, one place; a paraphrase drifts immediately |
| remove a `Needs Design` label without an ask carrying its reason | only Josh can say a design is done |
| add `Needs Design` to anything in the approved executable set | it must not become a stub factory |
| put a manual step inside an agent's execution issue | manual steps get their own `Josh` issue |
| combine artifact/doc/UI review and live procedure walkthroughs into a single manual issue | inspecting rendered artifacts in Google Chrome and executing live procedures with learners or external parties are distinct verification surfaces with different gates and acceptance criteria |
| hand Josh a step with no script, no exact click path, or no numbered runbook | every manual step handed to Josh (in chat or issue, pre- or post-Gate 1) requires a numbered runbook at `~/Dropbox/web-jam-llms/<Theme>/<topic>-manual-steps-<YYYY-MM-DD>.md` |
| design a mechanism that works on only one agent surface (Claude Code or agy/Antigravity) without stopping for discussion | everything designed must work on both surfaces; surface-neutral paths are deno task, gh CLI, and CI; fails when depending on Claude-only hooks, Claude memory, or mcp__* tools |
| file a `Sonnet`-labeled trigger-list issue without an enumerated closed case list of literal input strings — including a list that enumerates categories (e.g. "piped to an interpreter") instead of the strings a matcher will see | trigger-list work (guards, hooks, regex, matchers, filters, permission patterns) is sized for Sonnet by its case list, not its diff; a case list counts as closed only when every entry is a literal input string, never a category; vague criteria like "handle edge cases" and category-named criteria both fail in review — a category is an unclosed list wearing the shape of a closed one; issues must enumerate every adversarial input case as a literal string, or, where a category cannot be reduced to such a finite set at design time, be filed as `Opus`, naming the category that resisted enumeration |
| narrate its own revision history in prose — "what changed", "why this was withdrawn", "an earlier version said", a changelog, before/after framing | the document states the current design as though it had always been the design; superseded reasoning lives only in the decision-record appendix. Metadata about document revisions lives exclusively in the `## Revision History` table (web-jam-tools#892) |
| record the skill's own workflow state in the body — a Status line, a gate/approval state, "nothing filed", "design complete" | that describes where the skill's process has got to, not the system being designed; gate state lives in the conversation and in the issues the run produces |
| **dispatch — spawn a build agent, hand work to a lane, start a worktree, run `/work-issue`** | absolute standing rule |
| offer dispatch as a next step in the same breath as reporting what it filed | same rule, quieter failure |
| leave superseded drafts, renamed artifacts, or obsolete intermediate runbook files behind in Dropbox upon deliverable finalization | destination folders must contain only active, canonical deliverables to prevent the accumulation of stale working duplicates |

---

## Both Surfaces Parity Rule

Everything this skill designs works on both Claude Code and agy/Antigravity. A mechanism fails this rule when it depends on something only one surface has: a Claude Code hook, because agy-native hooks do not fire; Claude Code's memory directory, which agy does not have; or an `mcp__*` tool. The surface-neutral paths are this repository's `deno task` entries, the `gh` CLI, and CI. Where a mechanism cannot be made surface-neutral, the skill says so plainly and stops for discussion, rather than designing a one-surface mechanism and calling it done.

**Every design document carries a `## Both surfaces` section**, stating for each mechanism it designs how that mechanism works on each surface. `deno task design:lint-doc` fails a document that omits it.

### Installing is for Structure, Never for Content

**Installing is for structure, never for content.** Skill bodies and hook scripts are symlinked into the canonical clone, and agy invokes those same Claude Code symlinks through `agy-hook-shim.sh` while symlinking the same skill sources into its own plugin directory. One set of files serves both surfaces, so a content change to an existing skill or hook is live on both the moment the canonical clone is on the merged commit. For the resolution mechanism, see `docs/scripts.md` ("`install-hooks.sh` — what actually gets symlinked"); for the both-surfaces acceptance-criterion shape a content-only change must use, see `skills/file-issue/SKILL.md` rule 14 — do not restate either here. The installers exist for the two things a symlink cannot carry: a link that does not exist yet, and a registration entry. A new, renamed or deleted skill runs the skill installer. A new or deleted hook, or an existing hook whose event or matcher changed, runs the hook installer, which re-merges the repository's entries into the two settings files — merge targets holding Josh's own settings beside the repository's, and so not themselves symlinkable. Both run from the canonical clone, never from a worktree, which the installer's own path validation enforces.

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

### Sized for Sonnet

**Trigger-list work is sized for Sonnet by its case list, not its diff.** Work matching the guard/hook/regex/matcher/filter/permission-pattern trigger list (`web-jam-tools#427 "Route guard/matcher work to Sonnet, make its review execute rather than read, prove it in CI, enforce citations on GitHub writes, and stop Opus designing other lanes' fixes — A1 through A6"`) defaults to `Sonnet`. It only counts as `Sonnet`-sized once its acceptance criteria enumerate every adversarial input case the fix has to handle — not the phrase "handle edge cases," the actual list. Where that list splits along tested behaviors, file one issue per behavior, each with its own closed case list. Where the fix is a single, non-decomposable change whose case list cannot be pinned down at design time, file it `Opus`-labeled instead, and say why it could not be split.

**A case list counts as closed only when it enumerates input strings, never categories.** The rule above tests that a list exists; this one tests that the list is finite. For matcher work the defect is always the case nobody thought of, so a criterion naming a category — "piped to an interpreter", "redirected to a file", "a quoted delimiter" — is an unclosed list wearing the shape of a closed one, and satisfies the sizing rule while proving nothing. Every case a trigger-list issue claims to cover is written as the literal input the matcher will see (`/bin/bash`, `source /dev/stdin`, `cat >> /home/j/bash-x.md`), and where a category cannot be reduced to a finite set of such strings at design time, that is the "cannot be pinned down" condition in the rule above: the issue is filed `Opus`-labeled, naming the category that could not be enumerated. A category may still be stated, but only as the heading over its enumerated strings — never as a case in its own right.

**Resolver work is sized by its key space: acceptance criteria must enumerate key sources and every pairwise collision.** The rules above test whether a list of matcher inputs is finite; this one tests whether a set of resolver key sources is complete. When a deliverable resolves a reference to a target through any lookup keyed by author-supplied values — registry, index, symbol table, alias resolver — the design run must enumerate the complete set of key sources the format admits (for example, `web-jam-tools#748` admitted exactly four: 1-based position, explicit `id`, title, external `repo#N` citation). The acceptance criteria must state the collision behaviour for **every unordered pair** of those key sources, plus each source against itself (four sources yield six pairs and four self-collisions). A tier floor of **`Sonnet`** applies whenever a wrong resolution causes an irreversible external write — a GitHub edge, an email, a payment — rather than a local error, because that failure is silent and durable and review reaches it only by constructing the collision. Where the key-source set cannot be closed at design time, that is the "cannot be pinned down" condition in the trigger-list rule above: the issue is filed **`Opus`**-labeled, naming the open key space that could not be enumerated.

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
~/Dropbox/web-jam-llms/<Theme>/<topic>-manual-steps-<YYYY-MM-DD>.md
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
- **Runbook naming convention:** Runbooks are named `<topic>-manual-steps-<YYYY-MM-DD>.md`. Ownership of a manual step is designated exclusively by the `Josh` label, never by embedding a personal name in a filename, an issue title, or a document title.
- **Sequential step numbering:** Steps must be explicitly numbered sequentially (`## STEP 1`, `## STEP 2`, ...), or against a known total ("Step 2 of 6").
- **Detailed, literal commands:** Every shell command, script invocation, or path must be written out completely as a literal, copy-pasteable command snippet with real values/flags filled in (no placeholders, fuzzy instructions, or "go run it yourself").
- **What each step proves:** Explain explicitly what each step tests or proves.
- **What a correct result looks like:** State clearly the exact expected output, exit status, or visible behavior confirming success.
- **One action per step, one surface per step:** A step is ONE action/click/command per message/step (even inside a dashboard wizard); wait for completion before the next. Never compress navigation into "→" breadcrumb chains. See `docs/cross-ai-rules.md` § POST-MERGE MANUAL STEPS BECOME THEIR OWN `Josh` ISSUE.
- **Fully self-contained steps:** Each step must be self-contained — never tell the reader to scroll up or hunt for earlier content. Place text, URLs, and values inline in that step.
- **No vague verbs:** Never use vague verbs like "paste the block in" / "set that" / "add it there". Spell out literally what to select, keyboard shortcuts (Ctrl+C / ⌘+C, Ctrl+V / ⌘+V), which field, and which button.
- **No visual rendering styling references:** Do not describe visual styling (e.g. "the gray box"); use plain text markers (dashed lines, START/END markers) and literal text identifiers.
- **Up-front cost disclosures:** Flag any cost, paid-account, or purchase requirements UP FRONT with exact dollar amounts and free alternatives before setup begins.
- **Multi-account dashboards:** Step 1 on any multi-account dashboard (Cloudflare, Google, Heroku) is ALWAYS "confirm the account picker shows <account>".
- **Dashboard drift & walkthrough safety:** When dashboard UIs drift, steer from screen state rather than asserting guessed paths. No side-quest tool calls or unrelated lookups during manual walkthroughs.
- **No forced-choice popups during walkthroughs:** Do not use AskUserQuestion / forced-choice modals during manual walkthroughs; use plain conversational prose so questions or corrections are straightforward.
- **Secret isolation outside Claude Code:** The `!` prefix does NOT isolate a secret in Claude Code. Any command touching credentials (`heroku config:get`, `auth:token`, etc.) must specify a separate terminal outside Claude Code.
- **Save secrets to KeePass:** Remind Josh to save secrets and passwords to KeePass whenever a step reveals or generates a credential.
- **No conflating internal verification assertions with the human walkthrough script:** A runbook for a human task (e.g. demonstrating a skill, testing a UI, conducting a live walkthrough) must contain ONLY the actual steps of that activity. Never inject automated test assertions, shell commands (e.g. `test -f ... && grep ...`), or repo verification steps into a human walkthrough script. Technical verification of files or artifacts belongs in the PR test plan or issue acceptance criteria, never as a step in a human walkthrough.
- **Never let a result depend on default tool-output rendering.** When a step's pass/fail turns on what the agent actually read or ran, the runbook must do BOTH: turn the expanded view on explicitly in the launch command (for Claude Code, `claude --verbose`), AND include a separate step that asks the agent directly, e.g. "Which exact file paths did you read to answer that?". Collapsed output renders as a summary line such as `Read 1 file` with no path, which makes the run ungradeable.
- **Pruning intermediate runbooks upon unification:** When manual verification runbooks are merged into unified deliverables or consolidated into primary reference guides, any standalone intermediate runbook files (`.md` and `.html`) must be deleted from `~/Dropbox/web-jam-llms/<Theme>/` to avoid leaving orphaned verification drafts behind.

Manual steps never live inside an agent's execution issue. They are **grouped by gate position** — steps needed before the same agent issue share one `Josh` issue; steps at different points in the chain are separate issues. A step that gates nothing is still its own issue.

**Issue & Runbook Title Rule for Manual Steps:**
Never prefix issue titles or runbook document titles with a personal name (e.g. do NOT name an issue "Josh: ..."). Use professional, action-oriented titles like "Manual verification: ..." and use the `Josh` label exclusively to designate responsibility.

**Every manual step is a pair:**

| | Issue A — the agent's | Issue B — the manual verification pair |
|---|---|---|
| **Scriptable** | `Flash High`. Build `<path>` script and write the run instruction to `~/Dropbox/web-jam-llms/<Theme>/<topic>-manual-steps-<YYYY-MM-DD>.md` — exact literal commands, directory, what each step proves, expected result, and why he is running it. Closes when the script merges and doc exists. | `Josh` label. Titled "Manual verification: <action>" (never prefixed with "Josh:"). **Points at** that path (`~/Dropbox/web-jam-llms/<Theme>/<topic>-manual-steps-<YYYY-MM-DD>.md`), never restates it, explains WHY, and says STOP if the path cannot be read. Closes when he confirms he ran it. |
| **UI / Doc Review** | `Flash High`. Investigate the live UI or generate documentation/artifacts and write the inspection instruction to `~/Dropbox/web-jam-llms/<Theme>/<topic>-manual-steps-<YYYY-MM-DD>.md` — exact click path or document inspection steps in Google Chrome. Closes when the doc exists. | `Josh` label. Titled "Manual verification: <action>" (never prefixed with "Josh:"). **Points at** that path, never restates it, explains WHY, and says STOP if the path cannot be read. Closes when he confirms he inspected them in Google Chrome. |
| **Live Procedure / Walkthrough** | `Flash High`. Author the procedure walkthrough guide / instructional runbook at `~/Dropbox/web-jam-llms/<Theme>/<topic>-manual-steps-<YYYY-MM-DD>.md`. Closes when the runbook exists. | `Josh` label. Titled "Manual verification: <action>" (never prefixed with "Josh:"). **Points at** that path, never restates it, explains WHY, and says STOP if the path cannot be read. Closes when he confirms he executed the live demonstration/walkthrough with the learner or external party. |

Artifact/doc review and live procedure walkthroughs are distinct pairs and must NEVER be collapsed into a single composite pair or issue. Issue B is always linked via native GitHub dependency (`--blocked-by <issue_num>`) on issue A, without the redundant `Blocked` label (the `Blocked` label is reserved exclusively for external non-GitHub blockers; web-jam-tools#725). A step that can be neither scripted nor performed in a UI is the one case that is a lone `Josh` issue.

This replaces the old "Josh's run is an Epic checkbox" rule and `--part-of` convention for post-merge manual steps: a remaining manual step becomes its own issue, so the agent's PR closes the agent's issue normally.

### Designed Issues with Paired Manual Steps Become Parent Epics

When `/design-issue` resolves an existing issue into paired implementation and Josh manual verification tasks:
1. **Convert the target designed issue into native type `Epic`** (via GraphQL `updateIssue` with the repo's `Epic` `issueTypeId`).
2. **File the executable coding work as a child `Task` sub-issue** attached under that Epic.
3. **File the paired `Josh` manual verification step as a child `Task` sub-issue** attached under that same Epic (natively linked via `--blocked-by <issue_num>` dependency to the coding child, without the `Blocked` label).
4. **Author the parent Epic body with `## What this builds`, milestone, design document pointer, and `## Acceptance criteria` ("Closes when all child sub-issues close")** without duplicating a manual markdown list or checkboxes of sub-issues (GitHub natively renders and tracks sub-issues).

---

## The `Needs Design` Label

**Finding.** With no argument the skill scans all 8 active repos for open `Needs Design` issues and offers them as candidates.

**Adding — automatic, inside one guard rail.** The skill may add the label to an existing issue too under-specified to plan against, and to a follow-up it knowingly defers to a later design run. It may never add it to anything in the approved plan's executable set. A deferred stub still needs exactly one model label to pass `hooks/require-model-label-on-issue-create.sh`, so it goes out as `Opus` + `Needs Design`.

**Removing — never automatic, and the ask carries its reason.** Only Josh can say that a design is completed or not. Removing the `Needs Design` label and rewriting the issue's stale body sections happen in the same run — never separately (striking questions the design document answers, repointing design references, and reconciling scope). Use `deno task design:stale-bodies` (`web-jam-tools#746`) to find stale sections. The plan presented at Gate 2 lists every `Needs Design` label to be removed, each with its 4 parts, every time:

1. the issue, cited as `repo#number "title"`;
2. **why the design work that label asked for is now done** — naming the design document, the issues filed from it, and the specific stale body sections being rewritten (striking questions the design document answers, repointing design references, and reconciling scope);
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
- **The decision history goes in an appendix**, as one row per decision with its outcome — never interleaved with the design. This also binds the document's OWN revision narration: where the design changed direction, the body records the CURRENT design as though it had always been the design, and the abandoned alternative goes in the appendix as the rejected option of the decision that rejected it — never narrated in prose in the body. Revision metadata belongs exclusively in the `## Revision History` table, not in body prose (web-jam-tools#892).
- **The document never records the skill's own process state.** That describes where the `/design-issue` run has got to, not the system being designed; that state lives in the conversation and in the issues the run produces, per the phrasings ruled out under "What It Refuses to Do" above.
- **Never a bare label in the body.** No "per D-7" or "R-39"; labels exist so the decision table has stable row names, and nowhere else.
- **Josh's own words are preserved where they are load-bearing** — his ruling is the authority, and a paraphrase is weaker than his actual sentence.
- **A design document proves its own premises, and the gate will not open without them.** Every design document carries a `## Load-bearing premises` section: one row per premise the design depends on, naming what was checked and what it showed. The document checker fails a document that omits the section, and fails any row whose proof is empty or hedged. Gate 1's presentation states that every row in that table is proven, so a hedge moved out of the document and into the conversation stands beside a table that contradicts it. The gate task refuses to render or open a document whose checker run does not pass, so the checker cannot be bypassed by invoking the gate directly. A premise that cannot be proved does not become a caveat: either the mechanism resting on it leaves the design, or the work that would settle it is sequenced first and the mechanism is designed after it reports.
- **Consolidation happens BEFORE Gate 1, never after.** During the conversation the document accretes as decisions are made. Before GATE 1 the skill rewrites it into design-first shape. Josh never reviews a working draft.
- **Pre-Gate-1 test:** a reader who has never seen the conversation must not be able to tell, from the body, that the design ever said anything different, or that any approval workflow exists.
- **Every design document carries a `## Both surfaces` section**, stating for each mechanism it designs how that mechanism works on each surface (Claude Code and agy/Antigravity). `deno task design:lint-doc` fails a document that omits it.

**Standard Document Shape:**
1. What it is — one section, opening directly with what the thing is. No status block, no preamble of any kind.
2. Revision history — when revising an existing document (`## Revision History` table with Version, Date, Epic / Issue, Summary).
3. The workflow.
4. The gates, and what the thing refuses to do.
5. The rules that shape its output.
6. Both surfaces — stating for each mechanism how it works on Claude Code and agy/Antigravity.
7. Load-bearing premises — proving every premise the design depends on.
8. Where things live; what stays out of scope.
9. Appendices — rules absorbed, what Josh asked for verbatim, the decision record.

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

