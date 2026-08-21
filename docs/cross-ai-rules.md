# Cross-AI Rules for Josh Sherman's Personal Projects

_See [ai-team-playbook.md](ai-team-playbook.md) for how the team works / who's who (model tiers,
hand-offs, approval checkpoints). This doc holds the operational rules that apply to ALL of Josh's
AI team — voice rules, file placement, protected files, canonical task queues, hard operational
rules, and memory hygiene._

This content used to live in Dropbox `SHARED.md` (mirrored to Google Drive so Maria's claude.ai web
Sonnet could read it). It is now maintained here in `web-jam-tools` as the single source of truth.
AI-specific rules live in CLAUDE.md / AGENTS.md.

Last updated: 2026-07-11.

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

## EXAMPLE PITCHES (match this style — plain, conversational, only facts the user gave you)

--- Example A (warm tone, returning-area venue) --- Hi, My wife Maria and I are an acoustic duo from
Salem, VA. We're free the last two weeks of June and would love to play a Saturday at your place. My
son lives in Rustburg, so we're in the area anyway and it would be a real treat to get on your
stage. Let me know if any of those dates work. Thanks — Josh Sherman, joshandmariamusic.com

## --- Example B (professional tone, new venue) --- Hi, I'm Josh Sherman — my wife and I play as Josh and Maria, an acoustic duo out of Salem, VA. I came across your venue and wanted to ask about booking. We have Saturdays open between June 14 and 28. Happy to send a short sample or talk through what we play. Thanks — Josh Sherman, joshandmariamusic.com

If the user did NOT give you a fact (genre, style, prior venues, awards, follower counts), DO NOT
mention it. Just leave it out. The examples above only mention facts that were given.

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
- claude-opus-tasks.txt — Claude Opus (laptop); Dropbox-resident (web-jam-llms/).

agy-tasks.txt (agy/Flash lane) is RETIRED (web-jam-tools#249) — Josh deleted it and moved agy/Flash
dispatch to GitHub-issues-only; see `skills/delegate/SKILL.md`.

claude-fable-tasks.txt is RETIRED — Fable was removed from Josh's Anthropic plan on 2026-07-21 and
the file was never created. Fable's System Architect work (requirements/specs/issue-writing) now
goes to Opus.

Never modify a queue file that isn't yours. Phone-authored bridge files at Drive root (e.g.
`for-opus-<name>.txt`) are merged into the canonical queues by Claude Opus or via the drive-cleanup
skill.

## PROTECTED FILES (never modify without Josh's explicit override)

- MariaParty RSVP MASTER (id 1dVyXKVfl0G2fbA__2AOl22aWxjqcnwU9)
- MariaParty Master Plan v2 (id 1sdHddtCyXlhv9ONaiD_kHV-hB3R520Yy)
- MariaParty Banner Decision (id 129j2LWzs8_0jSAkqLGe_Zw53CD16YxMX)

## OPERATIONAL HARD RULES (apply to any AI taking action on Josh's behalf)

- CALENDAR CONFLICT: never schedule over an existing event without Josh's explicit override.
- EMAIL: always DRAFT, never send. Save as Gmail draft for Josh's review.
- FILES: never create a version-suffixed copy. Edit the master.
- **NO SCRATCH FILES OR SCRATCH FOLDERS IN GIT REPOSITORIES**: Never create scratch files, draft markdown files, temporary summaries, or a `scratch/` folder inside any GitHub repository workspace. All temporary files (such as `--summary-file`, `--test-plan-file`, `--test-evidence-file` for `create-draft-pr.sh`, or scratch issue templates) MUST be written to `/tmp/` (e.g. `/tmp/pr-summary.md`) or the agent session artifact scratch directory, and cleaned up when done, keeping repository working trees completely clean.
- Never contact venues, churches, or other third parties directly — Josh handles all outreach.
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
  never comply silently. Origin: 2026-07-16, Claude A froze mid-permission-prompt while running a
  Sonnet subagent + a headless agy dispatch plus a new discussion; recovery required keystroke
  injection from another session.
