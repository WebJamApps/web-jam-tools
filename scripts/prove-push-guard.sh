#!/usr/bin/env bash
# prove-push-guard.sh — web-jam-tools#1404
# Runs the design's "Proof before any new key" on the laptop:
# 1. Verifies git config --global core.hooksPath points to this clone's git-hooks (fails naming install-hooks.sh otherwise).
# 2. Sets up a throwaway repository under /tmp with a local bare remote.
# 3. Refuses push with fake Google-key-shaped string built at runtime, naming file, line, rule, never value.
# 4. Clean push succeeds.
# 5. Push refused with Docker stopped and no gitleaks program on PATH.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_HOOKS_PATH="$REPO_DIR/git-hooks"

# 1. Read global git configuration only
HOOKS_PATH="$(git config --global --get core.hooksPath 2>/dev/null || true)"
if [ -z "$HOOKS_PATH" ] || [ "$(readlink -f "$HOOKS_PATH" 2>/dev/null || echo "$HOOKS_PATH")" != "$(readlink -f "$EXPECTED_HOOKS_PATH" 2>/dev/null || echo "$EXPECTED_HOOKS_PATH")" ]; then
  echo "ERROR: git config --global core.hooksPath is not set to this clone's git-hooks directory ($EXPECTED_HOOKS_PATH)." >&2
  echo "       Run scripts/install-hooks.sh first to install the push-time secret guard." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d /tmp/prove-push-guard-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

REMOTE_DIR="$TMP_DIR/remote.git"
LOCAL_DIR="$TMP_DIR/local"

git init --bare -q "$REMOTE_DIR"
git clone -q "$REMOTE_DIR" "$LOCAL_DIR"
git -C "$LOCAL_DIR" config user.email "proof@webjam.com"
git -C "$LOCAL_DIR" config user.name "Push Guard Proof"

# Initial base commit pushed to main
echo "# Push Guard Proof" > "$LOCAL_DIR/README.md"
git -C "$LOCAL_DIR" add README.md
git -C "$LOCAL_DIR" commit -q -m "initial commit"
git -C "$LOCAL_DIR" push -q origin HEAD:main

echo "=== STAGE 1: Refused fake Google API key ==="
# Build fake Google-key-shaped string at runtime from pieces: AIzaSy + 33 chars = 39 chars
FAKE_KEY="AIzaSy$(printf '7%.0s' {1..33})"
echo "const apiKey = \"$FAKE_KEY\";" > "$LOCAL_DIR/leak.ts"
git -C "$LOCAL_DIR" add leak.ts
git -C "$LOCAL_DIR" commit -q -m "commit containing fake Google key"

STAGE1_OUT=""
STAGE1_STATUS=0
STAGE1_OUT="$(git -C "$LOCAL_DIR" push origin HEAD:main 2>&1)" || STAGE1_STATUS=$?

if [ "$STAGE1_STATUS" -eq 0 ]; then
  echo "ERROR: Push with fake Google API key succeeded, expected refusal!" >&2
  exit 1
fi

# Verification discipline: file, line, rule named, but NEVER the secret value
if ! echo "$STAGE1_OUT" | grep -q "leak.ts"; then
  echo "ERROR: Refusal output did not name file 'leak.ts':" >&2
  echo "$STAGE1_OUT" >&2
  exit 1
fi

if ! echo "$STAGE1_OUT" | grep -q "google-api-key"; then
  echo "ERROR: Refusal output did not name rule 'google-api-key':" >&2
  echo "$STAGE1_OUT" >&2
  exit 1
fi

if echo "$STAGE1_OUT" | grep -q "$FAKE_KEY"; then
  echo "ERROR: Refusal output leaked the secret value!" >&2
  exit 1
fi

echo "$STAGE1_OUT"
echo "OK: Refusal confirmed naming file, line and rule, with secret value unprinted."
echo

echo "=== STAGE 2: Clean push succeeds ==="
# Reset back to base commit and add clean commit
git -C "$LOCAL_DIR" reset --hard -q HEAD~1
echo "export const cleanValue = 42;" > "$LOCAL_DIR/clean.ts"
git -C "$LOCAL_DIR" add clean.ts
git -C "$LOCAL_DIR" commit -q -m "clean commit"

STAGE2_OUT="$(git -C "$LOCAL_DIR" push origin HEAD:main 2>&1)"
echo "$STAGE2_OUT"
echo "OK: Clean push succeeded."
echo

echo "=== STAGE 3: Docker stopped and no gitleaks program on PATH ==="
# Add another clean commit to test push under stopped Docker + no gitleaks
echo "export const anotherClean = 100;" >> "$LOCAL_DIR/clean.ts"
git -C "$LOCAL_DIR" add clean.ts
git -C "$LOCAL_DIR" commit -q -m "second clean commit"

# Create an isolated bin directory with essential system commands, excluding gitleaks
NO_GITLEAKS_BIN="$TMP_DIR/no_gitleaks_bin"
mkdir -p "$NO_GITLEAKS_BIN"
for cmd in git bash sh dirname basename cat rm mktemp date printf tr grep sed awk cut wc head tail chmod readlink ls docker; do
  p="$(command -v "$cmd" || true)"
  if [ -n "$p" ]; then
    ln -s "$p" "$NO_GITLEAKS_BIN/$cmd"
  fi
done

STAGE3_OUT=""
STAGE3_STATUS=0
STAGE3_OUT="$(PATH="$NO_GITLEAKS_BIN" DOCKER_HOST="unix:///tmp/nonexistent-docker.sock" git -C "$LOCAL_DIR" push origin HEAD:main 2>&1)" || STAGE3_STATUS=$?

if [ "$STAGE3_STATUS" -eq 0 ]; then
  echo "ERROR: Push with Docker stopped succeeded, expected refusal!" >&2
  exit 1
fi

if ! echo "$STAGE3_OUT" | grep -q "Docker is required to run gitleaks"; then
  echo "ERROR: Expected Docker failure message not found in output:" >&2
  echo "$STAGE3_OUT" >&2
  exit 1
fi

echo "$STAGE3_OUT"
echo "OK: Push refused when Docker is stopped and gitleaks is not on PATH."
echo

echo "Push guard proof: all 3 outcomes verified successfully."
exit 0
