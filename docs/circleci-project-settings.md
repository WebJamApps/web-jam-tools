# CircleCI Project Settings Standard

Standardized configuration management for WebJamApps CircleCI projects (web-jam-tools#697).

## Motivation & Standard

In active development workflows involving multiple AI agents and human contributors, developers frequently push iterative commits to feature branches. By default, CircleCI may run all queued and in-flight workflows for every push on a branch, even after a subsequent commit has superseded them.

**Standard:** All WebJamApps projects must have `autocancel_builds` enabled (`advanced.autocancel_builds: true`).

### Benefits
1. **Resource Efficiency**: Automatically cancels obsolete in-flight or queued workflow builds when new commits are pushed to the same branch, saving monthly compute credits.
2. **Reduced Queue Times**: Frees concurrent runner capacity for active jobs across the organization.
3. **Deterministic Feedback**: Ensures agents and developers only wait on and review CI status for the latest HEAD commit of a branch.

## Covered Projects

The standard applies to all 8 active WebJamApps CircleCI repositories:

- `web-jam-tools`
- `JaMmusic`
- `CollegeLutheran`
- `AppersonAuto`
- `TimShermanMusic`
- `HenricksonForSalem`
- `WebJamSocketCluster`
- `web-jam-back`

*(Note: `web-jam-llms` does not have CircleCI pipelines and is excluded).*

## CircleCI API v2 Integration

Project settings are managed via CircleCI v2 REST API:

- **Get Settings**:
  ```http
  GET https://circleci.com/api/v2/project/gh/WebJamApps/{project}/settings
  Circle-Token: <token>
  Accept: application/json
  ```
- **Update Settings**:
  ```http
  PATCH https://circleci.com/api/v2/project/gh/WebJamApps/{project}/settings
  Circle-Token: <token>
  Content-Type: application/json
  Accept: application/json

  {
    "advanced": {
      "autocancel_builds": true
    }
  }
  ```

## CLI Usage

The tool is implemented in `src/circleci-settings/` and exposed via `scripts/circleci-settings.ts` and `deno task circleci-settings`.

### Prerequisites

Export a valid CircleCI personal API token:

```bash
export CIRCLECI_TOKEN="<your-circleci-token>"
```

### Apply Mode (Default)

Checks each repository's settings and idempotently enables `autocancel_builds` where disabled:

```bash
deno task circleci-settings
```

Output:
```text
[web-jam-tools] enabled autocancel_builds
[JaMmusic] enabled autocancel_builds
[CollegeLutheran] enabled autocancel_builds
[AppersonAuto] enabled autocancel_builds
[TimShermanMusic] enabled autocancel_builds
[HenricksonForSalem] enabled autocancel_builds
[WebJamSocketCluster] enabled autocancel_builds
[web-jam-back] autocancel_builds is already true (in sync)

Successfully enabled autocancel_builds on 7 project(s). All 8 projects are now in sync.
```

### Drift Check Mode (`--check`)

Performs a read-only audit across all 8 projects without making changes. Exits `0` if all projects comply, or `1` if drift is detected:

```bash
deno task circleci-settings -- --check
```

Output when in sync:
```text
[web-jam-tools] autocancel_builds: true (in sync)
[JaMmusic] autocancel_builds: true (in sync)
[CollegeLutheran] autocancel_builds: true (in sync)
[AppersonAuto] autocancel_builds: true (in sync)
[TimShermanMusic] autocancel_builds: true (in sync)
[HenricksonForSalem] autocancel_builds: true (in sync)
[WebJamSocketCluster] autocancel_builds: true (in sync)
[web-jam-back] autocancel_builds: true (in sync)

All 8 projects have autocancel_builds enabled (in sync).
```

Output when drift is detected:
```text
[web-jam-tools] autocancel_builds: false (DRIFT)
...
Drift detected: 1 of 8 projects have autocancel_builds disabled. Run 'deno task circleci-settings' to sync.
```
