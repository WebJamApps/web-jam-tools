# Cross-AI Rules for Josh Sherman's Personal Projects

_See [ai-team-playbook.md](ai-team-playbook.md) for how the team works / who's who (model tiers,
tier order, hand-offs, approval checkpoints). This doc holds the operational rules that apply to ALL of Josh's
AI team — voice rules, file placement, protected files, canonical task queues, hard operational
rules, and memory hygiene._

> **Moved to the Obsidian vault (2026-11-05):** Origin stories, worked examples, and work-specific rules (example pitches, REAPER, Blocked label, Dropbox scope, backend guard detail, design receipts, epic coherence, standalone issues) now live word for word in `~/Dropbox/web-jam-llms/rules-vault/web-jam-tools-cross-ai-rules.md`. Read it before working in that area.

## VOICE RULES (for any email/pitch drafting task)

- Write as Josh in first person singular ("I", "my wife Maria"). Never "we are writing to" / "we
  specialize in" / "we are confident".
- Open with "Hi," or "Hi [name]," — NEVER "Dear [title]" (e.g. "Dear booking manager" is BANNED).
- Banned words: exciting, opportunity, passionate, thrilled, reach out, circle back, truly admire,
  deep connection, great addition, perfect fit.
- Tone: like an email between two people who'd recognize each other in a coffee shop.
  Conversational. No marketing copy.
- ANTI-HALLUCINATION: If the user did NOT tell you a fact, do not invent it. In particular: do not
  invent musical genres, awards, past venues, follower counts, or experience claims. If you don't
  know, leave it out.
- USE any personal hook the user gives you (e.g. "son lives in Rustburg"). Don't drop it.
- Avoid "your spot". Prefer "your venue" / "your stage" / the venue's actual name.

## FILE PLACEMENT RULE

Deliverable artifacts (pitch emails, drafts, EPK material) live in their project folder:

- JoshMariaMusic: gig-booking artifacts (My Drive/JoshMariaMusic/ — folder id
  1iS3KQwJwjAWjsPuvDntgvLemlPTIv9db)
- CollegeLutheran: church-related artifacts (My Drive/CollegeLutheran/ — folder id
  1LsfEXCpEUFIaq7HgxDYuIb21B4qU97ky)
- MariaParty: party planning artifacts (My Drive/MariaParty/ — folder id
  1vulNrPX61XlW3vMBdWusKsrjvzKiTbpZ)
- CLAUDE / GEMINI folders: AI team config/working docs only — NOT deliverables.

Never create version-suffixed copies (V2, V3, -new, -copy) — edit the master.

## CANONICAL TASK QUEUES

- claude-sonnet-tasks.txt (Drive root, id 1ooDgwiatb66PGH40ae1KpRTb9WAvn-IZ) — Claude Sonnet (Josh's
  phone app); Drive is authoritative.

Never modify a queue file that isn't yours. Phone-authored bridge files at Drive root (e.g.
`for-opus-<name>.txt`) are merged into the canonical queues by Claude Opus or via the drive-cleanup
skill.

## PROTECTED FILES (never modify without Josh's explicit override)

- MariaParty RSVP MASTER (id 1dVyXKVfl0G2fbA__2AOl22aWxjqcnwU9)
- MariaParty Master Plan v2 (id 1sdHddtCyXlhv9ONaiD_kHV-hB3R520Yy)
- MariaParty Banner Decision (id 129j2LWzs8_0jSAkqLGe_Zw53CD16YxMX)

## OPERATIONAL HARD RULES (apply to any AI taking action on Josh's behalf)

- **CODEX RUNNING MODEL:** On Codex, run `deno task whoami` whenever you need your own model — when Josh asks which model you are, and before `$pr-review` applies the reviewer rule — and never answer from your own context or from `~/.codex/config.toml`.
- CALENDAR CONFLICT: never schedule over an existing event without Josh's explicit override.
- EMAIL: always DRAFT, never send. Save as Gmail draft for Josh's review.
- **EMAIL SEND CARVE-OUT — `/book-gig` gated batch dispatch only:** The single named
  exception to "EMAIL: always DRAFT, never send" is `/book-gig`'s batch outreach dispatch
  (`deno task book-gig --send ... --confirm-drafts`), and only once BOTH independent approval
  gates for that batch are explicitly recorded: **Gate 1** (target venue-set approval, recorded
  server-side via `POST /outreach/approval/venue-set`) and **Gate 2** (Josh's distinct, explicit
  approval of the rendered draft copy itself, recorded server-side as a fingerprint of each
  approved email — any later change to the venue set or the rendered copy invalidates it). Gate 1
  approval of the venue set never authorizes dispatch on its own, and neither gate may ever be
  inferred from the other or from any other statement Josh makes — see
  `skills/book-gig/SKILL.md` for the full gate mechanics and fail-closed
  guards. This carve-out names this one dispatch path and nothing else: it does not generalize to
  any other skill, agent, or workflow, and it does not loosen voice rules or any other restriction
  in this document. Outside this one path, "EMAIL: always DRAFT, never send" remains absolute.
