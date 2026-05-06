# API Integrations for Claude and Gemini

Status of Google API integrations available to AI assistants in this workspace.

**Last verified:** 2026-05-06

---

## Summary

| Service | Claude (via MCP) | Gemini (via CLI tools) | Notes |
|---|---|---|---|
| Google Drive (files/folders) | ✅ Working | ✅ Working | Full read/write |
| Google Docs | ✅ Working | ✅ Working | Read, create, edit |
| Google Sheets | ✅ Working | ✅ Working | Read, append, format |
| Google Slides | ✅ Working | ✅ Working | Read, create, edit |
| Google Calendar | ✅ Working | ✅ Working | List/create/update/delete events |
| Google Tasks | ⚠️ API enabled, OAuth scope missing | ⚠️ Same | Cannot call yet |
| Gmail (send/draft) | ⚠️ API enabled, OAuth scope missing | ⚠️ Same | Cannot call yet |
| Gmail "scheduled send" | ❌ Not natively supported by Gmail API | ❌ Same | Workaround: draft + cron/Apps Script |

---

## Google Cloud Project

Both Claude (via the `google-drive` MCP) and Gemini (via its OAuth client) use the same GCP project.

- **Project number:** `65848821625`
- **APIs enabled:** Drive, Docs, Sheets, Slides, Calendar, **Tasks, Gmail** (last two enabled 2026-05-06 but not yet usable — see "Pending work" below)
- **OAuth client credentials:** Desktop app, JSON downloaded to `/home/joshua/.config/google-drive-mcp/gcp-oauth.keys.json`

---

## Claude — MCP servers configured

```bash
claude mcp list
```

Currently:

| MCP Name | Source | Purpose |
|---|---|---|
| `claude.ai Google Drive` | hosted (drivemcp.googleapis.com) | Lightweight Drive read/search via Anthropic-managed proxy |
| `google-drive` | npx `@piotr-agier/google-drive-mcp` | Full Drive + Docs + Sheets + Slides + Calendar with local OAuth |

The `google-drive` MCP is the primary one — it owns the OAuth token and exposes the most tools.

### Token + scopes (Claude side)

- **Token file:** `/home/joshua/.config/google-drive-mcp/tokens.json`
- **Granted OAuth scopes:**
  - `drive`, `drive.file`, `drive.readonly`
  - `documents`
  - `spreadsheets`
  - `presentations`
  - `calendar`, `calendar.events`
- **NOT yet granted:** `tasks`, `gmail.send`, `gmail.compose`, `gmail.modify`

The token auto-refreshes via the stored refresh token. If a call returns `401 invalid_grant`, delete `tokens.json` and re-run the MCP's auth flow.

---

## Gemini — CLI integrations

Gemini CLI has its own OAuth flow (separate from Claude's MCP token). Capabilities depend on which Google libraries Gemini's tooling has enabled and which scopes its OAuth client requests.

For coordination, a status note is kept in **Drive: My Drive / GEMINI / API_Integration_Status_*.md** (latest: `API_Integration_Status_2026-05-06.md`, file ID `1wIEd_Wn2eVwpwEVGIqB44Sw1RRSQ_z2T`). When either assistant changes the integration state, write a follow-up note in that folder.

---

## Verified live tests (2026-05-06)

Re-runnable smoke tests:

```bash
# Calendar (works)
TOKEN=$(jq -r '.access_token' ~/.config/google-drive-mcp/tokens.json)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://www.googleapis.com/calendar/v3/users/me/calendarList | jq '.items | length'
# → 4

# Tasks (currently 403 — scope missing)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://tasks.googleapis.com/tasks/v1/users/@me/lists | jq '.error.message // "OK"'
# → "Request had insufficient authentication scopes."

# Gmail (currently 403 — scope missing)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://gmail.googleapis.com/gmail/v1/users/me/profile | jq '.error.message // "OK"'
# → "Request had insufficient authentication scopes."
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

## Pending work — to unlock Tasks + Gmail

Two paths; pick one. Path B is recommended for cleaner separation.

### Path A — extend the existing `google-drive` MCP

1. Modify the MCP's requested scopes to add:
   - `https://www.googleapis.com/auth/tasks`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.compose`
2. Delete `~/.config/google-drive-mcp/tokens.json`
3. Re-run the MCP's auth flow — Joshua re-consents in the browser
4. Verify with the curl smoke tests above (should return 200)

The `@piotr-agier/google-drive-mcp` package would need to be forked or PR'd to add Tasks/Gmail tool definitions. The auth piece alone isn't enough — the MCP also needs to expose the tools.

### Path B — install dedicated MCP servers (recommended)

Each MCP handles its own OAuth flow. Cleaner separation; faster path.

```bash
# Gmail
claude mcp add gmail -- npx -y @gongrzhe/server-gmail-autoauth-mcp

# First-time setup for the Gmail MCP:
mkdir -p ~/.gmail-mcp
cp ~/.config/google-drive-mcp/gcp-oauth.keys.json ~/.gmail-mcp/   # reuse existing OAuth client
npx @gongrzhe/server-gmail-autoauth-mcp auth                       # browser flow
```

For Tasks: as of 2026-05-06, no widely-maintained Tasks-only MCP exists on npm. Options:

- Search again later (`npm search "google tasks mcp"`)
- Build a minimal one (Tasks API has ~6 methods)
- Use a calendar-event-as-task workaround

---

## Important notes for both Claude and Gemini

1. **Gmail "scheduled send" has no native API.** To "schedule" an email, create a draft now (`users.drafts.create`) and have a cron/systemd timer call `users.drafts.send` at the target time. Do not promise scheduled-send capability without that infrastructure.

2. **OAuth scopes vs API enablement are different things.** Enabling an API in the GCP console is necessary but not sufficient — the OAuth token must also have been granted that scope at consent time.

3. **Drive "Other" storage is invisible to MCP and rclone.** Quota usage in Gmail attachments, Google Photos, hidden app data, and orphaned files cannot be cleaned up via these tools. Use [one.google.com/storage](https://one.google.com/storage) to investigate.

4. **Files shared with Joshua but owned by others cannot be deleted** by either assistant via API/rclone (`403 insufficientFilePermissions`). They can only be "Removed" from the user's Drive view via the Drive web UI.

5. **The `dev` and `main` branches are off-limits for AI merges** (per `GEMINI.md` workspace rules). The user is the mandatory human-in-the-loop reviewer.
