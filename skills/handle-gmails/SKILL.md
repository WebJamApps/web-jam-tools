---
name: handle-gmails
description: Process Josh's Gmail inbox one message at a time, newest first, suggesting actions (archive, delete, draft reply, label) and pausing for approval. Use when triaging or processing Gmail inbox messages.
---

# handle-gmails

Process Josh's primary Gmail (joshua.v.sherman@gmail.com) one message at a time, newest first. Includes **both read and unread** messages in `label:inbox` — Josh is trying to keep the inbox clean, not just process unread.

## ⛔ Model tier gate — cheap tier required (do this FIRST)

This is mechanical, high-volume triage: every message body gets pulled into context one at a time, so it must run on the **cheapest tier**. On the laptop that is **Haiku** (Claude Code) or **Flash** (Antigravity / agy); on the phone it is the **Sonnet** seat. Running on higher tiers (such as Opus or Pro) burns expensive tokens on routine cleanup.

A skill cannot switch the session model itself, so on the laptop the **very first action of this skill is to verify the running model** — before pulling any email:

- **Claude Code surface:**
  - Verify the session is on Haiku. If on a pricier model (e.g. Sonnet, Opus), stop and prompt Josh to switch to Haiku before re-running `/handle-gmails`.
- **Antigravity (`agy`) surface:**
  - Verify the session is on Flash (`gemini-3.7-flash` or newer, enforced by `hooks/agy-model-guard.sh`). If on a higher-tier model (e.g. Pro), switch to Flash before proceeding.
- **Phone Sonnet surface:**
  - Exempt from this check — Sonnet is the intended cheap tier on mobile.

## Surfaces — who runs this and how it loads

This skill runs across three surfaces against the **same** primary inbox. Don't run multiple surfaces at the same moment.

| | **Laptop — Claude Code** (Haiku) | **Laptop — Antigravity / agy** (Flash) | **Phone — Claude app** (Sonnet) |
|---|---|---|---|
| Gmail tools | `mcp__gmail__*` (local MCP) | `search_emails`, `read_email`, `list_email_labels`, `modify_email` (unprefixed Gmail MCP tools) | `mcp__claude_ai_Gmail__*` |
| Local filesystem | yes | yes | **no** |
| How it loads | installed skill at `~/.claude/skills/handle-gmails/` (symlinked); invoked via `/handle-gmails` | installed plugin skill at `~/.gemini/config/plugins/webjam-tasks/skills/handle-gmails/`; invoked via `/handle-gmails` | Josh pastes prompt to fetch from GitHub (see "Phone pickup prompt" below) |

All surfaces share the identical core flow, action vocabulary, and hard rules. Laptop Haiku, laptop Flash, and phone Sonnet run the identical flow with no local runtime state.

## Trigger phrases

- `/handle-gmails`
- "handle my gmails" / "handle my email" / "process my inbox" / "let's do email"

## Per-session flow

Laptop and phone surfaces run the identical flow:

1. **Loop until inbox empty or Josh stops:**
   a. Pull the newest message/thread in `label:inbox` (query `in:inbox`, limit 1). See the per-surface tool map.
   b. If no results → tell Josh `Inbox is clean! 🎉` and stop.
   c. Read it (get the from/subject/date + body).
   d. Present a brief summary to Josh:
      - From, subject, date, ~3-line content summary
      - Suggested action with reasoning (1 line)
   e. **Pause for Josh's approval.** Never auto-execute; every message pauses for approval. Wait for: "ok", "yes", a different action ("archive instead", "draft reply: ..."), or "skip" / "next" / "stop".
   f. Execute the approved action (see Action vocabulary).
2. **Account 2 (web.jam.adm@gmail.com):** NOT handled by this skill on either surface. If Josh asks about it, remind him it's handled manually via the Gmail web UI (per Task 6 design 2026-05-20).

## Action vocabulary — per surface

On the phone, the `mcp__claude_ai_Gmail__*` tools operate on **threads and labels** (there is no direct "delete" or "modify"); archiving and spam are done by removing/adding labels. On Antigravity / agy, tool names are unprefixed (`modify_email`, `draft_email`, etc.) and `send_email`/`delete_email` are denied by `hooks/block-agy-gmail-send-delete.sh`. Describe the action semantically and use whichever tool on your surface matches.