- FILES: never create a version-suffixed copy. Edit the master.
- **NO SCRATCH FILES OR SCRATCH FOLDERS IN GIT REPOSITORIES**: Never create scratch files, draft markdown files, temporary summaries, or a `scratch/` folder inside any GitHub repository workspace. All temporary files (such as `--summary-file`, `--test-plan-file`, `--test-evidence-file` for `create-draft-pr.sh`, or scratch issue templates) MUST be written to `/tmp/` (e.g. `/tmp/pr-summary.md`) or the agent session artifact scratch directory, and cleaned up when done, keeping repository working trees completely clean.
- Never contact venues, churches, or other third parties directly — Josh handles all outreach.
- **Third-party contact carve-out (same one as above):** The `/book-gig` gated batch
  dispatch path described under the EMAIL SEND CARVE-OUT above is the only path on which an agent
  may contact a venue directly, and only under that same dual-gate condition. No other path, skill,
  or workflow permits an agent to contact venues, churches, or other third parties directly.
- **STATE VERIFICATION**: Before any suggestion, to-do item, or "ready for you" claim about a
  PR/issue/CI/deploy, run a fresh liveness check in that same turn (e.g.
  `gh pr view --json state,mergedAt` / `gh issue view --json state`). If state ≠ OPEN, it is done:
  drop it silently. `mergeable: UNKNOWN/null` on a PR usually means merged/closed — never read it as
  "the API is slow" and never advise merging without confirming state=OPEN. An inconclusive check is
  not a completed check: use a definitive fallback (local `git merge-tree`, `statusCheckRollup`) or
  say plainly that you could not verify — never hand Josh a verification step the agent can run
  itself.
- **ONE REPO, MULTIPLE LANES — ISOLATE, DON'T SERIALIZE** (Josh, 2026-08-21, superseding the
  2026-07-11 ONE REPO, ONE SESSION rule): Two subagents may work the same repo at the same time.
  Each lane MUST run in its own worktree (`scripts/new-agent-worktree.sh`) on its own branch off
  `dev` — never in the shared `~/WebJamApps/<repo>` checkout, which has a single HEAD and would
  branch-switch under a running agent. The MAX 2 CONCURRENT WORKSTREAMS PER TERMINAL cap below
  still applies. Parallel lanes off the same base will each bump `deno.json`/`package.json` to the
  same version; that is an expected merge conflict, resolved by rebasing the second PR onto `dev`
  and re-bumping — it is **not** a reason to refuse or queue a dispatch. State which lanes are live
  in a repo; never serialize silently.
- **MAX 2 CONCURRENT WORKSTREAMS PER TERMINAL**: Two live background jobs (e.g. a subagent + a
  headless agy dispatch) is the cap. When a THIRD thread (new discussion, dispatch, or background
  job) starts in the same session, the agent must WARN Josh first and propose a separate terminal —
  never comply silently. - **ISSUE CITATIONS ALWAYS CARRY REPO + NUMBER + TITLE**: Every mention of a GitHub issue or PR — in
  chat, in a commit message, in an issue/PR body, in a memory or queue file — must be written as
  `repo#number "title"`, e.g.
  `web-jam-back#998 "email subject or title still not easy for  me to see its target venue"`. **`#`
  followed by digits is an ILLEGAL token in anything Josh reads.** There is no exception for a
  repeat mention, a list item, a parenthetical, "the one I just named", or a closing one-line offer.
  If you don't know the title, look it up (`gh issue view N --repo R --json title`) before writing
  the sentence — never emit a bare number as a placeholder. If the full citation is too verbose,
  shorten to the TITLE, never to the number. The violation is almost always the LAST sentence of a
  message (the "want me to do X?" offer, written after the careful part), so re-read the finished
  message and check every `#` before sending. **This rule has exactly one carve-out — the literal `Closes`/`Fixes`/`Resolves`
  line in a PR body — see "THE CLOSES/FIXES/RESOLVES LINE IS SYNTAX, NOT PROSE" below.**
