---
name: draft-issue
description: File a GitHub issue the WebJamApps way — a deliberately chosen model label, every referenced issue/PR cited as repo + number + title, a duplicate search first, and concrete closeable acceptance criteria (no perpetual trackers). Use this instead of calling `gh issue create` (or the GitHub MCP `issue_write` create path) directly. Triggered when the user says "file an issue", "open an issue", "draft an issue", or when a task needs a tracking issue instead of just being done inline.
metadata:
  version: v1
  publisher: josh
---

# draft-issue — file a GitHub issue the WebJamApps way

## Execution model

This is mechanical-with-light-judgment (search for duplicates, write acceptance criteria that
close cleanly, pick one label from a six-item list) — run it on **Sonnet**, the cheapest tier that
reliably gets the judgment calls right. It is not hard-gated to a single model the way `/fix-labels`
and `/handle-gmails` are (this skill is the quality layer, not the floor — see "Why a skill AND a
hook" below); if you're running on a pricier model because you're mid-conversation, finish the
issue rather than switching, but don't default to Opus/Fable for a fresh `/draft-issue` invocation.

## Why a skill AND a hook

`hooks/require-model-label-on-issue-create.sh` (web-jam-tools#265) is a hard gate: it denies any
`gh issue create` or MCP `issue_write` create call that doesn't carry exactly one label from
`skills/fix-labels/labels.yaml`'s `modelTier: true` entries (`Haiku`, `Sonnet`, `Opus`, `Fable`,
`Flash Med`, `Flash High`) — read at runtime from the generated sidecar
`skills/fix-labels/model-labels.json`, since the hook is bash/python and can't parse YAML in CI.
That hook closes the silent-omission hole — it cannot judge whether the
label is the *right* one, whether the body cites its references correctly, whether a duplicate
already exists, or whether the acceptance criteria actually let the issue close. This skill is the
quality layer on top of that floor. Skipping this skill still gets caught by the hook if you forget
the label entirely; it does NOT get caught if you pick the label carelessly or write a vague body —
that's what following this skill prevents.

## Before you file

1. **Search for a duplicate first.** Run `gh issue list --repo WebJamApps/<repo> --state all --search
   "<keywords>"` (or `mcp__*__search_issues`) with a couple of keyword variants before creating
   anything. If a close match exists, comment on it or reopen it instead of filing a new one — a
   second issue for the same problem splits the discussion and the fix.
2. **Choose the model label deliberately, not as an afterthought.** This is the thing
   web-jam-tools#265 exists because of: web-jam-tools#263 shipped with only a `bug` label and no
   model label, because the label was going to be "added later." Decide the label as part of
   deciding what the issue IS — before you write the body — from:
   - `Haiku` — mechanical/one-off: lookups, scans, single-file/one-field edits, typo/data fixes,
     running tests/builds and reporting the result.
   - `Sonnet` — ordinary contained coding: a fix or feature across a few files, tests, light
     refactors.
   - `Opus` — genuine multi-file judgment, design/spec work, reviewing another model's output.
   - `Flash Med` / `Flash High` — frontend/UI coding, canonical in all 8 active repos per
     `skills/fix-labels/labels.yaml` (Josh's call, 2026-07-31: Flash High is at Sonnet quality and
     Flash Med a viable Haiku substitute, so both are routable everywhere, not just the front-end
     repos); pick High only when Medium is likely to need multiple retries.
   - `Fable` — retired/dormant; do not apply to new issues (kept in the schema for
     delete-protection only, per `skills/fix-labels/labels.yaml`).
   When genuinely unsure between two tiers, say so in the issue body rather than guessing — but
   still pick one label, since the hook requires exactly one.
3. **Draft acceptance criteria that let the issue CLOSE.** Concrete, checkable conditions — not a
   standing tracker that never resolves. A "make X better" issue with no finish line is a defect,
   not a feature request; if the work is genuinely open-ended, scope the issue to one concrete step
   and file a follow-up for the next one rather than leaving it perpetually open (see memory
   `github-issues-must-be-closeable`).

## Citation format (every reference, every time)

Every issue or PR the body mentions — first mention, tenth mention, a parenthetical, a "blocked by"
note, a "related to" aside — gets **repo + number + title**, no exceptions:

```
web-jam-tools#263 "/fix-labels reports success while leaving real drift behind — the schema diff is
eyeballed, not computed"
```

A bare `#263` or `wjt#263` is wrong even mid-sentence, even in a list where the previous line
already named it. If you don't know the title, look it up before writing the sentence:

```sh
gh issue view 263 --repo WebJamApps/<repo> --json title -q .title
gh pr view 263 --repo WebJamApps/<repo> --json title -q .title
```

## How to file it

```sh
gh issue create --repo WebJamApps/<repo> \
  --title "Short, specific title" \
  --body "$(cat <<'EOF'
## Why
...

## Acceptance criteria
- ...

## Non-goals
- ...
EOF
)" \
  --label Sonnet
```

- Exactly **one** label from the six model labels above — the hook denies zero or two-plus.
- Add non-model labels (`bug`, `enhancement`, `blocked`, a priority label, ...) alongside the model
  label freely; the hook only checks that exactly one *model* label is present, not that it's the
  only label.
- The MCP `issue_write` create path takes the same label as a JSON array element
  (`"labels": ["Sonnet", "bug"]`) — same one-model-label rule, same hook.

## If the hook denies the call

The denial message names what's wrong (no model label / multiple model labels / unparseable) and
lists the valid labels straight from `skills/fix-labels/model-labels.json` (generated from
`skills/fix-labels/labels.yaml`). Fix the `--label` flags (or
the MCP `labels` array) per the message and retry — there is no bypass, and there shouldn't be one:
the hook exists because "add the label after" is exactly how web-jam-tools#263 shipped unlabeled.
