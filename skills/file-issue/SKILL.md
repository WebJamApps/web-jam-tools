---
name: file-issue
description: File a GitHub issue the WebJamApps way — deliverable-first body shape (`## What this builds`), a deliberately chosen model label, every referenced issue/PR cited as repo + number + title, a duplicate search first, epics closing when children close, native Priority set via MCP, and concrete closeable acceptance criteria (no perpetual trackers). Use this instead of calling `gh issue create` (or the GitHub MCP `issue_write` create path) directly. Triggered when the user says "file an issue", "open an issue", "draft an issue", or when a task needs a tracking issue instead of just being done inline.
metadata:
  version: v1
  publisher: josh
---

# file-issue — file a GitHub issue the WebJamApps way

**HARD GATE:** Do you have Josh's (or other human's) explicit approval to file THIS issue, in this session? If not, STOP and ask.

## Execution model

This is mechanical-with-light-judgment (search for duplicates, write acceptance criteria that
close cleanly, pick one label from the model-tier list in `skills/fix-labels/labels.yaml`) — run it
on **Sonnet**, the cheapest tier that
reliably gets the judgment calls right. It is not hard-gated to a single model the way `/fix-labels`
and `/handle-gmails` are (this skill is the quality layer, not the floor — see "Why a skill AND a
hook" below); if you're running on a pricier model because you're mid-conversation, finish the
issue rather than switching, but don't default to Opus/Fable for a fresh `/file-issue` invocation.

## Why a skill AND a hook

`hooks/require-model-label-on-issue-create.sh` (web-jam-tools#265) is a hard gate: it denies any
`gh issue create` or MCP `issue_write` create call that doesn't carry exactly one label from
`skills/fix-labels/labels.yaml`'s `modelTier: true` entries — read at runtime from the generated
sidecar `skills/fix-labels/model-labels.json` (not restated here; that list drifts every time a
model tier is added or retired, so `labels.yaml` is the only place it lives), since the hook is
bash/python and can't parse YAML in CI.
That hook closes the silent-omission hole — it cannot judge whether the
label is the *right* one, whether the body cites its references correctly, whether a duplicate
already exists, or whether the acceptance criteria actually let the issue close. This skill is the
quality layer on top of that floor. Skipping this skill still gets caught by the hook if you forget
the label entirely; it does NOT get caught if you pick the label carelessly or write a vague body —
that's what following this skill prevents.

## Before you file

1. **Search for a duplicate first.** Run `gh issue list --repo WebJamApps/<repo> --state all --search
   "<keywords>"` (or `mcp__*__search_issues`) with a couple of keyword variants before creating
   anything. If an OPEN issue matches, use or update that open issue. However, if a matching issue is CLOSED, do NOT modify, comment on, or attempt to reuse it — see the Closed Issues Are Immutable rule below.
2. **Choose the model label deliberately, not as an afterthought.** This is the thing
   web-jam-tools#265 exists because of: web-jam-tools#263 shipped with only a `bug` label and no
   model label, because the label was going to be "added later."    Decide the label as part of
    deciding what the issue IS — before you write the body — from:
    - `Flash Med` — mechanical work, documentation cleanup/link updates, single-file edits, and routine execution tasks across all repos (Josh's default choice to save token quota; viable Haiku substitute).
    - `Flash High` — full-stack coding (FE, BE, APIs, tooling), contained refactoring, multi-file feature edits, and interactive work across all repos (Josh's default tier for interactive work; fast, cost-effective Sonnet alternative).
    - `Haiku` — mechanical/one-off: lookups, scans, single-file/one-field edits, typo/data fixes, running tests/builds and reporting the result.
    - `Sonnet` — major feature implementation, multi-file refactoring, complex backend/system coding, and deep reasoning across codebases (top-tier software engineering model; slightly higher capability than Flash High).
    - `Opus` — top-tier architectural design, complex tech-lead judgment, spec/requirements alignment, and reviewing complex subagent outputs.
    - `Fable` — retired/dormant; do not apply to new issues (kept in the schema for
      delete-protection only, per `skills/fix-labels/labels.yaml`).
   When genuinely unsure between two tiers, say so in the issue body rather than guessing — but
   still pick one label, since the hook requires exactly one.
3. **Draft acceptance criteria that let the issue CLOSE (Epics close when children close).**
   Concrete, checkable conditions — not a standing tracker that never resolves. A non-epic closes
   when its work is done; **an epic closes when its children close** (epics are not implementable
   themselves, but close when all child issues complete). Perpetual trackers remain banned. If the
   work is genuinely open-ended, scope the issue to one concrete step and file a follow-up for the next
   one rather than leaving it perpetually open.
4. **Executable Issue rule (Every non-Epic issue must stand alone).** Every issue body not typed
   `Epic` must stand alone without unresolvable pointer phrases (e.g., "see the comment", "see comment",
   "read the comment first", "read comment first", "as discussed above", "as discussed in",
   "per the discussion", "in the epic", "see the epic"). Anyone (human or AI model) picking up an
   issue must be able to execute it directly from the issue body without hunting through issue
   comments or parent epic threads for requirements. Sub-issues derived from an Epic must have their
   full requirements authored directly in the sub-issue body first before creation. Note: Native issue
   type `Epic` (which is orthogonal to model labels) is exempt from this check on edit paths (`gh issue edit`
   or MCP update), allowing Epics to reference comments or sub-issues as discussion evolves.
5. **Require Native Issue Type (`--type`).** Every new issue creation MUST explicitly specify a
   valid native GitHub issue type (`Task`, `Bug`, `Feature`, `Epic`) using `--type <Type>` or `-t <Type>`
   (or `"type": "<Type>"` in MCP `issue_write`). Native issue types are enforced by
   `hooks/require-model-label-on-issue-create.sh` (web-jam-tools#415).
6. **Apply `Needs Design` Label when Design is Required.** For Epics or sub-issues requiring design
   clarification before implementation, apply the canonical `Needs Design` status label alongside the chosen
   model label and native type.
7. **Closed Issues Are Immutable.** Never modify, reopen, add comments to, or add new requirements to a closed GitHub issue. Closed issues represent finished state. When new scope, follow-up findings, or modifications arise for a closed issue, file a net-new issue citing the closed issue (repo + number + title) instead.
8. **Prompt for a Milestone Before Filing.** Check the repo's open Milestones (`gh api repos/WebJamApps/<repo>/milestones` or `gh milestone list`) before creating the issue. Select one deliberately if a fitting Milestone exists. If no open Milestone fits the issue, explicitly note so in chat or in the issue body ("no fitting milestone — leaving unassigned") rather than silently omitting it. Note: This is a skill-level nudge, not a hook gate — `hooks/require-model-label-on-issue-create.sh` continues to enforce model label + native Type.
9. **Deliverable-First Body Shape (What this builds).** Open the issue body directly with a section
   titled `## What this builds` carrying a 1-2 sentence description of what is being built, immediately
   followed by a numbered list of what it does — no history preamble, conversation background, or past context.
10. **Set Native Priority Field via MCP, Never via `gh`.** Set the native `Priority` field (`Urgent`,
    `High`, `Medium`, `Low`) via GitHub MCP `issue_write` → `issue_fields` (or `set_issue_field`). `gh`
    CLI cannot set native GitHub project fields; never attempt to set native Priority via `gh`.

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

Always use `scripts/create-issue.ts` (or `deno task create-issue`):

```sh
deno task create-issue \
  --repo WebJamApps/<repo> \
  --title "Short, specific title" \
  --body-file /path/to/body.md \
  --type Task \
  --label Sonnet \
  --milestone "v1.2" \
  --priority High \
  --parent 437
```

`scripts/create-issue.ts` standardizes issue creation across all repos:
- Sets labels, milestone, native issue Type (`Task`, `Bug`, `Feature`, `Epic`), native Priority (`Urgent`, `High`, `Medium`, `Low`), and attaches the parent issue link (`--parent <num>`) via GraphQL `addSubIssue`.
- Re-reads the created issue afterwards and verifies all requested attributes stick (exits non-zero if any attribute failed to stick).
- Prints the formatted issue on success as `repo#number "title"`.

- Require `--type <Type>` (`Task`, `Bug`, `Feature`, `Epic`) on all issue creation calls.
- Specify `--milestone "<name>"` when an open repo Milestone matches the scope. If no open Milestone fits, explicitly note "no fitting milestone — leaving unassigned" in chat or body.
- Exactly **one** label from the six model labels above — the hook denies zero or two-plus.
- Add non-model status labels (`Blocked`, `Needs Design`, `Josh`, `parked`, ...)
  alongside the model label freely; the hook only checks that exactly one *model* label is present,
  not that it's the only label.
- Set native `Priority` field (`Urgent`, `High`, `Medium`, `Low`) via `scripts/create-issue.ts --priority <Level>`.
- Attach parent issue link via `scripts/create-issue.ts --parent <parent_issue_number>`.

## If the hook denies the call

The denial message names what's wrong (missing/invalid native issue type, no model label,
multiple model labels, unresolvable pointer phrases, or unparseable command) and lists valid native
types or model labels straight from `skills/fix-labels/model-labels.json`. Fix the `--type` and
`--label` flags (or the MCP `type` and `labels` fields) per the message and retry — there is no
bypass, and there shouldn't be one: the hook exists to enforce executable, properly categorized issues.
