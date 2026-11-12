# Production Uptime Monitoring Guide

Uptime monitoring for WebJam LLC production websites is managed via Deno Deploy 24/7 edge cron (`src/uptime/cron.ts`) and the local CLI task `deno task monitor:uptime` (`src/uptime/cli.ts` & `src/uptime/monitor.ts`).

## Monitored Targets

| Target Name | URL | Expected Status | Validation Strategy |
| :--- | :--- | :--- | :--- |
| **Josh & Maria Music** | `https://joshandmariamusic.com` | `200` | HTTP status check |
| **Josh & Maria Music (www)** | `https://www.joshandmariamusic.com` | `200`, `301`, `302`, `307`, `308` | Redirect / HTTP status check |
| **Web Jam** | `https://web-jam.com` | `200` | HTTP status check |
| **Web Jam Music** | `https://web-jam.com/music` | `200` | **Content-aware assertion**: Verifies HTTP 200 AND checks that page content contains expected music elements (catches SocketCluster outages where page returns 200 OK while empty) |
| **College Lutheran** | `https://collegelutheran.org` | `200` | HTTP status check |

## How It Works

1. **24/7 Edge Cron & Schedules (`src/uptime/cron.ts`)**:
   - **30-Minute Failure Check (`*/30 * * * *`)**: Evaluates all 5 targets every 30 minutes. Silent on success; sends an immediate alert email to `joshua.v.sherman@gmail.com` and `chemmariasherman@gmail.com` on failure detailing the outage.
   - **Daily Heartbeat (`0 12 * * *`)**: Evaluates all 5 targets at 12:00 UTC and checks the newest backup. Sends the daily status email to the existing alert recipients, with one backup-age line such as `Backup: newest good run is 25.0 hours old.` The site's status summary and subject remain independent of the backup warning.
   - **Midnight Backup Check (`0 0 * * *`)**: Checks the newest backup without sending another daily heartbeat or running the site checks.

   Both backup runs read public `GET https://web-jam.com/backup/status` from the same production backend address used by the site monitor. A timestamp in `newestGoodRun` gives the age; `"none"` means no good run exists. A non-success HTTP status means the backend cannot determine the backup state. The request times out after 10 seconds. A timestamp more than 26 hours old, no good run, an unknown/invalid answer, or a failed/timed-out request sends a `[Uptime Alert] MongoDB backup warning` naming that condition. Exactly 26 hours does not warn. A recent good run remains recent even if `lastRunFailed` is true; the backend reports individual failed runs separately. Noon reuses its check result in the heartbeat, including an explicit unavailable/none line when an age cannot be determined. The 30-minute job never reads backup status.

2. **Alert Recipients & Credentials**:
   - Gmail API environment settings: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. The shared `src/shared/gmail_send.ts` module refreshes an access token and sends mail through Gmail's HTTP API for site alerts, the daily heartbeat and backup warnings. `GMAIL_USER` and `GMAIL_APP_PASSWORD` are not used.
   - Test endpoint setting: `UPTIME_TEST_KEY`.
   - Alert recipients: `joshua.v.sherman@gmail.com`, `chemmariasherman@gmail.com`.

3. **Test Endpoints & Secret Key Protection**:
   - `/test-check` and `/test-heartbeat` test endpoints allow manual triggering of check and heartbeat routines.
   - Both test endpoints are closed to the public and require the `x-test-key` HTTP header exactly matching the secret key configured in the `UPTIME_TEST_KEY` setting.
   - Requests without `x-test-key`, with an incorrect key, or when `UPTIME_TEST_KEY` is unset or empty answer `404 Not Found` and perform no action.
   - An authenticated `/test-heartbeat` performs the noon routine, including the backup check and any warning. An authenticated `/test-check` performs only the site checks. These endpoints send real email; use them only for an explicitly authorized delivery test. The backup-line verification runbook uses the scheduled noon email instead.

## Commands & Local Usage

```sh
# Run manual uptime check locally:
deno task monitor:uptime

# Run Deno Deploy cron check entrypoint:
deno task monitor:cron
```

## Deno Deploy Deployment & Verification

