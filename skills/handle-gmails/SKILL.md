---
name: handle-gmails
description: Process Josh's Gmail inbox one message at a time, newest first. Suggest action (archive / delete / draft reply / label / mark important / mark spam / unsubscribe / next). Pause for approval before executing. Covers joshua.v.sherman@gmail.com primary account only — web.jam.adm@gmail.com is handled manually via the Gmail web UI. Per-sender auto-archive rules in rules.yaml. Daily-handled log in log/<YYYY-MM-DD>.md (auto-pruned after 7 days). Triggered when Josh says "/handle-gmails", "handle my gmails", "process my inbox", or similar. Also invoke if a session-start hook reminder appears noting today hasn't been handled.
---

# handle-gmails

Process Josh's primary Gmail (joshua.v.sherman@gmail.com) one message at a time, newest first. Includes **both read and unread** messages in `label:inbox` — Josh is trying to keep the inbox clean, not just process unread.

## Trigger phrases

- `/handle-gmails`
- "handle my gmails" / "handle my email" / "process my inbox" / "let's do email"
- A SessionStart-hook reminder ("[handle-gmails] not yet run today") — Josh may say "go" or "yes" in response

## Per-session flow

1. **Rotate the log directory.** Delete any file in `~/.claude/skills/handle-gmails/log/` whose date is more than 7 days old. Use `find ~/.claude/skills/handle-gmails/log -name "*.md" -mtime +7 -delete` or equivalent.
2. **Open today's log file** at `~/.claude/skills/handle-gmails/log/<YYYY-MM-DD>.md`. Create if missing with a header line `# Handled emails <date>`.
3. **Load rules** from `~/.claude/skills/handle-gmails/rules.yaml`. Empty file is fine — just no auto-skips.
4. **Loop until inbox empty or Josh stops:**
   a. Pull the newest message in `label:inbox` using `mcp__gmail__search_emails` with query `in:inbox`, maxResults: 1.
   b. If no results → print `Inbox is clean! 🎉` and stop. Update last-run state (Step 6) before exiting.
   c. Read it via `mcp__gmail__read_email`.
   d. **Check rules.yaml** — if sender matches a rule, apply that rule's action automatically, log it as `auto-<action>`, move to next message. (No pause for matched rules; that's the whole point of having rules.)
   e. Otherwise, present a brief summary to Josh:
      - From, subject, date, ~3-line content summary
      - Suggested action with reasoning (1 line)
   f. **Pause for Josh's approval.** Never auto-execute outside the rules.yaml path. Wait for: "ok", "yes", a different action ("archive instead", "draft reply: ..."), or "skip" / "next" / "stop".
   g. Execute the approved action (see Action vocabulary).
   h. Append to today's log: `- HH:MM — from: <addr> — subject: "<subj>" — action: <action>`
   i. If Josh says "always archive from <sender>" or similar, **add a rule to rules.yaml** before continuing.
5. **Account 2 (web.jam.adm@gmail.com):** NOT handled by this skill. If Josh asks about it, remind him it's handled manually via the Gmail web UI (per Task 6 design 2026-05-20).
6. **Update last-run.** Write today's date (YYYY-MM-DD ET) to `~/.claude/skills/handle-gmails/last-run.txt`. The SessionStart hook checks this file to decide whether to nag.

## Action vocabulary

| Action | How to execute |
|---|---|
| `archive` | `mcp__gmail__modify_email` removing `INBOX` label. Don't mark read if it was unread. |
| `delete` | `mcp__gmail__delete_email` (moves to Trash). |
| `draft reply` | `mcp__gmail__draft_email` with `inReplyTo` + `threadId` from the source message. Print the draft for Josh's review before saving. |
| `label <name>` | `mcp__gmail__get_or_create_label` then `mcp__gmail__modify_email` adding the label. Leaves message in inbox unless paired with `archive`. |
| `mark important` | `mcp__gmail__modify_email` adding `IMPORTANT`. |
| `mark spam` | `mcp__gmail__modify_email` removing `INBOX` and adding `SPAM`. |
| `unsubscribe` | Open the email's unsubscribe link if present (look in headers / body for List-Unsubscribe). Tell Josh the URL and ask for go-ahead before "executing" (we can't click — Josh does that). After: archive the email. |
| `do nothing / next` | No-op; move to next message. Useful for keeping a message in inbox intentionally. |
| `stop` / `done` | Update last-run.txt and exit cleanly. |

## Per-sender rules — rules.yaml

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

## Daily log — log/<YYYY-MM-DD>.md

Plain markdown, one bullet per handled message:

```
# Handled emails 2026-05-20

- 09:14 — from: bobby@macandbobs.com — subject: "Re: August dates" — action: draft reply
- 09:16 — from: noreply@linkedin.com — subject: "You have 3 new..." — action: auto-archive (new rule)
- 09:18 — from: amazon.com — subject: "Your order shipped" — action: archive
```

Rotation: at session start, delete `log/*.md` older than 7 days. Anything older than a week isn't useful for review.

## Last-run state — last-run.txt

A single line: today's date in `YYYY-MM-DD` (Eastern time). Updated at the end of every handle-gmails session (whether inbox was emptied or Josh said stop). The SessionStart hook reads this file:

- If file missing OR contains a date != today → and it's past 09:00 ET → nag Josh with: `[handle-gmails] inbox not yet handled today. Type /handle-gmails when ready.`
- If file contains today's date → silent.

## Hard rules

- **Never auto-execute outside the rules.yaml path.** Even "obvious" spam pauses for Josh's OK by default.
- **Always print draft replies BEFORE saving.** Josh reviews; he doesn't want unreviewed Gmail drafts in his account.
- **Never read or process emails from joshua.v.sherman+banking@ or any banking/healthcare/legal sender categories without explicit Josh prompt.** Skip with "this looks like a sensitive sender — leaving for manual review."
- **Don't handle web.jam.adm@gmail.com.** That account is manual (per Josh's choice 2026-05-20). If anything routes there, tell Josh and stop.