- **ISSUE CITATIONS ALWAYS CARRY REPO + NUMBER + TITLE**: Every mention of a GitHub issue or PR — in
  chat, in a commit message, in an issue/PR body, in a memory or queue file — must be written as
  `repo#number "title"`, e.g.
  `web-jam-back#998 "email subject or title still not easy for  me to see its target venue"`. **`#`
  followed by digits is an ILLEGAL token in anything Josh reads.** There is no exception for a
  repeat mention, a list item, a parenthetical, "the one I just named", or a closing one-line offer.
  If you don't know the title, look it up (`gh issue view N --repo R --json title`) before writing
  the sentence — never emit a bare number as a placeholder. If the full citation is too verbose,
  shorten to the TITLE, never to the number. The violation is almost always the LAST sentence of a
  message (the "want me to do X?" offer, written after the careful part), so re-read the finished
  message and check every `#` before sending. Josh has asked for this five times (2026-07-24 →
  2026-07-29); he reads these on a phone with many numbers in flight and a bare number costs him a
  lookup every time.
- **NO AGENT CONNECTS A NEW ACCOUNT, CREDENTIAL, OR MCP SERVER WITHOUT AUTHORIZATION:** No agent
  adds a connector, account, credential, or MCP server to any Claude or Flash surface without Josh's
  explicit authorization naming it. Discovering that something _could_ be connected is never
  permission to connect it. This applies to new OAuth grants, new MCP servers, new API tokens, and
  widening the scope of an existing connection. Origin (2026-07-30, Josh): _"it should NEVER have
  something else that I have not authorized."_ See web-jam-tools#324 "No agent connects a new
  account, credential, or MCP server without Josh's explicit authorization — add the rule and audit
  where it can be mechanically enforced" for the enforcement-surface audit.
- **NO GUARD IS EVER LOOSENED TO REDUCE JOSH'S FRICTION:** When Josh is frustrated at being asked,
  no agent removes, widens, or bypasses the thing that asks — not a permission rule, not a hook, not
  a skill gate, not a confirmation step. A guard exists because a failure already happened; deleting
  it converts his irritation into a permanent hole. **"I already approved this" is a request to
  RECOGNIZE an approval, never a request to DELETE a check** — those are opposite engineering
  responses to one complaint. Where a mechanism cannot express what Josh wants (a permission layer
  knows nothing about the conversation, so it cannot represent "already approved"), say so plainly
  and propose the thing that can; never approximate it by weakening the guard. The correct fix for a
  redundant prompt is a check that reads a recorded approval — silent when the approval exists,
  refusing when it does not. Origin (2026-08-11): during an eleven-issue filing run Josh was prompted
  per issue and said, correctly, that he had already approved the plan; the response was to move
  `mcp__claude_ai_GitHub_MCP__issue_write` and `sub_issue_write` from `ask` to `allow`, which stopped
  the prompting and also removed the only mechanical barrier to any session filing issues he never
  asked for. Reverted the same hour. Josh: _"add this to a STRONG rule to not loosen guards or like
  this ever again just to placate me this way, I said I ALREADY approved, not just allow it
  whatever!!!"_ The real fix is web-jam-tools#502 "Josh is asked to approve issue creation he already
  approved — write an approval token at the plan gate and add a PreToolUse hook that reads it".
