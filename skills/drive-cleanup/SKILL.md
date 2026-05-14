---
name: drive-cleanup
description: Analyze Josh's Google Drive for duplicates, misplaced files, and phone-authored task files awaiting merge. Reports findings as a table, waits for explicit approval, then executes approved actions. Triggered automatically at session start and at 07:00 daily; can also be invoked manually with /drive-cleanup.
---

# drive-cleanup

A three-phase Drive housekeeper. **Always do all three phases in order. Never skip Phase 2 (approval). Never auto-execute without Josh's explicit yes.**

## Phase 1 — Analyze (read-only)

Use the `mcp__google-drive__*` tools. Check at minimum:

### A. My Drive root

- **Multiple files with the same name** — flag any duplicates. The canonical task queues should each appear EXACTLY ONCE:
  - `gemma-tasks.txt` (id `15bfIDf4pJVEwbDIO4dMejLGg0hB-xFMP`) — laptop gemma's queue
  - `claude-opus-tasks.txt` (id `1Rz5yi81zy5ohwirUJsliF1KONIXUIQQL`) — laptop Opus's queue
  - `claude-app-tasks.txt` — phone Sonnet's own queue (Sonnet reads + executes from this)
- **Phone-authored task files** awaiting merge into the canonical queues:
  - `gemma-tasks-<YYYY-MM-DD-HHMM>.txt` → merge into canonical `gemma-tasks.txt`, then trash the timestamped file
  - `claude-app-tasks-<YYYY-MM-DD-HHMM>.txt` → merge into canonical `claude-app-tasks.txt`, then trash
- **Misplaced deliverable artifacts** at root (pitch emails, drafts, EPK material) — should live in `JoshMariaMusic`, `CollegeLutheran`, or `MariaParty` per the file-placement rule in `My Drive/CLAUDE/CLAUDE.md`.
- **Stray ephemeral files** (timestamped backups older than 7 days, log dumps, etc.) — flag for trash.

### B. Project folders (CLAUDE, GEMINI, JoshMariaMusic, MariaParty, CollegeLutheran)

- Within-folder duplicates (same name).
- Files violating the file-placement rule (e.g., a deliverable artifact stuck in CLAUDE that should be in JoshMariaMusic).

### C. Out-of-scope (do NOT touch without explicit instruction)

- Any file in MariaParty marked protected: `MariaParty RSVP MASTER`, `MariaParty Master Plan v2`, `MariaParty Banner Decision`.
- Files Josh has explicitly named in a current task as "leave alone."

## Phase 2 — Report + await approval

Present findings as a clear table per category. Format:

```
| # | Issue | File(s) (with id) | Proposed action |
|---|---|---|---|
| 1 | Duplicate gemma-tasks.txt | id A, id B | Merge B's tasks into A, trash B |
| 2 | Phone-authored task pending merge | gemma-tasks-2026-05-13-1941.txt (id X) | Merge into canonical gemma-tasks.txt, trash timestamped file |
| 3 | Pitch email at root | "Floyd Country Store Pitch.txt" (id Y) | Move into My Drive/JoshMariaMusic/ |
```

End with explicit prompt: **"Approve these actions? Reply yes / no / specific numbers (e.g., 1,3)."**

If Phase 1 found NOTHING, say exactly: `Drive is clean — no actions needed.` Do not proceed to Phase 3.

## Phase 3 — Execute (only after explicit approval)

For each approved action, use the appropriate Drive MCP tool. Verify high-stakes changes (canonical file edits) with a follow-up read. After all actions, post a short summary with what was done and which files (if any) Josh declined.

## Hard rules

- **Never delete the canonical task queues** (`gemma-tasks.txt` id `15bfIDf4dMejLGg0hB-xFMP`, `claude-opus-tasks.txt` id `1Rz5yi81zy5ohwirUJsliF1KONIXUIQQL`, `claude-app-tasks.txt`).
- **Never modify protected MariaParty files** (RSVP MASTER, Master Plan v2, Banner Decision) without explicit Josh override.
- **When merging phone-authored task files**, preserve task numbering carefully. If two source files both have "Task 1," renumber to be sequential in the destination.
- **Trash, don't permanently delete.** All deletes go to Drive trash so Josh can recover.

## Triggering

- Auto-runs at session start via the `SessionStart` hook in `~/.claude/settings.json`.
- Auto-runs at 07:00 ET daily via a scheduled routine (created with the `schedule` skill).
- Manual: invoke via the Skill tool or just type `/drive-cleanup`.

## See also

- `My Drive/CLAUDE/CLAUDE.md` — team structure, file placement rule, canonical queue IDs
- Memory: `reference_ai_team_structure.md`, `reference_gemma_tasks_file.md`, `reference_claude_opus_tasks_file.md`
