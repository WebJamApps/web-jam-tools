---
name: memory-cleanup
description: Cross-agent memory hygiene audit. Scans every memory surface across all of Josh's agents (Claude Code per-project + shared memory, the global and per-repo CLAUDE.md/AGENTS.md, the cross-AI SHARED.md/GEMMA.md/task queues, bridge-log, handle-gmails rules, and Google Drive memory/bridge files) for staleness, dangling [[links]], index↔file drift, and entries whose tracked issue/PR has closed. The read-only scan runs on a cheap Haiku subagent; findings are reported as a table and the skill WAITS for Josh's explicit approval before executing any fix. Edits ONLY the files in the surfaces table — never code. Triggered when Josh types /memory-cleanup or says "clean up memory", or when a session-start reminder notes it hasn't run today. Reminder-only — never auto-runs.
---

# memory-cleanup

A three-phase memory housekeeper for Josh's multi-agent workspace. **Always do all
three phases in order. Never skip Phase 2 (approval). Never auto-execute without
Josh's explicit yes.** The skill is invoked manually; the session-start hook only
*reminds* — it never runs the skill.

Master copy: `skills/memory-cleanup/SKILL.md` in `web-jam-tools`. Installed locally
as a file-level symlink at `~/.claude/skills/memory-cleanup/SKILL.md`. Runtime state
(the stamp file) lives in the local dir, NOT the repo tree.

**Stamp file:** `~/.claude/skills/memory-cleanup/last-run.txt` — one ISO date,
written only after an approved run completes (even if zero actions were approved,
so the reminder clears for the day).

## Why this exists

Memories go stale across agents (Claude Code, Gemma, agy/Antigravity, phone Sonnet).
Finished work keeps generating session-start reminders; queue lines outlive their PRs;
`GEMMA.md` accretes append-only cruft; MEMORY.md index lines drift from their files.
This skill is the periodic sweep that catches what the per-session
completion-reflection rule misses.

## Hard guard

The skill edits **ONLY** files in the surfaces table below — memory files, their
MEMORY.md indexes, the cross-AI markdown/queues, the handle-gmails rules, and the
two standing-rule files. It NEVER edits code, config, or anything else in a repo,
even if a finding seems to point there. Out-of-scope findings are reported as notes,
not actioned.

---

## Phase 1 — Scan (read-only, on a Haiku subagent)

Spawn the scan as a **Haiku subagent** via the Agent tool (`subagent_type: "Explore"`
or `general-purpose`, `model: "haiku"`) so cost stays minimal regardless of the
parent session's model. The subagent does read-only work only: it reads files,
runs `gh issue view <n>` / `gh pr view <n>` for closure checks, and returns the
findings table as text. **It must not write, edit, or delete anything.**

Give the subagent this surfaces list and the staleness policy. It reports, for every
finding: `surface | entry | finding | proposed action (keep / update / merge / delete)`.

**Command discipline (so the scan never triggers permission prompts):** the subagent
must use the dedicated Read / Glob / Grep tools for all file inspection — not Bash
equivalents. Bash is allowed only as single, simple commands that match Josh's
standing allowlist: `ls …`, `cat …`, `grep …`, `gh issue view …`, `gh pr view …`.
Never use compound or ad-hoc Bash: no `cd … && …` chains, no `for`/`while` loops,
no `;`-chained commands, no inline `python3 -c`/`node -e`, no heredocs. If a check
seems to need a loop, run the simple command once per target instead, or do it with
Read/Glob/Grep. Pass this paragraph to the subagent verbatim in its prompt.

### Surfaces to audit (11)

| # | Surface | Checks |
|---|---------|--------|
| 1 | `~/.claude/projects/*/memory/*.md` + each `MEMORY.md` | typed staleness (policy below); dangling `[[links]]` (target slug has no matching file); index↔file sync (orphan index lines pointing at missing files, files with no index line); any `MEMORY.md` >~15 lines → propose merges |
| 2 | `~/.claude/CLAUDE.md` (global) | contradictions with memories; rules superseded by newer decisions |
| 3 | per-repo `CLAUDE.md` (discover under `~/WebJamApps/*/`) | same as #2 |
| 4 | per-repo `AGENTS.md` (under `~/WebJamApps/*/`) | same; also flag any leftover `GEMINI.md` files (renamed → AGENTS.md June 2026) |
| 5 | `~/Dropbox/web-jam-llms/SHARED.md` | cross-AI rules: contradictions, superseded entries |
| 6 | `~/Dropbox/web-jam-llms/GEMMA.md` | append-only timestamped lines; flag any >60 days old or contradicting SHARED.md |
| 7 | `~/Dropbox/web-jam-llms/{agy,claude-opus,claude-fable,gemma}-tasks.txt` | any line referencing a closed issue / merged PR → propose removal |
| 8 | `~/Dropbox/web-jam-llms/bridge-log.md` | bridge items merged but unlogged (or logged-but-still-pending) |
| 9 | Google Drive memory/bridge files | **FLAG only** — defer execution to `/drive-cleanup`. Do not duplicate its bridge logic. |
| 10 | `~/.claude/skills/handle-gmails/rules.yaml` | rules referencing senders not seen recently (note for Josh; low confidence) |
| 11 | `~/.claude/shared-memory/*.md` + its `MEMORY.md` | same typed staleness as #1 |

