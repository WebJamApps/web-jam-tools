# Scripts

Index of utilities in `scripts/`. Run from the repo root unless noted.

## Workspace utilities

### `bootstrap-project.sh`

Scaffolds a new sibling project directory in the WebJamApps workspace with
basic README and structure.

```bash
./scripts/bootstrap-project.sh <project-name>
```

> Note: the script currently hard-codes a workspace root path. Edit
> `ROOT_DIR` near the top of the file to match your machine before use.

### `check-env.sh`

Quick health check for the local development environment. Reports Node
version, rclone Google Drive mount status, GitHub CLI auth, and basic Drive
visibility.

```bash
./scripts/check-env.sh
```

> Note: contains hard-coded paths that assume the maintainer's home
> directory layout. Adapt before using on a different machine.

### `new-agent-worktree.sh`

Creates an isolated git worktree for a WebJamApps sibling repo/branch — the
setup an agent needs to work on that repo without touching the shared main
clone. Seeds the gitignored `.env` / `.env.test` from the repo's main clone
into the new worktree when present (a fresh worktree never inherits
gitignored files, which otherwise breaks local DB-backed test runs there —
web-jam-tools#257). Prints the new worktree's absolute path as the last
line of stdout.

```bash
scripts/new-agent-worktree.sh <Repo> <branch> [base]
```

- `Repo` — sibling directory name under the workspace root (e.g.
  `WebJamSocketCluster`), must already be a git clone
- `branch` — branch name to create for the new worktree
- `base` — base ref to branch from (default: `dev`)

The worktree is created at `<Repo>/.claude/worktrees/<branch>` (`/` in the
branch name is flattened to `-`). Set `WEBJAMAPPS_ROOT` to override the
default workspace root (`/home/joshua/WebJamApps`).

> Depends on `hooks/block-secret-dumps.sh`'s `cp`/`test` exception
> (web-jam-tools#257) — without it, an agent working inside the new
> worktree can't re-seed these files by hand if it ever needs to.

### `circleci-settings.ts`

Manages the CircleCI project settings standard (`autocancel_builds: true`) across all 8 active WebJamApps projects (web-jam-tools#697). Supports drift checking via `--check` and idempotent application.

```bash
# Check for configuration drift across all 8 projects
deno task circleci-settings -- --check

# Enforce the standard across all 8 projects
deno task circleci-settings
```

See [docs/circleci-project-settings.md](circleci-project-settings.md) for full documentation.

### `install-git-secret-hook.sh`

Installs the push-time secret scanner (`gitleaks` pre-push hook) and shared `.gitleaks.toml` configuration into a target WebJamApps repository (web-jam-tools#658).

- Auto-detects Node repos (`.husky/pre-push`) vs Deno repos (`.git/hooks/pre-push`).
- Copies or reconciles the shared `.gitleaks.toml` rules and allowlist.
- Supports drift checking via `--check`.

```bash
# Install in current repository
bash scripts/install-git-secret-hook.sh

# Install into a sibling repository
bash scripts/install-git-secret-hook.sh --repo ../JaMmusic

# Check for drift
bash scripts/install-git-secret-hook.sh --check
```

### `reaper-update.sh`

Downloads and installs the latest REAPER version to a specified prefix.
Detects the currently installed version, compares it to the latest available,
and updates in place if needed. Preserves user configuration in `~/.config/REAPER`.

**Invocation options (in preference order):**

1. **From anywhere** (after one-time setup):
   ```bash
   reaper-update
   ```
   One-time setup (run from repo root):
   ```bash
   ln -s "$PWD/scripts/reaper-update.sh" ~/.local/bin/reaper-update
   ```
   Requires `~/.local/bin` on PATH.

2. **From inside the repo:**
   ```bash
   deno task update:reaper
   ```

3. **Direct script invocation:**
   ```bash
   bash scripts/reaper-update.sh
   ```

**Environment variables:**
- `REAPER_PREFIX` (default: `/home/joshua/opt`) — the parent directory where REAPER is installed

Example with custom prefix:
```bash
REAPER_PREFIX=/opt reaper-update
```

> Safety: the script checks that REAPER is not running before updating and
> fails if it detects a running process. Quit REAPER before updating.

### `statusline.sh`

Model-aware Claude Code status line (web-jam-tools#688). Reads the
status-line JSON payload Claude Code writes to stdin, extracts
`.model.display_name`, and prints a color-coded `[Opus]` / `[Sonnet]` /
`[Haiku]` badge in front of the existing status line — so a terminal running
the expensive tier is visually distinguishable from a cheaper one at a
glance. The match is on the family word in `display_name`, case-insensitive,
so a version bump (`Opus 5` to `Opus 6`) doesn't break it; an unrecognized
`display_name` prints uncolored rather than erroring, and a missing
`.model` key or malformed JSON on stdin both still produce a usable status
line. The original stdin payload is passed through unmodified to the
downstream status-line command (`npx -y ccusage statusline` by default) —
the badge is a prefix, never a replacement.

Installed automatically by `scripts/install-hooks.sh`, which symlinks
`scripts/statusline.sh` into the same destination the `*.sh` hooks are
linked into (honoring `--hooks-dir` / `CLAUDE_HOOKS_DIR`), then merges a
`statusLine` entry pointing at that stable installed path — never
`$REPO_DIR/scripts/statusline.sh`, which would break if the repo moved or a
branch lacking the file were checked out — into `~/.claude/settings.json`
(Claude Code only — agy has no status-line surface). The script is not a
hook: it stays out of `HOOKS_SRC` and out of every hook-registration loop,
so it never gains a `PreToolUse`/`PostToolUse`/`SessionStart`/`Stop` entry.
`hooks/lib/check_hook_install_drift.ts` covers it anyway — a dead or
unregistered `statusLine` is reported at SessionStart the same way a dead or
unregistered hook already is. Not meant to be run standalone in normal use,
but it can be for manual testing by piping a payload to it:

```bash
echo '{"model":{"id":"claude-opus-5","display_name":"Opus 5"}}' | scripts/statusline.sh
```

**Environment variables:**
- `STATUSLINE_DOWNSTREAM_CMD` (default: `npx -y ccusage statusline`) — the
  downstream command the captured payload is piped to after the badge.
  Overriding this is a test-only seam (the real default hits the network,
  which an automated test must not depend on); leave it unset for normal use.

## Example scraping / data utilities

These scripts target a specific Wix-hosted site and were built as one-offs
for the maintainer's use case. They're committed as **examples of Playwright
scraping patterns against a Wix site backed by MUI DataGrid**, not as
general-purpose tools.

| Script | What it does |
|---|---|
| `debug-wix.js` | Dumps the rendered DOM structure of the target site for inspection |
| `find-pagination.js` | Detects pagination controls on the target site |
| `scrape-gigs-v2.js` | First-pass scraper that walks pages of gig listings |
| `scrape-gigs-v3.js` | Newer scraper that handles MUI DataGrid virtualization |
| `scrape-and-sync.js` | Scrapes listings and writes them out as XLSX |
| `get-unique-venues.js` | Reads a text list of past gigs and emits unique venue names |

### Prerequisites

```bash
npm install   # installs playwright + xlsx
npx playwright install chromium
```

All of these scripts read from / write to local paths that are hard-coded
near the top of each file (Dropbox, Google Drive mount, etc.). Edit the
paths before running, or use them as reference implementations only.
