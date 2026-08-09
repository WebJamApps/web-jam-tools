---
name: issue-design
description: Design-then-issue-plan workflow prior to filing GitHub issues. Design work runs through this skill. Never dispatches (ends at "the issues exist").
metadata:
  version: v1
  publisher: josh
---

# /issue-design — design-then-issue-plan workflow prior to filing GitHub issues

`/issue-design` turns a problem into an approved design, and then into the right set of GitHub issues — the phase *before* filing. `/draft-issue` already owns filing a single issue and is unchanged.

Design work does not happen in plain chat. The moment a conversation turns into design — options, trade-offs, decisions worth recording — the session runs `/issue-design` and works inside it. That single rule is what lets the design machinery live in the skill instead of in memory, loading only when design is actually happening.

**ABSOLUTE STANDING RULE:** The skill **NEVER dispatches.** It ends at "the issues exist". It never spawns a build agent, hands work to a lane, starts a worktree, or runs `/next`.

---

## Workflow Phases

### Phase 1 — Design (Opus)

With no argument, the skill scans all 8 active repos for open issues labeled `Needs Design` and offers them as candidates. Josh picks; the skill never picks for him.

1. **Establish the theme and milestone.** `<Theme>` matches the GitHub milestone — read the live milestone list, never assume a fixed set. Create the design document at `~/Dropbox/web-jam-llms/<Theme>/<topic>-design-<YYYY-MM-DD>.md`, creating the theme folder if the milestone has none yet.
2. **Record what Josh asked for verbatim**, and the existing ground the work sits on.
3. **Put every decision to Josh one at a time** — options, real detail, a recommendation — and write his answer into the document as he gives it, never batched at the end. An item is decided only when he rules on THAT item by name.
4. **Verify facts rather than asserting them**, and record what was verified and how. Where a premise turns out to be false, say so in the document so it is not re-derived later.
5. **GATE 1 — stop.** Present the design and wait for Josh's explicit approval. No writes to GitHub before Gate 1.

### Phase 2 — The Issue Plan (Opus)

6. **Propose the plan table**, applying the epic heuristic and the Flash High size checklist:

   | # | Proposed title | Epic / child of | Model tier | Priority | Repo | Tests | Closes when |
   |---|---|---|---|---|---|---|---|

7. **Split out Josh's manual steps as pairs**, grouped by gate position in the dependency chain.
8. **Determine the dependency chain** across the planned issues and record it. Where an issue's deliverable is a pointer — "point X at Y" — the plan **names Y concretely**, because an unnamed target hides an ordering: if Y turns out to be something another planned issue creates, the two issues are not independent, and the implementer picks the target after the chain was already declared.
9. **List every `Needs Design` label change as its own named item** — each removal carrying its 4-part reason.
10. **GATE 2 — stop.** Present the plan and wait for Josh's explicit issue plan approval. No creating, editing, or labeling issues before Gate 2. Approving the plan table does not approve label removals; each is ruled on separately.

### Phase 3 — Filing (Sonnet subagent)

The subagent receives the approved plan table and the design document path. It files and reports; it builds nothing.

11. **File in plan order — the epic first, then each child** — invoking `/draft-issue` once per issue so the filing rules and their enforcing hook apply to every one. Attach each child to its parent as it goes; the ordering is forced by the parent/child link.
12. **Each body carries only scope, build mechanics and repo facts**, plus a pointer to the design document and the instruction to STOP if that path cannot be read. No requirement text is restated.
13. **Set the native Priority field** via GitHub MCP `issue_write` → `issue_fields`. (`gh` cannot set a native field).
14. **Apply the `Blocked` label AND the native dependency** to anything not yet startable — both signals, never one.
15. **If any issue fails to file, stop.** Report which issues exist and which do not, by repo + number + title. No silent retries, no carrying on with the rest.
16. **Update the design document's status line** to record what was filed.

---

## The Two Approval Gates