- **THE CLOSES/FIXES/RESOLVES LINE IS SYNTAX, NOT PROSE — NEVER APPLY THE CITATION FORMAT TO IT.**
  The one line in a PR body that carries a literal `Closes`, `Fixes`, or `Resolves` keyword is
  read by GitHub's auto-close parser, not by Josh, and that parser resolves only a bare `#N`
  (same-repo) or `owner/repo#N` (cross-repo) reference — a repo name with no `owner/` prefix
  (`web-jam-tools#784`) is neither of those forms and is not recognized. Trailing text after the
  reference does not break it — `Fixes #123 by rewriting the parser` closes normally — so the
  citation style fails here specifically because of the missing `owner/`, not because of the
  trailing title text.

  Correct: `Closes #784`
  Incorrect: `Closes web-jam-tools#784 "some title"`

- **NO AGENT CONNECTS A NEW ACCOUNT, CREDENTIAL, OR MCP SERVER WITHOUT AUTHORIZATION:** No agent
  adds a connector, account, credential, or MCP server to any Claude or Flash surface without Josh's
  explicit authorization naming it. Discovering that something _could_ be connected is never
  permission to connect it. This applies to new OAuth grants, new MCP servers, new API tokens, and
  widening the scope of an existing connection. - **NO GUARD IS EVER LOOSENED TO REDUCE JOSH'S FRICTION:** When Josh is frustrated at being asked,
  no agent removes, widens, or bypasses the thing that asks — not a permission rule, not a hook, not
  a skill gate, not a confirmation step. A guard exists because a failure already happened; deleting
  it converts his irritation into a permanent hole. **"I already approved this" is a request to
  RECOGNIZE an approval, never a request to DELETE a check** — those are opposite engineering
  responses to one complaint. Where a mechanism cannot express what Josh wants (a permission layer
  knows nothing about the conversation, so it cannot represent "already approved"), say so plainly
  and propose the thing that can; never approximate it by weakening the guard. The correct fix for a
  redundant prompt is a check that reads a recorded approval — silent when the approval exists,
  refusing when it does not. - **NO AI CLOSES OR REOPENS A GITHUB ISSUE AUTONOMOUSLY:** No agent may close (`gh issue close`) or
  reopen (`gh issue reopen`) any GitHub issue without Josh's explicit authorization in chat naming
  that specific issue. Always ask Josh for permission first before executing any issue close or reopen
  command.
