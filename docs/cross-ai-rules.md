# Cross-AI Rules for Josh Sherman's Personal Projects

*See [ai-team-playbook.md](ai-team-playbook.md) for how the team works / who's who
(model tiers, hand-offs, approval checkpoints). This doc holds the operational
rules that apply to ALL of Josh's AI team — voice rules, file placement, protected
files, canonical task queues, hard operational rules, and memory hygiene.*

This content used to live in Dropbox `SHARED.md` (mirrored to Google Drive so phone
Sonnet could read it). It is now maintained here in `web-jam-tools` as the single
source of truth. AI-specific rules live in CLAUDE.md / AGENTS.md.

Last updated: 2026-07-11.

## VOICE RULES (for any email/pitch drafting task)

- Write as Josh in first person singular ("I", "my wife Maria"). Never "we are writing to" / "we specialize in" / "we are confident".
- Open with "Hi," or "Hi [name]," — NEVER "Dear [title]" (e.g. "Dear booking manager" is BANNED).
- Banned words: exciting, opportunity, passionate, thrilled, reach out, circle back, truly admire, deep connection, great addition, perfect fit.
- Tone: like an email between two people who'd recognize each other in a coffee shop. Conversational. No marketing copy.
- ANTI-HALLUCINATION: If the user did NOT tell you a fact, do not invent it. In particular: do not invent musical genres, awards, past venues, follower counts, or experience claims. If you don't know, leave it out.
- USE any personal hook the user gives you (e.g. "son lives in Rustburg"). Don't drop it.
- Avoid "your spot". Prefer "your venue" / "your stage" / the venue's actual name.

## EXAMPLE PITCHES (match this style — plain, conversational, only facts the user gave you)

--- Example A (warm tone, returning-area venue) ---
Hi,
My wife Maria and I are an acoustic duo from Salem, VA. We're free the last two weeks
of June and would love to play a Saturday at your place. My son lives in Rustburg, so
we're in the area anyway and it would be a real treat to get on your stage.
Let me know if any of those dates work.
Thanks — Josh Sherman, joshandmariamusic.com

--- Example B (professional tone, new venue) ---
Hi,
I'm Josh Sherman — my wife and I play as Josh and Maria, an acoustic duo out of Salem,
VA. I came across your venue and wanted to ask about booking. We have Saturdays open
between June 14 and 28. Happy to send a short sample or talk through what we play.
Thanks — Josh Sherman, joshandmariamusic.com
---

If the user did NOT give you a fact (genre, style, prior venues, awards, follower counts), DO NOT mention it. Just leave it out. The examples above only mention facts that were given.

## FILE PLACEMENT RULE

Deliverable artifacts (pitch emails, drafts, EPK material) live in their project folder:
- JoshMariaMusic: gig-booking artifacts (My Drive/JoshMariaMusic/ — folder id 1iS3KQwJwjAWjsPuvDntgvLemlPTIv9db)
- CollegeLutheran: church-related artifacts (My Drive/CollegeLutheran/ — folder id 1LsfEXCpEUFIaq7HgxDYuIb21B4qU97ky)
- MariaParty: party planning artifacts (My Drive/MariaParty/ — folder id 1vulNrPX61XlW3vMBdWusKsrjvzKiTbpZ)
- CLAUDE / GEMINI folders: AI team config/working docs only — NOT deliverables.

Never create version-suffixed copies (V2, V3, -new, -copy) — edit the master.

## CANONICAL TASK QUEUES

- claude-sonnet-tasks.txt (Drive root, id 1ooDgwiatb66PGH40ae1KpRTb9WAvn-IZ) — Claude Sonnet (phone); Drive is authoritative.
- claude-opus-tasks.txt — Claude Opus (laptop); Dropbox-resident (web-jam-llms/).
- agy-tasks.txt — agy/Flash lane (laptop); Dropbox-resident.
- claude-fable-tasks.txt — Fable, when GA (laptop); Dropbox-resident.

Never modify a queue file that isn't yours. Phone-authored bridge files at Drive root (e.g. `for-opus-<name>.txt`) are merged into the canonical queues by Claude Opus or via the drive-cleanup skill.

## PROTECTED FILES (never modify without Josh's explicit override)

- MariaParty RSVP MASTER (id 1dVyXKVfl0G2fbA__2AOl22aWxjqcnwU9)
- MariaParty Master Plan v2 (id 1sdHddtCyXlhv9ONaiD_kHV-hB3R520Yy)
- MariaParty Banner Decision (id 129j2LWzs8_0jSAkqLGe_Zw53CD16YxMX)

## OPERATIONAL HARD RULES (apply to any AI taking action on Josh's behalf)

- CALENDAR CONFLICT: never schedule over an existing event without Josh's explicit override.
- EMAIL: always DRAFT, never send. Save as Gmail draft for Josh's review.
- FILES: never create a version-suffixed copy. Edit the master.
- Never contact venues, churches, or other third parties directly — Josh handles all outreach.
- **STATE VERIFICATION**: Before any suggestion, to-do item, or "ready for you" claim about a PR/issue/CI/deploy, run a fresh liveness check in that same turn (e.g. `gh pr view --json state,mergedAt` / `gh issue view --json state`). If state ≠ OPEN, it is done: drop it silently. `mergeable: UNKNOWN/null` on a PR usually means merged/closed — never read it as "the API is slow" and never advise merging without confirming state=OPEN. An inconclusive check is not a completed check: use a definitive fallback (local `git merge-tree`, `statusCheckRollup`) or say plainly that you could not verify — never hand Josh a verification step the agent can run itself.
- **ONE REPO, ONE SESSION**: never edit a repo another AI session is actively working (Josh, 2026-07-11). Before branching or editing, check `git status -sb` — a non-`dev` branch or dirty tree means another session likely has the repo in flight. Hand the change to that session/lane (route via Josh) or ask Josh first. A separate worktree or non-colliding branch does NOT make concurrent edits OK — parallel semver bumps and surprise PRs still collide.

## MEMORY HYGIENE (standing rules for any AI on the team)

- Completion-reflection: when a task tracked in any memory/queue completes, update or delete that memory, its queue line, and its MEMORY.md index line in the SAME session, before ending the turn. (A session opened before the update keeps a stale view until its next launch — the session-start reminder + /memory-cleanup close that gap.)
- Save-redirection during dispatch: in queue/dispatch sessions, route task state → the GitHub issue/PR; project facts → that project's memory dir; only cross-project routing/strategy lessons → web-jam-llms memory or this doc.
