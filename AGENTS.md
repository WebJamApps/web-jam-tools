# Agent Instructions for WebJamApps

This file contains instructions and context for every AI agent (Claude Code, agy/Antigravity, and any other assistant) working in this workspace.

## Read also

- [docs/ai-team-playbook.md](docs/ai-team-playbook.md) — the current AI team, what each tier is best at, how work hands off, and where Josh approves.
- [docs/cross-ai-rules.md](docs/cross-ai-rules.md) — cross-AI operational rules (voice rules, file placement, protected files, canonical task queues, memory hygiene) that apply to every AI on the team. Its **FE/BE COUPLING** section covers the backward-compat/expand-contract rule for shared BE/FE contracts and the `FE-couples:`/`Coupling-override:` conventions — read it before shipping a front-end half of coupled work.
- [docs/playwright-mcp.md](docs/playwright-mcp.md) — setup and operational guidelines for using Playwright MCP server (`@playwright/mcp`) to debug production websites.

## Workspace Overview
- **Root Directory:** `/home/joshua/WebJamApps`
- **Primary Projects:** JaMmusic, AppersonAuto, CollegeLutheran, web-jam-back, WebJamPg, etc.
- **Tools Repo:** `web-jam-tools` (this repository)

## Collaboration Rules
1. **Rclone Mount:** Google Drive is mounted at `~/gdrive` via a systemd user service (`rclone-gdrive.service`).
2. **Coding Standards:** Refer to individual project `AGENTS.md`/`CLAUDE.md` files (if present) for specific technology stacks.
3. **Repository Purpose:** `web-jam-tools` serves as a central hub for shared configurations, documentation of system setups, and general workspace memory.
4. **No Merging to DEV:** AI agents are **NOT** allowed to merge PR changes to the `dev` or `main` branches. The user acts as the mandatory human-in-the-loop reviewer and is responsible for all merges.

## Opening pull requests (all WebJamApps repos)

Finish a coding task by running the shared script — never `gh pr create` directly.
This applies **however the task was started** (via `/next` or just told to work an
issue ad-hoc). Put your summary and the **real test output** IN THE PR via the
flags — not only in the chat reply:

```
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
  --author "<tool> — <model>" \
  --summary "<what changed and why>" \
  --test-plan "<exact commands to verify + expected result>" \
  --test-evidence "<the actual lint + test output, confirming both ran green>" \
  --closes   # include ONLY if this PR fully completes the issue; omit for a partial PR
```

