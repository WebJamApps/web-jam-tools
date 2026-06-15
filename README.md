# web-jam-tools

Central hub for shared configuration, scripts, and documentation across the
WebJamApps workspace. The repo is geared toward making AI-assisted
development (Claude Code, Gemini CLI) productive across many sibling
project directories that live alongside it on the same machine.

## What's in here

- **`docs/`** — system-setup and integration documentation (rclone, Google APIs, etc.)
- **`scripts/`** — workspace bootstrapping, environment checks, and example scraping/data-prep utilities
- **`gig-scraper/`** — Playwright + xlsx scrapers for JoshMariaMusic gig booking
- **`gemma-cli/`** — local Gemma 4 Coordinator (Python package; editable pip install with its own venv)
- **`CLAUDE.md` / `GEMINI.md`** — orientation and rules for AI assistants working in the workspace

## Getting started

```bash
git clone https://github.com/WebJamApps/web-jam-tools.git
cd web-jam-tools
npm install     # only needed if you plan to run scripts/*.js
```

Then read:

- [GEMINI.md](GEMINI.md) — workspace rules (apply to all AI assistants and human contributors)
- [docs/scripts.md](docs/scripts.md) — what each script does and when to use it
- [docs/ai-assistant-google-setup.md](docs/ai-assistant-google-setup.md) — generic recipe for setting up Google Drive/Calendar/Gmail/Tasks MCP servers for Claude Code
- [docs/rclone-setup.md](docs/rclone-setup.md) — mounting Google Drive locally via rclone + systemd
- [docs/api-integrations.md](docs/api-integrations.md) — reference snapshot of one working setup (machine-specific paths; use the generic guide above for your own setup)

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
deno task test        # unit tests
deno task audit       # Trivy: dependency CVEs (HIGH/CRITICAL fail) + secret scan
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

**Continuous deployment.** The Deno Deploy app is connected to this GitHub repo
and **auto-deploys from `main`**. There is no deploy job in CircleCI: because
`ci/circleci: gate` is a required check on both `dev` and `main`, only gate-green
commits ever reach `main`, so every auto-deploy has already passed the gate. The
normal flow is: feature → PR → `dev` → promote `dev` → `main` → Deno Deploy
deploys.

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

**Manual / local deploy (escape hatch).** To push an ad-hoc deployment without a
`git` push (e.g. a hotfix), deploy the entrypoint from your machine with the
`deno deploy` CLI. It prompts for browser auth on first use and caches the
credential in your system keyring:

```bash
deno deploy \
  --org <your-deno-deploy-org> \
  --app web-jam-devotional \
  --entrypoint src/devotional/send_daily_devotional.ts \
  --prod
```

(Replace `<your-deno-deploy-org>` with your Deno Deploy organization. `--app`
must match the Deno Deploy app name.)

**Test a single send locally** (no deploy): set the three `GMAIL_*` env vars and
run `deno task devotional`, which sends once immediately. Do **not** re-add a
laptop cron for it — Deno Deploy owns the schedule now, and a second scheduler
would send every devotion twice.

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

## VSCode Python settings (`.vscode/settings.json`)

A committed `.vscode/settings.json` configures VSCode's Python extension to behave well with the `gemma-cli/` venv:

- **`python.defaultInterpreterPath`** points at `gemma-cli/.venv/bin/python` so VSCode's autocomplete, linting, and jump-to-definition work on `gemma_cli/*` source without "Import could not be resolved" errors.
- **`python.terminal.activateEnvironment: false`** disables auto-activation of the venv when opening integrated terminals. On some Linux setups, auto-activation adds a ~10-second startup delay and prints a spurious `^C` (SIGINT) into the terminal. Disabling it makes VSCode terminals open as fast as external ones.

This is safe because the `llama` / `gemma` wrapper scripts at `~/.local/bin/` invoke the venv's Python directly — no shell activation is needed to run them. Both VSCode integrated and external terminals behave the same for running the REPLs.

The settings file is committed so a fresh checkout gets the same environment without manual config. If you clone this repo and create `gemma-cli/.venv`, the interpreter path resolves automatically via `${workspaceFolder}`.

## gemma-cli setup notes

`gemma-cli/` is a Python package designed for editable install in its own venv. From `web-jam-tools/gemma-cli/`:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

Optionally put it on your PATH so `gemma` works from anywhere:

```bash
ln -s "$(pwd)/.venv/bin/gemma" ~/.local/bin/gemma
```

### Compatibility symlink (if migrating from a previous location)

`gemma-cli` lived at `~/WebJamApps/gemma-cli/` (a sibling of `web-jam-tools/`) before being moved inside this repo on 2026-05-13. Existing wrapper scripts, cron entries, or shell aliases that reference the old absolute path keep working if you leave a symlink at the old location pointing to the new one:

```bash
ln -s ~/WebJamApps/web-jam-tools/gemma-cli ~/WebJamApps/gemma-cli
```

Why a symlink instead of rebuilding: a Python venv bakes absolute paths into its activate script, shebang lines, and `.pth` files. The symlink lets every existing reference resolve transparently without needing to recreate the venv or grep your dotfiles for the old path.

## Contributing

- Branch from `dev`, open a PR against `dev`. Do not merge to `dev` or `main` from an AI assistant — a human reviewer is required.
- A PR can only be **merged** into `dev` once the CI gate passes (see [Checks (CI gate)](#checks-ci-gate)). Running those checks locally first is recommended, not required.
- Don't commit `node_modules/`, environment files, or credentials. The `.gitignore` covers the obvious cases.
- When adding new scripts, document them in `docs/scripts.md`.

## License

No license file is currently committed. Treat as all rights reserved unless otherwise specified by the maintainer.
