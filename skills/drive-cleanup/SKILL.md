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
  - `processed-*` files — bridge audit trail. Keep them.
  - (`SHARED.md` is already covered in the canonical-files-at-root list above.)

### B. Project folders (CLAUDE, GEMMA, GEMINI, JoshMariaMusic, MariaParty, CollegeLutheran)

- Within-folder duplicates (same name).
- Files violating the file-placement rule (e.g., a deliverable artifact stuck in CLAUDE that should be in JoshMariaMusic).

### C. Out-of-scope (do NOT touch without explicit instruction)

- Any file in MariaParty marked protected: `MariaParty RSVP MASTER`, `MariaParty Master Plan v2`, `MariaParty Banner Decision`.
- Files Josh has explicitly named in a current task as "leave alone."
- `processed-*` files at root — bridge audit trail; never delete.

## Phase 2 — Report + await approval

Present findings as a clear table per category. Format:

```
| # | Issue | File(s) (with id) | Proposed action |
|---|---|---|---|
| 1 | Sonnet bridge file pending | for-gemma-cavendish-cleanup.txt (id X) | Append to Dropbox gemma-tasks.txt; verify; rename Drive original to processed-2026-05-21-cavendish-cleanup.txt |
| 2 | Phone-Sonnet queue merge | claude-sonnet-tasks-2026-05-21-0830.txt (id Y) | Merge into canonical claude-sonnet-tasks.txt on Drive, trash timestamped file |
| 3 | Pitch email at root | "Floyd Country Store Pitch.txt" (id Z) | Move into JoshMariaMusic/ |
```

End with explicit prompt: **"Approve these actions? Reply yes / no / specific numbers (e.g., 1,3)."**

If Phase 1 found NOTHING, say exactly: `Drive is clean — no actions needed.` Do not proceed to Phase 3.

## Phase 3 — Execute (only after explicit approval)

### Bridge actions (`for-gemma-*.txt`, `for-opus-*.txt`, legacy `gemma-tasks-*.txt`, `claude-opus-tasks-*.txt`)

1. **Download** the source file content from Drive.
2. **Append** to the corresponding local Dropbox queue with atomic-write semantics (write to `<target>.tmp`, fsync, `os.replace`):
   - `for-gemma-*` / `gemma-tasks-*-*.txt` → `/home/joshua/Dropbox/web-jam-llms/gemma-tasks.txt`
   - `for-opus-*` / `claude-opus-tasks-*-*.txt` → `/home/joshua/Dropbox/web-jam-llms/claude-opus-tasks.txt`
3. **Verify** the append landed: re-read the local file and confirm the appended bytes are present. If verify fails, DO NOT rename the Drive original — leave it in place and flag the failure.
4. **Rename** the Drive original to `processed-YYYY-MM-DD-<short-name>.txt` (today's date). DO NOT trash. The rename IS the audit trail and lets Josh recover Sonnet's original input if anything goes wrong downstream.
5. **Append to `bridge-log.md`** at `/home/joshua/Dropbox/web-jam-llms/bridge-log.md`: timestamp (UTC), source filename, dest path, bytes appended, status (ok | failed-verify).

(Drive snapshots of the gemma/opus queues no longer exist — see "Storage model" above — so there's no Drive-side refresh step for bridge actions. `SHARED.md` is the only Dropbox-source file with a Drive snapshot; if a bridge or rule change updates `/home/joshua/Dropbox/web-jam-llms/SHARED.md`, refresh the Drive snapshot via `rclone copy /home/joshua/Dropbox/web-jam-llms/SHARED.md gdrive: --update`.)

### Sonnet queue merges (`claude-sonnet-tasks-*.txt`)

Drive-only — Sonnet's queue does not move. Append to canonical `claude-sonnet-tasks.txt` on Drive, renumber tasks if needed, then trash the timestamped source.

### Other actions

Moves / trashes / dedupes — use the appropriate Drive MCP tool. Verify high-stakes changes with a follow-up read.

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
```

`rclone --update` is a no-op when source and dest match modification time + size, so the refresh is cheap. If Josh has edited a template in Dropbox since the last drive-cleanup run, the next run pushes the update to Drive and phone Sonnet sees it on its next read.

**Do not push other files from `Dropbox/joshandmariamusic/JoshMariaMusic/`** — only the 4 Sonnet-readable templates above are mirrored. The rest stays Dropbox-only.

After all actions, post a short summary: what was done, what was declined, and any verify-failures that left files in their pre-action state. Include a "mirror: refreshed (or no-op)" line so Josh knows the templates are current.

## Hard rules

- **Never delete a canonical queue** — neither the Dropbox originals (`gemma-tasks.txt`, `claude-opus-tasks.txt`) nor `claude-sonnet-tasks.txt` on Drive.
- **Never delete `SHARED.md`** (Dropbox original or Drive snapshot) or `GEMMA.md` (Dropbox-only).
- **Bridge: verify before rename.** Never rename a Drive original to `processed-*` until the Dropbox append is verified.
- **Bridge: keep `processed-*` originals forever.** They are recoverable history.
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
