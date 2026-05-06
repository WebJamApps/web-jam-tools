# Setting up Google API integrations for AI assistants

Generic recipe for giving Claude Code (and other MCP-capable AI assistants)
access to Google Drive, Docs, Sheets, Slides, Calendar, Gmail, and Tasks
through MCP servers. **No personal credentials or paths.** Every value you
need to fill in is shown in `<ANGLE_BRACKETS>`.

## What you'll end up with

Three MCP servers registered with Claude Code, sharing one Google Cloud
OAuth client:

| MCP | Source | Capabilities |
|---|---|---|
| `google-drive` | npx `@piotr-agier/google-drive-mcp` | Drive + Docs + Sheets + Slides + Calendar |
| `gmail` | npx `@gongrzhe/server-gmail-autoauth-mcp` | Gmail read/send/draft/label/search/delete |
| `google-tasks` | npx `mcp-googletasks-vrob` | Task lists + tasks CRUD |

Each MCP keeps its own credentials file, so a leak or scope change in one
doesn't break the others.

---

## Prerequisites

- A Google account (personal or Workspace)
- Node.js 20+ and `npx`
- Claude Code installed (`claude --version`)
- `jq` for the verification snippets

---

## Part 1 — Google Cloud Console

### 1. Create or select a project

Go to [console.cloud.google.com](https://console.cloud.google.com/) and
create a new project (or pick an existing one). Note the project number —
you'll see it in error messages from the APIs.

### 2. Enable the APIs

Navigate to **APIs & Services → Library** and enable each of:

- Google Drive API
- Google Docs API
- Google Sheets API
- Google Slides API
- Google Calendar API
- Gmail API
- Google Tasks API

### 3. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen.**

- User type: **External** (or **Internal** if you have a Google Workspace and only your org will use it)
- Fill in app name, support email, developer contact
- Under **Scopes**, you can leave this blank for now — each MCP requests its own scopes at consent time
- Under **Test users**, add the Google account you'll use to authenticate
  (required while the app status is "Testing")

### 4. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID.**

- Application type: **Desktop app**
- Name: anything (e.g., "Claude MCP local")
- Click **Create**, then **Download JSON**

The downloaded file looks like:

```json
{
  "installed": {
    "client_id": "...apps.googleusercontent.com",
    "client_secret": "...",
    "redirect_uris": ["http://localhost"],
    "...": "..."
  }
}
```

Save it somewhere stable — the rest of the guide assumes
`<OAUTH_KEYS_PATH>` points at this file.

> Why Desktop and not Web app? Desktop OAuth clients accept any
> `http://localhost:<port>` callback, which is what these MCP servers use.
> A Web app client would require the exact callback URL to be pre-registered.

---

## Part 2 — Install the MCP servers

### Drive / Docs / Sheets / Slides / Calendar

```bash
claude mcp add google-drive -- npx -y @piotr-agier/google-drive-mcp
```

The first call to a tool from this MCP will trigger a browser-based OAuth
flow (or you can run the package's own auth subcommand if it provides one).
Tokens are stored under the MCP's config directory.

### Gmail

```bash
claude mcp add gmail -- npx -y @gongrzhe/server-gmail-autoauth-mcp

# One-time setup (on first run):
mkdir -p ~/.gmail-mcp
cp <OAUTH_KEYS_PATH> ~/.gmail-mcp/gcp-oauth.keys.json
npx @gongrzhe/server-gmail-autoauth-mcp auth   # opens browser for consent
```

The auth subcommand spins up a local HTTP server on `localhost:3000`,
opens the consent URL in your browser, and saves
`~/.gmail-mcp/credentials.json` when you approve.

Granted scopes: `gmail.modify`, `gmail.settings.basic` (covers send,
drafts, labels, search, delete).

### Google Tasks

```bash
CLIENT_ID=$(jq -r '.installed.client_id' <OAUTH_KEYS_PATH>)
CLIENT_SECRET=$(jq -r '.installed.client_secret' <OAUTH_KEYS_PATH>)

claude mcp add google-tasks \
  --env "GOOGLE_CLIENT_ID=$CLIENT_ID" \
  --env "GOOGLE_CLIENT_SECRET=$CLIENT_SECRET" \
  --env "OAUTH_PORT=3000" \
  -- npx -y mcp-googletasks-vrob
```

After registering, ask Claude in a session to **"Please authenticate with
Google Tasks."** The MCP exposes an `authenticate` tool that returns a
browser URL; visit it, approve, and credentials are saved under
`~/.config/mcp-googletasks-vrob/credentials.json`.

Granted scope: `tasks`.

---

## Part 3 — Verify

After authenticating each MCP, run these smoke tests. They each read the
respective MCP's stored access token and hit the corresponding API.

```bash
# Calendar — should print a number
TOKEN=$(jq -r '.access_token' ~/.config/google-drive-mcp/tokens.json)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://www.googleapis.com/calendar/v3/users/me/calendarList | jq '.items | length'

# Gmail — should print your email address
TOKEN=$(jq -r '.access_token' ~/.gmail-mcp/credentials.json)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://gmail.googleapis.com/gmail/v1/users/me/profile | jq '.emailAddress'

# Tasks — should print your task list titles
TOKEN=$(jq -r '.access_token' ~/.config/mcp-googletasks-vrob/credentials.json)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://tasks.googleapis.com/tasks/v1/users/@me/lists | jq '.items[].title'
```

A `403 insufficient authentication scopes` means the OAuth token doesn't
include the scope you need — usually because the consent flow was run
before the API was enabled in the console. Delete the relevant
credentials file and re-run that MCP's auth flow.

---

## Caveats

1. **Gmail has no native scheduled-send API.** If you want
   "send this email tomorrow at 9am," create a draft now via
   `users.drafts.create` and have a cron / systemd timer call
   `users.drafts.send` at the target time. Don't promise scheduled-send
   capability without that timer infrastructure in place.

2. **OAuth scope and API enablement are independent.** Enabling an API in
   the GCP console doesn't grant your existing token that scope; you need
   to re-run the consent flow.

3. **Tokens auto-refresh, but only while the refresh token is valid.**
   Refresh tokens issued by an unverified ("Testing") OAuth app expire
   after seven days. If you keep hitting `invalid_grant`, either publish
   the OAuth app or re-authenticate weekly.

4. **MCP tool definitions load at session start.** After
   `claude mcp add`, restart your Claude Code session (or the MCP server)
   for the new tools to become callable.

5. **Files shared with you but not owned by you cannot be deleted via
   API** — Google returns `403 insufficientFilePermissions`. The Drive
   web UI's "Remove from view" is the only way to drop them from your
   listing.
