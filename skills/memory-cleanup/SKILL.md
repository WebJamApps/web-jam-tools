---
name: memory-cleanup
description: Cross-agent memory hygiene audit. Scans every memory surface across all of Josh's agents (Claude Code per-project + shared memory, global and per-repo CLAUDE.md/AGENTS.md, cross-AI rules doc/task queues, bridge-log, handle-gmails rules, Google Drive memory/bridge files, hooks.json, and brain scratch files) for staleness, dangling [[links]], index↔file drift, and entries whose tracked issue/PR has closed. The read-only scan runs on a cheap subagent (Haiku / Flash); findings are reported as separate action/flag tables and the skill WAITS for Josh's explicit approval before executing any fix. Edits ONLY the files in the surfaces table — never code. Triggered when Josh types /memory-cleanup or says "clean up memory", or when a session-start reminder notes it hasn't run today. Reminder-only — never auto-runs.
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

Memories go stale across agents (Claude Code, agy/Antigravity, phone Sonnet).
Finished work keeps generating session-start reminders; queue lines outlive their PRs;
MEMORY.md index lines drift from their files.
This skill is the periodic sweep that catches what the per-session
completion-reflection rule misses.

## Hard guard

The skill edits **ONLY** files in the surfaces table below — memory files, their
MEMORY.md indexes, the cross-AI markdown/queues, the handle-gmails rules, and the
standing-rule files. It NEVER edits code, config, or anything else in a repo,
even if a finding seems to point there. Out-of-scope findings are reported as notes,
not actioned.

---

## Phase 1 — Scan (read-only, on a Haiku or Flash subagent)

Spawn the scan as a cheap subagent based on the host surface:
- **Claude Code surface:** Spawn via `Agent(subagent_type: "Explore", model: "haiku")`.
- **Antigravity (`agy`) surface:** Spawn via `invoke_subagent(TypeName: "self", Role: "Memory Cleanup Scanner", Model: "flash")` (or `"flash_lite"`).

The subagent does read-only work only: it reads files, checks issue/PR status (`gh issue view <n>`, `gh pr view <n>`), verifies git commit dates (`git log -1 --format=%ad --date=short -- <file>`), performs dangling-link slug diffs, and returns findings. **It must not write, edit, or delete anything.**

Give the subagent this surfaces list and the staleness policy.

**Command discipline & Evidence requirements:**
1. The subagent must use dedicated Read / Glob / Grep tools for file inspection. Bash is allowed only as single, simple allowed commands (`ls`, `cat`, `grep`, `gh issue view`, `gh pr view`, `git log`). Never use compound or ad-hoc Bash (`cd ... && ...`, loops, `;` chains, inline python/node).
2. **Empirical Evidence Requirement:** Staleness claims for any repo file MUST execute `git log -1 --format=%ad --date=short -- <file>` to verify actual commit age. Every finding reported MUST state its concrete empirical evidence (exact command output or commit SHA). Findings lacking empirical evidence MUST be omitted.
3. **Reproducible Clean Verdicts:** Reporting a surface as clean requires stating the exact command/computation executed to verify clean state.
4. **Reproducible Dangling-Link Slug Diff:** Collect all `[[slug]]` targets referenced across memory files, compute the set diff against actual `<slug>.md` filenames in the target directory, and report any missing target slugs.
5. **Inbound Link Protection:** Before proposing a `delete` or `merge` for a memory file, perform a mandatory grep for inbound `[[slug]]` references across memory dirs (`~/.claude/projects/*/memory/`, `~/.claude/shared-memory/`) and `CLAUDE.md`/`AGENTS.md` files. Report the inbound link count in the findings table. Pair any deletion or merge with a preservation edit that folds surviving facts into a linked memory that remains.

### Surfaces to audit (12)

