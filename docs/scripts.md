# Scripts

Index of utilities in `scripts/`. Run from the repo root unless noted.

## Workspace utilities

### `skill-start-check.ts`

Proves a skill still starts after its description or listing changes, on Claude Code and agy (web-jam-tools#1237).

```sh
deno task skill-start-check <skill-name> [--tool claude|agy|all]
```

The check reads the installed skill without changing its links. If its instructions or resources
differ from the candidate, it refuses rather than reporting a result for the installed copy. The
harness-only `start-check.json` is excluded from that comparison. agy checks require Linux
`setsid` and `kill` to terminate the check's process group and its descendants on timeout.

### `install-codex.ts`

Installs the Codex configuration described by web-jam-tools#1143 "scripts: Codex installer for
hooks, rules file, skills and settings". Run after `scripts/install-hooks.sh` has installed the
shared hook scripts under `~/.claude/hooks/`.

```sh
deno task install-codex
deno task install-codex --check
deno task install-codex --home /tmp/codex-install-check
deno task install-codex --help
```

The installer reads the four shared hook arrays from `scripts/install-hooks.sh`, registers them in
nested TOML tables with `WJT_SURFACE=codex`, copies the rules file as a regular file, links shared
skills into `~/.codex/skills/` except `handle-gmails`, and sets the top-level `sandbox_mode` to
`danger-full-access`. When run from a worktree, skill links point into the canonical clone so they
survive worktree removal.

`config.toml` is edited in place: only the top-level `sandbox_mode` line and the installer's own
`[[hooks.<Event>]]` tables change. Every other line, comments included, is kept byte for byte, so
existing settings, unrelated hooks and hook trust values cannot change. The edit is parsed and
checked against the values read before anything is written. A run with nothing to change leaves the
file byte-identical. `hooks.json`, `rules/default.rules`, built-in `.system` skills and `~/.agents/`
are untouched. Hook trust remains a manual Codex prompt.

Invalid TOML, unreadable hook arrays, missing hook scripts, missing rules, or a `config.toml` whose
installer hook tables cannot be edited in place (for example written as an inline array) refuse
installation before any writes. The rules file is written before `config.toml`. A conflicting skill
path is left in place and reported as skipped, while the safety set and other skills are installed;
the exit code is nonzero. `--check` writes nothing, returns zero when current, and reports each
difference or refusal with a nonzero exit code. On an empty home it reports missing hook
prerequisites alongside the installation drift.

Manual steps are in `~/Dropbox/web-jam-llms/Token_Savings/codex-install-manual-steps-2026-09-24.md`.

### `session-load-report.ts`

Emits the session load report at Claude Code startup in tab 1 of `agents` (web-jam-tools#1234). Reads the size of every session-load part from disk across Claude Code, agy, and Codex against the canonical limits in `src/session-load/limits.json`, prints a `systemMessage` JSON line, and exits 0.

```sh
deno run --allow-read --allow-env scripts/session-load-report.ts
```

### `bootstrap-project.sh`

Scaffolds a new sibling project directory in the WebJamApps workspace with basic README and
structure.

```bash
./scripts/bootstrap-project.sh <project-name>
```

> Note: the script currently hard-codes a workspace root path. Edit `ROOT_DIR` near the top of the
> file to match your machine before use.

### `check-env.sh`

Quick health check for the local development environment. Reports Node version, rclone Google Drive
mount status, GitHub CLI auth, and basic Drive visibility.

```bash
./scripts/check-env.sh
```

> Note: contains hard-coded paths that assume the maintainer's home directory layout. Adapt before
> using on a different machine.

### `new-agent-worktree.sh`

Creates an isolated git worktree for a WebJamApps sibling repo/branch — the setup an agent needs to
work on that repo without touching the shared main clone. Seeds the gitignored `.env` / `.env.test`
from the repo's main clone into the new worktree when present (a fresh worktree never inherits
gitignored files, which otherwise breaks local DB-backed test runs there — web-jam-tools#257).
Prints the new worktree's absolute path as the last line of stdout.

```bash
scripts/new-agent-worktree.sh <Repo> <branch> [base]
```

- `Repo` — sibling directory name under the workspace root (e.g. `WebJamSocketCluster`), must
  already be a git clone
- `branch` — branch name to create for the new worktree
- `base` — base ref to branch from (default: `dev`)

The worktree is created at `<Repo>/.claude/worktrees/<branch>` (`/` in the branch name is flattened
to `-`). Set `WEBJAMAPPS_ROOT` to override the default workspace root (`/home/joshua/WebJamApps`).

> Depends on `hooks/block-secret-dumps.sh`'s `cp`/`test` exception (web-jam-tools#257) — without it,
> an agent working inside the new worktree can't re-seed these files by hand if it ever needs to.

### `circleci-settings.ts`

Manages the CircleCI project settings standard (`autocancel_builds: true`) across all 8 active
WebJamApps projects (web-jam-tools#697). Supports drift checking via `--check` and idempotent
application.

```bash
# Check for configuration drift across all 8 projects
deno task circleci-settings -- --check

# Enforce the standard across all 8 projects
deno task circleci-settings
```

See [docs/circleci-project-settings.md](circleci-project-settings.md) for full documentation.

### `install-git-secret-hook.sh`

Installs the push-time secret scanner (`gitleaks` pre-push hook) and shared `.gitleaks.toml`
configuration into a target WebJamApps repository (web-jam-tools#658).

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

Downloads and installs the latest REAPER version to a specified prefix. Detects the currently
installed version, compares it to the latest available, and updates in place if needed. Preserves
user configuration in `~/.config/REAPER`.

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

> Safety: the script checks that REAPER is not running before updating and fails if it detects a
> running process. Quit REAPER before updating.

### `statusline.sh`

Model-aware Claude Code status line (web-jam-tools#688). Reads the status-line JSON payload Claude
Code writes to stdin, extracts `.model.display_name`, and prints a color-coded `[Opus]` / `[Sonnet]`
/ `[Haiku]` badge in front of the existing status line — so a terminal running the expensive tier is
visually distinguishable from a cheaper one at a glance. The match is on the family word in
`display_name`, case-insensitive, so a version bump (`Opus 5` to `Opus 6`) doesn't break it; an
unrecognized `display_name` prints uncolored rather than erroring, and a missing `.model` key or
malformed JSON on stdin both still produce a usable status line. The original stdin payload is
passed through unmodified to the downstream status-line command (`npx -y ccusage statusline` by
default) — the badge is a prefix, never a replacement.

Installed automatically by `scripts/install-hooks.sh`, which symlinks `scripts/statusline.sh` into
the same destination the `*.sh` hooks are linked into (honoring `--hooks-dir` / `CLAUDE_HOOKS_DIR`),
then merges a `statusLine` entry pointing at that stable installed path — never
`$REPO_DIR/scripts/statusline.sh`, which would break if the repo moved or a branch lacking the file
were checked out — into `~/.claude/settings.json` (Claude Code only — agy has no status-line
surface). The script is not a hook: it stays out of `HOOKS_SRC` and out of every hook-registration
loop, so it never gains a `PreToolUse`/`PostToolUse`/`SessionStart`/`Stop` entry.
`hooks/lib/check_hook_install_drift.ts` covers it anyway — a dead or unregistered `statusLine` is
reported at SessionStart the same way a dead or unregistered hook already is. Not meant to be run
standalone in normal use, but it can be for manual testing by piping a payload to it:

```bash
echo '{"model":{"id":"claude-opus-5","display_name":"Opus 5"}}' | scripts/statusline.sh
```

**Environment variables:**

- `STATUSLINE_DOWNSTREAM_CMD` (default: `npx -y ccusage statusline`) — the downstream command the
  captured payload is piped to after the badge. Overriding this is a test-only seam (the real
  default hits the network, which an automated test must not depend on); leave it unset for normal
  use.

### `update-all.sh`

Master update script that updates the local AI agent CLIs and DAW tooling in sequence:

1. `claude update` (Anthropic Claude Code CLI)
2. `agy update` (Google Antigravity CLI)
3. `codex update` (OpenAI Codex CLI)
4. `reaper-update` (Cockos REAPER digital audio workstation)

See [docs/local-dev-setup.md](local-dev-setup.md) for full developer environment setup and
installation steps on Linux.

**Invocation options (in preference order):**

1. **From anywhere** (after one-time setup):
   ```bash
   update-all
   ```
   One-time setup (run from repo root):
   ```bash
   ln -s "$PWD/scripts/update-all.sh" ~/.local/bin/update-all
   ```
   Requires `~/.local/bin` on PATH.

2. **From inside the repo:**
   ```bash
   deno task update:all
   ```

3. **Direct script invocation:**
   ```bash
   bash scripts/update-all.sh
   ```

**Options & Flags:**

- `--dry-run` (`-n`): Preview the update commands without executing them.
- `--fail-on-missing` / `--strict` (`-s`): Treat missing tools as failures (exit 1).
- `--help` (`-h`): Show usage and installation commands.

**Environment variables:**

- `CLAUDE_BIN`: Path or binary name for Claude CLI (default: `claude`).
- `AGY_BIN`: Path or binary name for Antigravity CLI (default: `agy`).
- `CODEX_BIN`: Path or binary name for Codex CLI (default: `codex`).
- `REAPER_UPDATE_BIN`: Path or command for REAPER updater (default: auto-detected from PATH or
  `$SCRIPT_DIR/reaper-update.sh`).

### `install-hooks.sh` — what actually gets symlinked

`scripts/install-hooks.sh` symlinks `hooks/*.sh` only — `hooks/lib/` is never installed, so there is
no `~/.claude/hooks/lib/` path on disk. A hook script reaches its shared `hooks/lib/*.ts` modules by
resolving its own symlink back to the canonical clone
(`HOOK_DIR=$(cd "$(dirname
"$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)`), then reading
`$HOOK_DIR/lib/<module>.ts` from there — agy reaches the same modules through those same Claude Code
symlinks via `hooks/agy-hook-shim.sh`. That means a content-only change to an already-installed hook
script, skill body, or `hooks/lib/*.ts` module is live on both surfaces the moment `dev` is pulled;
no install step is needed unless the change is structural (a new/renamed/deleted skill or hook, or a
changed event/matcher registration).

### `permissions.defaultMode`

The installer does not manage Claude Code's permission mode (`permissions.defaultMode` in
`~/.claude/settings.json`). Whatever mode is configured by the user remains untouched. A Sonnet or
Haiku subagent may edit in `auto` mode because `hooks/opus-delegation-gate.sh` judges a subagent by
its model rather than blocking edits based on auto mode (web-jam-tools#965, web-jam-tools#1232).

### `autoMode` (managed by `install-hooks.sh`)

The `autoMode` section of `~/.claude/settings.json` holds what Claude Code's auto-mode classifier
reads: the `environment` prose, the `allow` list and the `soft_deny` list.
`scripts/install-hooks.sh` owns the whole object. Its content is the `AUTO_MODE_JSON` block in that
script.

- **It is replaced as a whole.** A run installs the object when it is absent and replaces it when it
  differs; no other key in `settings.json` is touched. Object key order is ignored; the order of
  entries in a list counts. This differs from the permissions lists, which are additive.
- **Change it in `AUTO_MODE_JSON`, not in `settings.json`.** A hand edit to `settings.json` is
  reported by `--check` and overwritten by the next run. The previous file is kept as the usual
  `.bak-` backup.
- **The drift report names what differs.** Both `--check` and a replacing run list each top-level
  key that differs and, for a list, each entry only one side has, so a hand edit can be carried into
  `AUTO_MODE_JSON` first.
- **Paths are filled in at install time.** `__HOME__` in the block becomes `$HOME`, and
  `__REPOS_DIR__` becomes the directory that holds the `web-jam-tools` checkout the installer runs
  from (`~/WebJamApps` on Josh's laptop). The installed object is therefore correct on any machine.
- **Its strings are secret-scanned** with the same credential-literal check as `permissions` and
  `hooks`; a match refuses the write.

**Claude Code ONLY**, like `statusLine`: it is never merged into agy's
`hooks.json`.

### `skillOverrides` (managed by `install-hooks.sh`)

The `skillOverrides` section of `~/.claude/settings.json` holds overrides for Claude Code bundled
skills. `scripts/install-hooks.sh` sets the 30 skills bundled with Claude Code (13 document skills
named `anthropic-skills:<name>` and 17 built-in skills) to `name-only`, so their descriptions stop
loading at every session open while every skill stays listed and callable by name
(web-jam-tools#1240). Its content is the `SKILL_OVERRIDES_JSON` block in `scripts/install-hooks.sh`.

- **It is replaced as a whole.** A run installs the object when it is absent and replaces it when it
  differs; no other key in `settings.json` is touched.
- **Change it in `SKILL_OVERRIDES_JSON`, not in `settings.json`.** A hand edit to `settings.json` is
  reported by `--check` and overwritten by the next run.
- **The drift report names what differs.** Both `--check` and a replacing run list each key that
  differs or is missing.
- **Its strings are secret-scanned** with the same credential-literal check as `permissions` and
  `hooks`; a match refuses the write.

**Claude Code ONLY**: it is never merged into agy's `hooks.json`.

## Example scraping / data utilities

These scripts target a specific Wix-hosted site and were built as one-offs for the maintainer's use
case. They're committed as **examples of Playwright scraping patterns against a Wix site backed by
MUI DataGrid**, not as general-purpose tools.

| Script                 | What it does                                                       |
| ---------------------- | ------------------------------------------------------------------ |
| `debug-wix.js`         | Dumps the rendered DOM structure of the target site for inspection |
| `find-pagination.js`   | Detects pagination controls on the target site                     |
| `scrape-gigs-v2.js`    | First-pass scraper that walks pages of gig listings                |
| `scrape-gigs-v3.js`    | Newer scraper that handles MUI DataGrid virtualization             |
| `scrape-and-sync.js`   | Scrapes listings and writes them out as XLSX                       |
| `get-unique-venues.js` | Reads a text list of past gigs and emits unique venue names        |

### Prerequisites

```bash
npm install   # installs playwright + xlsx
npx playwright install chromium
```

All of these scripts read from / write to local paths that are hard-coded near the top of each file
(Dropbox, Google Drive mount, etc.). Edit the paths before running, or use them as reference
implementations only.
