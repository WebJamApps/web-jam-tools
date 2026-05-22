# claude-code-setup plugin

A Claude Code plugin that bundles automation recommendations + scaffolding suggestions for a codebase. Use it when you want a quick pass on "what Claude Code automations (hooks, skills, subagents, MCP servers, plugins) would benefit this project?"

Installed user-wide 2026-05-18.

## Install / verify

```text
/plugin install claude-code-setup@claude-plugins-official
```

Verify install:

```bash
cat ~/.claude/plugins/installed_plugins.json
# expect: "claude-code-setup@claude-plugins-official"
```

The skill that does the analysis surfaces in Claude Code as `claude-code-setup:claude-automation-recommender`. The marketplace it came from is `claude-plugins-official` (cached under `~/.claude/plugins/cache/claude-plugins-official/`).

## When to invoke

Ask Claude in any Claude Code session:

```text
recommend automations for this project
```

Or invoke the skill directly:

```text
/claude-code-setup:claude-automation-recommender
```

Good moments to run it:

- First time setting up Claude Code in a repo
- After major refactors that change tooling (e.g. test runner swap, package manager swap)
- When you notice you keep doing the same manual step and want it automated

## Scope

The recommender suggests across these categories:

- **Hooks** (settings.json) — automated behaviors that run on Claude events (SessionStart, PostToolUse, etc.)
- **Skills** (~/.claude/skills/ or per-plugin) — slash-invokable specialized capabilities
- **Subagents** — for parallelizable / context-isolated work
- **MCP servers** — external integrations (Drive, Gmail, etc.)
- **Plugins** — pre-built bundles of the above

It does NOT generate code changes itself — it produces a prioritized list of recommendations to discuss + selectively implement.

## Related repos to consider running it against

When you carve out time, run it against these WebJamApps frontends/backends to surface project-specific automations:

- JaMmusic
- CollegeLutheran
- web-jam-back
- WebJamSocketCluster
- AppersonAuto

Each repo has its own surface area (Vite frontends vs Node/Express backends vs cron-driven scripts), so the recommendations differ meaningfully across them.

## Cross-refs

- Plugin source / marketplace: `claude-plugins-official` (see `~/.claude/plugins/known_marketplaces.json`)
- Other docs in this folder: [api-integrations.md](api-integrations.md), [ai-assistant-google-setup.md](ai-assistant-google-setup.md)
