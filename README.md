# web-jam-tools

Central hub for shared configuration, scripts, and documentation across the
WebJamApps workspace. The repo is geared toward making AI-assisted
development (Claude Code, Gemini CLI) productive across many sibling
project directories that live alongside it on the same machine.

**Deno code coverage: 82.8%** (lines, all files; 25 tests). The CI gate **fails
under 80%** (all-files line); stretch goal **90%**. Regenerate the report with
`deno task coverage`; enforce the threshold with `deno task coverage:check`.

## What's in here

- **`docs/`** — system-setup and integration documentation (rclone, Google APIs, etc.)
- **`scripts/`** — workspace bootstrapping, environment checks, and example scraping/data-prep utilities
- **`src/`** — Deno TypeScript tools: task-queue (CLI), gig-scraper (Playwright + xlsx), devotional (daily email sender), outreach-cron (cadence automation), dropbox-link (share-link CLI for Setlist play links)
- **`skills/`** — Claude Code skills (single source of truth; symlinked into `~/.claude/skills`)
- **`hooks/`** — Claude Code hooks (single source of truth; symlinked into `~/.claude/hooks`, wired into `~/.claude/settings.json` by `scripts/install-hooks.sh` — see [Claude Code hooks](#claude-code-hooks))
- **`CLAUDE.md` / `GEMINI.md`** — orientation and rules for AI assistants working in the workspace

## Getting started

```bash
git clone https://github.com/WebJamApps/web-jam-tools.git
cd web-jam-tools
```

To use the Claude Code skills in `skills/`, run `scripts/install-skills.sh` — it
symlinks each skill into `~/.claude/skills/` (existing real dirs are backed up,
never deleted). Runtime/personal files (e.g. `rules.yaml`, `log/`) stay local and
gitignored.

To use the Claude Code hooks in `hooks/`, run `scripts/install-hooks.sh` — see
[Claude Code hooks](#claude-code-hooks) below for what it does and how to
configure the notes-sync reminder.

Then read:

- [AGENTS.md](AGENTS.md) — workspace rules (apply to all AI assistants and human contributors)
- [docs/ai-team-playbook.md](docs/ai-team-playbook.md) — the AI team: who does what, how work flows, and where Josh approves
- [docs/scripts.md](docs/scripts.md) — what each script does and when to use it
- [docs/ai-assistant-google-setup.md](docs/ai-assistant-google-setup.md) — generic recipe for setting up Google Drive/Calendar/Gmail/Tasks MCP servers for Claude Code
- [docs/rclone-setup.md](docs/rclone-setup.md) — mounting Google Drive locally via rclone + systemd
- [docs/api-integrations.md](docs/api-integrations.md) — reference snapshot of one working setup (machine-specific paths; use the generic guide above for your own setup)

## Claude Code hooks

`hooks/` is the single source of truth for this workspace's Claude Code
hooks. `scripts/install-hooks.sh`:

1. Symlinks every `hooks/*.sh` into `~/.claude/hooks/` (existing real files
   are backed up, never deleted).
2. Safely merges the `SessionStart` hooks listed in that script's
   `SESSION_START_HOOKS` array into `~/.claude/settings.json` — only adding
   entries that aren't already present, never touching permissions or any
   other settings. `settings.json` is backed up to `settings.json.bak-<date>`
   immediately before any write, and only when a write is actually
   happening. Re-running the installer is safe to do — it's a no-op once everything is wired.

`~/.claude/settings.json` is intentionally **not** version-controlled in this
public repo (it holds personal permission strings), so this is the only
supported way to wire a hook up — there is no manual settings-editing step
to follow.

```bash
scripts/install-hooks.sh
```

### `notes-sync-reminder.sh` — cross-instance notes reminder

Multiple machines (Josh's laptop, the household Windows desktop, potentially
more) run Claude Code and append cross-instance learnings to a shared notes
file in the team Dropbox hub. This `SessionStart` hook reminds you at the
start of a session when that file has new content since your last session on
this machine — and says nothing when it hasn't.

- **Config:** `CLAUDE_SYNC_NOTES_PATH` env var overrides the watched file.
  Default: `$HOME/Dropbox/web-jam-llms/windows-desktop-notes.md`.
- **Behavior:** silent no-op if the watched path doesn't exist (e.g. no
  Dropbox share on this machine); silent if unchanged since last session; a
  1-2 line reminder when it has changed (or the first time the hook runs on
  a machine).
- **State:** a content-hash marker is kept in `~/.claude/state/` (per-user,
  gitignored, never committed), so the reminder only fires once per change.
- **Scope (v1): POSIX/bash + coreutils only** — developed and tested on
  Linux. It should also work unmodified under Git Bash/WSL on the Windows
  11 desktop (bash + `sha256sum` are both present there), but that hasn't
  been verified; if neither `sha256sum` nor `shasum` is on `PATH` it falls
  back to an mtime+size marker instead of erroring. A native
  PowerShell/Windows port is out of scope for v1.

## Checks (CI gate)

Every PR runs a CircleCI **quality + security gate** (`.circleci/config.yml`). It
must pass before a PR can be **merged into `dev` or `main`** (enforced by branch
protection on both). Pushing is never blocked — CI runs the gate automatically on
each push.

**Recommended (not required):** run the same checks locally first, to catch
failures before the CI round-trip. You need Deno and Docker:

```bash
deno task check       # type check
deno task lint
deno task fmt:check   # formatting (use `deno task fmt` to auto-fix)
deno task test          # unit tests
deno task coverage      # unit tests + coverage report (lcov + HTML in cov_profile/)
deno task coverage:check # unit tests + fail if all-files line coverage < 80% (CI gate)
deno task audit         # Trivy: dependency CVEs (HIGH/CRITICAL fail) + secret scan
deno task sast        # Semgrep: static analysis of src/
```

Or run the entire CircleCI job locally (needs the [CircleCI CLI](https://circleci.com/docs/local-cli/)):

```bash
circleci local execute gate
```

Notes:

- `audit` / `sast` use the Trivy / Semgrep **Docker images** locally (you only
  need Docker) and the installed binaries in CI — the same scans either way.
- `audit` scans the **npm** dependencies: it bridges `deno.lock` → a
  `package-lock.json` that Trivy can read. JSR deps (`@std/*`) aren't covered.
- SAST findings are **refactored, not suppressed**.

## Deploy (daily-devotional service)

The daily-devotional generator (`src/devotional/send_daily_devotional.ts`) runs
on **Deno Deploy**, which fires it daily at 06:00 America/New_York via `Deno.cron`
— no laptop dependency (web-jam-tools#69).

> **Setting up a new service on Deno Deploy?** Follow the step-by-step runbook:
> [`docs/deno-deploy-setup.md`](docs/deno-deploy-setup.md) (create the app via
> CLI, wire CI deploy + token, secrets, verify, cutover).

**Continuous deployment — `main` ONLY, driven from CI.** Deployment runs from
**CircleCI**, not Deno Deploy's GitHub integration. The app's GitHub integration
is **disconnected**, so Deno never builds branches — `main` is the only thing
that ever deploys, and pull requests get **no Deno Deploy status check**. On
merge to `main`, the CircleCI `deploy` job (which `requires` the `gate` job, so
it runs only after the gate is green) runs:

```bash
deno deploy --org webjamapps --app web-jam-devotional --prod --token "$DENO_DEPLOY_TOKEN"
```

`DENO_DEPLOY_TOKEN` is a CircleCI env var — create the token in Deno Deploy →
org settings (`console.deno.com/webjamapps/~/settings`) → **Organization Tokens**
and **copy its value (shown only once)** (one token deploys every app in the
org), then add it under CircleCI → `web-jam-tools` → **Project Settings →
Environment Variables**. `ci/circleci: gate` is also a required check on both
`dev` and `main`, so only gate-green commits ever reach `main` in the first
place. Flow: feature → PR → `dev` → promote `dev` → `main` → gate → deploy. Full
setup steps for a new service are in
[`docs/deno-deploy-setup.md`](docs/deno-deploy-setup.md).

**Convention — one Deno Deploy app per microservice.** Each deployable service
gets its own Deno Deploy **app** (named `web-jam-<service>`, e.g.
`web-jam-devotional`), so each has isolated secrets, its own `Deno.cron`
schedule, an independent deploy, and its own subdomain. The free tier allows up
to **20 apps** (plus 1M requests/mo, 20 GB egress, 15h CPU/mo) — ample for this
model; a once-daily cron is negligible against those ceilings.

**Runtime secrets** live in the Deno Deploy dashboard (not in the repo): the
three Gmail OAuth values `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and
`GMAIL_REFRESH_TOKEN`. The script reads them via `Deno.env.get()` and refreshes a
short-lived access token on each cold-start run (Deno Deploy has no persistent
filesystem).

**Manual / local deploy (escape hatch).** To push an ad-hoc deployment without
going through CI (e.g. a hotfix), deploy from your machine with the same CLI. Run
it from the repo root (the app already knows its entrypoint); it prompts for
browser auth on first use and caches the credential in your system keyring, so
you can omit `--token`:

```bash
deno deploy --org webjamapps --app web-jam-devotional --prod
```

**Test a single send locally** (no deploy): set the three `GMAIL_*` env vars and
run `deno task devotional`, which sends once immediately. Do **not** re-add a
laptop cron for it — Deno Deploy owns the schedule now, and a second scheduler
would send every devotion twice.

## Dropbox share-link CLI

`src/dropbox-link/dropbox_link_cli.ts` (web-jam-tools#171) turns a Dropbox
file path into the two link forms used across WebJamApps when adding a song
to the web-jam-back **Setlist**:

- **Setlist form** — `www.dropbox.com/scl/fi/…?rlkey=…&dl=0` (viewer link)
- **Songs/widget form** — `dl.dropboxusercontent.com/scl/fi/…?rlkey=…&dl=1` (direct stream)

Both come from a single shared link (one Dropbox API call per path), so the
CLI always prints both, labeled — pick whichever form the destination needs.

**Input** — one or more paths, auto-detected, as args and/or newline-separated
on stdin (batch mode):

- Account-relative, e.g. `/joshandmariamusic/song.mp3` — used as-is.
- Local, e.g. `~/Dropbox/joshandmariamusic/song.mp3` or
  `/home/joshua/Dropbox/joshandmariamusic/song.mp3` — auto-mapped by
  stripping the local Dropbox root.

```bash
deno task dropbox:link -- /joshandmariamusic/song.mp3
deno task dropbox:link -- ~/Dropbox/joshandmariamusic/song.mp3
printf '/a.mp3\n/b.mp3\n' | deno task dropbox:link --
```

**Idempotent** — re-running on the same path returns the existing shared
link (Dropbox 409 `shared_link_already_exists` → list-and-reuse fallback),
never a duplicate.

### Auth: durable OAuth refresh token (one-time setup)

No more 4-hour throwaway access tokens. The CLI holds a **refresh token**
that never expires and mints a fresh access token on every run — env-driven,
no hardcoded laptop paths, secrets never committed:

| Env var | What it is |
|---|---|
| `DROPBOX_APP_KEY` | The `webjam-setlist-links` Dropbox app's key |
| `DROPBOX_APP_SECRET` | That app's secret |
| `DROPBOX_REFRESH_TOKEN` | Minted once via the offline OAuth flow below |

This reuses the existing **`webjam-setlist-links`** Dropbox app (account
`web.jam.adm@gmail.com`; scopes `files.metadata.read`, `sharing.read`,
`sharing.write` already granted) — no new app to create. To mint the refresh
token (one-time, or if it's ever revoked):

1. In a browser, visit (substitute the app key):
   ```
   https://www.dropbox.com/oauth2/authorize?client_id=<DROPBOX_APP_KEY>&response_type=code&token_access_type=offline
   ```
   `token_access_type=offline` is what makes Dropbox issue a refresh token
   instead of only a short-lived access token.
2. Approve access as `web.jam.adm@gmail.com`; Dropbox shows an authorization
   `code`.
3. Exchange that code for tokens:
   ```bash
   curl https://api.dropboxapi.com/oauth2/token \
     -d code=<the code from step 2> \
     -d grant_type=authorization_code \
     -d client_id=<DROPBOX_APP_KEY> \
     -d client_secret=<DROPBOX_APP_SECRET>
   ```
   The JSON response's `refresh_token` field is the durable
   `DROPBOX_REFRESH_TOKEN` — it does not expire under normal use.
4. Store all three values in **KeePass**, and set them as env vars wherever
   the CLI runs (shell profile for local/manual runs; the hosting platform's
   secret store for anything automated). Never commit them.

## VSCode multi-root workspace

`WebJamApps.code-workspace` is a multi-root VSCode workspace that opens this repo alongside its sibling repos (JaMmusic, CollegeLutheran, AppersonAuto, web-jam-back, WebJamSocketCluster, WebJamPg). It uses **relative paths**, so for it to work the sibling repos need to be cloned next to `web-jam-tools/`:

```text
~/WebJamApps/
├── web-jam-tools/        ← this repo
│   └── WebJamApps.code-workspace
├── JaMmusic/
├── CollegeLutheran/
├── AppersonAuto/
├── web-jam-back/
├── WebJamSocketCluster/
└── WebJamPg/
```

The committed copy of the workspace file lives in this repo; on the maintainer's machine a symlink at `~/WebJamApps/WebJamApps.code-workspace` points to it so the relative paths inside resolve correctly. To set up the same on a fresh checkout:

```bash
ln -s ~/WebJamApps/web-jam-tools/WebJamApps.code-workspace ~/WebJamApps/WebJamApps.code-workspace
```

Then `File → Open Workspace from File...` → that symlink (or the file directly).

## Contributing

- Branch from `dev`, open a PR against `dev`. Do not merge to `dev` or `main` from an AI assistant — a human reviewer is required.
- A PR can only be **merged** into `dev` once the CI gate passes (see [Checks (CI gate)](#checks-ci-gate)). Running those checks locally first is recommended, not required.
- Don't commit `node_modules/`, environment files, or credentials. The `.gitignore` covers the obvious cases.
- When adding new scripts, document them in `docs/scripts.md`.

## License

MIT License — see [LICENSE](LICENSE) file for full text.