| Gate | The skill waits for | It must not, before that gate |
|---|---|---|
| 1 — design | Josh's explicit approval of the design document | write anything to any GitHub issue |
| 2 — plan | Josh's explicit approval of the issue plan table | create, edit or label any issue |

A third gate — dispatch — exists as a standing rule and is not this skill's to hold, because the skill never dispatches at all.

---

## What It Refuses to Do

These are properties of the skill, written as explicit refusals:

| It refuses to | Because |
|---|---|
| write anything to a GitHub issue before GATE 1 | the design gate is real or it is decoration |
| create, edit or label an issue before GATE 2 | the plan gate, likewise |
| post design content as an issue comment, ever | comments are not a temp location |
| restate requirement text in an issue body | one fact, one place; a paraphrase drifts immediately |
| remove a `Needs Design` label without an ask carrying its reason | only Josh can say a design is done |
| add `Needs Design` to anything in the approved executable set | it must not become a stub factory |
| put a manual step inside an agent's execution issue | manual steps get their own `Josh` issue |
| hand Josh a step with no script and no exact click path | anything an agent can produce, an agent produces |
| **dispatch — spawn a build agent, hand work to a lane, start a worktree, run `/next`** | absolute standing rule |
| offer dispatch as a next step in the same breath as reporting what it filed | same rule, quieter failure |

---

## How Issues Are Shaped

### Epic or Flat

Propose an **epic with children** when the work spans more than one repo, needs more than three issues, or has halves proved by different kinds of evidence. Otherwise propose a **flat set**, or a single issue.

Never propose an epic that is only a container. An epic carries the shared context its children point at and closes when its children close. If the only thing an epic would add is a title, the plan is a flat set.

The heuristic only proposes. The plan table is the gate, so a wrong call is caught there.

### Sized for Flash High

Non-epic issues default to **`Flash High`** as the implementation tier. An issue is Flash-High-sized when all of these hold:

- one repo;
- one layer — frontend or backend, not both;
- roughly eight files or fewer;
- no schema or data migration;
- acceptance criteria provable by running that repo's own test / lint / build commands.

Anything over the line is split into multiple issues, and **every split carries its dependencies** — the `Blocked` label and the native GitHub dependency both.

### Closeable, Always

Every issue must be closeable. A non-epic closes when its work is done; **an epic closes when its children close.** Epics are not implementable but they are closeable when their sub-issues are done. Perpetual trackers remain banned.

### Proved by Something

The `Tests` column states what proves each issue — unit tests, a Playwright e2e spec, a full-stack run, or none — and why. The skill proposes; Josh rules per issue at GATE 2. It never silently drops coverage and never forces it.

