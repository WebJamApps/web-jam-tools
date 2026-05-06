# web-jam-tools

Central hub for shared configuration, scripts, and documentation across the
WebJamApps workspace. The repo is geared toward making AI-assisted
development (Claude Code, Gemini CLI) productive across many sibling
project directories that live alongside it on the same machine.

## What's in here

- **`docs/`** — system-setup and integration documentation (rclone, Google APIs, etc.)
- **`scripts/`** — workspace bootstrapping, environment checks, and example scraping/data-prep utilities
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

## Contributing

- Branch from `dev`, open a PR against `dev`. Do not merge to `dev` or `main` from an AI assistant — a human reviewer is required.
- Don't commit `node_modules/`, environment files, or credentials. The `.gitignore` covers the obvious cases.
- When adding new scripts, document them in `docs/scripts.md`.

## License

No license file is currently committed. Treat as all rights reserved unless otherwise specified by the maintainer.