`--summary`, `--test-plan`, and `--test-evidence` are **required** — the script
**refuses to open a PR with an empty or placeholder description** (web-jam-tools#77).
It always opens a **draft** PR based on **`dev`**, with the issue number derived from
the `<lane>/<issue#>-<slug>` branch name (or explicit `--issue` flag, which supports full URLs, `OWNER/REPO#N`, or bare `#N`/`N` and formats cross-repo closing lines as `Closes OWNER/REPO#N`) and a footer naming the tool + model (hard
invariants — no flag overrides them). By default it references the issue (`Part of #N` or `Part of OWNER/REPO#N`);
pass `--closes` to make it the completing PR (`Closes #N` or `Closes OWNER/REPO#N`). Josh alone reviews and
flips draft → ready. See `skills/draft-pr/SKILL.md`.

### PR body formatting (do this every time)

The script drops your `--summary` / `--test-plan` / `--test-evidence` values
**verbatim** under their headers — it does not reformat them, so professional
formatting is the **caller's** job. Fill every flag with proper markdown:

- **Summary** → **bullet points**, one change per bullet — never a single run-on
  sentence.
- **Shell commands** → a fenced ` ```sh ` code block, never inline prose.
- **HTML or code** → wrap every `<tag>`, snippet, or symbol in backticks or a fenced
  block so GitHub renders it literally. Never pass a raw `<sup>35</sup>`-style tag as
  prose — GitHub renders or swallows it and garbles the body.
- **Before/after** → add a short before → after snippet when it aids clarity.

Example of a well-formed call (bulleted summary, fenced commands + output):

`````
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
  --author "<tool> — <model>" \
  --summary "- Add X so Y works
- Refactor Z to stop duplicating W" \
  --test-plan "Run:
```sh
npm test
```
Expect: lint + unit green." \
  --test-evidence "```
ok | 42 passed | 0 failed
```" \
  --closes
`````

### PR version-bump convention

Every PR must bump the version once, on its first commit — `deno.json` in this repo (e.g. `"version": "1.26.x"`).
CI's "Version bump check (PR branches only)" gate blocks PRs whose version is unchanged
from the merge-base with `dev`. Always bump `deno.json` on the first commit of any new PR branch in `web-jam-tools` to prevent CircleCI gate failures.
When invoking `create-draft-pr.sh`, pass multi-line or rich markdown values using `--summary-file`, `--test-plan-file`, and `--test-evidence-file` pointing to files (e.g. in scratch/) to prevent shell argument escaping or flattening issues.

## CI gate (web-jam-tools)

Every PR runs a CircleCI **quality + security gate** (`.circleci/config.yml`),
required-green on `dev` via branch protection. Run the **same checks locally
before pushing** — "green locally" == "green in CI":

```
deno task check      # type check
deno task lint
deno task fmt:check   # formatting (deno task fmt to auto-fix)
deno task test        # unit tests
deno task audit       # Trivy: dependency CVEs (HIGH/CRITICAL fail) + secret scan
deno task sast        # Semgrep: static analysis of src/
```

**Before pushing:** run `deno task fmt` to auto-fix any formatting issues. A local
pre-push hook (`fmt-push-guard.sh`) blocks pushes with unformatted files; this
line is an advisory backup.

`audit` and `sast` run via **Docker** (so they're identical locally and in CI) —
Docker must be available. `audit` bridges Deno's npm deps to a `package-lock.json`
(Trivy can't read `deno.lock`); JSR deps are not covered. SAST findings are
**refactored, not suppressed**. Deploy on merge to `main` is added in web-jam-tools#69.

## Quota & Token Hygiene
- **Sliding Window Quota Preservation:** Google Antigravity (`agy`) tracks model token usage on a rolling 5-hour sliding window. To avoid triggering 3+ hour rate limit resets during long or multi-repo tasks:
  - Keep command outputs compact: avoid printing thousands of lines of raw test logs directly into main turn outputs.
  - Redirect large multi-line summaries, test plans, and evidence to scratch files (`--summary-file`, `--test-plan-file`, `--test-evidence-file`) when calling `create-draft-pr.sh`.
  - Delegate mechanical sub-tasks or heavy lookups to cheaper subagents (`Flash Med` or `Haiku`) when operating interactively on `Flash High`.
  - **Automatic Flash Med Subagent Handoff on "Go":** Once requirements and implementation steps are aligned interactively on `Flash High`, automatically delegate contained execution work (coding, running test suites, branch/PR creation) down to a `Flash Med` subagent without waiting for Josh to explicitly request delegation.

## System Setup
- **OS:** Ubuntu
- **Node.js:** v24.18.1 (LTS)
- **Rclone:** Configured for Google Drive (`gdrive:`)
- **Persistence:** Systemd user services managed via `systemctl --user`

## API Integrations

See [docs/api-integrations.md](docs/api-integrations.md) for the current status of Google Drive/Docs/Sheets/Slides/Calendar/Tasks/Gmail integrations available to AI assistants. Update that file (and the dated note in Drive `My Drive / GEMINI / API_Integration_Status_*.md`) when integration state changes.

## Production Monitoring

Uptime monitoring for production websites is managed via `deno task monitor:uptime` (`src/uptime/cli.ts`) and 24/7 Deno Deploy edge cron `deno task monitor:cron` (`src/uptime/cron.ts` using `Deno.cron`). See [docs/uptime-monitoring.md](docs/uptime-monitoring.md) for full guide, target list, deployment steps, and verification procedures.

- **Monitored Targets:**
  - `https://joshandmariamusic.com` (HTTP 200)
  - `https://www.joshandmariamusic.com` (HTTP 200 / redirect)
  - `https://web-jam.com` (HTTP 200)
  - `https://web-jam.com/music` (Content-aware check: HTTP 200 AND presence of music content elements)
  - `https://collegelutheran.org` (HTTP 200)
- **Alerting & Credentials:**
  - Reads `GMAIL_USER` and `GMAIL_APP_PASSWORD` environment variables.
  - Sends detailed failure alert emails to `joshua.v.sherman@gmail.com` via Nodemailer on failure.
  - Silent on success (exits with code 0).
- **Deno Deploy 24/7 Schedules:**
  - `Deno.cron("WebJam Production Uptime Check", "*/30 * * * *", ...)` runs every 30 minutes 24/7 (silent on success, email on failure).
  - `Deno.cron("WebJam Production Daily Heartbeat", "0 12 * * *", ...)` runs daily at 8:00 AM EDT (12:00 UTC) sending a self-health confirmation email to `joshua.v.sherman@gmail.com`.

