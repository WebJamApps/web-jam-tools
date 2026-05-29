# CLAUDE.md

`web-jam-tools` is the central hub for shared configs, scripts, and
documentation across the WebJamApps workspace. This file orients Claude
(and any AI assistant) when working in this repository.

## Read first

- [GEMINI.md](GEMINI.md) — workspace rules (apply to all AI assistants, not just Gemini)
- [docs/scripts.md](docs/scripts.md) — index of utilities in `scripts/`
- [docs/ai-assistant-google-setup.md](docs/ai-assistant-google-setup.md) — generic recipe to set up Google MCP servers (no personal paths)
- [docs/api-integrations.md](docs/api-integrations.md) — machine-specific reference snapshot of one working setup
- [docs/rclone-setup.md](docs/rclone-setup.md) — rclone Drive mount via systemd

## Hard rules

- **Never merge to `dev` or `main`.** A human reviewer is the mandatory gatekeeper (per GEMINI.md).
- **Always start on a feature branch off `dev`** before editing code, and bump the semver `version` on push (enforced by `~/.claude/hooks/`).
- **JS/TS is Deno, not Node.** All TypeScript lives under `src/` + `test/` and runs on Deno (`deno task ...`); there is no `package.json` or `node_modules`. Python (`gemma-cli/`, `scripts/`) is unchanged.

## Layout

- `docs/` — markdown documentation
- `src/` — Deno TypeScript tools: `task-queue/` (master task-list CLI), `gig-scraper/` (Playwright + xlsx scrapers), `devotional/` (daily God Pause sender)
- `test/` — Deno tests
- `deno.json` — Deno config: tasks, import map, fmt + lint
- `scripts/` — workspace bootstrap (`bootstrap-project.sh`, `check-env.sh`) + Python/shell helpers
- `gemma-cli/` — the Coordinator REPL (Python, own venv)
