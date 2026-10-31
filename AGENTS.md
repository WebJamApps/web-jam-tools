# Agent Instructions for WebJamApps

This file contains instructions and context for every AI agent (Claude Code, agy/Antigravity, and
any other assistant) working in this workspace.

## Cross-AI hard rules

The cross-AI hard rules that bind every agent on every surface are NOT duplicated here. They live in
exactly one file: `docs/cross-ai-rules.md` in the **`web-jam-tools` repository**, which normally
sits alongside this repository — `../web-jam-tools/docs/cross-ai-rules.md`, and on Josh's laptop
`/home/joshua/WebJamApps/web-jam-tools/docs/cross-ai-rules.md`.

Read that file before acting. If you cannot find it, STOP and say so — do not proceed without the
rules and do not reconstruct them from memory or from this file.

## Read also

- [docs/ai-team-playbook.md](docs/ai-team-playbook.md) — the current AI team, what each tier is best
  at, tier order across model labels, how work hands off, and where Josh approves.
- [docs/cross-ai-rules.md](docs/cross-ai-rules.md) — cross-AI operational rules (voice rules, file
  placement, protected files, canonical task queues, memory hygiene) that apply to every AI on the
  team. Its **FE/BE COUPLING** section covers the backward-compat/expand-contract rule for shared
  BE/FE contracts and the `FE-couples:`/`Coupling-override:` conventions — read it before shipping a
  front-end half of coupled work.
- [docs/playwright-mcp.md](docs/playwright-mcp.md) — setup and operational guidelines for using
  Playwright MCP server (`@playwright/mcp`) to debug production websites.
- [docs/agy-hooks.md](docs/agy-hooks.md) — the agy (Antigravity/Flash) PreToolUse/PostToolUse hook
  contract as measured, the translation shim that makes hooks actually enforce there, and the
  Antigravity Gmail MCP setup + send/delete fence built on top of it.

## Workspace Overview

- **Root Directory:** `/home/joshua/WebJamApps`
- **Primary Projects:** JaMmusic, AppersonAuto, CollegeLutheran, web-jam-back, WebJamPg, etc.
- **Tools Repo:** `web-jam-tools` (this repository)

## Collaboration Rules

1. **Rclone Mount:** Google Drive is mounted at `~/gdrive` via a systemd user service
   (`rclone-gdrive.service`).
2. **Coding Standards:** Refer to individual project `AGENTS.md`/`CLAUDE.md` files (if present) for
   specific technology stacks.
3. **Repository Purpose:** `web-jam-tools` serves as a central hub for shared configurations,
   documentation of system setups, and general workspace memory.
4. **No Merging to DEV:** AI agents are **NOT** allowed to merge PR changes to the `dev` or `main`
   branches. The user acts as the mandatory human-in-the-loop reviewer and is responsible for all
   merges.
5. **Mandatory Isolated Worktrees & Clean Local Dev Discipline:** In `web-jam-tools`, all task work,
   bug fixes, investigation repros, and file edits MUST be performed strictly inside an isolated git
   worktree (e.g. `/tmp/agy-worktrees/...` or `.claude/worktrees/...`). Agents are STRICTLY
   FORBIDDEN from editing files, staging changes, creating branches, committing, or leaving
   uncommitted edits directly in the main clone (`/home/joshua/WebJamApps/web-jam-tools`). The main
   local clone for `web-jam-tools` MUST always remain checked out on `dev` with a clean working tree
   (note: this rule is specific to `web-jam-tools` and differs from UI projects).
6. **PreToolUse Hook Path Fencing:** When implementing PreToolUse path/repo fencing hooks, do not
   treat a non-git working directory as an implicit trusted repository root. Fail closed on non-git
   directories so writes to sensitive paths (such as `~/.claude/CLAUDE.md`) remain blocked even when
   a session is opened at home or outside a git repository.
10. **Pre-Existing Hook Permission & Git Index Immutability:** Do not stage or commit permission
    mode changes (`100644` → `100755`) on pre-existing hook files (`hooks/agy-hook-shim.sh`,
    `hooks/agy-model-guard.sh`, `hooks/block-agy-gmail-send-delete.sh`) unless the issue is
    explicitly about modifying those hook files. When local work requires executing shell scripts
    with `chmod +x`, ensure the git index mode matches `origin/dev` before committing by verifying
    `git diff origin/dev...HEAD --summary` carries no unrelated file mode changes.
12. **Task Command Verification in Documentation & CLIs:** Whenever documenting or printing runnable
    commands as `deno task <task-name> ...` or `npm run <script> ...` (in `SKILL.md`, CLI `--help`
    text, usage strings, or error messages), verify that the task/script name is actually registered
    in `deno.json`'s `"tasks"` (or `package.json`'s `"scripts"`). Never document or print
    non-existent task commands that fail with `Task not found` when an agent or developer follows
    them.
13. **Strict Foreign-Key Equality & Conflict Handling:** When validating whether an entity is
    already linked to a target record (e.g., `gig.venueId === targetVenueId`), never combine the
    equality check with a truthiness fallback (such as `id === target || Boolean(id)`), which
    collapses the condition into a bare existence check and treats mismatched links as matches.
    Always require strict equality, and handle the mismatched case (`id && id !== target`)
    explicitly as a conflict rather than misreporting it as already linked.
14. **Phased Data Migrations & Expand-Contract Discipline:** In multi-phase database migrations and
    field transitions (e.g. retiring legacy artist slugs, renaming columns, changing MongoDB schema
    filters):
    - **Phase 1: Widening (Expand):** Readers, query filters, and API consumers must first be
      widened to accept both legacy and new values, landing before any data is migrated.
    - **Phase 2: Operational Data Migration:** The data migration script (e.g.
      `heroku run "npm run migrate:..."`) is executed against production. This is an operational
      runbook step typically performed by Josh after the widening PR merges.
    - **Phase 3: Narrowing (Contract):** Only AFTER the operational data migration has verifiably
      run and completed against production (with verification evidence confirmed in the tracking
      issue or live production queries), agents may open or implement the narrowing PR that retires
      legacy values and removes fallback filters.
    - **Never Preemptively Implement Narrowing:** Agents must NEVER open, implement, or merge PRs
      for the narrowing phase while the production data migration remains unexecuted or unverified.
      Doing so breaks production consumers (e.g. emptying query results) the moment the PR deploys.
      If an assigned issue contains both widening and narrowing phases, the narrowing phase must
      remain held/blocked until operational execution is confirmed.
