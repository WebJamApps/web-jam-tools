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
- Don't commit `node_modules/`, environment files, or credentials. The `.gitignore` covers the obvious cases.
- When adding new scripts, document them in `docs/scripts.md`.

## License

No license file is currently committed. Treat as all rights reserved unless otherwise specified by the maintainer.
