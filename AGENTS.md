# Gemini Instructions for WebJamApps

This file contains instructions and context for the Gemini CLI and AI assistants working in this workspace.

## Workspace Overview
- **Root Directory:** `/home/joshua/WebJamApps`
- **Primary Projects:** JaMmusic, AppersonAuto, CollegeLutheran, web-jam-back, WebJamPg, etc.
- **Tools Repo:** `web-jam-tools` (this repository)

## Collaboration Rules
1. **Rclone Mount:** Google Drive is mounted at `~/gdrive` via a systemd user service (`rclone-gdrive.service`).
2. **Coding Standards:** Refer to individual project `GEMINI.md` files (if present) for specific technology stacks.
3. **Repository Purpose:** `web-jam-tools` serves as a central hub for shared configurations, documentation of system setups, and general workspace memory.
4. **No Merging to DEV:** Gemini is **NOT** allowed to merge PR changes to the `dev` or `main` branches. The user acts as the mandatory human-in-the-loop reviewer and is responsible for all merges.

## Opening pull requests (all WebJamApps repos)

Finish a coding task by running the shared script — never `gh pr create` directly.
This applies **however the task was started** (via `/next` or just told to work an
issue ad-hoc). Put your summary and the **real test output** IN THE PR via the
flags — not only in the chat reply:

```
~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh \
  --author "<tool> — <model>" \
  --summary "<what changed and why>" \
  --test-plan "<exact commands to verify + expected result>" \
  --test-evidence "<the actual lint + test output, confirming both ran green>" \
  --closes   # include ONLY if this PR fully completes the issue; omit for a partial PR
```

`--summary`, `--test-plan`, and `--test-evidence` are **required** — the script
**refuses to open a PR with an empty or placeholder description** (web-jam-tools#77).
It always opens a **draft** PR based on **`dev`**, with the issue number derived from
the `<lane>/<issue#>-<slug>` branch name and a footer naming the tool + model (hard
invariants — no flag overrides them). By default it references the issue (`Part of #N`);
pass `--closes` to make it the completing PR (`Closes #N`). Josh alone reviews and
flips draft → ready. See `skills/draft-pr/SKILL.md`.

## CI gate (web-jam-tools)

Every PR runs a CircleCI **quality + security gate** (`.circleci/config.yml`),
required-green on `dev` via branch protection. Run the **same checks locally
before pushing** — "green locally" == "green in CI":

```
deno task check      # type check
deno task lint
deno task fmt:check   # formatting (deno task fmt to auto-fix)
deno task test        # unit tests
deno task audit       # Trivy: dependency CVEs (HIGH/CRITICAL fail) + secret scan
deno task sast        # Semgrep: static analysis of src/
```

`audit` and `sast` run via **Docker** (so they're identical locally and in CI) —
Docker must be available. `audit` bridges Deno's npm deps to a `package-lock.json`
(Trivy can't read `deno.lock`); JSR deps are not covered. SAST findings are
**refactored, not suppressed**. Deploy on merge to `main` is added in web-jam-tools#69.

## System Setup
- **OS:** Ubuntu
- **Node.js:** v24.16.0 (LTS)
- **Rclone:** Configured for Google Drive (`gdrive:`)
- **Persistence:** Systemd user services managed via `systemctl --user`

## API Integrations

See [docs/api-integrations.md](docs/api-integrations.md) for the current status of Google Drive/Docs/Sheets/Slides/Calendar/Tasks/Gmail integrations available to AI assistants. Update that file (and the dated note in Drive `My Drive / GEMINI / API_Integration_Status_*.md`) when integration state changes.
