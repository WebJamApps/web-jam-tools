#!/bin/bash

echo "--- WebJamApps Workspace Health Check ---"

# Check Node
echo -n "[Node.js] "
node -v || echo "Not found"

# Check Rclone Mount
echo -n "[Google Drive Mount] "
if systemctl --user is-active --quiet rclone-gdrive.service; then
    echo "Active (Systemd)"
else
    echo "Inactive! Run: systemctl --user start rclone-gdrive.service"
fi

# Check GitHub CLI
echo -n "[GitHub CLI] "
gh auth status 2>&1 | grep -q "Logged in" && echo "Authenticated" || echo "Not Authenticated"

# Check Mount Visibility
echo -n "[Drive Files Visible] "
ls /home/joshua/gdrive > /dev/null 2>&1 && echo "Yes" || echo "No"

echo "----------------------------------------"