- **NO AI CLOSES OR REOPENS A GITHUB ISSUE AUTONOMOUSLY:** No agent may close (`gh issue close`) or
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

  **`--force-with-lease` is `ask`, not `deny`** (`ASK_RULES` in `scripts/install-hooks.sh`), so the
  harness prompts with the literal command before it runs and Josh answers per invocation. That
  prompt is the mechanism enforcing this rule — a deny entry could not, since static string matching
  has no view of whether Josh authorized anything, and it therefore refused the authorized case and
  the unauthorized one identically. Plain `--force` remains denied outright. Local branch cleanup after a merge (deleting a LOCAL branch with
  `git branch -d`/`-D`, `git fetch --prune` to prune stale local remote-tracking refs) remains
  permitted and unchanged — this rule narrows that standing post-merge cleanup habit to local
  branches only, it does not remove it or require re-approval for it. Enforced by three independent
  layers: a harness `permissions.deny` block on the ways `git push`/`git branch` can delete or
  clobber a remote ref (`--delete`/`-d`, empty-source colon refspecs, plain `--force`/`-f`,
  `--mirror`, `--prune`, and `git branch -D`/`--delete --force`
  against a `remotes/` ref — installed via `scripts/install-hooks.sh` in this repo; note
  `--force-with-lease` is `ask` rather than `deny`, per the paragraph above), a GitHub
  ruleset restricting deletions on the branches agents create (`claude/**`, `agy/**`, `dev`, `main`
  — Josh-only UI work, see web-jam-tools#308 "Remote branches can be deleted by an agent with no
  authorization — advisory guard does not block (3 layers: deny rules, GitHub ruleset, HARD
  RULES)"), and this HARD RULE. Origin: 2026-07-29, an agent deleted
  `claude/cross-ai-rules-issue-citation-hard-rule` from `web-jam-tools` immediately after Josh
  merged web-jam-tools#307 "Add ISSUE CITATIONS hard rule to operational rules" — Josh had only said
  the PR was merged, never authorized a deletion, and the `PreToolUse` guard that fired was advisory
  text an agent could rationalize past.
- **REAPER RECORDING SESSIONS & RATE LIMIT SAFETY:** When running REAPER music recording sessions
  via Reaper MCP:
  1. REAPER DAW, audio interfaces, recorded WAV audio stems, and `.RPP` project files live locally
     on the user's computer and are 100% safe from rate limit interruptions.
  2. Google does NOT broadcast an advance warning gauge prior to hitting temporary hourly rate
     limits (`429 Rate Limit Exceeded`).
  3. Use **`Flash Med`** for routine, high-volume REAPER operations (`transport_play`,
     `transport_stop`, `track_create`, volume/pan tweaks, clip splits) to preserve hourly token
     headroom.
  4. Reserve **`Flash High`** for complex multi-track creative mixing, sidechain routing, and
     intricate composition passes.
  5. Always execute a project save (`project_save`) before running large multi-step automated
     sequences.
- **MAIN BRANCH PRs MUST ORIGINATE FROM DEV:** Across all 8 active WebJamApps repos, any PR
  targeting `main` must originate from `dev` as its head branch (`dev` → `main`). Feature branches
  (`gemini/*`, `claude/*`, `feat/*`, `fix/*`) must target `dev` as their base branch. Direct PRs
  from feature branches to `main` are strictly forbidden and blocked by CI and script guardrails
  (web-jam-tools#351 "all 8 active github repos - their main branch only accepts PR requests from
  their dev branch").
- **MULTI-REPO ISSUES STAY OPEN UNTIL ALL REPOS ARE COMPLETE:** When an issue explicitly covers
  multiple repositories (e.g. "all 8 active github repos"), no single PR in one repository may pass
  `--closes` or claim the issue is completed. PRs in individual repos must use `--part-of` so the
  tracking issue remains OPEN until the final repository's PR is merged.
- **POST-MERGE MANUAL STEPS BECOME THEIR OWN `Josh` ISSUE:** A manual step Josh must perform — an
  installer run, a session restart, a scheduled/cron cycle, a prod deploy, a third-party dashboard
  change — never lives inside an agent's execution issue. It is filed as its own `Josh`-labeled
  issue, paired with the agent's issue and `Blocked` on it (both the label and the native
  dependency). The agent's PR then closes the agent's issue normally with `Closes #N`, because that
  issue no longer contains anything the agent could not do from a branch. The pairing rules live in
  the `/design-issue` skill, which owns how those two issues are written.
  - **PR-open-time test:** Before opening a PR, check: _does any acceptance criterion require
    something an implementing agent cannot do from a branch?_ If yes, that criterion belongs in a
    separate `Josh` issue, not in this one.
  - **`--no-close` is the residual case only.** Where a criterion genuinely cannot be split out into
    its own issue, the PR passes `--no-close` (with an optional reason via `--no-close-reason
    "<text>"` or `--no-close-reason-file PATH`) and Josh closes the issue by hand once the
    post-merge steps are verified. Splitting is the default; this is the exception.
  - **Verification command:** To verify that a PR does not close its linked issue, run:
    ```bash
    gh pr view <N> --repo WebJamApps/<repo> --json closingIssuesReferences
    ```
    An **empty array** (`[]`) in `closingIssuesReferences` is the only valid proof that GitHub will
    not auto-close the issue on merge. Body text prose alone is NOT proof, because GitHub parses the
    keyword rather than prose.
  - **Designed Issues with Paired Manual Steps Become Parent Epics:** When `/design-issue` resolves an
    existing issue into paired implementation and Josh manual verification tasks, convert the target
    designed issue into native type `Epic` (via GraphQL `updateIssue` with the repo's `Epic`
    `issueTypeId`), file the executable coding work as a child `Task` sub-issue attached under that
    Epic, and file the paired `Josh` manual verification task as a child `Task` sub-issue attached
    under that same Epic (marked `Blocked` on the coding child). The parent Epic body carries the
    sub-issue list and closes when all sub-issues close.
  - **Manual Step Issue & Document Title Rule:** Never prefix issue titles or runbook document
    titles with personal names (e.g. do NOT name an issue "Josh: ..."). Use professional,
    action-oriented titles like `Manual verification: ...` or `Verification: ...`. Ownership and
    responsibility are designated exclusively by the `Josh` label or assignees, never by embedding
    a personal name in the issue or document title.
  - **One action per step, one surface per step:** A numbered step in a runbook is a single physical
    action in a single place. Never combine opening a session with asking that session something, and
    never cover two surfaces in one step — two surfaces asking one question is four steps, not one.
    State explicitly what happens to a session afterwards (leave it open, close it, move to the next
    terminal). Where order matters, the numbering IS the instruction. Origin: web-jam-tools#510 "Josh:
    verify live that agy and Claude Code read the rules through the pointer in a converted repo" —
    its runbook listed both the `claude` and the `agy` launch commands under one step with the
    question below them, and Josh opened two terminals, closed them, then reopened them one at a time
    to work out the intended order. His verdict: "these should have been 4 steps".
- **THE `Blocked` LABEL IS CANONICAL — NATIVE ISSUE DEPENDENCIES DO NOT REPLACE IT.** Josh wants
  BOTH: native GitHub issue-dependency links (the real relationship between issues) AND the
  `Blocked` label (capital B, hex `B60205`, `repos: all` in `skills/fix-labels/labels.yaml`) as the
  at-a-glance signal that makes an unworkable issue obvious in a plain list view without opening
  each issue. They do different jobs: use a native dependency whenever a **specific issue** blocks
  the work — it names which one, renders in the Issues list, and clears itself on close. Use the
  `Blocked` label whenever the work is unworkable **for any reason**, including the many with no
  issue to point at (a vendor, a credential Josh must generate, a physical action). Native
  dependencies cannot express that case at all, which is why the label is not redundant. No agent
  may prune `Blocked` from `labels.yaml` (or delete it live) on the theory that native dependencies
  made it redundant — that is exactly what happened once already: `blocked` (lowercase) was removed
  in commit 7d2523d as part of a nine-label prune shipped for web-jam-tools#300, justified as "->
  native issue dependencies," and Josh never actually agreed to that one — it rode along in a batch
  whose headline was about priority labels. web-jam-tools#329 "Restore the Blocked label as
  canonical in labels.yaml — it was pruned in a batch Josh never ratified, and he wants it alongside
  native dependencies" restored it. See `skills/fix-labels/labels.yaml`'s `Blocked` entry for the
  full rationale.
- **RESTRICTED LAPTOP DROPBOX SCOPE & SECURITY GUARDRAILS:** Access to `~/Dropbox` on the laptop is
  restricted to three approved top-level folders: `joshandmariamusic`, `web-jam-llms`, and
  `mark_henrickson`. All other top-level `~/Dropbox/*` folders — including `Dropbox/WebJamApps` —
  are explicitly denied in `permissions.deny` via `install-hooks.sh` for file tools (`Read`, `Edit`,
  `Write`) and Dropbox MCP mutation tools (`delete`, `move`). Note: Deny rules on file tools do not
  constrain raw Bash commands (which use string-pattern matching for Bash permission rules), serving
  as an operational guardrail rather than an absolute security boundary (web-jam-tools#321 "Add the
  laptop Dropbox deny list, verify Flash confinement, and document the restricted scope").
- **APPROVAL IS PER GATE.** Approval of a design is not approval to file the tracking issue.
  Approval of an issue is not approval to dispatch. Each gate needs its own imperative from Josh
  naming that step. An agent writes the issue body to a file (or shows it in chat) and waits; the
  `gh issue create` call (or MCP `issue_write` create) follows only the words "file it" (or
  equivalent). A dispatch (spawning a subagent, an agy/Flash handoff) follows only an explicit
  instruction to dispatch. A single "go" is ambiguous across gates and must never be read as
  covering more than one — the expensive, hard-to-reverse half (issue noise, spawned tokens) is
  always the later gate, so collapsing gates fails in the direction that costs the most. Origin:
  2026-08-07, during web-jam-tools#426 "/handle-gmails: add recognizers that propose the follow-up
  work an email implies, plus a per-session PR that teaches the skill what it learned" design, an
  agent treated Josh's single approval of a three-item plan as covering the design, the issue
  filing, AND the dispatch — announcing "filing the tracking issue, then dispatching to Sonnet"
  before either gate had its own go-ahead. Josh stopped it at the draft stage. See web-jam-tools#433
  "gate issue creation and dispatch mechanically, and write the approval-is-per-gate rule" for the
  mechanical half of this fix (ask-rules on `gh issue create` and MCP `issue_write` create,
  installed via `scripts/install-hooks.sh`).
- **ACCURATE TEST ASSERTIONS FOR NEWLY IMPLEMENTED FEATURES:** When writing unit tests for new
  features or CLI flags (such as mode-modifying flags like `--update` or `--no-close`), test
  assertions must explicitly verify the specific mode indicator or feature-specific output (e.g.
  asserting `DRY RUN (UPDATE` or exact flag output) to prove the feature took effect, rather than
  relying only on assertions shared with default paths.
- **DESIGN WORK RUNS THROUGH `/design-issue`:** Design work — options, trade-offs, decisions worth
  recording — does not happen in plain chat. The moment a conversation turns into design, invoke
  `/design-issue` and work inside it.
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

     **The test, and it is the whole of it: if the two copies disagree, is there a genuine question
     about which one is correct?**
     - **Yes → this rule applies.** Each copy is editable and each is treated as the source in its
       own context. Eight `AGENTS.md` files, each read as authoritative by whatever agent opened
       that repo, is the banned shape.
     - **No → this rule does NOT apply, and never did.** Backups, mirrors, caches, generated
       artifacts and build output are one-directional and derived: written from an original, never
       edited in place, never consulted as the truth while the original exists. A stale backup is a
       snapshot being old, not a conflict. `claude-backup/` and the pre-scrub repo mirror under
       `backups/` in `~/Dropbox/web-jam-llms/` are legitimate and are not what this rule is about.
       Neither is a cache, a lockfile, or a generated `dist/`.

     **Better than either: make drift physically impossible.** `~/Dropbox/web-jam-llms/package.json`
     is a symlink to `~/WebJamApps/package.json` — one file reachable by two paths, so the copies
     cannot diverge and no machinery is needed to check that they haven't. Where a single artifact
     genuinely must be reachable from two places, prefer that over any mechanism that compares.
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

  Origin: web-jam-tools#437 "Eliminate the 8-way AGENTS.md duplication — the cross-AI rules block is
  committed to 8 repos and kept in step by a sync script, a drift check, a hook, a CI gate and two
  tests". A ~189-line rules block was committed into `AGENTS.md` in eight repositories —
  roughly 1,500 duplicated lines — and held in step by a generator, a `--check` drift mode, a
  SessionStart hook, a CI gate and two tests. **The CI gate never could detect drift**: the
  generator skips repositories absent from the machine, so in CI seven of eight were skipped and the
  gate passed having compared one file against itself. Five mechanisms, and the one that ran
  everywhere was structurally incapable of working. Compounding it on 2026-08-13: a child issue had
  restated requirements that its own design section contradicted, an agent followed the issue rather
  than the document, and wrote to a file outside every git repository to satisfy a criterion that
  should never have existed.
- **A PR FOR A HOOK ISSUE NEVER CLOSES THE ISSUE.** When an issue adds or changes a hook — a git
  hook, a Claude Code hook, any hook installed onto a machine — the PR body carries no closing
  keyword (`Closes`, `Fixes`, `Resolves`) for it. Use `Part of <repo>#<number>` instead. After the
  PR merges, the hook is installed and confirmed to actually fire, and only then is the issue closed
  by hand.

  Josh, 2026-08-19: _"whenever we create an issue involving hooks, the PR should never close on
  merge, it should always remain open so we can install the hook and/or confirm the hook is working,
  then the issue gets closed manually"_.

## DESIGN CLAIMS MUST CARRY RECEIPTS (wjt#305)

A settled design shipped an unverified claim as established fact, sitting unmarked right next to
claims that HAD been verified with live commands. Josh had no way to tell an assertion from a
receipt — they read as equally solid. These rules exist to prevent that class of failure.

### Rule 1 — requirement-critical claims carry a receipt or a warning label

Any statement in a design, spec, issue comment, or PR body that answers a stated requirement of
Josh's must either:

- carry its receipt inline — the exact command run and its actual output, or a screenshot; or
- be explicitly tagged `ASSUMPTION — NOT VERIFIED`.

A design may **not** be marked settled/approved while any requirement-critical claim is unmarked. If
there is no command that could produce a receipt, that is itself the signal that the claim needs a
different kind of verification — say so instead of asserting it.

### Rule 2 — a UI requirement can never be verified through an API

If the requirement is about what Josh can **see**, the only acceptable evidence is a screenshot, or
Josh's own confirmation that he sees it. API calls, REST payloads, and CLI output do not count and
never have. Marking a design settled on API-only evidence when the requirement is a UI requirement
is a hard blocker, not a nit.

Origin: web-jam-tools#287 "fix-labels skill expanded / corrected" — the design asserted "field
values appear in the issue sidebar and in search" without a screenshot, Josh accepted the design on
that basis, the org-wide migration in web-jam-tools#298 "Migrate existing issues to native
Priority/Area fields, Type, and dependencies (org-wide)" was verified entirely through REST, and
Josh then could not find the `Area` field in the browser at all.

## EPIC AND SUB-ISSUE COHERENCE (wjt#326)

An epic was put in front of Josh for approval while it contradicted its own sub-issues. Two
permission rules he had never approved sat as acceptance criteria on a sub-issue while the epic
still listed them as awaiting his ruling; separately, a decision he HAD made was still recorded as
"still open" in an epic comment written 24 minutes before he ruled. His approval gate was reviewing
a different document than agents would have built from. These rules exist to prevent that class of
failure.

The root cause is structural, not carelessness. Sub-issues are deliberately written self-contained
("everything needed is below — do not go looking for context on the parent epic") so a dispatched
agent need not load the epic. That is correct for dispatch economics, and it is exactly what
guarantees drift: every decision ends up written down in three places, and a ruling updates only the
artifact the agent happened to be editing at the time.

### Rule 1 — implementation detail may be duplicated; approval status may not

A sub-issue may restate as much build detail as it needs in order to stay self-contained. It must
**never** assert whether Josh approved something.

- Approval status lives in exactly ONE artifact per epic: the epic body, or a single
  decisions-ledger comment on it that is edited in place — never appended to, never superseded by a
  later comment.
- Where a sub-issue needs to refer to approval status, it links: "approval status: see the parent
  epic". It does not restate the answer.
- An unapproved item may still be written up as an acceptance criterion, but it carries
  `NOT APPROVED — do not build` inline, and the epic remains the only place that records when that
  changes.

Rationale: duplicated build detail that drifts produces a wrong implementation, which tests and
review catch. Duplicated approval status that drifts produces work Josh never sanctioned, which
nothing catches — because the document he reviewed told him it was still his call.

### Rule 2 — run a coherence check before asking Josh to review an epic

Before telling Josh an epic is ready for review or approval, dispatch a cheap (Haiku) read-only
check that loads the epic body, every comment on it, and every sub-issue, and reports:

- any decision recorded as settled in one artifact and open in another;
- any acceptance criterion whose approval status is unstated or contradicted;
- any item marked "deferred to a follow-up" with no such issue actually filed;
- any checkbox whose ticked state disagrees with the prose around it.

Report the findings to Josh together with the review request — not silently fixed, not omitted. "I
found nothing" is a valid and useful result.

This is not optional polish. Josh's review is the only gate in the workflow; an epic that is
internally inconsistent makes that gate meaningless.

### Rule 3 — "deferred to a follow-up" requires the follow-up to exist

An item deferred out of an epic is filed as a real issue before the epic closes, or it is not
deferred and stays in the epic. "Deferred" with no issue behind it is deletion with extra steps —
and it lands hardest on exactly the items that got deferred because they were hard.

### Rule 4 — a ruling becomes a tracked issue in the same session

A ruling becomes a tracked issue in the same session. When Josh decides something, file the GitHub
issue for it before the session ends. Writing it into a design document, a Dropbox record, or agent
memory is not tracking the work — none of those carry a routing label, none can be dispatched, and
none can be closed. A decision recorded only in a document surfaces again only if someone happens to
re-read that document. This applies with particular force when the resulting work is Josh's own
manual steps, which must never live only in a chat or a doc. Do not report a decision as "settled
and recorded" when only a document was written. The document keeps the reasoning; the issue is the
tracking surface; link them both ways.

## STANDALONE EXECUTABLE ISSUES AND EPIC TYPES (wjt#342)

Every actionable GitHub issue body (not typed `Epic`) must be fully self-contained and executable on
its own. An issue body may not rely on unresolvable pointer phrases such as "see the comment", "see
comment", "read the comment first", "read comment first", "as discussed above", "as discussed in",
"per the discussion", "in the epic", or "see the epic".

- **Author-in-sub-issues-first guidance**: When breaking down work or decomposing an Epic into
  sub-issues, author the full requirements, acceptance criteria, and technical context directly in
  each sub-issue body _first_. Do not write the requirements only in an Epic comment or discussion
  thread and point sub-issues to it with pointer phrases.
- **Sync requirements**: If requirements evolve or decisions are made during discussion in an Epic
  or comment thread, update the sub-issue body itself so the sub-issue remains the single,
  standalone source of truth for the assigned model or agent.
- **Native `Epic` issue types**: Native issue type `Epic` (which is orthogonal to model labels like
  `Sonnet` or `Opus`) is exempt from pointer-phrase blocking on edit operations (`gh issue edit` or
  MCP `issue_write` update) to allow high-level tracking documents and comment-based discussions to
  evolve.

## FE/BE COUPLING (wjt#240)

A change with a back-end half and a front-end half can ship half-done — e.g. the "venue must have a
physical address" BE rule shipped before the create-Gigs "new venue" FE flow collected an address,
and broke prod. These rules exist to prevent that class of failure.

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
  issue/PR; project facts → that project's memory dir; only cross-project routing/strategy lessons →
  web-jam-llms memory or this doc.
