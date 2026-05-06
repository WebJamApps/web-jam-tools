# API Integrations for Claude and Gemini

> **Scope:** This document is a *snapshot of one specific machine's setup*
> and contains hard-coded paths under `/home/joshua/`. For a generic,
> reusable recipe with no personal paths, see
> [ai-assistant-google-setup.md](./ai-assistant-google-setup.md).

Status of Google API integrations available to AI assistants in this workspace.

**Last verified:** 2026-05-06 (Gmail + Tasks unlocked same day)

---

## Summary

| Service | Claude (via MCP) | Gemini (via CLI tools) | Notes |
|---|---|---|---|
| Google Drive (files/folders) | ✅ Working | ✅ Working | Full read/write |
| Google Docs | ✅ Working | ✅ Working | Read, create, edit |
| Google Sheets | ✅ Working | ✅ Working | Read, append, format |
| Google Slides | ✅ Working | ✅ Working | Read, create, edit |
| Google Calendar | ✅ Working | ✅ Working | List/create/update/delete events |
| Google Tasks | ✅ Working | ⚠️ Separate OAuth needed | List + CRUD on lists/tasks |
| Gmail (send/draft) | ✅ Working | ⚠️ Separate OAuth needed | Read, send, draft, label, search, delete |
| Gmail "scheduled send" | ❌ Not natively supported by Gmail API | ❌ Same | Workaround: draft + cron/Apps Script |

---

## Google Cloud Project

Both Claude (via the `google-drive` MCP) and Gemini (via its OAuth client) use the same GCP project.

- **Project number:** `65848821625`
- **APIs enabled:** Drive, Docs, Sheets, Slides, Calendar, Tasks, Gmail
- **OAuth client credentials:** Desktop app, JSON at `/home/joshua/.config/google-drive-mcp/gcp-oauth.keys.json`. The same Desktop OAuth client is reused by all three MCP servers (loopback redirect on `localhost:3000`).

---

## Claude — MCP servers configured

```bash
claude mcp list
```

Currently:

| MCP Name | Source | Purpose | Token file |
|---|---|---|---|
| `claude.ai Google Drive` | hosted (drivemcp.googleapis.com) | Lightweight Drive read/search via Anthropic-managed proxy | (managed) |
| `google-drive` | npx `@piotr-agier/google-drive-mcp` | Drive + Docs + Sheets + Slides + Calendar | `~/.config/google-drive-mcp/tokens.json` |
| `gmail` | npx `@gongrzhe/server-gmail-autoauth-mcp` | Gmail read/send/draft/label/search/delete | `~/.gmail-mcp/credentials.json` |
| `google-tasks` | npx `mcp-googletasks-vrob` | Task lists + tasks CRUD | `~/.config/mcp-googletasks-vrob/credentials.json` |

Each MCP has its own credentials file with its own scopes; all three reuse the same Desktop OAuth client from `~/.config/google-drive-mcp/gcp-oauth.keys.json`.

### Granted scopes per MCP

- **`google-drive`:** `drive`, `drive.file`, `drive.readonly`, `documents`, `spreadsheets`, `presentations`, `calendar`, `calendar.events`
- **`gmail`:** `gmail.modify`, `gmail.settings.basic`
- **`google-tasks`:** `tasks`

Tokens auto-refresh via stored refresh tokens. If any MCP call returns `401 invalid_grant`, delete that MCP's credentials file and re-run its auth flow.

---

## Gemini — CLI integrations

Gemini CLI has its own OAuth flow (separate from Claude's MCP token). Capabilities depend on which Google libraries Gemini's tooling has enabled and which scopes its OAuth client requests.

For coordination, a status note is kept in **Drive: My Drive / GEMINI / API_Integration_Status_*.md** (latest: `API_Integration_Status_2026-05-06.md`, file ID `1wIEd_Wn2eVwpwEVGIqB44Sw1RRSQ_z2T`). When either assistant changes the integration state, write a follow-up note in that folder.

---

## Verified live tests (2026-05-06)

Each MCP has its own token file. Re-runnable smoke tests:

```bash
# Calendar (200)
TOKEN=$(jq -r '.access_token' ~/.config/google-drive-mcp/tokens.json)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://www.googleapis.com/calendar/v3/users/me/calendarList | jq '.items | length'

# Gmail (200)
TOKEN=$(jq -r '.access_token' ~/.gmail-mcp/credentials.json)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://gmail.googleapis.com/gmail/v1/users/me/profile | jq '.emailAddress'

# Tasks (200)
TOKEN=$(jq -r '.access_token' ~/.config/mcp-googletasks-vrob/credentials.json)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://tasks.googleapis.com/tasks/v1/users/@me/lists | jq '.items[].title'
```

---

## Calendars available on the primary account

Owner: `joshua.v.sherman@gmail.com`

| Calendar | Role | ID |
|---|---|---|
| <joshua.v.sherman@gmail.com> | owner (PRIMARY) | `joshua.v.sherman@gmail.com` |
| Family | owner | `family18083373936733298689@group.calendar.google.com` |
| <chemmariasherman@gmail.com> | reader | `chemmariasherman@gmail.com` |
| Holidays in United States | reader | `en.usa#holiday@group.v.calendar.google.com` |

---

## rclone (separate from MCP)

For batch Drive cleanup (delete by date, find large files, etc.), see [rclone-setup.md](./rclone-setup.md). rclone uses its own OAuth client at `~/.config/rclone/rclone.conf`, **not** the MCP's token.

---

## How the MCPs were installed (for reference / re-install)

```bash
# Gmail MCP
claude mcp add gmail -- npx -y @gongrzhe/server-gmail-autoauth-mcp
mkdir -p ~/.gmail-mcp
cp ~/.config/google-drive-mcp/gcp-oauth.keys.json ~/.gmail-mcp/
npx @gongrzhe/server-gmail-autoauth-mcp auth        # browser flow

# Google Tasks MCP
CLIENT_ID=$(jq -r '.installed.client_id' ~/.gmail-mcp/gcp-oauth.keys.json)
CLIENT_SECRET=$(jq -r '.installed.client_secret' ~/.gmail-mcp/gcp-oauth.keys.json)
claude mcp add google-tasks \
  --env "GOOGLE_CLIENT_ID=$CLIENT_ID" \
  --env "GOOGLE_CLIENT_SECRET=$CLIENT_SECRET" \
  --env "OAUTH_PORT=3000" \
  -- npx -y mcp-googletasks-vrob
# Auth happens by asking Claude "Please authenticate with Google Tasks" — the
# MCP exposes an `authenticate` tool that returns a URL for browser consent.
```

---

## Important notes for both Claude and Gemini

1. **Gmail "scheduled send" has no native API.** To "schedule" an email, create a draft now (`users.drafts.create`) and have a cron/systemd timer call `users.drafts.send` at the target time. Do not promise scheduled-send capability without that infrastructure.

2. **OAuth scopes vs API enablement are different things.** Enabling an API in the GCP console is necessary but not sufficient — the OAuth token must also have been granted that scope at consent time.

3. **Drive "Other" storage is invisible to MCP and rclone.** Quota usage in Gmail attachments, Google Photos, hidden app data, and orphaned files cannot be cleaned up via these tools. Use [one.google.com/storage](https://one.google.com/storage) to investigate.

4. **Files shared with Joshua but owned by others cannot be deleted** by either assistant via API/rclone (`403 insufficientFilePermissions`). They can only be "Removed" from the user's Drive view via the Drive web UI.

5. **The `dev` and `main` branches are off-limits for AI merges** (per `GEMINI.md` workspace rules). The user is the mandatory human-in-the-loop reviewer.
