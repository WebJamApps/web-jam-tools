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
- **Never commit `node_modules/`.** It is covered by `.gitignore` — keep it that way.

## Layout

- `docs/` — markdown documentation
- `scripts/` — workspace bootstrap (`bootstrap-project.sh`, `check-env.sh`) and gig-scraping scripts
- `package.json` — deps for the scripts (xlsx, playwright)
