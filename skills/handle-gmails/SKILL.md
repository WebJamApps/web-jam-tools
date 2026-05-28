---
name: handle-gmails
description: Process Josh's Gmail inbox one message at a time, newest first. Suggest action (archive / delete / draft reply / label / mark important / mark spam / unsubscribe / next). Pause for approval before executing. Runs on TWO surfaces — laptop Opus (Claude Code, local mcp__gmail__ tools + local files) and phone Sonnet (Claude app, mcp__claude_ai_Gmail__ tools, no filesystem). Covers joshua.v.sherman@gmail.com primary account only — web.jam.adm@gmail.com is handled manually via the Gmail web UI. Per-sender auto-archive rules in rules.yaml (laptop only). Daily-handled log in log/<YYYY-MM-DD>.md (laptop only, auto-pruned after 7 days). Triggered when Josh says "/handle-gmails", "handle my gmails", "process my inbox", or similar. Also invoke if a session-start hook reminder appears noting today hasn't been handled.
---

# handle-gmails

Process Josh's primary Gmail (joshua.v.sherman@gmail.com) one message at a time, newest first. Includes **both read and unread** messages in `label:inbox` — Josh is trying to keep the inbox clean, not just process unread.

## Surfaces — who runs this and how it loads

This one skill runs on two surfaces against the **same** primary inbox. Don't run both at the same moment.

| | **Laptop — Opus** (Claude Code) | **Phone — Sonnet** (Claude app) |
|---|---|---|
| Gmail tools | `mcp__gmail__*` (local MCP) | `mcp__claude_ai_Gmail__*` |
| Local filesystem | yes | **no** |
| How it loads | installed skill at `~/.claude/skills/handle-gmails/` (symlinked to this repo); invoked via `/handle-gmails` | Josh pastes a prompt telling Sonnet to fetch this file from GitHub and follow it (see "Phone pickup prompt" below) |
| rules.yaml / daily log / last-run.txt | used (steps 1–3, 6) | **skipped** — no filesystem. Every message pauses for approval; no auto-rules, no log, no last-run. |

Both surfaces share the same **core flow**, **action vocabulary**, and **hard rules**. The local-file machinery (rules, log, last-run) is laptop-only and is clearly marked below.

## Trigger phrases

- `/handle-gmails`
- "handle my gmails" / "handle my email" / "process my inbox" / "let's do email"
- A SessionStart-hook reminder ("[handle-gmails] not yet run today") — Josh may say "go" or "yes" in response (laptop only)

## Per-session flow

Steps marked **(laptop only)** require a local filesystem — phone Sonnet skips them.

1. **(laptop only) Rotate the log directory.** Delete any file in `~/.claude/skills/handle-gmails/log/` whose date is more than 7 days old. Use `find ~/.claude/skills/handle-gmails/log -name "*.md" -mtime +7 -delete` or equivalent.
2. **(laptop only) Open today's log file** at `~/.claude/skills/handle-gmails/log/<YYYY-MM-DD>.md`. Create if missing with a header line `# Handled emails <date>`.
3. **(laptop only) Load rules** from `~/.claude/skills/handle-gmails/rules.yaml`. Empty file is fine — just no auto-skips. (Phone has no rules — every message pauses.)
4. **Loop until inbox empty or Josh stops:**
   a. Pull the newest message/thread in `label:inbox` (query `in:inbox`, limit 1). See the per-surface tool map.
   b. If no results → tell Josh `Inbox is clean! 🎉` and stop. (Laptop: update last-run, step 6, before exiting.)
   c. Read it (get the from/subject/date + body).
   d. **(laptop only) Check rules.yaml** — if sender matches a rule, apply that rule's action automatically, log it as `auto-<action>`, move to next message. (No pause for matched rules; that's the whole point of having rules.)
   e. Otherwise, present a brief summary to Josh:
      - From, subject, date, ~3-line content summary
      - Suggested action with reasoning (1 line)
   f. **Pause for Josh's approval.** Never auto-execute outside the rules.yaml path. Wait for: "ok", "yes", a different action ("archive instead", "draft reply: ..."), or "skip" / "next" / "stop".
   g. Execute the approved action (see Action vocabulary).
   h. **(laptop only)** Append to today's log: `- HH:MM — from: <addr> — subject: "<subj>" — action: <action>`
   i. **(laptop only)** If Josh says "always archive from <sender>" or similar, add a rule to rules.yaml before continuing. (On phone, tell Josh the rule will apply next time he runs it on the laptop.)
5. **Account 2 (web.jam.adm@gmail.com):** NOT handled by this skill on either surface. If Josh asks about it, remind him it's handled manually via the Gmail web UI (per Task 6 design 2026-05-20).
6. **(laptop only) Update last-run.** Write today's date (YYYY-MM-DD ET) to `~/.claude/skills/handle-gmails/last-run.txt`. The SessionStart hook checks this file to decide whether to nag.

