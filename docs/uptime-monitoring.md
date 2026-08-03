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

1. **24/7 Edge Cron (`src/uptime/cron.ts`)**:
   - Executes `Deno.cron("WebJam Production Uptime Check", "*/30 * * * *", ...)` every 30 minutes on Deno Deploy.
   - Evaluates all 5 targets in parallel.
   - **Silent on Success**: If all 5 targets pass, exits with code 0 silently (zero noise).
   - **Alert on Failure**: If any target fails (status mismatch, missing content keyword, or connection error), uses `npm:nodemailer` to immediately dispatch an email report to `joshua.v.sherman@gmail.com`.

2. **Alert Credentials**:
   - Environment variables: `GMAIL_USER` and `GMAIL_APP_PASSWORD`.
   - Alert recipient: `joshua.v.sherman@gmail.com`.

## Commands & Local Usage

```sh
# Run manual uptime check locally:
deno task monitor:uptime

# Run Deno Deploy cron check entrypoint:
deno task monitor:cron
```

## Deno Deploy Deployment & Verification

1. **Deploying to Deno Deploy**:
   - Link `web-jam-tools` repository to a Deno Deploy project on [dash.deno.com](https://dash.deno.com).
   - Entrypoint: `src/uptime/cron.ts`.
   - Add `GMAIL_USER` and `GMAIL_APP_PASSWORD` to Deno Deploy Project Settings -> Environment Variables.

2. **Verifying Live Operation**:
   - Check the **Cron** tab in the Deno Deploy dashboard to view live executions and 30-minute schedule status.
   - To perform a live failure alert test, trigger a check with a failing test target or environment flag and confirm receipt of the alert email at `joshua.v.sherman@gmail.com`.

## Changing Targets or Schedules

To add new targets or modify check parameters:
- Edit `DEFAULT_TARGETS` in `src/uptime/monitor.ts`.
- To adjust the cron schedule frequency, edit the cron string in `src/uptime/cron.ts` (e.g. `*/15 * * * *` for 15-minute intervals).
