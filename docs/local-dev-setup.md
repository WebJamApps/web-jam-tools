# Local Development Environment Setup (Linux)

This guide documents how to set up and maintain the local AI-assisted development environment across the WebJamApps workspace on Linux.

## Overview

The WebJamApps development workflow relies on multiple AI coding assistants, MCP servers, and audio production tools:

1. **Claude Code CLI (`claude`)** — Anthropic's interactive CLI agent for terminal-based development and subagent delegation.
2. **Antigravity CLI (`agy`)** — Google's coding agent CLI (Gemini Flash / Pro), utilized for headless task dispatch and high-efficiency full-stack implementation.
3. **OpenAI Codex CLI (`codex`)** — OpenAI's terminal-based coding assistant.
4. **Cockos REAPER DAW (`reaper` & `reaper-update`)** — Digital audio workstation used for music projects, MIDI generation, stem bounces, and live tracking via the Reaper MCP server.

To keep these tools current without having to remember distinct update commands for each ecosystem, a master update script [`scripts/update-all.sh`](../scripts/update-all.sh) is provided.

---

## Prerequisites & System Path

Ensure `~/.local/bin` exists and is included in your `PATH`. In `~/.bashrc` (or `~/.zshrc`):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Verify basic build and scripting tools:

```bash
sudo apt update && sudo apt install -y curl git bash tar xz-utils jq
```

Ensure modern runtime environments are installed:
- **Deno** (v2.x+): `curl -fsSL https://deno.land/install.sh | sh`
- **Node.js** (v20+ / v22+): via `nvm` or official NodeSource packages.

---

## Tool Installation Guide

### 1. Claude Code CLI (`claude`)

Anthropic Claude Code is installed globally into `~/.local/share/claude` with an entrypoint symlinked to `~/.local/bin/claude`:

```bash
# Official standalone installer
curl -fsSL https://claude.ai/install.sh | bash
```

Alternatively via npm:
```bash
npm install -g @anthropic-ai/claude-code
```

**Verification:**
```bash
claude --version
```

**Manual update:**
```bash
claude update
```

---

### 2. Google Antigravity CLI (`agy`)

The Antigravity CLI binary lives in `~/.local/bin/agy`.

1. Download or install the `agy` Linux binary to `~/.local/bin/agy`.
2. Ensure the binary is executable:
   ```bash
   chmod +x ~/.local/bin/agy
   ```
3. Run the built-in environment and shell configuration step:
   ```bash
   agy install
   ```

**Verification:**
```bash
agy --version
```

**Manual update:**
```bash
agy update
```

---

### 3. OpenAI Codex CLI (`codex`)

The OpenAI Codex CLI is installed via the official install script:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

**Verification:**
```bash
codex --version
```

**Manual update:**
```bash
codex update
```

---

### 4. Cockos REAPER DAW (`reaper` & `reaper-update`)

REAPER is installed to `$REAPER_PREFIX` (default: `/home/joshua/opt` or `$HOME/opt`).

1. **Initial Installation / Updates via `reaper-update.sh`:**
   Run the repository's REAPER updater script:
   ```bash
   bash scripts/reaper-update.sh
   # Or with a custom prefix:
   REAPER_PREFIX="$HOME/opt" bash scripts/reaper-update.sh
   ```
   The script checks the latest available Linux x86_64 release from `https://www.reaper.fm/download.php`, extracts the tarball, and runs the official Cockos `install-reaper.sh` installer quietly into your specified prefix.

2. **Symlink for Global PATH Access:**
   Create a symlink in `~/.local/bin` so `reaper-update` is runnable from anywhere:
   ```bash
   ln -s "$PWD/scripts/reaper-update.sh" ~/.local/bin/reaper-update
   ```

3. **Verify:**
   ```bash
   reaper-update
   ```
   > *Note:* REAPER user configuration and preferences are preserved in `~/.config/REAPER`. Always quit REAPER before updating.

---

## Combined Updating with `update-all`

To update all 4 development tools with a single command, use [`scripts/update-all.sh`](../scripts/update-all.sh).

### One-Time Setup (Recommended)

From the root of the `web-jam-tools` repository:

```bash
ln -s "$PWD/scripts/update-all.sh" ~/.local/bin/update-all
```

### Running the Update

Once symlinked, run from any terminal:

```bash
update-all
```

Or from inside the `web-jam-tools` repository:

```bash
deno task update:all
# or alias:
deno task update
# or direct script:
bash scripts/update-all.sh
```

### Script Execution Flow & Features

The script executes the updates in strict sequential order:
1. `claude update`
2. `agy update`
3. `codex update`
4. `reaper-update` (resolves `reaper-update` in PATH, falling back to `scripts/reaper-update.sh`)

At the conclusion of the run, a summary table is printed:

```text
[update-all] ==================== Summary ====================
[update-all] claude update:   SUCCESS
[update-all] agy update:      SUCCESS
[update-all] codex update:    SUCCESS
[update-all] reaper-update:   SUCCESS
[update-all] =================================================
```

### Flags & Options

- **Dry run:** Preview planned commands without executing updates:
  ```bash
  update-all --dry-run
  ```
- **Strict mode (fail on missing):** By default, missing tools are reported with a warning and marked as `SKIPPED (not installed)`. If you want the script to fail if any tool is absent:
  ```bash
  update-all --strict
  ```
- **Help:**
  ```bash
  update-all --help
  ```

### Overriding Binary Paths

If tools are installed under non-standard paths, override them via environment variables:

```bash
CLAUDE_BIN="/custom/bin/claude" \
AGY_BIN="/custom/bin/agy" \
CODEX_BIN="/custom/bin/codex" \
REAPER_UPDATE_BIN="/custom/bin/reaper-update" \
update-all
```

---

## Additional WebJamApps Workspace Setup

After setting up the CLIs above:

1. **Install Push-Time Secret Scanner:**
   ```bash
   bash scripts/install-git-secret-hook.sh
   ```
2. **Install Claude Skills:**
   ```bash
   deno task install-skills
   ```
3. **Install Claude & Antigravity Hooks:**
   ```bash
   bash scripts/install-hooks.sh
   ```
4. **Wire Multi-Root VSCode Workspace:**
   ```bash
   ln -s ~/WebJamApps/web-jam-tools/WebJamApps.code-workspace ~/WebJamApps/WebJamApps.code-workspace
   ```