1. **Automated CircleCI Cloud Deployment**:
   - Like `web-jam-devotional`, `web-jam-uptime` is automatically deployed to Deno Deploy via CircleCI's `deploy-uptime` job whenever changes are merged to `main`.
   - Uses `DENO_DEPLOY_TOKEN` in CircleCI and deploys with isolated config `deno.uptime.json` targeting repo root `.`:
     ```sh
     deno deploy . --config deno.uptime.json --prod --token "$DENO_DEPLOY_TOKEN" --non-interactive --json
     ```
   - **One-time Secret Setup (Dashboard)**: Under Deno Deploy Project Settings -> Environment Variables for `web-jam-uptime`, configure `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, and `UPTIME_TEST_KEY`. Use the existing authorized Gmail API settings; never paste their values into commands, logs, or issue comments.

2. **Verifying Live Operation**:
   - Check the **Cron** tab in the Deno Deploy dashboard (`console.deno.com` / `dash.deno.com`) to view live executions and 30-minute / daily 8:00 AM schedule status.
   - Perform live alert tests by running `deno task monitor:uptime` locally or verifying test alert email delivery to `joshua.v.sherman@gmail.com` and `chemmariasherman@gmail.com`.

The numbered manual procedure for checking the delivered backup-age line is `~/Dropbox/web-jam-llms/backup-restore/status-email-backup-line-manual-steps-2026-10-07.md`.

## Changing Targets or Schedules

To add new targets or modify check parameters:
- Edit `DEFAULT_TARGETS` in `src/uptime/monitor.ts`.
- To adjust the cron schedule frequency or heartbeat time, edit the cron strings in `src/uptime/cron.ts`.

## Deno Deploy CLI & Runtime Rules (moved from AGENTS.md)

## Deno Deploy CLI & Runtime Rules

- **Root Directory Positional Argument**: Always pass `.` (workspace root) as the positional root
  argument to `deno deploy` (e.g. `deno deploy . --config deno.uptime.json --prod`). NEVER pass an
  individual file path like `src/uptime/cron.ts` as the positional root argument because Deno Deploy
  will set `/tmp/build/src` as the working directory, isolating it from root project files
  (`deno.json`, `./monitor.ts`) and causing builds to hang or fail looking for dependencies.
- **Entrypoint Configuration in Isolated Configs**: Entrypoint and app metadata must be configured
  inside isolated `deno.<service>.json` config files (e.g. `deno.uptime.json`,
  `deno.devotional.json`) under
  `"deploy": { "org": "webjamapps", "app": "...", "entrypoint": "...", "exclude": [...] }` and
  passed via `--config deno.<service>.json`. Do NOT pass `--entrypoint` to `deno deploy` (without
  `create`), as `--entrypoint` is only a subcommand flag for `deno deploy create`.
- **Deno Deploy Dynamic Containers Require `Deno.serve`**: In dynamic mode
  (`--runtime-mode dynamic`), entrypoint scripts must include a `Deno.serve` listener guarded by
  `import.meta.main` (e.g.
  `if (import.meta.main && typeof Deno !== "undefined" && typeof Deno.serve === "function") Deno.serve(...)`).
  Without `Deno.serve`, scripts containing only `Deno.cron` exit immediately after top-level
  execution, causing Deno Deploy to report `The revision failed`.
- **Token Security**: `DENO_DEPLOY_TOKEN` secrets are permanently masked in Deno Console and
  CircleCI (`xxxxn9p8`). To align local CLI and CircleCI tokens, generate a fresh token in Deno
  Console (`https://console.deno.com/account/tokens`), export locally
  (`export DENO_DEPLOY_TOKEN="..."`), and update CircleCI via `circleci envvar create`.
- **Pre-Push Formatting Check**: ALWAYS run `deno task fmt` AND verify `deno task fmt:check` passes
  100% green before pushing EVERY commit (including minor test additions, bug fixes, or
  documentation updates). Pushing without running `deno task fmt` can cause subtle formatting drift
  (such as trailing newlines or quote style changes) that breaks CircleCI's strict `Format check`
  gate.

- **Endpoint Test Coverage & Coverage Gate**: When adding or updating HTTP endpoint routes or branch
  logic in Deno modules (e.g. `src/uptime/cron.ts`), always export testable handler functions (like
  `handleHttpReq`) and add corresponding unit tests in `test/*.test.ts` covering endpoints and error
  paths. Uncovered HTTP endpoints lower module line coverage and can cause overall repository
  coverage to drop below CircleCI's strict 90% line-coverage threshold
  (`[coverage] FAIL: all-files line coverage < 90% threshold`).
- **Uptime Test Endpoint Protection & Exact Secret Key Matching**: Test endpoints on the uptime
  monitoring service (`/test-check` and `/test-heartbeat`) must strictly guard execution against an
  exact matching `x-test-key` HTTP header configured via `UPTIME_TEST_KEY`. Any missing, empty, or
  mismatched header, query parameter fallback (`?key=...`), case variation, or execution attempt
  when `UPTIME_TEST_KEY` is unset or empty must fail closed with HTTP 404 Not Found and perform no
  action.
