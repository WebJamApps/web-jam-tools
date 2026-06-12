# memory-cleanup — Obsidian vault & hand-editing notes

The `/memory-cleanup` skill audits the memory surfaces (see `SKILL.md`). Obsidian is
an optional companion: it gives a visual graph of the memory files and an
unresolved-links panel that doubles as a dangling-`[[link]]` detector.

Memory files are already Obsidian-compatible — they use YAML frontmatter and `[[wiki]]`
links, no conversion needed.

## One-time setup

1. **Install Obsidian — MUST be run by Josh in a NATIVE terminal**, not from Claude
   Code / the VS Code integrated terminal. Claude Code runs inside the VS Code **snap**
   sandbox, where `XDG_DATA_HOME` is redirected to `~/snap/code/<rev>/.local/share/`.
   A `flatpak --user install` from there lands in that throwaway sandbox dir (not your
   real `~/.local/share/flatpak`), and nesting flatpak's bubblewrap inside the snap
   fails to launch (`Bad file descriptor` / "commit … not installed"). So an agent
   cannot install or verify Obsidian for you — do it yourself:

   ```bash
   # in a real terminal (Ctrl+Alt+T), uses the existing SYSTEM flathub remote:
   flatpak install flathub md.obsidian.Obsidian   # polkit will ask for your password
   flatpak run md.obsidian.Obsidian               # confirm it opens
   ```

   Fallback if you'd rather avoid flatpak entirely: the official `.deb` from
   <https://obsidian.md> (`sudo apt install ./obsidian_*.deb`) — also un-sandboxed and
   shows up in the app launcher.
2. **Cross-AI store symlinked into the projects tree** (done by the build — this part
   is a plain symlink in real `$HOME`, unaffected by the snap redirect) so it shows up
   alongside the per-project memory dirs:

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
