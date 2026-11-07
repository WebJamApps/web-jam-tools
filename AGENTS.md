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

> **Moved to the Obsidian vault (2026-11-05):** Coding lessons (hooks, tests, CLIs, parsers, installers, venue mining) now live word for word in `~/Dropbox/web-jam-llms/rules-vault/web-jam-tools-AGENTS.md`. Read it before working in that area.

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
26. **Folding `/learn` Rule Updates into Area Rules Files and the Same Feature Branch & PR:** When
    instructed to run `/learn` (or when folding lessons learned into rules during task work or PR
    reviews), run `/learn` if available. When `/learn` writes lessons into the repository's rules
    file, move each lesson that applies to one area, word for word, into that area's rules file
    (`docs/rules/<area>.md`), creating the file and its pointer line when the area has none; a
    lesson that applies everywhere stays in the rules file (`AGENTS.md`). The resulting updates must
    be committed directly onto the active feature branch and included in the same PR (e.g. `chore:
    fold /learn updates into rules`) and pushed up together with the work. Never open a separate PR,
    never defer updating rules to a follow-up step, and never leave rule updates unpushed or waiting
    for a post-merge step on `dev`.
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
- **Agent PRs Must Never Auto-Close `Josh`-Labeled Issues**: Issues labeled `Josh` represent manual
  human steps, verification runs, and runbook tasks that no agent can perform or close. Automated
  agent pull requests must never generate `Closes #N` targeting an issue labeled `Josh`. When
  branching from or contributing fixes/tooling discovered during a manual verification task, always
  pass `--part-of` (or `--no-close`) to `create-draft-pr.sh` so the issue remains open for human
  verification. Furthermore, safety-critical guards inspecting issue metadata must fail closed: if
  fetching issue labels or attributes fails (due to API error, rate limit, or network blip), the
  script must treat the query failure as a blocking error rather than swallowing stderr with
  `|| true` and falling open.
## Batch Email & Outreach Dispatch Safety

- **Batch Email & Outreach Dispatch Safety**: When implementing real outbound email or batch
  outreach commands (like `--send`), always provide explicit recipient filtering/exclusion options
  (`--venues`, `--skip`) so the user can selectively dispatch only approved candidates, ensuring
  code strictly supports the human-approval safety guarantees described in skill documentation.

