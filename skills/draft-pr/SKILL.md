---
name: draft-pr
description: Open a pull request the WebJamApps way — always draft, always based on dev, with "Closes #N" baked in. Use this to finish ANY coding task in a WebJamApps repo instead of calling `gh pr create` directly. Triggered when the user says "open a PR", "draft PR", "finish the task", or when you've completed a coding task on a feature branch.
metadata:
  version: v1
  publisher: josh
---

# draft-pr — finish a coding task by opening a draft PR

Never call `gh pr create` directly in a WebJamApps repo. Finish coding tasks by
running the shared script, which is the single source of truth for PR creation:

```
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh --author "Claude Code — <your model>"
```

It **always** produces a draft PR based on `dev` with `Closes #N` baked in, and an
attribution footer — none of which can be overridden. Josh alone reviews and flips
draft → ready on GitHub.

## Before you run it

1. You are on a feature branch named `claude/<issue#>-<slug>` (the issue number in
   the branch is how the script derives `Closes #N`). If your branch lacks the
   number, pass `--issue N` explicitly.
2. Everything is committed (clean working tree) and lint + tests are green.

## How to run it

Pass your actual model in `--author` so Josh can track per-model quality, and fill
the body sections via flags:

```
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
  --author "Claude Code — Opus 4.8" \
  --summary "What changed and why, in 2–4 sentences." \
  --test-plan "Exact commands to run + expected result." \
  --test-evidence "Confirmation lint + unit tests ran green; paste the final output." \
  --screenshots "Only for UI-visible changes; omit the flag otherwise."
```

- `--author` is **required** (the script refuses without it).
- The content flags are optional — anything you omit becomes a visible placeholder
  in the PR body for you or Josh to fill on GitHub. Prefer to fill `--summary`,
  `--test-plan`, and `--test-evidence` every time.
- `--screenshots` is for UI-visible changes only; omit the flag to omit the section.

## What the script refuses to do (and why that's correct — don't work around it)

It exits non-zero when: `--author` is missing, you're on `dev`/`main`, the working
tree is dirty, the repo has no `dev` branch, or no issue number can be resolved. If
it refuses, fix the underlying condition — do not fall back to `gh pr create`.
