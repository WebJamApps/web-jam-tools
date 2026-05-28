---
name: drive-cleanup
description: Analyze Josh's Google Drive for duplicates, misplaced files, and phone-Sonnet-authored bridge files awaiting merge into the Dropbox-authoritative gemma/opus queues. Reports findings as a table, waits for explicit approval, then executes approved actions (including the cross-store bridge). Triggered automatically at session start and at 07:00 daily; can also be invoked manually with /drive-cleanup.
---

# drive-cleanup

A three-phase Drive housekeeper. **Always do all three phases in order. Never skip Phase 2 (approval). Never auto-execute without Josh's explicit yes.**

## Storage model (post-2026-05-21 migration)

Authoritative storage split:

- **Local Dropbox** (`/home/joshua/Dropbox/web-jam-llms/`, symlinked at `/home/joshua/WebJamApps/web-jam-llms/`): `gemma-tasks.txt`, `claude-opus-tasks.txt`, `SHARED.md`, `GEMMA.md`. The Coordinator (gemma4:26b) and Claude Code read these directly via local FS.
- **Local Dropbox** (`/home/joshua/Dropbox/joshandmariamusic/JoshMariaMusic/`): all venue deliverables — pitch templates, sent outreach, DRAFTs, research, project log, social copy. Authoritative since Task 42 migration 2026-05-21.
- **Local Dropbox** (`/home/joshua/Dropbox/joshandmariamusic/MariaParty/`): retired retirement-party docs (RSVP MASTER, Master Plan v2, Banner Decision, etc.). Project complete 2026-05-21 except for food scheduling — Sonnet has no involvement going forward.
- **Drive** (My Drive root): `claude-sonnet-tasks.txt` (phone Sonnet's own queue — Drive is authoritative). Phone Sonnet also drops cross-queue task contributions into Drive root using `for-gemma-<name>.txt` / `for-opus-<name>.txt` (or the older `<queue>-YYYY-MM-DD-HHMM.txt` pattern); drive-cleanup is the bridge that pulls them into Dropbox.
- **Drive** (`gdrive:JoshMariaMusic/`): READ-ONLY mirror of 4 Sonnet-readable files only — `Pitch Email – MidRange Cafe Bar.txt`, `Pitch Email – Originals Venues.txt`, `Pitch Email – Pub Festival Brewery.txt`, `Online Form Information Block.txt`. Dropbox-authoritative; drive-cleanup pushes Dropbox→Drive on every run so phone Sonnet always sees fresh templates.

The Drive originals of `gemma-tasks.txt`, `claude-opus-tasks.txt`, and `GEMMA.md` were trashed 2026-05-21 — they had no readers. The Drive `MariaParty/` folder was also trashed 2026-05-21 (project complete; no Sonnet involvement). Only `SHARED.md` and the 4-file JMM mirror remain as Drive snapshots — phone Sonnet consults them.

## Phase 1 — Analyze (read-only)

Use the `mcp__google-drive__*` tools. Check at minimum:

### A. My Drive root

- **Multiple files with the same name** — flag any duplicates. The canonical Drive-resident files should each appear EXACTLY ONCE:
  - `claude-sonnet-tasks.txt` (id `1ooDgwiatb66PGH40ae1KpRTb9WAvn-IZ`) — phone Sonnet's own queue (Drive **is** authoritative)
  - `SHARED.md` (id `1X48-YCTaYScEIEJNaD4__imsMfWwMoRr`) — Drive snapshot of the Dropbox authoritative copy; refreshed by drive-cleanup when needed
  - (Note: as of 2026-05-21 there are NO Drive copies of `claude-opus-tasks.txt`, `gemma-tasks.txt`, or `GEMMA.md` — those are Dropbox-only.)
- **Sonnet bridge files** awaiting merge into the Dropbox-authoritative queues:
  - `for-gemma-<name>.txt` → BRIDGE into `/home/joshua/Dropbox/web-jam-llms/gemma-tasks.txt`
  - `for-opus-<name>.txt` → BRIDGE into `/home/joshua/Dropbox/web-jam-llms/claude-opus-tasks.txt`
  - `gemma-tasks-<YYYY-MM-DD-HHMM>.txt` → same target as `for-gemma-*` (legacy naming)
  - `claude-opus-tasks-<YYYY-MM-DD-HHMM>.txt` → same target as `for-opus-*` (legacy naming)
- **Phone-Sonnet queue merges** (these stay on Drive — Sonnet's queue does not move):
  - `claude-sonnet-tasks-<YYYY-MM-DD-HHMM>.txt` → merge into canonical `claude-sonnet-tasks.txt` on Drive, then trash the timestamped file.
- **Misplaced deliverable artifacts** at root (pitch emails, drafts, EPK material) — should live in `JoshMariaMusic`, `CollegeLutheran`, or `MariaParty` per the file-placement rule.
- **Stray ephemeral files** (timestamped backups older than 7 days, log dumps) — flag for trash.
- **Allowed non-queue files at root (whitelist — DO NOT flag):**
  - `processed-*` files — legacy audit-trail leftovers from before 2026-05-27. New bridges are trashed, not renamed; existing `processed-*` files can be flagged for trash on a manual cleanup pass but should not be auto-actioned.
  - (`SHARED.md` is already covered in the canonical-files-at-root list above.)

### B. Project folders (CLAUDE, GEMMA, GEMINI, JoshMariaMusic, MariaParty, CollegeLutheran)

- Within-folder duplicates (same name).
- Files violating the file-placement rule (e.g., a deliverable artifact stuck in CLAUDE that should be in JoshMariaMusic).

### C. Task-queue health scan (BOTH queues)

**Always run this every invocation, even if there were no Drive-side bridges.** Scan BOTH local Dropbox queues:

- `~/Dropbox/web-jam-llms/claude-opus-tasks.txt`
- `~/Dropbox/web-jam-llms/gemma-tasks.txt`

For each queue:

1. **Numbering check (BOTH queues)** — extract every `Task N` header (case-insensitive, `^\s*task\s+\d+`) and verify they are at uniform step 5 starting from 0 (so `0, 5, 10, 15, ...`). If not, OR if there are duplicate task numbers (common after bridges from multiple source files each numbered `1, 2, 3`), surface a renumber-to-5 proposal as a Phase 2 finding. Also flag any typos in header lines (e.g. `Taslk N` instead of `Task N`) — fix them before renumbering, since the renumber script's regex requires `task` to match. Skip only if the queue has ≤2 tasks.
2. **Headline length check (OPUS QUEUE ONLY)** — for each task, count non-blank lines from its `Task N` header up to the next `Task M` header (or EOF). Any task with more than 3 non-blank body lines is a compression candidate. Surface as a Phase 2 finding: "compress N tasks (Task X, Task Y, ...) — extract bodies to memory files, leave one-line headlines + `[[task-spec-<slug>]]` cross-refs." Gemma's queue tasks tend to be short operational items that don't need compression, and the Coordinator doesn't use the memory system; do NOT compress gemma queue entries.

Surfacing these is mandatory — if all checks pass cleanly for a queue, say so in the Phase 2 report ("Opus queue: 12 tasks, all at step-5 numbering, all headline-sized — clean." / "Gemma queue: 8 tasks, all at step-5 numbering — clean."). Don't silently omit either queue.

### D. Out-of-scope (do NOT touch without explicit instruction)

- Any file in MariaParty marked protected: `MariaParty RSVP MASTER`, `MariaParty Master Plan v2`, `MariaParty Banner Decision`.
- Files Josh has explicitly named in a current task as "leave alone."
- `processed-*` files at root — legacy audit-trail files from before 2026-05-27. Don't auto-action; surface to Josh if a manual cleanup pass is wanted.

## Phase 2 — Report + await approval

Present findings as a clear table per category. Format:

```
| # | Issue | File(s) (with id) | Proposed action |
|---|---|---|---|
| 1 | Sonnet bridge file pending | for-gemma-cavendish-cleanup.txt (id X) | Append to Dropbox gemma-tasks.txt; verify; trash Drive original |
| 2 | Phone-Sonnet queue merge | claude-sonnet-tasks-2026-05-21-0830.txt (id Y) | Merge into canonical claude-sonnet-tasks.txt on Drive, trash timestamped file |
| 3 | Pitch email at root | "Floyd Country Store Pitch.txt" (id Z) | Move into JoshMariaMusic/ |
```

End with explicit prompt: **"Approve these actions? Reply yes / no / specific numbers (e.g., 1,3)."**

If Phase 1 found NOTHING, say exactly: `Drive is clean — no actions needed.` Do not proceed to Phase 3.

## Phase 3 — Execute (only after explicit approval)

### Bridge actions (`for-gemma-*.txt`, `for-opus-*.txt`, legacy `gemma-tasks-*.txt`, `claude-opus-tasks-*.txt`)

1. **Download** the source file content from Drive.
2. **Compute the next task number for each bridge.** Before writing, read the destination queue and find the highest existing `Task N` header. Then assign each bridge content a sequential `Task N+1:`, `Task N+2:`, ... (the renumber-to-5 pass later will normalize these to step 5, but they need SOME number now so the task structure is parseable). The bridge content typically has a line like `Task: <description>` — replace that with `Task <NN>: <description>` (keeping the description text). If the bridge has multiple `Task:` lines (e.g. `Task 1:`, `Task 2:`), increment for each.
3. **Append** to the corresponding local Dropbox queue with atomic-write semantics (write to `<target>.tmp`, fsync, `os.replace`):
   - `for-gemma-*` / `gemma-tasks-*-*.txt` → `/home/joshua/Dropbox/web-jam-llms/gemma-tasks.txt`
   - `for-opus-*` / `claude-opus-tasks-*-*.txt` → `/home/joshua/Dropbox/web-jam-llms/claude-opus-tasks.txt`
4. **Verify** the append landed: re-read the local file and confirm the appended bytes are present AND that the new `Task NN:` headers parse correctly. If verify fails, DO NOT trash the Drive original — leave it in place and flag the failure.
5. **Trash** the Drive original (move to Drive trash, recoverable for 30 days). The content is preserved in the Dropbox queue and in `bridge-log.md`; the Drive copy is no longer needed once the bridge succeeds. Josh's decision 2026-05-27 — keeps Drive root clean instead of accumulating `processed-*` files indefinitely.
6. **Append to `bridge-log.md`** at `/home/joshua/Dropbox/web-jam-llms/bridge-log.md`: timestamp (UTC), source filename, dest path, bytes appended, assigned task numbers, status (ok | failed-verify).
7. **Re-run the Phase 1.C opus-queue health scan** (renumber + compression) — bridging just added new tasks that may need compression and definitely shifted the numbering off step-5. The renumber+compress pass is what normalizes the queue back into shape.

(Drive snapshots of the gemma/opus queues no longer exist — see "Storage model" above — so there's no Drive-side refresh step for bridge actions. `SHARED.md` is the only Dropbox-source file with a Drive snapshot; if a bridge or rule change updates `/home/joshua/Dropbox/web-jam-llms/SHARED.md`, refresh the Drive snapshot via `rclone copy /home/joshua/Dropbox/web-jam-llms/SHARED.md gdrive: --update`.)

### Sonnet queue merges (`claude-sonnet-tasks-*.txt`)

Drive-only — Sonnet's queue does not move. Append to canonical `claude-sonnet-tasks.txt` on Drive, renumber tasks if needed, then trash the timestamped source.

### Sonnet re-uploads (same-name file at root that already exists in a project folder)

Phone Sonnet **cannot edit Drive files in place** — it has no write capability. When it wants to revise a file that lives in a project folder (e.g. `CLAUDE/Gig Promotion Strategy.md`, `JoshMariaMusic/Pitch Email – ...`), it uploads a fresh copy to Drive **root** because it also can't navigate into folders. So a same-name duplicate at Drive root next to an existing folder copy is the standard "Sonnet revised this file" signal, not a stray.

Workflow when detected:

1. Download both: the root copy AND the folder copy.
2. `diff` them to confirm the root copy is genuinely a revision (not an accidental re-upload of an older version).
3. If the root copy is newer/revised: use `mcp__google-drive__updateTextFile` against the FOLDER copy's file id, passing the root copy's content. This overwrites the in-folder file with the new content while preserving its file id (so any existing references to that id stay valid).
4. Re-download the folder copy and verify the bytes match the root copy.
5. Trash the root copy via `mcp__google-drive__deleteItem`.
6. If the diff shows the root copy is OLDER than the folder copy (rare — would mean Sonnet uploaded a stale revision), surface to Josh; don't overwrite. The folder copy is authoritative when it's newer.

Surface in Phase 2 as: `Sonnet re-upload of <filename>: root copy (modified <date>) vs folder copy (modified <date>) — propose update folder copy with root content + trash root.`

### Other actions

Moves / trashes / dedupes — use the appropriate Drive MCP tool. Verify high-stakes changes with a follow-up read.

### Queue renumber (Phase 1 surfacing → Phase 3 execute, added 2026-05-22)

If Phase 1 analysis spots a canonical queue with non-step-multiple task numbers (e.g. tasks numbered `2, 21, 22, 24, 27, 29, ...` — gaps from deletions or non-uniform spacing), surface a renumber-to-5 proposal as a Phase 2 finding. On approval, run:

```bash
# dry-run first (recommended)
~/WebJamApps/web-jam-tools/scripts/renumber-queue.py \
  --path ~/Dropbox/web-jam-llms/claude-opus-tasks.txt --dry-run

# apply after Josh approves the plan
~/WebJamApps/web-jam-tools/scripts/renumber-queue.py \
  --path ~/Dropbox/web-jam-llms/claude-opus-tasks.txt
```

`--model gemma4:26b` works too (resolves to the gemma-tasks.txt path). Step defaults to 5 starting at 0; pass `--step` / `--start` for other shapes. Atomic write under the hood (the script imports `gemma_cli.queue`, which uses `.tmp + os.replace`).

Surfacing rule: propose renumber when the queue has more than 2 tasks AND the existing numbers are not already at step `--step` starting at `--start`. Skip if Josh would have to renumber every single task for trivial reason (cosmetic; not worth churning Dropbox revision history daily).

**Scope:** the renumber utility only handles Dropbox-resident queues (`gemma-tasks.txt`, `claude-opus-tasks.txt`). **`claude-sonnet-tasks.txt` (on Drive) is intentionally out of scope** — would require an rclone download / renumber / upload roundtrip the script doesn't do. Josh's call 2026-05-22; revisit if Sonnet's queue ever ends up with messy numbering that's worth fixing.

**`claude-opus-tasks.txt` ONLY — headline compression pass (added 2026-05-22):** when renumbering the Opus queue, also compress long task bodies. Many Opus tasks are multi-paragraph specs Josh hand-wrote (Task 34 is ~30 lines, Task 35 has phases A-F, etc.) — they bloat the queue file and make scanning it tedious. The compression workflow:

1. For each task body with more than ~3 lines of detail, **save the full body to a memory file** at `~/.claude/projects/-home-joshua-WebJamApps-JaMmusic/memory/task_spec_<content-derived-slug>.md` with frontmatter type `project`. The slug derives from the task's CONTENT (e.g. `task_spec_elca_devotional_source_swap`), NOT its number — task numbers change with renumber, so number-based slugs go stale.
2. **Replace the task body in the queue with a one-line headline** plus a `[[task-spec-<slug>]]` cross-ref. Example before:
   ```text
   Task 21 (added 2026-05-16): Switch the daily CollegeLutheran devotional source from ELCA Prayer Ventures to a different ELCA resource. Current setup pulls from Prayer Ventures and stores day-N files in `My Drive/CollegeLutheran/devotional/PV_<YYYY-MM>/` (e.g. PV_2026-05 has day-01 through day-31). Josh wants to swap to another official ELCA resource.
   [+ several more paragraphs of detail]
   ```
   After:
   ```text
   Task 5 (added 2026-05-16): Swap CL daily devotional source from ELCA Prayer Ventures to another official ELCA resource. [[task-spec-elca-devotional-source-swap]]
   ```
3. The memory file holds the FULL details. When Josh later says "start Task 5", load `[[task-spec-elca-devotional-source-swap]]` first to recover context, then execute.
4. Add the memory file to `MEMORY.md` so it's loaded into context proactively when relevant (same pattern as project memories).

Skip compression for tasks already short (1-2 sentence headlines) — those are already in the desired shape.

Also: when Josh later asks to **delete a task**, leave the memory file in place. Memory files are history; only the queue entry goes away. (If a task spec becomes truly obsolete and Josh wants the memory pruned, that's a separate `/remember` cleanup.)

Apply this compression ONLY to `claude-opus-tasks.txt` — gemma's queue tasks tend to be short operational items that don't need compression, and gemma doesn't use the same memory system.

### Mirror refresh (always — runs unconditionally each invocation)

After Phase 3 actions complete (or even if there were none), refresh the read-only Drive snapshots of files Dropbox-side users edit but Sonnet reads phone-side:

```bash
# Cross-AI rules (SHARED.md): single file, infrequent change
rclone copy /home/joshua/Dropbox/web-jam-llms/SHARED.md gdrive: --update

# Venue-outreach mirror: 4 Sonnet-readable templates
rclone copy /home/joshua/Dropbox/joshandmariamusic/JoshMariaMusic/ gdrive:JoshMariaMusic/ \
  --include "Pitch Email – MidRange Cafe Bar.txt" \
  --include "Pitch Email – Originals Venues.txt" \
  --include "Pitch Email – Pub Festival Brewery.txt" \
  --include "Online Form Information Block.txt" \
  --update

# Venue booking master (Gig Booking Worksheet xlsx): Dropbox is the SOLE master.
# Push a read-only copy to Sonnet's Drive CLAUDE folder so the phone side sees
# current status. Sonnet/Gemini must NOT edit the Drive copy — to change a venue
# they leave a task for gemma, which writes the Dropbox master via
# update_venue_contact. (Replaces the old Drive→Dropbox `cp` sync, which ran the
# wrong direction and could clobber the master — removed 2026-05-28.)
rclone copy "/home/joshua/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx" gdrive:CLAUDE/ --update
```

`rclone --update` is a no-op when source and dest match modification time + size, so the refresh is cheap. If Josh has edited a template in Dropbox since the last drive-cleanup run, the next run pushes the update to Drive and phone Sonnet sees it on its next read.

**Do not push other files from `Dropbox/joshandmariamusic/JoshMariaMusic/`** — only the 4 Sonnet-readable templates above are mirrored. The rest stays Dropbox-only.

### Gig-progress summary (regenerate each run — never let it go stale)

After the xlsx mirror push above, REBUILD a short status digest from the master xlsx so phone Sonnet has a readable view of booking progress without parsing the raw sheet:

1. Read `/home/joshua/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx` (openpyxl, or the gemma-cli venue tools).
2. Build a brief digest: total venues; counts by campaign status (Sent / Followed-up / Confirmed / Passed / Not-contacted); the most recent CONFIRMED gigs with dates; recent PASSED venues; and any venues awaiting follow-up.
3. **Overwrite** `Gig Booking Status.md` in the Drive CLAUDE folder (`gdrive:CLAUDE/Gig Booking Status.md`) with that digest, stamped with the run timestamp.

Because it is **regenerated from the master on EVERY run** (session-start + daily 07:00 + manual), it cannot drift — it's always a fresh snapshot of the current xlsx, never a hand-maintained file that rots. Sonnet reads it for "where are we on bookings?" without touching the xlsx.

After all actions, post a short summary: what was done, what was declined, and any verify-failures that left files in their pre-action state. Include a "mirror: refreshed (or no-op)" line so Josh knows the templates are current, and a "gig status: rebuilt" line confirming the digest was regenerated from the xlsx.

## Hard rules

- **Never delete a canonical queue** — neither the Dropbox originals (`gemma-tasks.txt`, `claude-opus-tasks.txt`) nor `claude-sonnet-tasks.txt` on Drive.
- **Never delete `SHARED.md`** (Dropbox original or Drive snapshot) or `GEMMA.md` (Dropbox-only).
- **Bridge: verify before trash.** Never trash a Drive original until the Dropbox append is verified.
- **Bridge: trash, don't rename.** The pre-2026-05-27 convention was to rename to `processed-*` for an indefinite audit trail. Current convention: trash. The content lives in the Dropbox queue + `bridge-log.md`; Drive's 30-day trash window is enough recovery.
- **Never modify protected MariaParty files** without explicit Josh override.
- **When merging task files**, preserve task numbering. If two source files both have "Task 1," renumber sequentially in the destination.
- **Trash, don't permanently delete.** All deletes go to Drive trash so Josh can recover.

## Triggering

- Auto-runs at session start via the `SessionStart` hook in `~/.claude/settings.json`.
- Auto-runs at 07:00 ET daily via a scheduled routine (created with the `schedule` skill).
- Manual: invoke via the Skill tool or just type `/drive-cleanup`.

## See also

- `My Drive/CLAUDE/CLAUDE.md` — team structure, file placement rule, canonical queue IDs
- `/home/joshua/Dropbox/web-jam-llms/bridge-log.md` — append-only audit log of every bridge action
- Memory: `reference_ai_team_structure.md`, `reference_gemma_tasks_file.md`, `reference_claude_opus_tasks_file.md`, `reference_claude_sonnet_tasks_file.md`, `project_web_jam_llms_migration_plan.md`
