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

## System Setup
- **OS:** Ubuntu
- **Node.js:** v24.15.0
- **Rclone:** Configured for Google Drive (`gdrive:`)
- **Persistence:** Systemd user services managed via `systemctl --user`