| Action | Laptop — Claude Code (`mcp__gmail__*`) | Laptop — Antigravity / agy (Gmail MCP) | Phone — Claude app (`mcp__claude_ai_Gmail__*`) |
|---|---|---|---|
| `archive` | `modify_email` removing `INBOX`. Don't mark read if it was unread. | `modify_email` removing `INBOX`. Don't mark read if it was unread. | `unlabel_thread` removing `INBOX`. |
| `delete` (move to Trash) | `modify_email` with `addLabelIds: ["TRASH"]` — moves the message to Trash without permanently deleting it. | `modify_email` with `addLabelIds: ["TRASH"]` (direct delete is blocked by safety hook). | `label_thread` (or `label_message`) adding `TRASH` — moves it to Trash. (`TRASH` is a supported system label; there's just no dedicated delete tool.) |
| `draft reply` | `draft_email` with `inReplyTo` + `threadId` from the source message. **Print the draft for Josh's review before saving.** | `draft_email` with `inReplyTo` + `threadId` from the source message. **Print the draft for Josh's review before saving.** | `create_draft` referencing the thread. **Print the draft for Josh's review before saving.** |
| `label <name>` | `get_or_create_label` then `modify_email` adding the label. | `modify_email` adding the label ID (resolve via `list_email_labels`). | `list_labels` (or `create_label` if missing) then `label_thread` adding it. |
| `mark important` | `modify_email` adding `IMPORTANT`. | `modify_email` adding `IMPORTANT`. | `label_thread` adding `IMPORTANT`. |
| `mark spam` | `modify_email` removing `INBOX` and adding `SPAM`. | `modify_email` removing `INBOX` and adding `SPAM`. | `label_thread` adding `SPAM` + `unlabel_thread` removing `INBOX`. |
| `unsubscribe` | Find the List-Unsubscribe link (headers/body), give Josh the URL, ask for go-ahead (we can't click — Josh does). Then archive. | Find the List-Unsubscribe link (headers/body), give Josh the URL, ask for go-ahead (we can't click — Josh does). Then archive. | Same — find the link, give Josh the URL, then archive (unlabel `INBOX`). |
| `do nothing / next` | No-op; move to next message. | No-op; move to next message. | Same. |
| `stop` / `done` | Just stop — nothing to persist. | Just stop — nothing to persist. | Just stop — nothing to persist. |

## Phone pickup prompt

Paste this into the Claude app (Sonnet) — it needs web access / fetch enabled:

> Fetch https://raw.githubusercontent.com/WebJamApps/web-jam-tools/dev/skills/handle-gmails/SKILL.md and follow it as your instructions to process my Gmail inbox. You are the **phone Sonnet** surface: use your `mcp__claude_ai_Gmail__*` tools. Go one message at a time, newest first, and pause for my approval before doing anything.

## Hard rules — all surfaces

- **NO TRACKING OF THE EMAILS ANYWHERE (D7).** A standing requirement, not just a cleanup step. Nothing may record the inbox, the backlog, or any individual message: no GitHub issue, no memory file, no checkpoint, no session-resume note, no daily log, no handled-message record, no remaining-count written down anywhere, in any repo or on any surface. Josh runs `/handle-gmails` when he wants to work through email and stops when he wants to stop. Gmail is the record. The exception that is not tracking: work an email implies (a venue-record update, a GitHub issue for an idea) is real work and gets filed normally; recording the email, or the state of the inbox, as such is forbidden.
- **Never auto-execute.** Every message pauses for Josh's OK. Even "obvious" spam pauses for approval.
- **Always print draft replies BEFORE saving.** Josh reviews; he doesn't want unreviewed Gmail drafts in his account.
- **Never read or process emails from joshua.v.sherman+banking@ or any banking/healthcare/legal sender categories without explicit Josh prompt.** Skip with "this looks like a sensitive sender — leaving for manual review."
- **Don't handle web.jam.adm@gmail.com.** That account is manual (per Josh's choice 2026-05-20). If anything routes there, tell Josh and stop.

## Description Detail & Triggers

Process Josh's Gmail inbox one message at a time, newest first. Suggest action (archive / delete / draft reply / label / mark important / mark spam / unsubscribe / next). Pause for approval before executing. Runs across laptop Haiku (Claude Code), laptop Flash (Antigravity), and phone Sonnet (Claude app) — running the identical flow with no local runtime state. Covers joshua.v.sherman@gmail.com primary account only — web.jam.adm@gmail.com is handled manually via the Gmail web UI. Triggered when Josh says "/handle-gmails", "handle my gmails", "process my inbox", or similar.