Where a repo has no working e2e stack, the skill says so plainly rather than proposing coverage that cannot run, and names the issue that would unblock it (for example, JaMmusic#1282 and JaMmusic#1283 blocked on Atlas test connection string).

Regression matters as much as the new feature, and a full-stack test must be runnable locally, not only in CircleCI.

---

## Josh's Manual Steps

Manual steps never live inside an agent's execution issue. They are **grouped by gate position** — steps needed before the same agent issue share one `Josh` issue; steps at different points in the chain are separate issues. A step that gates nothing is still its own issue.

**Every manual step is a pair:**

| | Issue A — the agent's | Issue B — Josh's |
|---|---|---|
| **Scriptable** | `Flash High`. Build `<path>` — one script Josh runs with one command. Deliverable-first, numbered list of what it does. Closes when the script merges. | `Josh` label. The exact command, from what directory, what success looks like — **and WHY he is running it**. Closes when he confirms he ran it. |
| **UI** | `Flash High`. Investigate the live UI and write the run instruction to `~/Dropbox/web-jam-llms/<Theme>/<topic>-josh-steps-<YYYY-MM-DD>.md` — exact click path, screen by screen, literal button and field names. Closes when the doc exists. | `Josh` label. **Points at** that path, never restates it, explains WHY, and says STOP if the path cannot be read. Closes when he confirms he did them. |

Issue B is always `Blocked` on issue A, with both the label and the native dependency. A step that can be neither scripted nor performed in a UI is the one case that is a lone `Josh` issue.

This replaces the old "Josh's run is an Epic checkbox" rule and `--part-of` convention for post-merge manual steps: a remaining manual step becomes its own issue, so the agent's PR closes the agent's issue normally.

---

## The `Needs Design` Label

**Finding.** With no argument the skill scans all 8 active repos for open `Needs Design` issues and offers them as candidates.

**Adding — automatic, inside one guard rail.** The skill may add the label to an existing issue too under-specified to plan against, and to a follow-up it knowingly defers to a later design run. It may never add it to anything in the approved plan's executable set. A deferred stub still needs exactly one model label to pass `hooks/require-model-label-on-issue-create.sh`, so it goes out as `Opus` + `Needs Design`.

**Removing — never automatic, and the ask carries its reason.** Only Josh can say that a design is completed or not. A removal ask has four parts, every time:

1. the issue, as `repo#number "title"`;
2. **why the design work that label asked for is now done** — naming the design document and the issues filed from it;
3. anything it did **not** resolve;
4. an actual question asking Josh to confirm.

The skill never asserts a design is complete. Wording like "design complete, removing the label" is a defect. Silence is not approval — an unruled item means the label stays. If Josh declines, the skill does not re-ask in the same run.

---

## Design Document Conventions

### Where Design Documents Live

```
~/Dropbox/web-jam-llms/<Theme>/<topic>-design-<YYYY-MM-DD>.md
```

`<Theme>` matches the GitHub milestone. Read the live milestone list from GitHub before creating. Create the theme folder if the milestone has none yet.

### Document Lifecycle & Reference Instructions

- **No automatic lifecycle.** The skill never archives, moves or deletes a design document, and neither does `/memory-cleanup`. Design documents are permanent until Josh deletes them. A missing design document is a normal state, not drift.
- **Instruction for issues pointing at doc.** Every issue pointing at a design document carries the instruction to **STOP and say so if the path cannot be read** — never to reconstruct requirements from the issue body, from comments, or from guesswork.

### Writing Style

- **The document states what the thing IS.** Present tense, design first. A reader who has never seen the conversation should be able to read it top to bottom and know what is being built.
- **The decision history goes in an appendix**, as one row per decision with its outcome — never interleaved with the design.
- **Never a bare label in the body.** No "per D-7" or "R-39"; labels exist so the decision table has stable row names, and nowhere else.
- **Josh's own words are preserved where they are load-bearing** — his ruling is the authority, and a paraphrase is weaker than his actual sentence.
- **Consolidation happens BEFORE Gate 1, never after.** During the conversation the document accretes as decisions are made. Before GATE 1 the skill rewrites it into design-first shape. Josh never reviews a working draft.

**Standard Document Shape:**
1. What it is — one section, no preamble.
2. The workflow.
3. The gates, and what the thing refuses to do.
4. The rules that shape its output.
5. Where things live; what stays out of scope.
6. Appendices — rules absorbed, what Josh asked for verbatim, the decision record.

---

## Which Model Runs What

| Phase | Tier | Why |
|---|---|---|
| Design | Opus | Judgment; it is the reason the skill exists |
| Filing | Sonnet subagent | Mechanical, but bodies must be self-contained and correctly cited |

Delegating filing to a cheaper tier is not "dispatch" in the prohibited sense: it is the skill doing its own job more cheaply, never handing the resulting issues to anyone to build.

---

## What Stays Out

- Building anything it designed.
- Maintaining dependency or `Blocked` state after filing — `/backlog-groom` is the maintainer of record for that drift.
- Tracking live priority after filing — native Priority field owns it.
- Archiving or deleting design documents — Josh alone.