- **STANDING AGENT CREDENTIAL CLASSIFICATION RULE (MACHINE-CONSUMED VS HUMAN-CONSUMED):** Whenever
  an agent encounters or generates a new credential, account identifier, or token, the agent must
  **STOP and prompt Josh to classify it** as either machine-consumed (e.g. `GITHUB_TOKEN`,
  `GEMINI_API_KEY`, `HEROKU_API_KEY`, `CIRCLECI_TOKEN`, `DENO_DEPLOY_TOKEN` stored in shell rc or
  secret store) or human-consumed (e.g. `webjam.claude@gmail.com` stored in KeePass only) BEFORE
  storing, exporting, or configuring it in any shell profile, `.env` file, or configuration file.
  Human-consumed credentials belong in KeePass only and must never be exported to shell profiles or
  stored in application configuration files (web-jam-tools#344 "Human-only credentials register and
  guard hook").
- **NO AI DELETES OR FORCE-PUSHES A REMOTE BRANCH, EVER, WITHOUT AN EXPLICIT IMPERATIVE FROM JOSH
  NAMING THAT BRANCH — OR THE PULL REQUEST IT BELONGS TO.** "The PR is merged" is NOT such an
  instruction — it states a fact, it does not authorize deleting anything.

  **Naming the PR counts as naming the branch** (Josh, 2026-08-13: *"I can ask for a PR to be fixed
  (not just the branch, but the PR)"*). A pull request resolves to exactly one head branch, so "fix
  PR 521" or "rebase web-jam-tools#521" identifies the target as precisely as the branch name does,
  and it is how Josh actually works. Resolve it before acting —
  `gh pr view <N> --repo WebJamApps/<Repo> --json headRefName` — and act on **that** branch and no
  other. This widens what counts as a valid imperative; it does not weaken the requirement that one
  exist. A bare "fix it", a merged-PR notification, or your own inference that a rebase is needed
  are still not authorization.

  **DELETION is unaffected by this paragraph.** Naming a PR authorizes a `--force-with-lease` push
  to its head branch. It never authorizes deleting that branch, and the deletion patterns stay in
  `permissions.deny` with no prompt and no exception.

- **MULTI-REPO ISSUES STAY OPEN UNTIL ALL REPOS ARE COMPLETE:** When an issue explicitly covers
  multiple repositories (e.g. "all 8 active github repos"), no single PR in one repository may pass
  `--closes` or claim the issue is completed. PRs in individual repos must use `--part-of` so the
  tracking issue remains OPEN until the final repository's PR is merged.
- **POST-MERGE MANUAL STEPS BECOME THEIR OWN `Josh` ISSUE:** Replaced by the canonical design
  document `/home/joshua/Dropbox/web-jam-llms/Token_Savings/design-issue-file-issue-design-2026-08-23.md`
  (revision 2.14.0) in the sections "Manual Steps & Runbooks" and "How a pull request names its issue".
  A `Josh` issue and a runbook are for repeatable operations setup and extensive manual testing;
  a simple or one-time local step after a merge is acceptance criteria on the agent's own issue
  with a PR issue line `Part of #N (local step after merge)` (`--local-step`), and its Workflow Status
  reads `Merged, needs local step` from the merge.
  - **Designed Issues with Paired Manual Steps Become Parent Epics:** When `/design-issue` resolves an
    existing issue into paired implementation and Josh manual verification tasks, convert the target
    designed issue into native type `Epic` (via GraphQL `updateIssue` with the repo's `Epic`
    `issueTypeId`), file the executable coding work as a child `Task` sub-issue attached under that
    Epic, and file the paired `Josh` manual verification task as a child `Task` sub-issue attached
    under that same Epic (natively linked via `blocked_by` dependency to the coding child, without the
    `Blocked` label). The parent Epic body specifies
    `## What this builds`, milestone, design document pointer, and `## Acceptance criteria` ("Closes
    when all child sub-issues close") without duplicating a manual markdown checklist of sub-issues.
- **APPROVAL IS PER GATE.** Approval of a design is not approval to file the tracking issue.
  Approval of an issue is not approval to dispatch. Each gate needs its own imperative from Josh
  naming that step. An agent writes the issue body to a file (or shows it in chat) and waits; the
  `gh issue create` call (or MCP `issue_write` create) follows only the words "file it" (or
  equivalent). A dispatch (starting work on an issue by spawning a subagent or handing it to
  agy/Flash) follows only an explicit instruction to dispatch. Once Josh has said go on a piece of
  work, the session doing it may hand parts of that same work to a helper at the same level or
  cheaper without a new go — that carries out an approved step, it does not open a new gate. A single "go" is ambiguous across gates and must never be read as
  covering more than one — the expensive, hard-to-reverse half (issue noise, spawned tokens) is
  always the later gate, so collapsing gates fails in the direction that costs the most. - **DESIGN WORK RUNS THROUGH `/design-issue`:** Design work — options, trade-offs, decisions worth
  recording — does not happen in plain chat. The moment a conversation turns into design, invoke
  `/design-issue` and work inside it.
- **NO ISSUE IS FILED OR ATTACHED TO AN EPIC OUTSIDE `/design-issue`:** A new issue, and an existing
  issue added to an epic as a child, comes only from a `/design-issue` Gate 2 plan that Josh
  approved. The one exception is an issue Josh explicitly tells the agent to create in that turn,
  such as a `Needs Design` placeholder or his own `/file-issue`, and nothing is filed or attached
  under a placeholder until its design run. New work an agent finds mid-session (a defect, a gap, a
  follow-up) is reported to Josh with full details and options; the agent never files it, and never
  steers Josh toward filing it, as a shortcut around the design run. A plan that turns out to be
  missing a step after filing is a defect in the run, never a reason to file more issues outside it.
- **EVERY DECISION OR QUESTION PUT TO JOSH CARRIES FULL DETAILS AND A RECOMMENDATION:** In any
  context, not only design runs, every decision or question put to Josh carries: (1) the facts it
  turns on, checked first, with no "not verified" left that a cheap check can settle; (2) every
  option, with what it costs, what work it creates and what it risks; (3) the agent's
  recommendation, last, with its reason. A re-ask counts too: a decision raised again after a block,
  an interruption or any turn in between is laid out in full again, never as "see above". When
  several decisions are open, show a short index and then lay out each one in full, one at a time.
- **MAINTAINABILITY AND NON-DUPLICATION ARE FIRST-ORDER DESIGN CRITERIA — NOT AFTERTHOUGHTS.**
  Every design decision is judged on who has to keep the result in step and what happens when they
  don't. A design that is correct on the day it ships and rots quietly afterwards has failed. Five
  binding rules, in force for every design, every issue body, every document, every code change:
  1. **A fact lives in exactly ONE artifact. Everything else POINTS at it.** This is not a
     preference. Requirements live in the design document; an executable issue carries scope, build
     mechanics and repo facts, and points for the rest. A paraphrase drifts the moment it is
     written; a verbatim copy is just slower drift.
  2. **NEVER propose machinery to hold AUTHORITATIVE copies in step.** A generator, a sync script, a
     drift check, a session hook, a CI gate or a test whose purpose is to keep N editable copies
     identical **does not prevent drift — it manages drift**, and it adds a second thing to maintain
     on top of the first. If the answer to "how do we stop these copies diverging?" is a tool, the
     design is wrong: delete the copies. **The amount of machinery is itself the diagnostic** —
     needing five mechanisms to hold one block identical is proof the block should exist once.

  3. **NEVER write a precedence rule.** "Where X and Y disagree, X wins" does not resolve a
     conflict; it *licenses* one, declaring drift acceptable so long as everyone knows the winner.
     Not approved, in any artifact, ever. If a difference is found, repair it in EVERY place it
     exists, in that session, before continuing.
  4. **Duplication is only acceptable when removing it is impossible, and the impossibility is
     proven and recorded** — measured against the real tools, not inferred. Record what was measured
     and what limitation is being accepted, in the design, where the next reader will find it.
  5. **Every design answers, in writing: who maintains this, and what breaks when they forget?**
     If the honest answer is "an agent or Josh has to remember", the design is not finished — an
     advisory rule binds only those who read and obey it. Push enforcement to a point that cannot
     be skipped, and where it still cannot be made airtight, **state the gap plainly rather than
     letting the guard be mistaken for complete coverage. An inert guard believed to be live is
     worse than a known gap.**

- **A PR FOR A HOOK ISSUE NEVER CLOSES THE ISSUE.** Replaced by the canonical design document
  `/home/joshua/Dropbox/web-jam-llms/Token_Savings/design-issue-file-issue-design-2026-08-23.md`
  (revision 2.14.0) in the sections "Manual Steps & Runbooks" and "How a pull request names its issue".
  Hooks, skills and scripts are links into the canonical clone and close on merge once dev is pulled,
  unless an installer write or laptop step is required, in which case the PR passes `--local-step`
  (`Part of #N (local step after merge)`).

## FE/BE COUPLING (web-jam-tools#240 "dispatching to sub-agents  -  part two improvements")

### Backward-compat / expand-contract rule

A back-end change to a shared contract (a required field, a validation rule, a request/response
shape that a front-end consumes) MUST be additive/non-breaking until the front-end ships — enforce
the breaking part in a LATER change.

Right order for the venue example:

1. BE accepts venues without an address (unchanged/additive).
2. FE is updated to collect/require the address.
3. THEN BE enforces the address as required.

Enforcing the new required field before the FE sends it is exactly what broke prod — never skip
straight to step 3.

### Coupling record convention

When work has coupled BE + FE halves, cross-reference them with a `FE-couples: <repo>#NNN` line in
the issue/PR bodies — bidirectional, each half names the other (the FE issue/PR gets a matching
pointer back to the BE one).

### Coupling-override convention

A coupled BE PR that is genuinely safe to ship alone (backward-compatible per the expand-contract
rule above, or behind a flag) carries a `Coupling-override: <reason>` line in the PR body to pass
the merge gate. Example:

```
Coupling-override: additive only — address stays optional until JaMmusic#NNN ships
```

### Merge gate (summary)

A coupled BE change must reach `main` via a `dev→main` PR; a required status check verifies the FE
half is merged to the FE repo's `main` (≈ deployed, given auto-deploy fan-out) OR a valid
`Coupling-override:` line is present. Direct CLI pushes to `main` stay fine for UNcoupled changes.
The enforcement Action itself lives in the web-jam-back repo (a separate build, out of scope here) —
this section is the canonical rule text and conventions that Action enforces.

## MEMORY HYGIENE (standing rules for any AI on the team)

- Completion-reflection: when a task tracked in any memory/queue completes, update or delete that
  memory, its queue line, and its MEMORY.md index line in the SAME session, before ending the turn.
  (A session opened before the update keeps a stale view until its next launch — the session-start
  reminder + /memory-cleanup close that gap.)
- Save-redirection during dispatch: in queue/dispatch sessions, route task state → the GitHub
  issue/PR; project facts → that project's memory dir; cross-project routing/strategy lessons →
  web-jam-llms memory; operational rules that bind the whole AI team (voice, file placement,
  protected files, hard rules) → this doc via PR (the single source of truth). Test: "would this
  matter in a session about a different repo?"
