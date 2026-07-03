# Deno Deploy Operations Runbook

Operations guide for managing Deno Deploy applications in this repo. Focus is on the **new console.deno.com platform** (not the deprecated dash.deno.com).

## Authentication

All CLI commands authenticate via the `DENO_DEPLOY_TOKEN` environment variable. This must be a **personal access token** (prefix `ddp_`) created in console.deno.com.

```bash
export DENO_DEPLOY_TOKEN="ddp_..."  # your token
```

The token is stored in `~/.bashrc` and can be loaded for non-interactive shells:
```bash
eval "$(grep '^export DENO_DEPLOY_TOKEN' ~/.bashrc)"
```

### Token Type

- **Personal Access Token** (`ddp_*`): Works with the CLI. Use this.
- **Organization Token** (`ddo_*`): For dashboard settings; see console.deno.com.

**Note:** The REST API (`https://api.deno.com/v1` and `/v2`) rejects personal access tokens with `invalidToken` / `INVALID_TOKEN` errors. CLI is the supported path for agent access.

## Access Runtime Logs

Stream application execution logs (not build logs):

```bash
deno deploy logs \
  --org webjamapps \
  --app <app-name> \
  --start '2026-07-02T00:00:00Z' \
  --end '2026-07-03T00:00:00Z'
```

Omit `--start` and `--end` to stream live logs. The command continues until manually stopped.

Example:
```bash
deno deploy logs --org webjamapps --app webjam-outreach-cron --start '2026-07-02T10:00:00Z'
```

## Access Build Logs

Build logs (compile errors, deployment status) are **not available via CLI**. They are **dashboard-only**:

1. Open https://console.deno.com/webjamapps/
2. Select the app (e.g., `webjam-outreach-cron`)
3. Go to **Deployments** or **Revisions** tab
4. Click a revision to view its build log

## Retry a Failed Build

Failed builds can only be retried through the dashboard UI:

1. https://console.deno.com/webjamapps/
2. Select the app
3. Go to **Deployments/Revisions**
4. Click the failed revision
5. Click **Retry** (if available, or check the build settings drawer)

The CLI deployment command `deno deploy --app <app> --prod` deploys the latest code; there is no separate `retry` subcommand.

## Stop Rebuilding on Unrelated Pushes

### Finding: No Native Deno Deploy Path Filter

Deno Deploy has **no native feature to skip builds based on changed paths** (e.g., "only build if src/outreach-cron/ changed"). The platform rebuilds on every push to the linked GitHub branch.

### Resolution (settled 2026-07-03): CircleCI deploys BOTH apps; GitHub integration abandoned

Deno's GitHub integration is not used for either app — it builds on every push
(docs-only included) and its flaky builds blocked a dev→main merge (issue #130).
Instead, both apps deploy from the CircleCI `deploy` job (`.circleci/config.yml`),
which runs on `main` only, after the `gate` job passes:

- **web-jam-devotional** — unlinked + CircleCI-deployed since web-jam-tools#69.
- **webjam-outreach-cron** — same treatment as of #130. One-time manual step:
  disconnect the app's GitHub integration in the console (app → **Settings** →
  **Deploy from GitHub** → disconnect), or both deploy paths run.

Net effect: deploys happen only on merges to `main` that pass the gate — better
than path filtering (a GitHub-Actions `paths:` workaround was considered and
rejected; no reason to keep two deploy systems).

## Verify a Deployment Succeeded

After deploying (CI or manual), check the app's status:

1. https://console.deno.com/webjamapps/
2. Select the app
3. **Deployments/Revisions** tab → latest revision should show **Ready** (or **Success**)
4. **Cron** tab (if applicable) → schedule should list next run time

## Known Limitations

| Feature | Status | Notes |
|---------|--------|-------|
| List builds/revisions | ❌ CLI-only (not documented) | Use dashboard |
| Fetch build log | ❌ CLI-only | Use dashboard Deployments tab |
| Retry failed build | ❌ CLI-only | Use dashboard "Retry" button |
| Path-filtered builds | ❌ No native support | Moot: both apps deploy from CircleCI (main-only, post-gate); GitHub integration disconnected |
| REST API v1/v2 | ❌ Rejects `ddp_` tokens | API accepts `ddo_` org tokens only (not exposed via CLI) |

## Useful Docs

- [Deno Deploy overview](https://docs.deno.com/deploy/)
- [deno deploy CLI reference](https://docs.deno.com/runtime/reference/cli/deploy/)
- [Builds reference](https://docs.deno.com/deploy/reference/builds/)
- [Apps & Revisions](https://docs.deno.com/deploy/early-access/reference/apps/)

