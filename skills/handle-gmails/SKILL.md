---
name: handle-gmails
description: Process Josh's Gmail inbox one message at a time, newest first, suggesting actions (archive, delete, draft reply, label) and pausing for approval. Use when triaging or processing Gmail inbox messages.
---

# handle-gmails

Process Josh's primary Gmail (joshua.v.sherman@gmail.com) one message at a time, newest first. Includes **both read and unread** messages in `label:inbox` — Josh is trying to keep the inbox clean, not just process unread.

## Chosen model and cost question — before any Gmail call

On Claude Code, agy and Codex, the model Josh chooses runs this skill. First run
`deno task running-model` to read the actual model from the tool’s own session record.
Do not infer identity from the model’s self-description. If identity cannot be read, tell Josh
“the model could not be read” and proceed with that visible note (workflow fail-open).

Before any Gmail tool call, ask once per invocation on the expensive models:

- **Codex on Astra:** “Are you sure you want to do this? Astra is expensive you should probably choose a cheaper model.”
- **Claude Code on Opus:** “This is Opus. Are you sure you want to do this? Opus is expensive; you should probably use Sonnet or Haiku.”
- **Claude Code on Fable:** “This is Fable. Are you sure you want to do this? Fable is expensive; you should probably use Sonnet or Haiku.”
- **Other readable models:** ask nothing. This includes Haiku and Sonnet on Claude Code,
  Sol and Luna on Codex, and every allowed agy model (including Argon and Hydrogen).

**Wait for Josh’s affirmative reply before any mailbox work on that expensive model.** A refusal
stops that invocation. A request to change models follows his choice. Silence is not approval.
A later invocation, or a switch onto Astra, Opus or Fable during the work, asks again before
Gmail work on that model. Never parse prose keywords or manufacture a confirmation token.
The skill’s dialogue is the confirmation; the model-context hook proves no approval.

A one-off mailbox read outside this skill asks no cost question on any model. The hook never
refuses for model identity. Cost confirmation grants no mail action: every existing per-message
approval and mail fence still applies.

## Surfaces — who runs this and how it loads

The three laptop tools and the phone reach the same primary inbox. Do not run them at the same time.
The canonical paths, model-note registrations and fences are specified in
`~/Dropbox/web-jam-llms/AI_Misbehaves/gmail-design.md`, “Gmail on each tool” and
“Connections and mail safety”.

| Surface | Gmail tools | How it loads |
|---|---|---|
| Claude Code | Local `mcp__gmail__*`; the hosted `mcp__claude_ai_Gmail__*` connector is denied whole | `~/.claude/skills/handle-gmails/`, invoked as `/handle-gmails` |
| agy | Local Gmail server, unprefixed tool names | `~/.gemini/config/plugins/webjam-tasks/skills/handle-gmails/`, invoked as `/handle-gmails` |
| Codex | OpenAI Gmail plugin, `mcp__codex_apps__gmail_*`; no local server | `~/.codex/skills/handle-gmails/`, invoked as `$handle-gmails` |
| Phone Claude app | `mcp__claude_ai_Gmail__*`; laptop settings do not affect it | Fetch using the phone pickup prompt below; no local filesystem |

A missing connection is reported before mailbox work; never add a connection to make this skill run.
Codex mailbox work requires the separately authorized fence firing proof before live use.
All surfaces share the identical core flow, action vocabulary and hard rules, with no local runtime state.

## Trigger phrases

- `/handle-gmails`
- "handle my gmails" / "handle my email" / "process my inbox" / "let's do email"

## Per-session flow

After the model check and any required cost confirmation, laptop and phone surfaces run the identical flow:

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

On Codex use the plugin’s tools after its fence proof; discover the currently offered names before calling.
The following map does not grant actions the fence refuses. On the phone, the `mcp__claude_ai_Gmail__*` tools operate on **threads and labels** (there is no direct "delete" or "modify"); archiving and spam are done by removing/adding labels. On Antigravity / agy, tool names are unprefixed (`modify_email`, `draft_email`, etc.) and `send_email`/`delete_email` are denied by `hooks/block-agy-gmail-send-delete.sh`. Describe the action semantically and use whichever tool on your surface matches.

| Action | Laptop — Claude Code (`mcp__gmail__*`) | Laptop — Antigravity / agy (Gmail MCP) | Phone — Claude app (`mcp__claude_ai_Gmail__*`) | Codex (`mcp__codex_apps__gmail_*`) |
|---|---|---|---| --- |
| `archive` | `modify_email` removing `INBOX`. Don't mark read if it was unread. | `modify_email` removing `INBOX`. Don't mark read if it was unread. | `unlabel_thread` removing `INBOX`. | `gmail_archive_emails`; preserve unread status. |
| `delete` (move to Trash) | `modify_email` with `addLabelIds: ["TRASH"]` — moves the message to Trash without permanently deleting it. | `modify_email` with `addLabelIds: ["TRASH"]` (direct delete is blocked by safety hook). | `label_thread` (or `label_message`) adding `TRASH` — moves it to Trash. (`TRASH` is a supported system label; there's just no dedicated delete tool.) | `gmail_delete_emails` moves to Trash; obey the ask-or-refuse fence. |
| `draft reply` | `draft_email` with `inReplyTo` + `threadId` from the source message. **Print the draft for Josh's review before saving.** | `draft_email` with `inReplyTo` + `threadId` from the source message. **Print the draft for Josh's review before saving.** | `create_draft` referencing the thread. **Print the draft for Josh's review before saving.** | `gmail_create_draft` referencing the source thread; print for review before saving. |
| `label <name>` | `get_or_create_label` then `modify_email` adding the label. | `modify_email` adding the label ID (resolve via `list_email_labels`). | `list_labels` (or `create_label` if missing) then `label_thread` adding it. | `gmail_list_labels` / `gmail_create_label`, then `gmail_apply_labels_to_emails`. |
| `mark important` | `modify_email` adding `IMPORTANT`. | `modify_email` adding `IMPORTANT`. | `label_thread` adding `IMPORTANT`. | `gmail_apply_labels_to_emails` adding `IMPORTANT`. |
| `mark spam` | `modify_email` removing `INBOX` and adding `SPAM`. | `modify_email` removing `INBOX` and adding `SPAM`. | `label_thread` adding `SPAM` + `unlabel_thread` removing `INBOX`. | `gmail_batch_modify_email` adding `SPAM` and removing `INBOX`. |
| `unsubscribe` | Find the List-Unsubscribe link (headers/body), give Josh the URL, ask for go-ahead (we can't click — Josh does). Then archive. | Find the List-Unsubscribe link (headers/body), give Josh the URL, ask for go-ahead (we can't click — Josh does). Then archive. | Same — find the link, give Josh the URL, then archive (unlabel `INBOX`). | Give Josh the link for approval, then archive. |
| `do nothing / next` | No-op; move to next message. | No-op; move to next message. | Same. | No-op; move to next message. |
| `stop` / `done` | Just stop — nothing to persist. | Just stop — nothing to persist. | Just stop — nothing to persist. | Stop; persist nothing. |

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

Process Josh's Gmail inbox one message at a time, newest first. Suggest action (archive / delete / draft reply / label / mark important / mark spam / unsubscribe / next). Pause for approval before executing. Runs on Josh’s chosen model in Claude Code, agy and Codex, and on phone Sonnet (Claude app) — running the identical flow with no local runtime state. Covers joshua.v.sherman@gmail.com primary account only — web.jam.adm@gmail.com is handled manually via the Gmail web UI. Triggered when Josh says "/handle-gmails", "handle my gmails", "process my inbox", or similar.
