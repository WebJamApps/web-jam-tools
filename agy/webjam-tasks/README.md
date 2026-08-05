# webjam-tasks — agy plugin

Antigravity CLI (`agy`) plugin that registers the **`/next`** slash command for the
WebJamApps task lane. `/next <Repo>#<issue-num>` pulls a named `agy`-labeled
GitHub issue, sets up a fresh branch off `dev`, and implements it in the current
agy session. It calls `../../scripts/handle-agy-tasks.sh --setup-only` for the
deterministic issue-fetch + git-branch setup. (Dispatch is GitHub-issues-only —
the older mode that pulled from `~/Dropbox/web-jam-llms/agy-tasks.txt` with no
issue argument was removed in web-jam-tools#249.)

It also bundles `hooks.json` + `hooks/block-merge-deploy.sh`, a PreToolUse hook
that denies PR merges, protected-branch pushes, and production deploys inside
**any** agy session (not just `/next`) — see "## Merge/deploy guard hook" below.
This is the agy-side counterpart to `hooks/block-dangerous-git-deploy.sh`, which
only binds Claude Code and never fires for agy (web-jam-tools#308 follow-up).

## Why a plugin (not a loose skill)

agy only surfaces a skill as a slash command when the skill lives inside an
**installed plugin** (a dir with a `plugin.json` at its root; agy auto-discovers the
`skills/` subdir). A bare `SKILL.md` anywhere on disk is never scanned — typing
`/next` just falls through to the nearest builtin (e.g. `/context`).

## Install (one-time, per machine)

```bash
agy plugin install ~/WebJamApps/web-jam-tools/agy/webjam-tasks
```

`install` **copies** the plugin into `~/.gemini/config/plugins/webjam-tasks/`, so by
default edits here wouldn't take effect without reinstalling. To make edits live,
repoint the installed files as symlinks back into this repo:

```bash
INST=~/.gemini/config/plugins/webjam-tasks
SRC=~/WebJamApps/web-jam-tools/agy/webjam-tasks
ln -sf "$SRC/plugin.json"          "$INST/plugin.json"
ln -sf "$SRC/hooks.json"           "$INST/hooks.json"
mkdir -p "$INST/hooks"
ln -sf "$SRC/hooks/block-merge-deploy.sh" "$INST/hooks/block-merge-deploy.sh"

# Symlink all skills under skills/ across ~/.claude/skills and ~/.gemini/config/plugins/webjam-tasks/skills:
scripts/install-skills.sh
```

After that, edit the files here, **restart agy**, and changes are live — no
reinstall. (Restart is still needed; agy reads skills/hooks at startup. Symlink
the *files*, not the dirs — agy's dir scan can skip symlinked directories.)

Verify any time with: `agy plugin validate "$INST"` and `agy plugin list`.

## Merge/deploy guard hook

`hooks/block-merge-deploy.sh` is a PreToolUse hook (agy's native hook contract,
see [antigravity.google/docs/hooks](https://antigravity.google/docs/hooks)) that
denies the same dangerous actions as the Claude-side guard: `gh pr merge`,
`git push origin main`/`dev`, `deno deploy --prod`/`deployctl deploy`, and the
REST/GraphQL merge endpoints (`gh api ... pulls/N/merge`, `gh api ...
repos/OWNER/REPO/merges`, and `gh api graphql` `mergePullRequest`/`mergeBranch`
mutations).

**What is verified, and what is not (read this before relying on it):**

- **Verified**: `agy plugin validate` confirms `hooks.json` is well-formed and
  the hook is discovered (`hooks : 1 processed`). The hook script's own
  matching logic was unit-tested directly (piping the documented PreToolUse
  stdin JSON shape into the script and checking its `{"decision":...}` stdout)
  for all of the block/allow cases above — see the PR that introduced this file
  for the exact commands and output.
- **NOT verified end-to-end**: this was never exercised inside a live,
  interactive/headless `agy` session actually attempting one of these
  commands. agy is closed-source (a compiled binary, not a browsable repo), so
  the exact args field name its shell-execution tool uses could not be
  confirmed against source — only against docs/blog examples. The hook works
  around that by pattern-matching the entire stdin payload rather than one
  named field (see the comment block at the top of the script), which should
  make it robust to that uncertainty, but this is a residual gap: **do not
  assume agy is fully blocked from these actions until someone runs it
  interactively and confirms a real deny.**
- This hook also does not share `hooks/lib/normalize_command.py`'s
  heredoc/prose-stripping, so — unlike the Claude-side guard — it may
  over-block prose that merely *mentions* a blocked command (e.g. a PR body
  describing `deno deploy --prod`). That is an intentional bias toward safety
  for a first version, not an oversight.
