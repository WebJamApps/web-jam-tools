# Scripts

Index of utilities in `scripts/`. Run from the repo root unless noted.

## Workspace utilities

### `bootstrap-project.sh`

Scaffolds a new sibling project directory in the WebJamApps workspace with
basic README and structure.

```bash
./scripts/bootstrap-project.sh <project-name>
```

> Note: the script currently hard-codes a workspace root path. Edit
> `ROOT_DIR` near the top of the file to match your machine before use.

### `check-env.sh`

Quick health check for the local development environment. Reports Node
version, rclone Google Drive mount status, GitHub CLI auth, and basic Drive
visibility.

```bash
./scripts/check-env.sh
```

> Note: contains hard-coded paths that assume the maintainer's home
> directory layout. Adapt before using on a different machine.

## Example scraping / data utilities

These scripts target a specific Wix-hosted site and were built as one-offs
for the maintainer's use case. They're committed as **examples of Playwright
scraping patterns against a Wix site backed by MUI DataGrid**, not as
general-purpose tools.

| Script | What it does |
|---|---|
| `debug-wix.js` | Dumps the rendered DOM structure of the target site for inspection |
| `find-pagination.js` | Detects pagination controls on the target site |
| `scrape-gigs-v2.js` | First-pass scraper that walks pages of gig listings |
| `scrape-gigs-v3.js` | Newer scraper that handles MUI DataGrid virtualization |
| `scrape-and-sync.js` | Scrapes listings and writes them out as XLSX |
| `get-unique-venues.js` | Reads a text list of past gigs and emits unique venue names |

### Prerequisites

```bash
npm install   # installs playwright + xlsx
npx playwright install chromium
```

All of these scripts read from / write to local paths that are hard-coded
near the top of each file (Dropbox, Google Drive mount, etc.). Edit the
paths before running, or use them as reference implementations only.