### Staleness policy by memory type (frontmatter `metadata.type`)

- **`user` / `feedback`** — never age out. Flag only when contradicted or superseded
  by a newer memory or rule.
- **`project`** — flag if untouched ~30 days. If its issue/PR is closed (check via
  `gh`), propose delete or condense to a one-line "done" note.
- **`reference`** — verify the pointer every run: is the linked issue still open? does
  the path/URL still exist? Flag dead pointers.
- **Untyped files** (`SHARED.md`, `GEMMA.md`, the queues) — use the per-row rules in
  the table above.

Closure checks: `gh issue view <n> --json state` and `gh pr view <n> --json state`.
A `CLOSED`/`MERGED` state on an issue/PR that a memory or queue line still tracks is a
delete/condense candidate.

---

## Phase 2 — Report + await approval

Present the subagent's findings as a single table to Josh, grouped or numbered so he
can approve selectively:

```
| # | Surface | Entry | Finding | Proposed action |
|---|---|---|---|---|
| 1 | project memory (web-jam-back) | facebook-feed.md | issue #797 merged 3 days ago | delete file + its MEMORY.md line |
| 2 | shared MEMORY.md | 17 lines | over ~15-line budget | merge stack + circleci notes |
| 3 | opus queue | "Task 35 — #43 handle-gemini" | PR #44 merged | remove line |
| 4 | GEMMA.md | line dated 2026-03-30 | >60 days old | archive/remove |
| 5 | Drive | for-opus-foo.txt | bridge pending | (note) hand to /drive-cleanup |
```

If a surface is clean, say so explicitly (don't silently omit it) — Josh should see
all 11 were checked. Then **STOP and wait for explicit approval.** Accept "yes",
"do 1,3,4", "all but 2", etc. Never execute an unapproved row.

---

## Phase 3 — Execute (in the parent session)

Only after approval, and only for approved rows:

1. Apply each edit/delete in the parent session (the subagent never writes).
2. **Keep indexes in sync:** when you delete or rename a memory file, remove or update
   its `MEMORY.md` index line in the same dir. When you merge memories, update the
   index lines to match.
3. **Surface #9 (Drive):** never act here — just confirm it was handed to
   `/drive-cleanup` (or remind Josh to run it).
4. Write today's ISO date to `~/.claude/skills/memory-cleanup/last-run.txt`.
5. Post a short summary: what was changed, what was declined, anything left for
   `/drive-cleanup`.

## Hard rules

- **Approval-gated.** No writes happen before Phase 2 approval. The scan is read-only.
- **Edits only the surfaces table.** Never code, never other repo files.
- **Index↔file together.** Never leave a `MEMORY.md` line pointing at a deleted file,
  or a file with no index line.
- **Drive is flag-only.** Defer all Drive execution to `/drive-cleanup`; no duplicate
  bridge logic here.
- **Never delete a canonical queue or SHARED.md / GEMMA.md file** — only prune stale
  *lines* within them.
- **`user` / `feedback` memories never age out** — touch them only on a clear
  contradiction Josh confirms.
- **Stamp on every approved run**, even a zero-action one, so the daily reminder clears.

## Triggering

- Manual: type `/memory-cleanup`, or say "clean up memory" / "memory hygiene".
- A SessionStart-hook reminder ("Memory cleanup hasn't run today …") — Josh may say
  "go" / "yes". The hook **never** auto-runs the skill; Josh starts it.

## See also

- `skills/memory-cleanup/README.md` — Obsidian vault setup + agent-safety rules for
  hand-editing memory files.
- `~/.claude/CLAUDE.md` + `~/Dropbox/web-jam-llms/SHARED.md` — the two standing rules
  (completion-reflection; save-redirection during dispatch) this sweep backstops.
- `/drive-cleanup` — owns all Google Drive execution (surface #9 defers to it).
- `scripts/backup-claude-memory.sh` — what protects these memory surfaces.
