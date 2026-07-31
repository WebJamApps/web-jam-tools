# Cross-AI Rules for Josh Sherman's Personal Projects

*See [ai-team-playbook.md](ai-team-playbook.md) for how the team works / who's who
(model tiers, hand-offs, approval checkpoints). This doc holds the operational
rules that apply to ALL of Josh's AI team — voice rules, file placement, protected
files, canonical task queues, hard operational rules, and memory hygiene.*

This content used to live in Dropbox `SHARED.md` (mirrored to Google Drive so Maria's
claude.ai web Sonnet could read it). It is now maintained here in `web-jam-tools` as the single
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

- claude-sonnet-tasks.txt (Drive root, id 1ooDgwiatb66PGH40ae1KpRTb9WAvn-IZ) — Claude Sonnet (Josh's phone app); Drive is authoritative.
- claude-opus-tasks.txt — Claude Opus (laptop); Dropbox-resident (web-jam-llms/).

agy-tasks.txt (agy/Flash lane) is RETIRED (web-jam-tools#249) — Josh deleted it
and moved agy/Flash dispatch to GitHub-issues-only; see `skills/delegate/SKILL.md`.

claude-fable-tasks.txt is RETIRED — Fable was removed from Josh's Anthropic plan
on 2026-07-21 and the file was never created. Fable's System Architect work
(requirements/specs/issue-writing) now goes to Opus.

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
- **MAX 2 CONCURRENT WORKSTREAMS PER TERMINAL**: Two live background jobs (e.g. a subagent + a headless agy dispatch) is the cap. When a THIRD thread (new discussion, dispatch, or background job) starts in the same session, the agent must WARN Josh first and propose a separate terminal — never comply silently. Origin: 2026-07-16, Claude A froze mid-permission-prompt while running a Sonnet subagent + a headless agy dispatch plus a new discussion; recovery required keystroke injection from another session.
- **ISSUE CITATIONS ALWAYS CARRY REPO + NUMBER + TITLE**: Every mention of a GitHub issue or PR — in chat, in a commit message, in an issue/PR body, in a memory or queue file — must be written as `repo#number "title"`, e.g. `web-jam-back#998 "email subject or title still not easy for  me to see its target venue"`. **`#` followed by digits is an ILLEGAL token in anything Josh reads.** There is no exception for a repeat mention, a list item, a parenthetical, "the one I just named", or a closing one-line offer. If you don't know the title, look it up (`gh issue view N --repo R --json title`) before writing the sentence — never emit a bare number as a placeholder. If the full citation is too verbose, shorten to the TITLE, never to the number. The violation is almost always the LAST sentence of a message (the "want me to do X?" offer, written after the careful part), so re-read the finished message and check every `#` before sending. Josh has asked for this five times (2026-07-24 → 2026-07-29); he reads these on a phone with many numbers in flight and a bare number costs him a lookup every time.
- **NO AGENT CONNECTS A NEW ACCOUNT, CREDENTIAL, OR MCP SERVER WITHOUT AUTHORIZATION:** No agent adds a connector, account, credential, or MCP server to any Claude or Flash surface without Josh's explicit authorization naming it. Discovering that something *could* be connected is never permission to connect it. This applies to new OAuth grants, new MCP servers, new API tokens, and widening the scope of an existing connection. Origin (2026-07-30, Josh): *"it should NEVER have something else that I have not authorized."* See web-jam-tools#324 "No agent connects a new account, credential, or MCP server without Josh's explicit authorization — add the rule and audit where it can be mechanically enforced" for the enforcement-surface audit.
- **NO AI DELETES OR FORCE-PUSHES A REMOTE BRANCH, EVER, WITHOUT AN EXPLICIT IMPERATIVE FROM JOSH NAMING THAT BRANCH.** "The PR is merged" is NOT such an instruction — it states a fact, it does not authorize deleting anything. Local branch cleanup after a merge (deleting a LOCAL branch with `git branch -d`/`-D`, `git fetch --prune` to prune stale local remote-tracking refs) remains permitted and unchanged — this rule narrows that standing post-merge cleanup habit to local branches only, it does not remove it or require re-approval for it. Enforced by three independent layers: a harness `permissions.deny` block on the ways `git push`/`git branch` can delete or clobber a remote ref (`--delete`/`-d`, empty-source colon refspecs, `--force`/`-f`/`--force-with-lease`, `--mirror`, `--prune`, and `git branch -D`/`--delete --force` against a `remotes/` ref — installed via `scripts/install-hooks.sh` in this repo), a GitHub ruleset restricting deletions on the branches agents create (`claude/**`, `agy/**`, `dev`, `main` — Josh-only UI work, see web-jam-tools#308 "Remote branches can be deleted by an agent with no authorization — advisory guard does not block (3 layers: deny rules, GitHub ruleset, HARD RULES)"), and this HARD RULE. Origin: 2026-07-29, an agent deleted `claude/cross-ai-rules-issue-citation-hard-rule` from `web-jam-tools` immediately after Josh merged web-jam-tools#307 "Add ISSUE CITATIONS hard rule to operational rules" — Josh had only said the PR was merged, never authorized a deletion, and the `PreToolUse` guard that fired was advisory text an agent could rationalize past.
- **THE `Blocked` LABEL IS CANONICAL — NATIVE ISSUE DEPENDENCIES DO NOT REPLACE IT.** Josh wants BOTH: native GitHub issue-dependency links (the real relationship between issues) AND the `Blocked` label (capital B, hex `B60205`, `repos: all` in `skills/fix-labels/labels.yaml`) as the at-a-glance signal that makes an unworkable issue obvious in a plain list view without opening each issue. They do different jobs: use a native dependency whenever a **specific issue** blocks the work — it names which one, renders in the Issues list, and clears itself on close. Use the `Blocked` label whenever the work is unworkable **for any reason**, including the many with no issue to point at (a vendor, a credential Josh must generate, a physical action). Native dependencies cannot express that case at all, which is why the label is not redundant. No agent may prune `Blocked` from `labels.yaml` (or delete it live) on the theory that native dependencies made it redundant — that is exactly what happened once already: `blocked` (lowercase) was removed in commit 7d2523d as part of a nine-label prune shipped for web-jam-tools#300, justified as "-> native issue dependencies," and Josh never actually agreed to that one — it rode along in a batch whose headline was about priority labels. web-jam-tools#329 "Restore the Blocked label as canonical in labels.yaml — it was pruned in a batch Josh never ratified, and he wants it alongside native dependencies" restored it. See `skills/fix-labels/labels.yaml`'s `Blocked` entry for the full rationale.

## DESIGN CLAIMS MUST CARRY RECEIPTS (wjt#305)

A settled design shipped an unverified claim as established fact, sitting
unmarked right next to claims that HAD been verified with live commands. Josh
had no way to tell an assertion from a receipt — they read as equally solid.
These rules exist to prevent that class of failure.

### Rule 1 — requirement-critical claims carry a receipt or a warning label

Any statement in a design, spec, issue comment, or PR body that answers a
stated requirement of Josh's must either:

- carry its receipt inline — the exact command run and its actual output, or
  a screenshot; or
- be explicitly tagged `ASSUMPTION — NOT VERIFIED`.

A design may **not** be marked settled/approved while any requirement-critical
claim is unmarked. If there is no command that could produce a receipt, that
is itself the signal that the claim needs a different kind of verification —
say so instead of asserting it.

### Rule 2 — a UI requirement can never be verified through an API

If the requirement is about what Josh can **see**, the only acceptable
evidence is a screenshot, or Josh's own confirmation that he sees it. API
calls, REST payloads, and CLI output do not count and never have. Marking a
design settled on API-only evidence when the requirement is a UI requirement
is a hard blocker, not a nit.

Origin: web-jam-tools#287 "fix-labels skill expanded / corrected" — the design
asserted "field values appear in the issue sidebar and in search" without a
screenshot, Josh accepted the design on that basis, the org-wide migration in
web-jam-tools#298 "Migrate existing issues to native Priority/Area fields,
Type, and dependencies (org-wide)" was verified entirely through REST, and
Josh then could not find the `Area` field in the browser at all.

## FE/BE COUPLING (wjt#240)

A change with a back-end half and a front-end half can ship half-done — e.g. the
"venue must have a physical address" BE rule shipped before the create-Gigs "new
venue" FE flow collected an address, and broke prod. These rules exist to prevent
that class of failure.

### Backward-compat / expand-contract rule

A back-end change to a shared contract (a required field, a validation rule, a
request/response shape that a front-end consumes) MUST be additive/non-breaking
until the front-end ships — enforce the breaking part in a LATER change.

Right order for the venue example:
1. BE accepts venues without an address (unchanged/additive).
2. FE is updated to collect/require the address.
3. THEN BE enforces the address as required.

Enforcing the new required field before the FE sends it is exactly what broke
prod — never skip straight to step 3.

### Coupling record convention

When work has coupled BE + FE halves, cross-reference them with a
`FE-couples: <repo>#NNN` line in the issue/PR bodies — bidirectional, each half
names the other (the FE issue/PR gets a matching pointer back to the BE one).

### Coupling-override convention

A coupled BE PR that is genuinely safe to ship alone (backward-compatible per
the expand-contract rule above, or behind a flag) carries a
`Coupling-override: <reason>` line in the PR body to pass the merge gate.
Example:

```
Coupling-override: additive only — address stays optional until JaMmusic#NNN ships
```

### Merge gate (summary)

A coupled BE change must reach `main` via a `dev→main` PR; a required status
check verifies the FE half is merged to the FE repo's `main` (≈ deployed, given
auto-deploy fan-out) OR a valid `Coupling-override:` line is present. Direct CLI
pushes to `main` stay fine for UNcoupled changes. The enforcement Action itself
lives in the web-jam-back repo (a separate build, out of scope here) — this
section is the canonical rule text and conventions that Action enforces.

## MEMORY HYGIENE (standing rules for any AI on the team)

- Completion-reflection: when a task tracked in any memory/queue completes, update or delete that memory, its queue line, and its MEMORY.md index line in the SAME session, before ending the turn. (A session opened before the update keeps a stale view until its next launch — the session-start reminder + /memory-cleanup close that gap.)
- Save-redirection during dispatch: in queue/dispatch sessions, route task state → the GitHub issue/PR; project facts → that project's memory dir; only cross-project routing/strategy lessons → web-jam-llms memory or this doc.
