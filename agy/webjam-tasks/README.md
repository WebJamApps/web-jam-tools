# webjam-tasks — agy plugin

Antigravity CLI (`agy`) plugin that registers the **`/next`** slash command for the
WebJamApps task lane. `/next` pulls the next queued coding task (from
`~/Dropbox/web-jam-llms/agy-tasks.txt` or a named `agy`-labeled GitHub issue), sets
up a fresh branch off `dev`, and implements it in the current agy session. It calls
`../../scripts/handle-agy-tasks.sh --setup-only` for the deterministic
queue-parse + git-branch setup.

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
ln -sf "$SRC/skills/next/SKILL.md" "$INST/skills/next/SKILL.md"
```

After that, edit the files here, **restart agy**, and changes are live — no
reinstall. (Restart is still needed; agy reads skills at startup. Symlink the
*files*, not the dirs — agy's dir scan can skip symlinked directories.)

Verify any time with: `agy plugin validate "$INST"` and `agy plugin list`.
