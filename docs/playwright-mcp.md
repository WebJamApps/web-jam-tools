# Playwright MCP Server Setup & Usage Guide

*Created for [web-jam-tools#353](https://github.com/WebJamApps/web-jam-tools/issues/353). Last updated 2026-08-03.*

This document details the configuration and operational guidelines for using the official **Microsoft Playwright MCP Server** (`@playwright/mcp`) across the AI team (AGY/Flash and Claude/Sonnet) for live browser automation and production site debugging.

---

## 1. Overview & Capabilities

The Playwright MCP server exposes browser automation tools to AI assistants:

* **Live Web Navigation:** Navigate directly to production and staging URLs (`https://jam-music.org`, `https://appersonauto.com`, etc.).
* **DOM & Layout Inspection:** Retrieve full accessibility trees, page text, and DOM snapshots.
* **Console & Network Log Capture:** Inspect runtime JavaScript errors, console messages, and failed HTTP API requests (404, 500 status codes).
* **Interactive Debugging:** Click interactive elements, fill forms, trigger modals, and inspect dynamic single-page application (SPA) states.
* **Device Emulation:** Test responsive mobile and desktop viewports (`--mobile`, `--viewport-size`).

---

## 2. Configuration Files

The Playwright MCP server is registered in both AI assistant configuration locations:

### 🟢 Gemini / Antigravity CLI (`~/.gemini/config/mcp_config.json`)
```json
{
  "mcpServers": {
    "reaper": {
      "command": "/home/joshua/opt/Reaper-MCP/.venv/bin/reaper-mcp",
      "args": []
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--headless"]
    }
  }
}
```

### 🟣 Claude Code (`~/.claude/mcp_config.json`)
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--headless"]
    }
  }
}
```

---

## 3. Operational Guidelines for AI Agents

1. **Headless Execution:**
   * Run in `--headless` mode by default for fast, background execution without opening desktop windows.
   * If headed visual debugging is needed by the user, pass `--headless=false` in temporary execution commands.

2. **Rate Limits & Efficiency:**
   * Use mobile viewport emulation (`--mobile`) when checking mobile layout issues to save prompt/response tokens.
   * Take targeted snapshots rather than dumping full HTML source unless strictly necessary.

3. **Production Site Rules:**
   * Debug read-only states (e.g. layout rendering, public page API responses, network failures).
   * **Never** submit production admin forms or mutate production database state via browser tools without explicit approval from Josh.
