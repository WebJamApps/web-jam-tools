# Josh's AI Team Playbook

*For Josh. Last updated 2026-06-27. Covers the current team, what each member is best at, how workflows hand off between them, and where Josh approves.*

---

## The team

Think of it as a small scrum team: one Product Owner (Josh), several specialist AI tiers that handle work in their lane, and a future System Architect (Fable, not yet GA). Josh approves at the checkpoints; the AIs deliver the work between them.

**GitHub issues are model-labeled** (`Haiku` / `Sonnet` / `Opus` / `Flash`) to route each issue to the right tier.

| # | Member | Where | Role | Best at | Task queue |
|---|--------|-------|------|---------|------------|
| 1 | **Josh** | Everywhere | Product Owner | Decisions, approvals, sending the actual emails, talking to venues, final say on every workflow checkpoint | — |
| 2 | **Fable** *(Claude Code)* | Laptop *(planned — not yet GA)* | System Architect | Requirements discussion, specs, GitHub issue writing. Never execution work a cheaper model could handle. | `claude-fable-tasks.txt` |
| 3 | **Opus** *(Claude Code)* | Laptop | Judgment / Tech Lead | Deciding what to do, multi-file design and architecture, reviewing subagent output, conversations with Josh. Not for mechanical work — hand that to Haiku or Sonnet. | `claude-opus-tasks.txt` |
| 4 | **Sonnet** *(Claude Code subagent)* | Laptop | Coder | Ordinary contained coding — a fix or feature across a few files, writing tests, light refactors. | *(issued via GitHub label)* |
| 5 | **Haiku** *(Claude Code subagent)* | Laptop | Mechanic | Lookups, web research, scans, single-file/single-field edits, typo & data fixes, running tests/builds + reporting, screenshots. | *(issued via GitHub label)* |
| 6 | **Flash** *(Gemini 3.5 Medium via agy/Antigravity)* | Laptop | Frontend / General agy | Frontend and UI coding (notably strong at it) + general agy lane. **Paid** on Josh's Google billing — a separate budget that spares the Anthropic budget. Invoked via `/next`. | `agy-tasks.txt` |
| 7 | **Claude Mobile** *(Sonnet)* | Phone (Claude Android app) | Mobile Strategist | On-the-go reading of any Drive file, thoughtful drafting, planning. Drops task files at Drive root for the laptop to pick up. | `claude-sonnet-tasks.txt` |
| 8 | **Gemini Mobile** | Phone (Gemini app) | Field Assistant | Voice Q&A, Calendar/Tasks entries, Maps, Hotels/Flights lookups, capturing notes during a venue phone call. Not agentic. | — |

### How work flows