15. **Venue Hold Field Separation & Write-Path Mutation Safety:**
    - **Never Conflate Contact Holds with Calendar Limits:** Never conflate "do not contact until"
      (`resumeBooking`) with "calendar dates booked through" (`bookedThrough`). `resumeBooking`
      represents a contact hold (the venue asked for space, compared against TODAY — e.g. "try again
      in 4 months"), whereas `bookedThrough` means dates are booked solid while outreach remains
      eligible today (compared against the TARGET WINDOW being pitched — e.g. Olde Salem Brewing
      booked through 2026 but pitchable today for January 2027). CLI and skill write tools must keep
      their arguments separate (`--until`/`--resume` for `resumeBooking` at UTC `00:00:00.000Z`;
      `--booked-through` for `bookedThrough` at UTC `23:59:59.999Z`), never deriving or defaulting
      one from the other.
    - **Mutation Safety on Venue Resolution:** On mutation/write paths that modify database records
      (such as holds or gig-linking), never use reverse string containment
      (`query.includes(venue)`), which risks a longer query matching a short venue name it merely
      contains and silently mutating the wrong record. Require exact ID, exact name, exact
      normalized name, or strict forward containment (`venue.includes(query)`) with a minimum length
      floor (>= 3 characters) and strict ambiguity detection.
17. **Client-Side Candidate Enrichment & Safety Fencing:** When a client-side reporting tool is
    required to display granular status badges for records that a single backend endpoint (e.g.
    `GET /outreach/candidates`) filters out by design, do not introduce phantom fields that the
    endpoint cannot return. The client must either consume backend-provided held/excluded candidate
    structures or enrich candidate pools by cross-referencing related endpoints (e.g. `GET /venue`,
    `GET /outreach`), while strictly setting safety exclusion flags (`isExcluded: true`) so held,
    conflicting, or direct-chat venues are excluded from drafting, pitch generation, and batch
    dispatch.
19. **Fail-Closed Confirmation Guards, Design Fidelity & CLI Test Isolation:**
    - **Fail-Closed Confirmation Guards:** Any confirmation flag (e.g. `--confirm-drafts`) must
      default-deny and fail closed on all non-affirmative, negative, empty, or malformed `=<value>`
      inputs. Only exact affirmative values (bare flag, or `=true`/`=yes`/`=1`) evaluate to
      confirmed. Tests must cover negative and malformed variations.
    - **Design Alignment over Generic Aliases:** Never introduce generic or unapproved aliases (such
      as `--confirm`) that contradict governing design documents or re-open the conflation the
      explicit naming prevents.
    - **CLI Test Filesystem Isolation:** CLI test suites running commands that produce persistent
      run logs, reports, or artifacts must never write to live production or user directories
      (`${HOME}/Dropbox/...`). Tests must isolate filesystem writes by setting `HOME` or target
      paths to a scoped temporary directory (`Deno.makeTempDir()`).
    - **Zero-Cost Early Refusal:** Place prerequisite validation guards as early as possible before
      initiating expensive or network-bound operations.
20. **Gate 1 Candidate Filtering & Approval Set Integrity:**
    - **Fail-Closed on Unmatched or Partially Unmatched Venue Filters:** When filtering candidates
      by explicit venue names or IDs (e.g. `--venues`), if the filter matches zero eligible
      candidates OR contains any unmatched entries (partial mismatch), the process must immediately
      fail closed and abort without writing an approval record, reporting the specific unmatched
      entries. It must never silently fall back to approving the entire candidate pool or record an
      under-approved subset where the user believed they approved every named venue.
    - **No Silent Approval Overwrites (D-54):** Because backend batch approval endpoints upsert on
      batchId/weekend, recording Gate 1 approval classifies the requested venue set against the
      stored one and never simply overwrites it. A set that keeps every stored venue and adds others
      is a **widening**: it is re-recorded as a whole, with the stored set printed beside the new
      one before writing, and dispatch then reaches only the approved venues carrying no outreach
      record for that weekend, so a widening never re-mails an already-pitched venue. A set that
      **removes or replaces** a stored venue is refused outright and nothing is recorded. A re-run
      with the identical venue set remains a harmless no-op. No flag overrides this; there is no
      `--re-record`.
    - **Fail Closed When Prior-Approval State Cannot Be Read (D-54):** The re-record classification
      above depends on a network lookup, so its third outcome is specified: when that lookup cannot
      determine whether a prior approval exists — a non-2xx status, an unparseable body, an expired
      token, or a dropped connection — the command must **refuse** and make no POST. Only a genuine
      HTTP 404 may be read as "no approval exists". A lookup that returned nothing and a lookup that
      could not run are indistinguishable to the caller, and treating the second as the first would
      silently replace a vetted approval through the backend's upsert on the weekend key.
    - **Never Synthesize or Fabricate Approved Entities:** Never fabricate or synthesize candidate
      records (e.g. `{ _id, name: _id }`) from unmatched command-line arguments to bypass
      candidate-set membership. Every approved entity in an authoritative gate must verifiably
      originate from the vetted candidate set and satisfy all eligibility criteria (valid ID, active
      booking email, and no spacing/hold exclusions).
    - **Align Eligibility Predicates Across Approval Gates:** The candidate eligibility predicate
      used at Gate 1 (`c._id && c.email && !c.isExcluded`) must strictly match the predicate
      enforced at Gate 2 and dispatch, so that recorded approvals never diverge from dispatchable
      sets.
21. **Scoped Task Permissions & Fail-Closed Harvesting Discipline:**
    - **Scoped Permissions in Task Registries (`deno.json`):** Task commands defined in `deno.json`
      must NOT use blanket, unscoped permission flags (`--allow-read`, `--allow-env`, `--allow-net`,
      or `-A`). Permissions must be strictly scoped to least privilege: `--allow-net` restricted to
      specific external API/scrape hosts and backend hosts; `--allow-env` restricted to explicitly
      required variables (e.g. `HOME,WEB_JAM_LLM_TOKEN,WEB_JAM_BACK_URL`); and `--allow-read`
      restricted to the target skill/data directory and specific token file paths (e.g.
      `skills/venue-mining,$HOME/Dropbox/web-jam-llms/web-jam-llm.token`).
22. **Sticky Table Headers with Border Collapse:** When implementing sticky `th` headers in HTML
    tables using `border-collapse: collapse`, native CSS `border-top` / `border-bottom` dividers
    disappear or drop out during vertical scrolling in web engines. Always preserve divider lines by
    applying inset box-shadows on sticky cells:
    `box-shadow: inset 0 1px 0 var(--border-color), inset 0 -1px 0 var(--border-color);`.
23. **Client-Side Script Behavioral Test Coverage:** When generating standalone HTML containing
    embedded `<script>` client interactivity (such as table pagination, filtering, or sorting), unit
    tests must not rely solely on static source-string matching
    (`assertStringIncludes(html, "...")`). Extract pure state calculation functions (e.g.,
    `computeTablePagination`) or run behavioral tests that assert directly on computed pagination
    ranges, page clamping, edge cases, and control states.
24. **Top-Level Tooling Config Parity with Explicit Task Path Invocations:** When expanding
    code-quality or CI gates (such as `deno check`, `deno fmt`, `deno lint`, ESLint, or Prettier) to
    cover additional top-level project directories (e.g. `hooks/`, `scripts/`, `tools/`), never
    update only the script/task definitions that pass explicit command-line paths. Always keep the
    root configuration files (`deno.json`, `.eslintrc`, `biome.json`, etc.) top-level
    `include`/`files` arrays synchronized to include those same directories. If top-level `include`
    arrays are left narrower than task commands, bare tool invocations run by editors, IDE
    integrations, pre-commit hooks, or developers by hand will silently skip files in the omitted
    directories.
25. **Hook Wrapper Switch-Aware Routing & End-to-End Shell Entry Point Coverage:**
    - **Never Bypass Switch Evaluation in Shell Wrappers:** When adding an off-switch, release
      token, or bypass mechanism to a guarded workflow or hook, shell entry point wrappers
      (`hooks/*.sh`) must never emit early denials or exit on unparseable inputs, tool errors, or
      format failures before consulting the switch-aware evaluator module. All potential refusal
      paths must route through switch evaluation so an active switch can release a wrongly-refusing
      guard on its next invocation.
    - **Installed Shell Entry Point Regression Coverage:** Integration tests for hook switches must
      invoke the outer shell script entry point (not only the underlying TypeScript module) against
      unparseable inputs and malformed payloads under active switch conditions, proving that the
      shell script actually emits an allow decision and logs the release.
    - **Verifiable Refusal Fixtures in Runbooks & PR Plans:** When authoring runbooks or test plans
      verifying refusal-to-release transitions, never point to non-existent transcript or state
      paths that fail open to allow by default. Always create genuine fixtures representing
      unapproved states so the refusal is verifiably reproduced before testing release and cleanup.
26. **Folding `/learn` AGENTS.md Updates into the Same Feature Branch & PR:** When instructed to run
    `/learn` and push up `AGENTS.md` (or when folding lessons learned into rules during task work or
    PR reviews), the resulting updates to `AGENTS.md` must be committed directly onto the active
    feature branch and included in the same PR (e.g. `chore: fold /learn updates into AGENTS.md`)
    and pushed up together with the work. Never open a separate PR, never defer updating `AGENTS.md`
    to a follow-up step, and never leave `AGENTS.md` unpushed or waiting for a post-merge step on
    `dev`.
27. **Complete Service Tool Surface Coverage & Permission Drift Detection:**
    - **Enumerate Full Permission-Altering Surfaces in Rulesets:** When implementing
      permission-consent requirements for an external service or MCP server (such as Google Drive or
      Gmail), never limit prompt/ask or denial rules to deletion alone when the requirements or
      acceptance criteria specify sharing, permission modification, or access alteration. Every
      identified permission-altering tool (e.g. `mcp__google-drive__addPermission`,
      `mcp__google-drive__updatePermission`, `mcp__claude_ai_Google_Drive__share_file`) must be
      explicitly enumerated in `ASK_RULES` or `DENY_RULES`.
    - **Comprehensive Permission Reconciliation & Drift Test Coverage:** Test suites validating
      permission installer rules (`scripts/install-hooks.sh` and
      `scripts/merge-hooks-into-settings.ts`) must include explicit controls verifying: (1) each
      tool is assigned to the correct permission tier (`ask` or `deny`) and absent from opposite
      tiers; (2) pre-existing or stale entries in `permissions.allow` are automatically
      retracted/stripped upon installation; (3) `--check` mode flags misplaced or cross-listed allow
      entries as configuration drift with non-zero exit codes; and (4) unrelated read-only or safe
      tools remain unaffected.
28. **Candidate Skill/Config Execution Isolation & Bounded Process Timeout Enforcement:**
    - **Candidate Configuration Isolation in Agent Runners:** Verification and start-check runners
      executing agent sessions (Claude Code, agy, Codex) against repository candidates must load the
      requested candidate using session-local configuration, or verify that the installed
      instructions and resources match the candidate byte for byte and refuse any mismatch. Shared
      user skill links must never be temporarily swapped. Test suites must include regressions
      proving that a differing candidate is either exercised in isolation or refused before
      execution; the unchanged installed `dev` copy must never produce a result for a differing
      candidate.
    - **Bounded Subprocess Timeout Escalation & Stream Cleanup:** Subprocess executors enforcing
      execution deadlines must never rely solely on `AbortSignal` or single-signal termination
      (`SIGTERM`) combined with un-cancelled pipe reading (`cmd.output()`), which hangs indefinitely
      if a subprocess traps `SIGTERM` or if background child processes inherit and retain open
      `stdout`/`stderr` handles. Executors must cancel streams and escalate termination (SIGTERM ->
      bounded grace period -> SIGKILL). Test suites must include subprocess regressions verifying
      timely return when signals are trapped and pipes are retained.
29. **Helper Ancestry & Skill Discovery Test Isolation:** The helper-ancestry and skill-discovery
    test-isolation rules for hooks live in [docs/agy-hooks.md](docs/agy-hooks.md) ("Helper ancestry
    rules"). Read them before changing hook permission or skill-run inheritance.
30. **First-Match Decision Table Ordering & Reachability Test Coverage:**
    - **Fallback / Catch-All Ordering After Specific Tests:** In top-down decision tables, pattern-matching cascades, or priority-selection rules evaluated under a first-match rule (such as `skills/file-issue/SKILL.md` rule 10 Priority level tests), catch-all or default fallback rows (e.g. "Nothing above fits", "default") must ALWAYS be ordered after all specific condition rows (including "Low" or lower-priority specific conditions). Even if an upstream design document drafts the default above lower levels, the agent must recognize that placing a fallback above specific tests makes subsequent rows unreachable dead rules, and order the fallback last.
    - **Reachability and Order Assertions in Rule Validation:** Unit and validation test suites for decision tables or skill instructions must never rely solely on disjoint `text.includes(...)` substring checks that only verify the presence of isolated rule strings. Tests must explicitly assert relative rule ordering and reachability (e.g. `lowIndex < mediumIndex`), and test suites must include negative regression cases verifying that misordering a fallback above specific tests fails validation.
31. **Full Edit Reconciliation & Superseded Exception Removal on Rule Changes:**
    - **Reconcile Surrounding Clauses and Exceptions on Instruction Updates:** When updating or replacing an instruction in a skill, rule, or design document (such as replacing "One row per Epic or standalone Issue" with "One row and one version bump per design run"), never stop at changing a single targeted bullet or line. Re-read and reconcile the surrounding introductory sentences, adjacent bullets, qualifiers, and exceptions (such as obsolete Epic-based rollup exceptions). Retaining superseded exceptions creates contradictory guidance (e.g. telling a run to append one row per run while an adjacent bullet tells it that child issues roll up without a version bump).
    - **Reject Superseded Exceptions in Validation Tests:** Validation test suites for rule changes must never rely solely on a single string-exclusion test (e.g. `assertFalse(text.includes("One row per Epic"))`) that allows contradictory retained instructions or exception clauses to survive. Tests must actively assert that all contradictory retained instructions and superseded exception patterns are rejected, with negative test cases verifying that retaining obsolete exceptions fails validation.
32. **Fail-Closed Shell Check Classification & Command Substitution Status Capture:**
    - **Capture Command Substitution Exit Codes via `|| status=$?`:** In Bash, never capture the
      exit status of a command substitution inside an inverted `if ! var=$(cmd); then status=$?; fi`
      condition. Because `!` inverts the pipeline return value to 0, `$?` inside the `then` block
      evaluates to `0` rather than the non-zero exit code of `cmd`. Always assign exit status
      directly using `var=$(cmd) || status=$?` before evaluating `status`.
    - **Evaluate Specific Failure Classifications Before Catch-All Non-Zero Checks:** In shell hook
      or config drift checkers that parse evaluator output, specific failure strings (such as
      `msg="missing"`) must be evaluated before generic non-zero status checks (`status -ne 0` /
      `msg="not_last"`). Generic non-zero branches evaluated prematurely catch all non-zero returns
      and misclassify specific missing or corrupted states as generic drift.
    - **Preserve Hook Registry Placement and End Ordering:** When installing or reconciling hook
      chains where a specific handler must execute last (such as skill-run or prompt-watch hooks),
      reconciliation steps must guarantee that handlers are moved to the end of the registry array
      across all matched blocks and that re-ordering logic accounts for managed hook pruning.
33. **Fail-Closed Verification, Probe Log Integrity & CLI Alias Wiring:**
    - **Never Certify Safety from Incomplete, Corrupted, or Empty Inputs:** In safety verification and auditing tools (such as probe log analyzers, lyric checkers, and security sweeps), parse errors, corrupted records, truncated payloads, or empty inputs must never be skipped or treated as a clean pass. A damaged or missing log cannot prove that no forbidden writes occurred, and an empty reading cannot prove that content matches. All incomplete, unreadable, or unusable inputs must fail closed with a non-zero exit code and refuse to emit a verified-safe or pass outcome. Test suites must explicitly cover damaged, truncated, empty, and malformed inputs.
    - **Wiring and Regression Coverage for Advertised CLI Aliases:** Whenever a CLI short option or alias (e.g. `-j` for `--json`) is documented in `--help` text, usage strings, or task specifications, the CLI argument parser must explicitly map the alias in its option configuration. Tests must include end-to-end CLI regressions verifying that the documented alias functions identically to the long flag.
    - **Reconciling Execution Model Headings with Delegation Tables:** When updating a skill's execution model or delegation matrix to assign work to the primary session or specific model tiers, review and update all subsequent workflow headings and step descriptions to eliminate obsolete unconditional delegation labels (e.g. "(Delegated to Subagent)"). Skill validation tests must assert the absence of contradictory retained delegation directives.
34. **Dictionary Validation Prior to Word Augmentation & Launcher-Scoped Task Permissions:**
    - **Validate Reference Dictionaries Before Augmenting with Target Words:** When augmenting a reference dictionary with target definition words for OCR or reading filtering, never augment the dictionary before validating that the dictionary itself contains usable entries. Accepting an empty dictionary and populating it only with target definition words causes OCR filtering to discard precisely the extraneous or omitted lyrics that the verification pipeline was specifically designed to detect, turning omission defects into false passes. An empty or unusable dictionary must fail closed with the undeterminable outcome, and test suites must cover this false-pass regression.
    - **Scoped Filesystem Permissions for Variable-Input Task Registries via Launchers:** When registering Deno tasks in `deno.json` whose file targets vary by user/agent input (such as paths for songs, scans, readings, or dictionaries) and whose outputs write to temporary scratch spaces, never grant blanket `--allow-read` or `--allow-write` in `deno.json` (violating Rule 21). Instead, delegate to a launcher script that inspects and resolves the explicit input paths and an isolated temporary output directory, granting `--allow-read` only to those paths plus required module files, `--allow-write` only to the temporary directory, and retaining strictly scoped `--allow-run` binary allowlists.
35. **Preserving Accumulated Multi-Batch Dispatch History Across Intervening Review and Discovery Runs:**
    - **Retain Dispatch History Across Intervening Reviews:** When multi-batch workflows accumulate dispatched runs into a single durable weekend or campaign report (such as `POST /outreach/report`), intervening curation, review, or discovery operations (e.g. Gate 1 candidate curation or Gate 2 copy reviews) must keep the visible candidate tables and pitch cards strictly curated to the active review set without resurrecting unapproved or held candidates from earlier sweeps.
    - **Never Clobber Stored Dispatch History:** Crucially, intervening reviews must NEVER clobber or discard accumulated dispatch state (`batchDispatch`, `batches`, dispatched candidates, and historical pitch entries) or reset the report index's `dispatchedCount` to zero.
    - **Continuous Dispatch History Retention:** Report publishing pipelines must retain prior dispatch history in the durable stored report and embedded machine-readable run data (`<script id="book-gig-run-data">`) so subsequent batch dispatches correctly accumulate with all previous dispatches (e.g. `send(A) -> review(B) -> send(B)` finishes with both A and B dispatched, rather than erasing A).
    - **Outreach Record Identity vs. Entity Identity Separation:** In backend dispatch structures (e.g. `batchDispatch.records`), each dispatch record represents an outreach document possessing its own database `_id` alongside a foreign `venueId`. When resolving dispatched entities or building lookup sets (e.g. `priorDispatchedIds`), always resolve to entity identity (`rec.venueId`) rather than the outreach document's `_id` (`rec._id`). Testing fixtures for dispatch reports must supply the full backend document shape (both `_id` and `venueId`) so that identity confusion is caught during testing rather than passing against simplified single-key fixtures.
    - **Intervening Review Regression Coverage:** Test suites covering multi-batch reporting pipelines must not exercise only back-to-back sends; they must include regressions verifying that intervening review and discovery publications between dispatches preserve prior dispatch metrics, candidate records, and cumulative batch history.
36. **Markdown Section Traversal, Multi-Line List Item Assembly & Strict Version Bumping:**
    - **Maintain Section Scope Through Nested Subsections:** When parsing or validating markdown documents bounded by section headings (such as `## Acceptance criteria`), heading scanners must determine the boundary heading level `N` (e.g. level 2 for `##`). Scanners must NOT terminate upon encountering any markdown heading (`/^##+/`); they must continue traversing through nested subheadings (`level > N`, such as `### Behavior` or `#### Specific Cases`) and only terminate upon reaching a heading of equal or higher rank (`level <= N`). Terminating prematurely on nested headings allows unvetted items inside subsections to escape validation.
    - **Assemble Multi-Line Markdown List Items Prior to Validation:** When auditing or linting markdown list items (such as acceptance criteria, checklist entries, or requirements), validators must never evaluate individual physical lines in isolation. In standard markdown, list items frequently wrap across continuation lines. Parsers must accumulate list items and their continuation lines into complete logical items before executing validation rules (such as checking for double-quoted headings or backtick commands), preventing false rejections of valid wrapped criteria. Test suites must include regressions for grouped criteria under subsections and wrapped criteria across continuation lines.
    - **Preserve Indented Markdown Heading Recognition:** In CommonMark/Markdown, ATX headings can have optional leading whitespace (up to 3 spaces of indentation). When scanning for section headings or boundary headings, parsers must evaluate line prefixes after trimming leading whitespace (or match optional leading whitespace `/^\s*#{1,6}/`), rather than anchoring strictly to the beginning of the raw un-trimmed line (`/^#{1,6}/`). Strict un-trimmed anchors fail to recognize indented target sections (e.g. `  ## Acceptance criteria`) and indented following sections (e.g. `  ## Files changed`), causing false rejections or failing to terminate section scope.
    - **Strict Semver Exceedance Verification Prior to PR Creation:** PR branches must always verify that `deno.json` (or `package.json`) strictly exceeds the current tip of `origin/dev`, catching stale or omitted version bumps before pushing.
37. **Global Git Hook Worktree Resolution, Runbook Prerequisite Direct State Queries & Non-Closing Hook PRs:**
    - **Resolve Common Git Directory for Global Hooks Chaining Local Hooks:** When authoring machine-wide or global Git hooks (such as those installed via `core.hooksPath`), hooks that chain into a repository's local hooks must NOT rely on `git rev-parse --git-dir` (which points to `.git/worktrees/<name>` in linked worktrees and misses `.git/hooks`). Instead, resolve the common repository directory via `git rev-parse --git-common-dir` (which resolves the canonical `.git`), check for `$COMMON_DIR/hooks/<hook>`, and enforce the self-recursion guard (`readlink -f "$REPO_HOOK" != "$THIS_SCRIPT"`). Tests for global Git hooks must explicitly cover linked worktree invocations with nonzero and zero exit outcomes.
    - **Query PR State Directly in Runbook Prerequisites:** When authoring verification runbooks whose prerequisites depend on a pull request having merged, never use `gh pr list` without `--state` (which defaults to `--state open`) combined with title searches that may not match. Query the PR directly by number or URL (`gh pr view <PR> --json state --jq .state`) or pass `--state merged` so the command receipt can actually evaluate to `MERGED`.
    - **PRs for Hook Issues Never Auto-Close the Issue:** Per `docs/cross-ai-rules.md`, pull requests introducing or modifying hooks (git hooks, agent hooks, or system hooks) must never carry closing keywords (`Closes #<N>`, `Fixes #<N>`) in the PR description because the issue must remain open for post-merge installation and manual verification.
38. **Translation Shim Coverage & Nested Tool Argument Extraction:**
    - **Translate All Surface Tool Names to Claude-Standard Equivalents:** When building or extending translation shims (such as `hooks/lib/agy_hook_shim.ts`) between different agent surfaces (e.g. Antigravity/agy and Claude Code), every native tool name capable of performing operations guarded by security or workflow rules (e.g. `replace_file_content`, `multi_replace_file_content`, `write_to_file`, and GitHub MCP issue writes) must be explicitly mapped in the tool name registry (`TOOL_NAME_MAP`) to the corresponding Claude Code tool names (`Edit`, `Write`, `NotebookEdit`, `mcp__<server>__<tool>`). Unmapped tools must pass through unchanged by identity.
    - **Unpack Nested MCP Arguments for Downstream Matchers and Checkers:** When translating lazy or dispatcher tool calls (such as agy's `call_mcp_tool`), translation layers must not pass nested tool parameters only inside an encapsulated `Arguments` container. Downstream guards and permission layers expect standard top-level fields (e.g. `method`, `title`, `body`, `labels`, `owner`, `repo`). Translators must unpack nested `Arguments` objects onto the normalized `tool_input` while preserving top-level metadata, ensuring guards evaluate the actual arguments rather than failing or missing vetting.
39. **Shared Hook Runner Delegation & Fail-Closed/Fail-Open Invariants:**
    - **Delegate All Hook Entry Points Through the Shared Runner:** Every hook entry point in `hooks/*.sh` must delegate its execution through the shared runner `hooks/lib/run_hook.sh` (decision D-32).
    - **Preserve Group Default Fallback Behavior:** When Deno cannot run (missing on PATH, crashed with unexpected exit code, or timed out after 15s), the runner enforces the group default: safety guards fail closed (exit code 2 with standard refusal on stderr) and workflow guards fail open (exit code 0 with additionalContext/systemMessage on stdout, leaving terminal stderr clean).
    - **Preserve Target Safety Invariants on Surface Shims:** Surface wrappers and translation boundaries (such as `hooks/agy-hook-shim.sh`) must inherit their fail-closed/fail-open fallback from the wrapped target hook's group, emitting native surface-specific denial envelopes (e.g. `{"decision":"deny"}` on PreToolUse, `overwrite_result` on PostToolUse in agy) so runner timeouts and runtime crashes never fail open on safety guards.
    - **Propagate Safety Runner Refusals Without Absorption:** Callers and outer scripts invoking safety-guarded helper tasks must never absorb runner exit codes (`|| true`) or discard refusal stderr (`2>/dev/null`), ensuring fallback execution never bypasses a safety refusal.
    - **Isolate Runner Fallback Notes Across Command-Capturing Hooks (`--note-file`):** When intermediate shell hooks capture subprocess output into variables, runner fallback notes must route through a dedicated out-of-band channel (`--note-file`) rather than being parsed from stdout via sentinel substrings (such as `"systemMessage"` or `"hookSpecificOutput"`). Inferring runner notes from command output allows ordinary assistant text, git comments, or file content discussing hook payloads to bypass checks.
    - **Silence CLI Success Output on Automated Hooks (`--discard-stdout` / `--quiet`):** Automated background or PostToolUse hooks that run shared CLI tools (such as `src/memory-index/cli.ts` in `hooks/regenerate-memory-index.sh`) must run in quiet/discard mode so success logging is not leaked onto stdout.

## Opening pull requests (all WebJamApps repos)

Open every PR through the `draft-pr` skill (`skills/draft-pr/SKILL.md`), never `gh pr create`
directly. It covers the script, its flags and PR body formatting.

### PR version-bump convention

Every PR must bump the version once, on its first commit — `deno.json` in this repo (e.g.
`"version": "1.26.x"`). CI's "Version bump check (PR branches only)" gate blocks PRs whose version
is unchanged from the merge-base with `dev`. Always bump `deno.json` on the first commit of any new
PR branch in `web-jam-tools` to prevent CircleCI gate failures. When updating or rebasing an open PR
branch after other PRs have merged to `dev`, verify that `HEAD`'s version remains strictly greater
than `origin/dev`'s current version (e.g. `git show origin/dev:deno.json`), and bump again on the
fix commit if `origin/dev` has moved ahead. When invoking `create-draft-pr.sh`, pass multi-line or
rich markdown values using `--summary-file`, `--test-plan-file`, and `--test-evidence-file` pointing
to temporary files in /tmp/ (e.g. /tmp/pr-summary.md) — never create scratch files or scratch/
directories inside the repo to prevent shell argument escaping or flattening issues.

## CI gate (web-jam-tools)

Every PR runs a CircleCI **quality + security gate** (`.circleci/config.yml`), required-green on
`dev` via branch protection. Run the **same checks locally before pushing** — "green locally" ==
"green in CI":

```
deno task check      # type check
deno task lint
deno task fmt:check   # formatting (deno task fmt to auto-fix)
deno task test        # unit tests
deno task audit       # Trivy: dependency CVEs (HIGH/CRITICAL fail) + secret scan
deno task sast        # Semgrep: static analysis of src/
```

**Before pushing:** run `deno task fmt` to auto-fix any formatting issues. A local pre-push hook
(`fmt-push-guard.sh`) blocks pushes with unformatted files; this line is an advisory backup.

`audit` and `sast` run via **Docker** (so they're identical locally and in CI) — Docker must be
available. `audit` bridges Deno's npm deps to a `package-lock.json` (Trivy can't read `deno.lock`);
JSR deps are not covered. SAST findings are **refactored, not suppressed**.

## Quota & Token Hygiene

- **Model Tier Order:** The one tier order lives in
  [docs/ai-team-playbook.md](docs/ai-team-playbook.md) ("Tier order"); this file states none of its
  own. Reviewer-tier pairing follows that order (`skills/pr-review/SKILL.md`). The order does
  **not** decide the default lane for everyday work: that stays a cost decision (Flash bills to
  Google; Sol and Astra bill to Plus; Sonnet and Opus bill to the constrained Anthropic budget), so
  Flash remains the default implementation tier.
  - **Subagent PR Author Accuracy:** When delegating execution tasks down to a subagent, instruct
    the subagent to pass `--author` matching its actual model tier (e.g.
    `--author "Claude Code — Haiku 5.5"` for Haiku subagents) when calling `create-draft-pr.sh`.

## System Setup

- **OS:** Ubuntu
- **Node.js:** v24.18.1 (LTS)
- **Rclone:** Configured for Google Drive (`gdrive:`)
- **Persistence:** Systemd user services managed via `systemctl --user`

## API Integrations

The status of Google Drive/Docs/Sheets/Slides/Calendar/Tasks/Gmail integrations available to AI
assistants is tracked privately, NOT in this public repo:
`~/Dropbox/web-jam-llms/Access_Controls/api-integrations-2026-07-31.md`. Update that file (and the
dated note in Drive `My Drive / GEMINI / API_Integration_Status_*.md`) when integration state
changes. If you cannot read that path, STOP and say so rather than guessing.

## Production Monitoring

Uptime monitoring targets, alerting and schedules: [docs/uptime-monitoring.md](docs/uptime-monitoring.md).

## Deno Deploy CLI & Runtime Rules

Read the Deno Deploy CLI and runtime rules in [docs/uptime-monitoring.md](docs/uptime-monitoring.md)
("Deno Deploy CLI & Runtime Rules") before running `deno deploy` or changing a deployed entrypoint.

## Language & Runtime Standardization

- **Language & Runtime Standardization**: All helper scripts, hooks, tools, and utilities in
  `web-jam-tools` (and TypeScript repos) must be written in Deno/TypeScript. Do NOT introduce Python
  scripts; prefer Deno/TypeScript for all workspace helpers and hook parsers.
- **Path Traversal & Identifier Validation in Automation Scripts**: Any script constructing
  filesystem paths from input plan identifiers, slugs, or keys (e.g., in memory/rule migrations or
  CLI utilities) MUST validate each identifier against a strict safe alphanumeric pattern (e.g.,
  `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`) to prevent directory traversal and accidental
  reads/writes/trashes outside the target directory.
- **Version Scrubbing & Generic Comment Descriptions**: When executing version-migration tasks with
  explicit grep-to-zero requirements (such as removing retired model version strings), ensure all
  decorative occurrences—including header comments, rejection bullet lists, and example command
  strings—describe requirements generically (e.g., "every Flash slug below the 3.7 floor") rather
  than retaining or reintroducing retired version literals in comments.
- **Agent PRs Must Never Auto-Close `Josh`-Labeled Issues**: Issues labeled `Josh` represent manual
  human steps, verification runs, and runbook tasks that no agent can perform or close. Automated
  agent pull requests must never generate `Closes #N` targeting an issue labeled `Josh`. When
  branching from or contributing fixes/tooling discovered during a manual verification task, always
  pass `--part-of` (or `--no-close`) to `create-draft-pr.sh` so the issue remains open for human
  verification. Furthermore, safety-critical guards inspecting issue metadata must fail closed: if
  fetching issue labels or attributes fails (due to API error, rate limit, or network blip), the
  script must treat the query failure as a blocking error rather than swallowing stderr with
  `|| true` and falling open.
- **Config & Skill Reconciliation in Symlink Installers**: When installer scripts symlink live
  environment paths (e.g. `~/.gemini/config/mcp_config.json` or `~/.claude/skills/*`) to
  repo-mastered files, they must preserve pre-existing real files not just by backing them up to
  `.bak-*`, but by actively reconciling and copying any local-only entries/keys into the repo master
  before replacing the destination with the symlink, regardless of whether the repo master already
  exists. Furthermore, candidate reconciled configurations must be validated for secrets/credentials
  in-memory before modifying the repository master file on disk, ensuring secrets never touch
  tracked files on refusal.
- **Header & Inline Comment Integrity**: When updating or appending feature documentation, usage
  notes, or issue references in file headers or comments, never truncate or clobber adjacent
  pre-existing sentences or design rationale. Always preserve surrounding sentences and explanations
  intact, adding net-new feature documentation as distinctly separated paragraphs with clean comment
  block formatting.
- **Checklist Renumbering & Cross-Reference Integrity**: When inserting, deleting, or reordering
  numbered checklist items, sections, or workflow steps in skills and documentation (e.g.
  `skills/pr-review/SKILL.md`), perform a full document search for internal cross-references (such
  as citations in worked examples, exception clauses, or references like "per Step 2 item X").
  Ensure all shifted rule numbers and parenthetical titles are updated consistently across the file
  so references never point to the wrong rule.
- **Rule Changes Sweep Every Restatement:** Before editing an instruction, read the linked issue's
  acceptance criteria and the approved design for what the rule must (and must not) say. Then grep
  for every restatement of the same rule (AGENTS.md, `skills/*/SKILL.md`, `docs/`) and update all of
  them in the same PR. When a new rule overlaps an existing exception, rewrite or remove the
  exception so no artifact gives contradictory instructions. When an instruction specifies a single
  source of truth for `AGENTS.md` (such as the tier order in `docs/ai-team-playbook.md`), point to
  it from `AGENTS.md` rather than restating it there, while preserving required synchronized
  statements in skills (such as `skills/delegate/SKILL.md` and `skills/pr-review/SKILL.md`) where
  contracts and test suites require the chain.

- **Static Analysis & SAST (Semgrep) ReDoS Safety**: In Deno/TypeScript tools, validators, and
  analyzers, avoid dynamic `new RegExp(...)` with runtime variable inputs (e.g.
  `new RegExp(`\\b${escapeRegExp(pattern)}\\b`, "i")`), which triggers Semgrep
  `detect-non-literal-regexp` blocking failures in CI's SAST gate (`deno task sast`). Instead, use
  string indexing / word boundary helpers (`indexOf`, lowercase token matching) or static RegExp
  patterns.
- **Duplicate Pin-Test Locations for the Same Rule**: When a design/issue spec offers a choice
  between "a new test file... or an addition to an existing test file" for a pin test, treat it as
  exclusive-or, not both. Adding the identical `assertStringIncludes` assertions in both a
  standalone file and an existing suite doubles
  maintenance cost for the same coverage with no added protection. Pick exactly one location before
  writing the test.
- **Bundled Skill Override Identity Verification**: When calculating bundled skill limits or
  overrides in multi-agent session load tooling, never count arbitrary or unrelated overrides (e.g.
  `unrelated-custom-skill: name-only`) as satisfying bundled skill requirements. Overrides must be
  matched strictly by identity against the canonical list of bundled skill identities, handling
  namespaced prefixes (`anthropic-skills:`, `claude-ai:`) and reporting the exact count of
  un-overridden bundled skills.
- **Limit-Enforced Session Load Part Coverage**: When reporting multi-tool session load footprints
  across surfaces (Claude Code, agy, Codex), report only parts that have an explicit limit
  configured per the design document. Unbounded extensions without limits (such as MCP connectors or
  agy's Google-bundled skills) must not be inspected or reported in the tab 1 session-load report.
- **Registration Isolation Assertion Discipline**: In tests verifying that hooks or startup scripts
  are NOT registered in global settings or unauthorized surfaces, never wrap assertion checks in
  blanket `try/catch` blocks that swallow assertion errors. Catch only `Deno.errors.NotFound`, run
  registration assertions outside `try/catch`, and write explicit negative tests against fixtures
  containing forbidden registrations to guarantee that violations actually fail the test suite.
- **End-to-End Execution Flow Parity Across Multi-Step Skills**: When adding an alternative
  execution path or exception branch to an early step of a multi-step skill or pipeline (such as
  routing rebased PRs to whole-PR review instead of incremental review in `skills/pr-review/SKILL.md`),
  carry the branch cleanly through all downstream execution stages. Downstream artifact-fetching
  commands (e.g. diff queries), scoping/filtering constraints, report section instructions (e.g.
  `Changes Since Last Review`), and range-statement requirements must explicitly distinguish the
  alternative path from the default path so later steps never execute commands or emit output
  contradicting the early-step branch. Instruction tests must pin the distinction across both the
  early branch and each downstream stage.

## Batch Email & Outreach Dispatch Safety

- **Batch Email & Outreach Dispatch Safety**: When implementing real outbound email or batch
  outreach commands (like `--send`), always provide explicit recipient filtering/exclusion options
  (`--venues`, `--skip`) so the user can selectively dispatch only approved candidates, ensuring
  code strictly supports the human-approval safety guarantees described in skill documentation.

## Venue Mining, Verification & Candidate Enrichment Rules

- **Probed Domain Provenance Precedence & Identity Fencing**: When evaluating candidate outreach
  eligibility where probed domains require affirmative venue identity verification (D-49/SKILL.md),
  always check probed domain provenance (`probed`) BEFORE generic published source matching
  (`website`). A probed domain containing "website" (e.g. `cafewebsite.com` or `thepub.website`)
  must never bypass identity verification or trigger `outreachEligible: true`. Identity verification
  must require explicit, typed affirmative boolean evidence (`identityConfirmed === true` or
  `approved === true`) rather than bare truthiness or untyped values (such as `"false"` or `false`),
  and must never derive approval from unrestricted prose substrings in notes (such as
  `"not explicitly approved"` or `"identity confirmed: no; name+city match failed"` matching
  positive phrases). Candidates with unverified, missing, or negative provenance/identity must fail
  closed with `outreachEligible: false` and require verified source evidence.
- **Agent Skill & Config Test Isolation from Live User Home**: Tests asserting that skills, hooks,
  or configurations install or resolve across agent surfaces (Claude Code, agy, Codex) must never
  read or assert directly against live personal workstation paths (`$HOME/.claude/...`,
  `$HOME/.gemini/...`). Always isolate tests using temporary fixture directories
  (`Deno.makeTempDir()`) with isolated destination parameters (`--claude-dest`, `--agy-dest`,
  `allowUnsafeForTesting: true`), ensuring test suites pass deterministically in clean CI and
  container environments without preinstalled agent surfaces.
- **Independent Terminal Input (`/dev/tty`) for Interactive Prompts After Reading Piped `stdin`**:
  When a CLI tool reads batch data from `Deno.stdin` (such as piped file paths consumed to EOF) and
  subsequently spawns an interactive subprocess that prompts on its standard input (such as
  `keepassxc-cli` prompting for a master password), never pass `stdin: "inherit"` to the
  subprocess, which hands it the already-exhausted pipe. Open an independent terminal file
  descriptor (`/dev/tty` via `fs.openSync(ttyPath, "r")`, injectable via `ttyPath` for tests) and
  pass it to `Deno.Command`'s `stdin` (closing it in `finally`), and test the CLI entry point
  end-to-end with piped `stdin` rather than only stubbing `Deno.Command` with `stdin: "null"`. In
  Python PTY subprocess helpers (`subprocess.Popen` + `pty.openpty()`) that close `proc.stdin` early
  to deliver EOF on piped `stdin` before calling `proc.communicate(timeout=...)`, always set
  `proc.stdin = None` immediately after `proc.stdin.close()` so Python 3.12 runtimes in CI do not
  call `self.stdin.flush()` and fail with `ValueError: flush of closed file`, and ensure new test
  fixtures respect the exact permission flags documented in the issue and PR test plan.
- **Non-Interactive Test Execution & Stdin Isolation Against Blocking Prompts**: When executing
  local test suites or background commands, agents must never run test suites with open or piped
  standard input that allows interactive `prompt()` calls (such as CLI confirmation prompts) to
  block indefinitely waiting for terminal input. Always isolate test input by redirecting from
  `/dev/null` (`deno task test < /dev/null`) and prioritize targeted test suites specified by the
  issue during iterative development. Before pushing and opening a PR, always execute all six local
  checks required by the "CI gate (web-jam-tools)" section (`deno task check`, `deno task lint`,
  `deno task fmt:check`, `deno task test`, `deno task audit`, `deno task sast`) to ensure the
  changes satisfy the repository's CircleCI gate without failures.
- **Synchronized Input Contracts & Caller Guidance on Validator Requirements**: When updating a
  task, ranking engine, or CLI tool with newly required inputs (such as requiring `levelFromTests`
  for Epics without open child Priorities regardless of repository size), update all caller
  touchpoints in sync: skill workflow instructions, CLI `--help` text, input documentation
  (`docs/scripts.md`), and interface/type comments (`Judgment.levelFromTests`). Never leave caller
  guidance or documentation stating that inputs are only required below a size floor or that certain
  entities receive no proposal when the underlying validator now rejects missing inputs; keep
  fail-closed validation and caller contracts fully reconciled.
