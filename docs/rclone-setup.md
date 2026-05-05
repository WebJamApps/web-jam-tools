# Rclone Google Drive Setup (Ubuntu)

This document details the rclone configuration used to mount Google Drive locally.

## Configuration Details
- **Remote Name:** `gdrive`
- **Type:** Google Drive
- **Mount Point:** `/home/joshua/gdrive`
- **Cache Mode:** `writes`

## Systemd Service
The mount is managed by a systemd user service located at:
`~/.config/systemd/user/rclone-gdrive.service`

### Service Commands
- **Start:** `systemctl --user start rclone-gdrive.service`
- **Stop:** `systemctl --user stop rclone-gdrive.service`
- **Check Status:** `systemctl --user status rclone-gdrive.service`
- **Enable on Boot:** `systemctl --user enable rclone-gdrive.service`

## Manual Mount Command
If needed, the manual command is:
```bash
rclone mount gdrive: ~/gdrive --vfs-cache-mode writes
```