1. A task originates from Josh — either typed at the laptop, dropped via phone (Claude Mobile or Gemini Mobile), or surfaced by `/drive-cleanup` or `/memory-cleanup`.
2. Josh (or an AI on Josh's behalf) writes it up as a GitHub issue and applies the model-tier label (`Haiku` / `Sonnet` / `Opus` / `Flash`) that should execute it.
3. If it came from the phone, Claude Mobile drops a task file at Drive root (`for-opus-<name>.txt` or `for-agy-<name>.txt`). Next laptop session, `/drive-cleanup` picks it up, appends it to the Dropbox-resident canonical queue, then renames the Drive original to `processed-YYYY-MM-DD-<name>.txt`.
4. The owning tier executes the issue. **Coding tasks always end with a draft PR** — base branch `dev`, `Closes #N` baked into the body, created as a draft so Josh controls when it's ready for review. Josh alone flips draft → ready and merges.
5. Josh approves at the checkpoints listed in the [Human-in-the-loop](#human-in-the-loop--where-josh-approves) section. Only then does the task close and the next one start.

### Standing rules

- **Josh handles all venue contact.** No AI emails or calls a venue directly.
- **Reviews are lean, not rewrites.** When Opus reviews a draft, the job is to flag specific issues — not redo the work.
- **Phone apps drop only at Drive root.** They can't target a folder. Cleanup is the laptop's job via `/drive-cleanup`.
- **Always delegate to the cheapest model that can do the job.** Haiku for mechanical one-offs, Sonnet for ordinary coding, Flash for frontend/UI, Opus for judgment and design only. Spending Opus tokens on mechanical work wastes the Anthropic budget.

---

## Phone apps — quick comparison

Use both phone apps as **readers and voice-chat assistants**, not as file-managers. Claude Mobile handles thoughtful drafting; Gemini Mobile handles voice lookups, calendar/task entries, and field notes during phone calls.

| Job | Claude Mobile | Gemini Mobile |
|-----|--------------|---------------|
| Read a Drive file, ask questions about it | ✓ Best | ✓ Good |
| Thoughtful drafting (pitch emails, careful text) | ✓ Best | ~ OK, lower quality |
| Quick voice Q&A and web lookups | ✓ Good | ✓ Best |
| Create a Calendar event quickly | ~ Works in chat | ✓ Best (built-in) |
| Create a Google Task | ~ Awkward | ✓ Best (built-in) |
| Capture voice notes during a phone call | ✓ Good | ✓ Best (Field Assistant) |
| "Execute a list of tasks from a file" | ~ Reads + can do some steps | ✗ Will not execute — only summarizes |
| Modify, move, or delete existing Drive files | ✗ Can't (scope wall) | ✗ Can't (scope wall) |
| Save a new file to a specific Drive folder | ✗ Lands in root only | ✗ Lands in root only (if at all) |

---

## Claude Mobile — how to use it well

### What it CAN do well

- ✓ **Read any file in your Drive** — any folder, any size
- ✓ **Voice-in → text-out conversations**
- ✓ **Summarize, extract, compare** — great for "tell me about this doc"
- ✓ **Thoughtful drafting** — pitch emails, careful text. Better than Gemini Mobile for this.
- ✓ **Brainstorm and think out loud** — no files needed

### What it CANNOT do (don't ask)

- ✗ Modify any existing file in your Drive
- ✗ Move files into folders
- ✗ Delete files / move to trash
- ✗ Save files anywhere except Drive root

### Good voice prompts

- "Read my MariaParty Master Plan and tell me the confirmed headcount."
- "Read the OMINE Productions pitch and tell me if it's too formal."
- "Look at my Floyd Country Store pitch — does it use any banned words?"
- "Draft a short follow-up email to Mike at Floyd Country Store and read it back to me."

### Avoid

- "Save a draft of…" / "Create a file with…" → goes to Drive root. Not the end of the world — `/drive-cleanup` on the laptop will offer to move or merge it next session — but ideally keep the draft in chat and redo from the laptop.
- "Update the Master Plan to…" → can't update; will create a duplicate
- "Move this file to the JoshMariaMusic folder…" → cannot do
- "Delete that old V3 RSVP file…" → cannot do

### The one supported way to "save" from Claude Mobile

Drop a task file at Drive root using one of these naming conventions:

- **For Opus** (laptop): `for-opus-<name>.txt` (preferred) or legacy `claude-opus-tasks-YYYY-MM-DD-HHMM.txt`
- **For agy/Flash** (laptop): `for-agy-<name>.txt`

The team flow above (step 3) handles the merge into the Dropbox-resident canonical queue and renames the Drive original to `processed-*`.

---

## Gemini Mobile — how to use it well

### What it CAN do well

- ✓ **Read Drive files** — summarization and Q&A
- ✓ **Create Google Calendar events** — best mobile tool for this
- ✓ **Create Google Tasks** — best mobile tool for this
- ✓ **Voice input + voice chat**
- ✓ **Quick web lookups, Maps, Hotels, Flights** — built-in
- ✓ **Capture notes during a venue phone call** (Field Assistant role)

### What it CANNOT do (don't ask)

- ✗ **"Execute" tasks listed inside a file** — will only summarize file content, won't treat it as a command queue.
- ✗ Modify, move, or delete existing Drive files (same OAuth wall as Claude Mobile)
- ✗ Reliably save new files to Drive in a specific folder
- ✗ Thoughtful long-form drafting — quality is lower than Claude Mobile; use Claude for that

### Good voice prompts

- "Add a 2pm Friday calendar event to call Floyd Country Store."
- "Add a Google Task: pick up banner from Salem CVS."
- "Summarize my MariaParty Master Plan."
- "Take notes: Mike at Floyd said yes for late June, follow up Tuesday."
- "Driving directions from here to Floyd Country Store."

---

## `/drive-cleanup` — what it covers

Triggered manually (`/drive-cleanup` in any Claude Code session) or by the session-start reminder. Phase 1 runs on a Haiku subagent (read-only). Checks for:

- Duplicate files (same name appearing twice)
- **Claude Mobile bridge files** at Drive root (`for-opus-*.txt` / `for-agy-*.txt` / legacy timestamped variants) — these get appended to the Dropbox-resident canonical queue; the Drive original is renamed to `processed-YYYY-MM-DD-<name>.txt` (kept forever as audit trail)
- Misplaced deliverable artifacts at Drive root that should live in `JoshMariaMusic` or `CollegeLutheran`
- Stray ephemeral files (old timestamped backups, log dumps)
- Files in the `Misc/` folder older than 90 days (flagged for review)

**Mirror refresh** — on every run, `/drive-cleanup` also pushes the current Dropbox `SHARED.md` back to Drive via rclone. Cheap no-op when nothing has changed; pushes updates when you've edited a template in VS Code so phone Sonnet sees the fresh copy on its next read.

**Never touched without explicit override:** the canonical task queues (`claude-sonnet-tasks.txt` on Drive; `claude-opus-tasks.txt` and `agy-tasks.txt` in Dropbox), `SHARED.md`. `processed-*` files are kept forever as the bridge audit trail.

---

## `/memory-cleanup` — what it covers

Triggered manually (`/memory-cleanup` in any Claude Code session) or by the session-start reminder. Phase 1 runs on a Haiku subagent (read-only). Checks for:

- Stale project memories (issue/PR closed; flag for delete or condense)
- Dangling `[[links]]` (target slug has no matching memory file)
- MEMORY.md index lines that don't match their files
- Outdated or contradicted lines in `SHARED.md` / `GEMMA.md`
- Task-queue lines referencing closed issues or merged PRs

Approval flow: findings table → Josh approves selectively → execute.

---

## Human in the loop — where Josh approves

Several workflows are built around **Josh approving each step** before the next one runs. This is by design — the AIs propose, Josh disposes. Knowing the approval points helps you spot when something is waiting on you.

| Workflow | Where you approve | What you're saying yes/no to |
|----------|------------------|------------------------------|
| `/drive-cleanup` | Phase 2 (after the findings table, before any execution) | Which proposed file moves / merges / trashings actually happen. Reply `yes`, `no`, or specific numbers (e.g. `1,3`). |
| `/memory-cleanup` | Phase 2 (after the findings table, before any execution) | Which stale memories / queue lines to update or remove. Reply `yes`, `no`, or specific numbers. |
| Task-file workflow (Opus / agy queues) | After each task is reported back — before the AI moves to the next task or removes the task from the queue | Whether the result is correct and whether the task can be deleted from the queue. "Looks good" / "approve and remove" greenlights the next one. |
| GitHub coding tasks | At the draft-PR checkpoint | Whether the PR body is correct and the branch is ready to flip from draft to ready. Josh merges; no AI self-merges. |
| Multistep plans in Claude Code | At each logical checkpoint — not just at the end | Whether the next step should run. "Green light" means start the next step, not run the entire batch unattended. |
| Pitch emails / venue outreach | Before any email is actually sent | The exact wording, recipient, and whether it goes out at all. AIs draft — you send. |
| Risky git operations (push, force-push, `reset --hard`, branch deletes) | Before Claude Code runs the command | Whether the destructive / shared-state action proceeds. Approval for one push is not approval for all pushes. |
| `/code-review ultra` (multi-agent cloud PR review) | Triggering it at all | Only you can launch it — it's billed and Claude Code can't self-trigger. Use it when a PR is worth the spend. |
| MariaParty protected files (RSVP MASTER, Master Plan v2, Banner Decision) | Before any edit | Explicit override required — default behavior is "do not touch." |
| Memory writes that would override prior guidance | When the AI flags a contradiction with an existing memory record | Whether the new info supersedes the old or both should coexist. |

### What "approve" sounds like

- `yes` — proceed with all proposed actions
- `no` — cancel everything in this batch
- `1,3` — do items 1 and 3 only
- `looks good` / `approve` — greenlight the next step in a task-file workflow
- `hold on` / `wait` — pause; don't move forward yet

### What an AI should be doing while waiting on you

- Nothing. The pause is the point.
- Specifically: not running the next task, not "going ahead and just" doing the related cleanup, not pre-emptively starting the follow-up.

---

## Quick decision tree

| If you need to… | Use… |
|----------------|------|
| Ask a question about a Drive file | Claude Mobile (or Gemini for a quick read) |
| Add a calendar event from voice | Gemini Mobile |
| Add a Google Task from voice | Gemini Mobile |
| Draft a pitch email or careful text | Claude Mobile (then review later from laptop) |
| Take notes during a venue phone call | Gemini Mobile |
| Frontend / UI coding task | **Flash** (agy/Antigravity) via `/next` |
| Ordinary contained coding task | **Sonnet** subagent (via Opus) |
| Mechanical one-off (lookup, data fix, typo, scan) | **Haiku** subagent (via Opus) |
| Design, architecture, multi-file judgment | **Opus** (Claude Code) |
| Modify, move, or delete a Drive file | Claude Code on laptop (Drive MCP) or the web Drive app |
| Save something into a Drive folder | Don't do this on phone — use the laptop |

---

## Why phone apps are limited

Both the Claude Android app and the Gemini app use conservative Google Drive OAuth scopes: they can read files and create new ones, but cannot modify, move, or delete — these limits are set by Anthropic and Google respectively and cannot be elevated. Gemini Mobile additionally is not *agentic*: even when it reads a task list from a file, it summarizes the contents instead of treating them as a queue of actions. That's why agentic work and file management belong on the laptop.
