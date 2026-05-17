#!/bin/bash

# WebJamApps Project Bootstrapper
# Usage: ./bootstrap-project.sh <project-name>

PROJECT_NAME=$1

if [ -z "$PROJECT_NAME" ]; then
    echo "Usage: $0 <project-name>"
    exit 1
fi

ROOT_DIR="/home/joshua/WebJamApps"
PROJECT_DIR="$ROOT_DIR/$PROJECT_NAME"

if [ -d "$PROJECT_DIR" ]; then
    echo "Error: Directory $PROJECT_DIR already exists."
    exit 1
fi

echo "--- Bootstrapping $PROJECT_NAME ---"

# 1. Create directory and basic files
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

cat <<EOM > README.md
# $PROJECT_NAME

This project was bootstrapped by the WebJamApps Bootstrapper.

## Setup
- Clone the repo
- Copy .env.example to .env
- Install dependencies
EOM

cat <<EOM > GEMINI.md
# Gemini Context: $PROJECT_NAME

## Tech Stack
- (Update this section)

## Development Workflow
- (Update this section)
EOM

cat <<EOM > .gitignore
node_modules/
.env
dist/
coverage/
.DS_Store
EOM

touch .env.example

# 2. Git and GitHub Setup
git init
git add .
git commit -m "initial commit"

echo "Creating GitHub repository in WebJamApps organization..."
gh repo create "WebJamApps/$PROJECT_NAME" --public --source=. --push

# 3. Branching and Protection
echo "Setting up branches..."
git checkout -b dev
git push -u origin dev
gh repo edit "WebJamApps/$PROJECT_NAME" --default-branch dev

echo "Applying branch protection..."
PROTECTION_JSON='{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "restrictions": null
}'

echo "$PROTECTION_JSON" | gh api -X PUT "/repos/WebJamApps/$PROJECT_NAME/branches/main/protection" --input -
echo "$PROTECTION_JSON" | gh api -X PUT "/repos/WebJamApps/$PROJECT_NAME/branches/dev/protection" --input -

echo "--- $PROJECT_NAME is ready! ---"
