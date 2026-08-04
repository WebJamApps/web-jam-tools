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
   - **Daily 8:00 AM Heartbeat (`0 12 * * *`)**: Evaluates all 5 targets every morning at 8:00 AM EDT (12:00 UTC) and sends a positive status confirmation email (`[Uptime Monitor] Daily Heartbeat: All 5 Production Services Healthy`) to `joshua.v.sherman@gmail.com` and `chemmariasherman@gmail.com` confirming the monitor is active and all services are up.

2. **Alert Recipients & Credentials**:
   - Environment variables: `GMAIL_USER` and `GMAIL_APP_PASSWORD`.
   - Alert recipients: `joshua.v.sherman@gmail.com`, `chemmariasherman@gmail.com`.

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
   - Uses `DENO_DEPLOY_TOKEN` in CircleCI and deploys `src/uptime/cron.ts` to `web-jam-uptime`.
   - **One-time Secret Setup (Dashboard)**: Under Deno Deploy Project Settings -> Environment Variables for `web-jam-uptime`, add `GMAIL_USER` and `GMAIL_APP_PASSWORD`.

2. **Verifying Live Operation**:
   - Check the **Cron** tab in the Deno Deploy dashboard (`console.deno.com` / `dash.deno.com`) to view live executions and 30-minute / daily 8:00 AM schedule status.
   - Perform live alert tests by running `deno task monitor:uptime` locally or verifying test alert email delivery to `joshua.v.sherman@gmail.com` and `chemmariasherman@gmail.com`.

## Changing Targets or Schedules

To add new targets or modify check parameters:
- Edit `DEFAULT_TARGETS` in `src/uptime/monitor.ts`.
- To adjust the cron schedule frequency or heartbeat time, edit the cron strings in `src/uptime/cron.ts`.
