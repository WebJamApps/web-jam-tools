# Deploying a service to Deno Deploy

Runbook for putting a scheduled/served Deno script in this repo onto **Deno
Deploy** (the new platform at `console.deno.com` / `app.deno.com`). Deployment is
driven from **CircleCI** (`deno deploy` on `main` only) — **not** Deno's GitHub
integration — so `main` is the only thing that ever deploys and PRs get no Deno
check. The CI gate is enforced at merge.

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

## Step 1 — Create the app (CLI, no GitHub integration)

Create the app from the **CLI** so it is **not** linked to GitHub. A
GitHub-linked app auto-builds *every* branch and posts a `deploy/<org>/<app>`
status check on PRs — exactly what we don't want. **Do NOT use the dashboard's
"Deploy from GitHub" flow.**

From the repo root:

```bash
deno deploy create \
  --org webjamapps \
  --app web-jam-devotional \
  --source local \
  --runtime-mode dynamic \
  --entrypoint src/devotional/send_daily_devotional.ts
```

First run opens a browser to authenticate (cached in your keyring). With no flags
the command runs interactively. If the app name is taken, pick a variant and
update the `--app` references here and in the README.

> **Already created it via the dashboard "Deploy from GitHub" flow?** Open the
> app's **Settings**, find the **"Deploy from GitHub"** section, and click
> **Unlink**. After that it deploys only via the CLI/CI below — no branch builds,
> no PR check.

## Step 2 — Wire CI deploy

1. **Create a Deno Deploy access token** — org settings
   (`console.deno.com/webjamapps/~/settings`) → **Organization Tokens** → create
   one and copy the value (shown once). Add it to **CircleCI** as the
   `DENO_DEPLOY_TOKEN` env var (CircleCI → `web-jam-tools` → **Project Settings →
   Environment Variables**).
2. The CircleCI `deploy` job (already in `.circleci/config.yml`) runs only on
   `main`, only after `gate`, and deploys with:
   ```bash
   deno deploy --org webjamapps --app web-jam-devotional --prod --token "$DENO_DEPLOY_TOKEN"
   ```

> Result: **no preview deploys and no Deno check on PRs** — `main` is the only
> thing that ever deploys.

## Step 3 — Add the runtime secrets

In the app → **`Settings`** → **Environment Variables**, add the three Gmail
OAuth values. **They must be available to the `Production` context** — the deploy
runs with `--prod`, so secrets scoped only to another context won't be visible at
runtime. The Deno UI lets you **paste `.env` lines** or **drag a `.env` file** —
both load all three at once.

| Variable | Source (current laptop creds) |
|---|---|
| `GMAIL_CLIENT_ID` | `~/.gmail-mcp/gcp-oauth.keys.json` → `installed.client_id` |
| `GMAIL_CLIENT_SECRET` | `~/.gmail-mcp/gcp-oauth.keys.json` → `installed.client_secret` |
| `GMAIL_REFRESH_TOKEN` | `~/.gmail-mcp/credentials.json` → `refresh_token` |

Generate the three pasteable lines straight from those files — three short,
paste-safe commands (a single long-quoted one-liner tends to break on paste and
leave the shell hung at a `>` continuation prompt):

```bash
jq -r '"GMAIL_CLIENT_ID="+(.installed.client_id // .web.client_id)' ~/.gmail-mcp/gcp-oauth.keys.json
jq -r '"GMAIL_CLIENT_SECRET="+(.installed.client_secret // .web.client_secret)' ~/.gmail-mcp/gcp-oauth.keys.json
jq -r '"GMAIL_REFRESH_TOKEN="+.refresh_token' ~/.gmail-mcp/credentials.json
```

> ⚠️ **Run these in a normal terminal, NOT via Claude Code's `!` prefix.** They
> print the real `client_secret` and `refresh_token`; the `!` prefix would dump
> them into the chat transcript (which is stored). Copy the three `GMAIL_...=`
> lines into Deno's env-var box (it accepts pasted `.env` lines). To make a file
> to drag instead, redirect them to `/tmp/<service>.env`, drag it, then delete
> it.

These never live in the repo. The service refreshes a short-lived access token
from them on each cold-start run.

## Step 4 — Merge the code to `dev`

Merge the service PR into `dev` (the CI **gate** must be green — it's a required
status check on `dev`). **Nothing deploys** — CI only deploys on `main`.

## Step 5 — Promote `dev` → `main` (first deploy)

Open a `dev` → `main` PR and merge it (gate is also required on `main`). On
merge, the CircleCI `deploy` job runs `deno deploy … --prod` and deploys the new
code to **production**, with the Step 3 secrets present. `Deno.cron` registers on
this deploy.

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

## Adding another service (monorepo)

`web-jam-tools` is a **monorepo** of microservices; each deployable service is
its **own Deno Deploy app** (free tier allows up to **20 apps**). To add one:

1. **Create its app** (CLI, no GitHub link) — Step 1 with that service's name and
   entrypoint:
   ```bash
   deno deploy create --org webjamapps --app web-jam-<service> \
     --source local --runtime-mode dynamic --entrypoint src/<service>/<entry>.ts
   ```
2. **Add its secrets** to that app (Step 3) — each app has its own isolated env.
3. **Add a CircleCI deploy job** for it: copy the `deploy` job in
   `.circleci/config.yml`, rename it (e.g. `deploy-<service>`), change `--app`,
   and add it to the `workflows` list with `requires: [gate]` and
   `filters: { branches: { only: main } }`. The **same `DENO_DEPLOY_TOKEN`**
   deploys every app in the org — no new token needed.

Each service deploys independently from `main`, with its own entrypoint, secrets,
schedule, and subdomain.

## Manual / local deploy (escape hatch)

To push an ad-hoc deployment without going through CI (e.g. a hotfix), deploy
from your machine with the same CLI, run from the repo root (the app already
knows its entrypoint). Interactive browser auth on first use is cached in your
keyring, so you can omit `--token`:

```bash
deno deploy --org webjamapps --app web-jam-devotional --prod
```