| # | Surface | Checks |
|---|---------|--------|
| 1 | `~/.claude/projects/*/memory/*.md` + each `MEMORY.md` | typed staleness; inbound link grep before propose; dangling `[[links]]` (slug diff); index↔file sync; `MEMORY.md` with >15 indexed files → propose merges (excluding `user`/`feedback`) |
| 2 | `~/.claude/CLAUDE.md` (global) | contradictions with memories; rules superseded by newer decisions |
| 3 | per-repo `CLAUDE.md` (`/home/joshua/WebJamApps/*/CLAUDE.md`) | same as #2; require `git log` staleness evidence |
| 4 | per-repo `AGENTS.md` across all 8 active WebJamApps repos (`/home/joshua/WebJamApps/*/AGENTS.md`) | same; also flag any leftover `GEMINI.md` files (renamed → AGENTS.md June 2026); require `git log` staleness evidence |
| 5 | `/home/joshua/WebJamApps/web-jam-tools/docs/cross-ai-rules.md` | cross-AI rules: contradictions, superseded entries |
| 6 | `~/Dropbox/web-jam-llms/{agy,claude-opus,claude-fable}-tasks.txt` | any line referencing a closed issue / merged PR → propose removal |
| 7 | `~/Dropbox/web-jam-llms/bridge-log.md` | bridge items merged but unlogged (or logged-but-still-pending) |
| 8 | Google Drive memory/bridge files | **FLAG only** — defer execution to `/drive-cleanup`. Do not duplicate its bridge logic. |
| 9 | `~/.claude/skills/handle-gmails/rules.yaml` | rules referencing senders not seen recently (note for Josh; low confidence) |
| 10 | `~/.claude/shared-memory/*.md` + its `MEMORY.md` | same typed staleness and index checks as #1 |
| 11 | `~/.gemini/config/hooks.json` | hook configuration drift check and syntax validation |
| 12 | Stale `~/.gemini/antigravity-cli/brain/*/scratch/` | files older than ~14 days (**FLAG only** for manual cleanup) |

### Staleness policy by memory type (frontmatter `metadata.type`)

- **`user` / `feedback`** — never age out. Flag only when contradicted or superseded by a newer memory or rule. **Memories typed `user` or `feedback` are NEVER merge candidates regardless of index size.**
- **`project`** — flag if untouched ~30 days (verify with `git log` or file mtime). If its issue/PR is closed (check via `gh`), propose delete or condense to a one-line "done" note.
- **`reference`** — verify the pointer every run: is the linked issue still open? does the path/URL still exist? Flag dead pointers.
- **Untyped files** (`cross-ai-rules.md`, the queues) — use the per-row rules in the table above.

Index trigger: Propose file merges only when a `MEMORY.md` index references **> 15 indexed files**. Do not use line counts as the trigger.

Closure checks: `gh issue view <n> --json state` and `gh pr view <n> --json state`.
A `CLOSED`/`MERGED` state on an issue/PR that a memory or queue line still tracks is a delete/condense candidate.

---

## Phase 2 — Report + await approval

Present the subagent's findings split into two separate output sections: **Approvable Action Rows** and **Informational / Flag-Only Notes**.

### 1. Approvable Action Rows

| # | Surface | Entry | Finding & Evidence | Inbound Links | Proposed Action |
|---|---|---|---|---|---|
| 1 | project memory (web-jam-back) | facebook-feed.md | issue #797 merged (`gh pr view 798` -> MERGED) | 0 links | delete file + remove line from MEMORY.md |
| 2 | project memory (web-jam-tools) | index | 18 indexed files (>15 files trigger) | N/A | merge deployment + docker notes into release.md (preserve surviving facts; user/feedback exempt) |
| 3 | opus queue | "Task 35 — #43 handle-gemini" | PR #44 merged (`gh pr view 44` -> MERGED) | 0 links | remove line from agy-tasks.txt |

### 2. Informational / Flag-Only Notes

| # | Surface | Entry | Finding & Evidence | Flag / Recommendation |
|---|---|---|---|---|
| 1 | Drive | for-opus-foo.txt | bridge pending | Hand off to /drive-cleanup |
| 2 | scratch | ~/.gemini/antigravity-cli/brain/abc123/scratch/tmp.py | file mtime > 14 days ago | Flag for manual cleanup |
| 3 | handle-gmails | rules.yaml | sender "foo@bar.com" unhandled >60d | Review sender rule relevance |

### Clean Surface Verification Summary

If a surface is clean, state so explicitly along with the exact command/computation executed:
- Surface 2 (`~/.claude/CLAUDE.md`): Clean (`grep -i contradiction` verified 0 conflicts).
- Surface 3 (`/home/joshua/WebJamApps/*/CLAUDE.md`): Clean (`git log -1` checked across 8 repos, all updated within 14 days).

Then **STOP and wait for explicit approval.** Accept "yes", "do 1,3", "all but 2", etc. Never execute an unapproved row.

---

## Phase 3 — Execute

Only after approval, and only for approved rows:

