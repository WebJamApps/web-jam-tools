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

### Workaround: GitHub Actions Path Filter (if GitHub-linked)

If the app is linked to GitHub (verified in app **Settings** → **Deploy from GitHub**), you can:

1. **Unlink the app** if you want manual/CI-only deploys (current web-jam-tools approach per deno-deploy-setup.md).
2. **Use GitHub Actions** with path filters if you want automated GitHub deploys but only for certain paths:
   - Create a `.github/workflows/deploy-outreach-cron.yml` workflow with:
     ```yaml
     on:
       push:
         branches: [main]
         paths:
           - 'src/outreach-cron/**'
           - 'deno.json'
     jobs:
       deploy:
         runs-on: ubuntu-latest
         steps:
           - uses: actions/checkout@v4
           - uses: denoland/deployctl@v1
             with:
               project: webjam-outreach-cron
               entrypoint: src/outreach-cron/advance_cadence.ts
               root: .
     ```
   - Deploy via your GitHub Actions workflow, **not** Deno's GitHub integration.

### Current Setup (CircleCI)

This repo deploys via CircleCI (see `.circleci/config.yml` and docs/deno-deploy-setup.md):
- App is **unlinked from GitHub** (no auto-builds on push).
- Deploys only from CircleCI on `main` branch.
- Every source push triggers a test gate; only passing `main` merges deploy.

This avoids pointless rebuilds; no further Deno configuration is needed.

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
| Path-filtered builds | ❌ No native support | Use GitHub Actions filters or unlink from GitHub |
| REST API v1/v2 | ❌ Rejects `ddp_` tokens | API accepts `ddo_` org tokens only (not exposed via CLI) |

## Useful Docs

- [Deno Deploy overview](https://docs.deno.com/deploy/)
- [deno deploy CLI reference](https://docs.deno.com/runtime/reference/cli/deploy/)
- [Builds reference](https://docs.deno.com/deploy/reference/builds/)
- [Apps & Revisions](https://docs.deno.com/deploy/early-access/reference/apps/)

