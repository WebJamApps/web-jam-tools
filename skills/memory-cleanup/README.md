# memory-cleanup — Obsidian vault & hand-editing notes

The `/memory-cleanup` skill audits the memory surfaces (see `SKILL.md`). Obsidian is
an optional companion: it gives a visual graph of the memory files and an
unresolved-links panel that doubles as a dangling-`[[link]]` detector.

Memory files are already Obsidian-compatible — they use YAML frontmatter and `[[wiki]]`
links, no conversion needed.

## One-time setup (done by the skill build, except the last manual step)

1. **Obsidian installed** on the laptop (flatpak `md.obsidian.Obsidian`, or snap / the
   official `.deb` as fallback).
2. **Cross-AI store symlinked into the projects tree** so it shows up alongside the
   per-project memory dirs:

   ```bash
   ln -s ~/Dropbox/web-jam-llms ~/.claude/projects/dropbox-web-jam-llms
   ```

   This is safe for `scripts/backup-claude-memory.sh`: that script only syncs each
   project's `memory/` subdir, and the symlinked dir has none — so it's skipped.
   (Verified by a manual backup run; `backup-log.txt` still logs `ok`.)

## The one manual step left for Josh

Open Obsidian once and point it at the projects tree:

> **Obsidian → "Open folder as vault" → `~/.claude/projects`**

After that, every per-project `memory/` dir plus the symlinked `dropbox-web-jam-llms`
store appears as one vault. The left-rail **unresolved links** view lists every
`[[link]]` with no target file — the same dangling-link finding the skill reports.

## Agent-safety rules for hand-editing memory files

These keep the files parseable by *all* agents (Claude Code, Gemma, agy, phone Sonnet),
not just Obsidian:

- **Keep the YAML frontmatter intact** — `name`, `description`, `metadata.type`. The
  skill's staleness policy keys off `metadata.type`; a dropped or malformed block
  makes a file un-typed.
- **No Obsidian-only plugin syntax** — no Dataview queries, no `%%comments%%`, no
  embeds beyond plain `[[wikilinks]]`. Stick to standard Markdown + frontmatter so
  every agent can read the file.
- **`.obsidian/` is expected and out of backup scope** — Obsidian writes its config
  there; the backup script only syncs `memory/` subdirs, so it's ignored. Don't add
  it to backup.