1. **Execution surface:** The scan subagent NEVER writes. Phase 3 edits may be applied directly in the parent session OR by dispatching a dedicated **Writer Subagent**:
   - **Claude Code surface:** Dispatch writer subagent via `Agent(model: "sonnet")` or `Agent(model: "haiku")`.
   - **Antigravity (`agy`) surface:** Dispatch writer subagent via `invoke_subagent(TypeName: "self", Role: "Memory Cleanup Writer", Model: "flash_med")` (or `"flash"`).
   The parent session provides the writer subagent with a fully specified list of approved edits (exact file paths, target lines/files to delete or modify, and preservation text).

2. **Repo files are special (surfaces #3/#4/#5 — per-repo `CLAUDE.md`/`AGENTS.md` and `/home/joshua/WebJamApps/web-jam-tools/docs/cross-ai-rules.md`):** never leave these edits dirty in a working tree. For each affected repo: check `git status -sb` first, create a feature branch off `dev` (stash/restore if the checkout is on an unrelated branch), bump the repo's semver, commit, push, and open a **draft PR** to `dev` — Josh reviews and merges. All other surfaces (memory dirs, Dropbox task queues) are edited in place.

3. **Keep indexes in sync:** when you delete or rename a memory file, remove or update its `MEMORY.md` index line in the same dir. When you merge memories, update the index lines to match.

4. **Surface #8 (Drive) & Surface #12 (Scratch):** never delete or edit directly — confirm Drive items are handed to `/drive-cleanup` and scratch files are flagged for Josh.

5. Write today's ISO date to `~/.claude/skills/memory-cleanup/last-run.txt`.

6. Post a short summary: what was changed, what was declined, anything left for `/drive-cleanup` or manual review.

## Hard rules

- **Approval-gated.** No writes happen before Phase 2 approval. The scan subagent is read-only and NEVER writes.
- **No unilateral deferrals.** Approval covers every approved row IN FULL, in this run. Never execute part of the findings and report the rest as "deferred — too large for this run." If a finding is genuinely big (e.g. a bulk dangling-links pass), it must appear in the Phase 2 table as its own numbered row so Josh can approve or defer it HIMSELF. Once he says "yes" / "do all", every approved row gets executed before the turn ends. (The built-in exceptions are surfaces #8/Drive and #12/Scratch, which are flag-only by design.)
- **Edits only the surfaces table.** Never code, never other repo files.
- **Index↔file together.** Never leave a `MEMORY.md` line pointing at a deleted file, or a file with no index line.
- **Drive (#8) and Scratch (#12) are flag-only.** Defer all Drive execution to `/drive-cleanup`; flag scratch files for user cleanup; no direct deletes.
- **Never delete a canonical queue or `docs/cross-ai-rules.md`** — only prune stale *lines* within them.
- **`user` / `feedback` memories never age out and are NEVER merge candidates**, regardless of index file count. Touch them only on a clear contradiction Josh confirms.
- **Inbound Link Protection.** Mandatory grep for inbound `[[link]]` references before proposing any `delete` or `merge`. Pair with preservation edits folding surviving facts into a linked memory.
- **Empirical Evidence Required.** Staleness or closure claims must cite empirical command/SHA evidence (`git log`, `gh issue/pr view`). Statements lacking evidence are omitted. Clean verdicts must report the exact verification command.
- **Dual Surface Compatibility.** Fully compatible with Claude Code (`Agent` with `haiku`/`sonnet`) and Antigravity (`invoke_subagent` with `flash`/`flash_med`). All paths specified as explicit home paths.
- **Stamp on every approved run**, even a zero-action one, so the daily reminder clears.

## Triggering

- Manual: type `/memory-cleanup`, or say "clean up memory" / "memory hygiene".
- A SessionStart-hook reminder ("Memory cleanup hasn't run today …") — Josh may say "go" / "yes". The hook **never** auto-runs the skill; Josh starts it.

## See also

- `skills/memory-cleanup/README.md` — Obsidian vault setup + agent-safety rules for hand-editing memory files.
- `~/.claude/CLAUDE.md` + `/home/joshua/WebJamApps/web-jam-tools/docs/cross-ai-rules.md` — the two standing rules (completion-reflection; save-redirection during dispatch) this sweep backstops.
- `/drive-cleanup` — owns all Google Drive execution (surface #8 defers to it).
- `scripts/backup-claude-memory.sh` — what protects these memory surfaces.
