# Deploying a service to Deno Deploy

Runbook for putting a scheduled/served Deno script in this repo onto **Deno
Deploy** (the new platform at `console.deno.com` / `app.deno.com`), with
continuous deployment from GitHub and the CI gate enforced at merge.

The worked example is the **daily-devotional** service
(`src/devotional/send_daily_devotional.ts`, web-jam-tools#69). For a different
service, substitute its entrypoint, app name, and secrets.

> **Convention:** one Deno Deploy **app per microservice**, named
> `web-jam-<service>` (e.g. `web-jam-devotional`). Each app has isolated
> secrets, its own `Deno.cron` schedule, an independent deploy, and its own
> subdomain. Free tier allows up to **20 apps** (plus 1M requests/mo, 20 GB
> egress, 15h CPU/mo) — ample.

> **Use the new platform**, `console.deno.com` — **not** the old `dash.deno.com`
> (Deno Deploy Classic + `deployctl`), which is being shut down 2026-07-20.

---

## Prerequisites (code)

The service must be Deno-Deploy-ready before you wire up hosting:

- A single **entrypoint** file (e.g. `src/devotional/send_daily_devotional.ts`).
- Scheduling via **`Deno.cron`**, registered only on Deno Deploy
  (guard with `Deno.env.get("DENO_DEPLOYMENT_ID")` so local runs don't schedule).
- Secrets read via **`Deno.env.get(...)`** — Deno Deploy has no persistent
  filesystem, so nothing can be read from disk.
- No build/install step (remote + `npm:` deps resolve at deploy).

## Step 1 — Create the app

1. Go to **`console.deno.com`** and sign in with GitHub.
2. Select (or create) the **organization** — for WebJamApps this is
   `webjamapps` (URL: `console.deno.com/webjamapps`). Org name/slug **cannot be
   changed after creation**.
3. Click **`+ New App`**.
4. **Select the GitHub repository** `WebJamApps/web-jam-tools`. If it isn't
   listed, use **Add another GitHub account** / **Configure GitHub App
   permissions** to grant the Deno Deploy GitHub App access to the repo.
5. Open **`Edit app configuration`** (the build/entrypoint fields are collapsed
   behind this button). Set:
   - **Entry point** (required — marked with a red `*`):
     `src/devotional/send_daily_devotional.ts`
   - **Framework preset:** `No Preset`
   - **Install command / Build command:** leave **empty**.
   - Root/working directory: leave default.
   The right-hand **APP CONFIG** summary should now show your entry point.
6. Set the **app name / slug** to `web-jam-devotional`. (If taken, pick a
   variant and update this doc + the README `--app` reference.)
7. Click **`Create App`**.

> The first build may **fail or no-op** — at this point the production branch is
> still the repo default (`dev`) and the secrets aren't set yet. That's
> expected; the first *real* deploy happens in Step 5.

## Step 2 — Set the production branch to `main`

By default Deno Deploy treats the repo's **default branch** (`dev` here) as the
production branch. We deploy from `main` instead, to keep the `dev`→`main`
staging buffer.

1. Open the app → **`Settings`** → **`Git`** tab.
2. Change the **production branch** from `dev` to **`main`**.
3. Save.

Now: commits on `main` deploy to **production**; commits on other branches
(incl. `dev`) deploy as **preview** only.

## Step 3 — Add the runtime secrets

In the app → **`Settings`** → **Environment Variables** (Production context),
add the three Gmail OAuth values:

| Variable | Where to get it (current laptop source) |
|---|---|
| `GMAIL_CLIENT_ID` | `~/.gmail-mcp/gcp-oauth.keys.json` → `installed.client_id` |
| `GMAIL_CLIENT_SECRET` | `~/.gmail-mcp/gcp-oauth.keys.json` → `installed.client_secret` |
| `GMAIL_REFRESH_TOKEN` | `~/.gmail-mcp/credentials.json` → `refresh_token` |

These never live in the repo. The service refreshes a short-lived access token
from them on each cold-start run.

## Step 4 — Merge the code to `dev`

Merge the service PR into `dev` (the CI **gate** must be green — it's a required
status check on `dev`). This does **not** deploy to production yet (production =
`main`); a `dev` push is a preview deploy only.

## Step 5 — Promote `dev` → `main` (first production deploy)

Open a `dev` → `main` PR and merge it (gate is also required on `main`). On
merge, Deno Deploy auto-builds and deploys the new code to **production**, with
the Step 3 secrets present. `Deno.cron` registers on this deploy.

## Step 6 — Verify

- **Deploy succeeded:** app → **Deployments/Revisions** → latest shows
  **Ready/Success**.
- **Cron registered:** app → **Cron** tab lists the schedule(s) with a next-run
  time. (The devotional registers two: `0 10 * * *` and `0 11 * * *` UTC; the
  code only actually sends at 06:00 America/New_York, so exactly one send/day
  year-round across DST.)
- **Send pipeline works now** (without waiting for 06:00 ET) — local test send:
  ```bash
  cd ~/WebJamApps/web-jam-tools
  export GMAIL_CLIENT_ID='...' GMAIL_CLIENT_SECRET='...' GMAIL_REFRESH_TOKEN='...'
  deno task devotional        # sends one devotional immediately
  ```
- **Definitive cloud proof:** the 06:00 ET email the next morning (and the Cron
  tab's execution history showing the run).

## Step 7 — Cutover (retire the old laptop cron)

Once the cloud send is confirmed, remove the laptop `cron` entry that used to
send the devotional (the `0 6 * * *` `deno run …send_daily_devotional.ts` line
in `crontab -l`). Until this is done, **both** the laptop and the cloud fire at
06:00 ET and the devotion sends **twice**.

## Manual / local deploy (escape hatch)

To push an ad-hoc deployment without a `git` push (e.g. a hotfix), deploy from
your machine with the new-platform `deno deploy` CLI (interactive browser auth
on first use, cached in your keyring):

```bash
deno deploy \
  --org webjamapps \
  --app web-jam-devotional \
  --entrypoint src/devotional/send_daily_devotional.ts \
  --prod
```

> Add `[skip deploy]` to a commit message to make Deno Deploy skip building that
> commit.
