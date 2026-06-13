# Gemini Instructions for WebJamApps

This file contains instructions and context for the Gemini CLI and AI assistants working in this workspace.

## Workspace Overview
- **Root Directory:** `/home/joshua/WebJamApps`
- **Primary Projects:** JaMmusic, AppersonAuto, CollegeLutheran, web-jam-back, WebJamPg, etc.
- **Tools Repo:** `web-jam-tools` (this repository)

## Collaboration Rules
1. **Rclone Mount:** Google Drive is mounted at `~/gdrive` via a systemd user service (`rclone-gdrive.service`).
2. **Coding Standards:** Refer to individual project `GEMINI.md` files (if present) for specific technology stacks.
3. **Repository Purpose:** `web-jam-tools` serves as a central hub for shared configurations, documentation of system setups, and general workspace memory.
4. **No Merging to DEV:** Gemini is **NOT** allowed to merge PR changes to the `dev` or `main` branches. The user acts as the mandatory human-in-the-loop reviewer and is responsible for all merges.

## Opening pull requests (all WebJamApps repos)

Finish a coding task by running the shared script — never `gh pr create` directly:

```
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh --author "<tool> — <model>"
```

It always opens a **draft** PR based on **`dev`** with **`Closes #N`** baked in
(derived from the `<lane>/<issue#>-<slug>` branch name) and a footer naming the
tool + model. These are hard invariants — no flag overrides them. Josh alone
reviews and flips draft → ready. See `skills/draft-pr/SKILL.md`.

## System Setup
- **OS:** Ubuntu
- **Node.js:** v24.15.0
- **Rclone:** Configured for Google Drive (`gdrive:`)
- **Persistence:** Systemd user services managed via `systemctl --user`

## API Integrations

See [docs/api-integrations.md](docs/api-integrations.md) for the current status of Google Drive/Docs/Sheets/Slides/Calendar/Tasks/Gmail integrations available to AI assistants. Update that file (and the dated note in Drive `My Drive / GEMINI / API_Integration_Status_*.md`) when integration state changes.