## Action vocabulary — per surface

On the phone, the `mcp__claude_ai_Gmail__*` tools operate on **threads and labels** (there is no direct "delete" or "modify"); archiving and spam are done by removing/adding labels. Describe the action semantically and use whichever tool on your surface matches.

| Action | Laptop — `mcp__gmail__*` | Phone — `mcp__claude_ai_Gmail__*` |
|---|---|---|
| `archive` | `modify_email` removing `INBOX`. Don't mark read if it was unread. | `unlabel_thread` removing `INBOX`. |
| `delete` | `delete_email` (moves to Trash). | No delete tool — `label_thread` adding `TRASH` + `unlabel_thread` removing `INBOX`. If that's unavailable, archive instead and tell Josh to delete it later on the laptop. |
| `draft reply` | `draft_email` with `inReplyTo` + `threadId` from the source message. **Print the draft for Josh's review before saving.** | `create_draft` referencing the thread. **Print the draft for Josh's review before saving.** |
| `label <name>` | `get_or_create_label` then `modify_email` adding the label. | `list_labels` (or `create_label` if missing) then `label_thread` adding it. |
| `mark important` | `modify_email` adding `IMPORTANT`. | `label_thread` adding `IMPORTANT`. |
| `mark spam` | `modify_email` removing `INBOX` and adding `SPAM`. | `label_thread` adding `SPAM` + `unlabel_thread` removing `INBOX`. |
| `unsubscribe` | Find the List-Unsubscribe link (headers/body), give Josh the URL, ask for go-ahead (we can't click — Josh does). Then archive. | Same — find the link, give Josh the URL, then archive (unlabel `INBOX`). |
| `do nothing / next` | No-op; move to next message. | Same. |
| `stop` / `done` | Update last-run.txt and exit cleanly. | Just stop — nothing to persist. |

## Phone pickup prompt

Paste this into the Claude app (Sonnet) — it needs web access / fetch enabled:

> Fetch https://raw.githubusercontent.com/WebJamApps/web-jam-tools/dev/skills/handle-gmails/SKILL.md and follow it as your instructions to process my Gmail inbox. You are the **phone Sonnet** surface: use your `mcp__claude_ai_Gmail__*` tools and skip every step marked "(laptop only)". Go one message at a time, newest first, and pause for my approval before doing anything.

## Per-sender rules — rules.yaml  *(laptop only)*

Format:

```yaml
# ~/.claude/skills/handle-gmails/rules.yaml
# Auto-actions applied without pausing. Add via Josh saying "always X from <sender>" during a session.
rules:
  - sender: "newsletter@example.com"          # exact match
    action: archive
    note: "Josh said always archive 2026-05-20"
  - sender_pattern: "*.@noreply.linkedin.com" # glob; matches against From header
    action: archive
    note: "LinkedIn notifications"
  - subject_contains: "Your shipping update"
    action: archive
    note: "Routine shipping confirmations"
```

Match priority: `sender` (exact) → `sender_pattern` (glob) → `subject_contains` (substring). First match wins.

When adding a rule mid-session, write it to rules.yaml, then apply it to the CURRENT message and log the action as `auto-<action> (new rule)`.

## Daily log — log/<YYYY-MM-DD>.md  *(laptop only)*

Plain markdown, one bullet per handled message:

```
# Handled emails 2026-05-20

- 09:14 — from: bobby@macandbobs.com — subject: "Re: August dates" — action: draft reply
- 09:16 — from: noreply@linkedin.com — subject: "You have 3 new..." — action: auto-archive (new rule)
- 09:18 — from: amazon.com — subject: "Your order shipped" — action: archive
```

Rotation: at session start, delete `log/*.md` older than 7 days. Anything older than a week isn't useful for review.

## Last-run state — last-run.txt  *(laptop only)*

A single line: today's date in `YYYY-MM-DD` (Eastern time). Updated at the end of every handle-gmails session (whether inbox was emptied or Josh said stop). The SessionStart hook reads this file:

- If file missing OR contains a date != today → and it's past 09:00 ET → nag Josh with: `[handle-gmails] inbox not yet handled today. Type /handle-gmails when ready.`
- If file contains today's date → silent.

## Hard rules — both surfaces

- **Never auto-execute outside the rules.yaml path.** Even "obvious" spam pauses for Josh's OK by default. (On the phone there are no rules, so EVERYTHING pauses.)
- **Always print draft replies BEFORE saving.** Josh reviews; he doesn't want unreviewed Gmail drafts in his account.
- **Never read or process emails from joshua.v.sherman+banking@ or any banking/healthcare/legal sender categories without explicit Josh prompt.** Skip with "this looks like a sensitive sender — leaving for manual review."
- **Don't handle web.jam.adm@gmail.com.** That account is manual (per Josh's choice 2026-05-20). If anything routes there, tell Josh and stop.
