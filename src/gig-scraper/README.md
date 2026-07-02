# gig-scraper

Playwright scrapers used by the JoshMariaMusic gig booking workflow. Originally Node/CommonJS
scratch scripts; ported to **Deno** (TypeScript, `npm:` specifiers) on 2026-05-29 when web-jam-tools
went all-Deno for its JS/TS.

These scrapers are website reference/research tools only — they are not part of the venue booking
system of record. The venue master is Mongo, served via the web-jam-back `/venue` API.

## Scripts

| Script               | Deno task                | Purpose                                                                                                                                                            |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scrape_gigs.ts`     | `deno task scrape:gigs`  | Scrape the gigs table from `joshandmariamusic.com` (Playwright, paginated MUI DataGrid); writes `Past Gigs Raw Data.txt` + `Past Gigs List.txt` next to the script |
| `scrape_songs.ts`    | `deno task scrape:songs` | Scrape the songs table from `joshandmariamusic.com/music/songs`; writes `page_debug.html` for inspection                                                           |
| `fetch_api_songs.ts` | `deno task fetch:songs`  | Hit the public `/song` JSON endpoint and filter by title — faster than scraping when you only need API-backed data                                                 |
| `list_buttons.ts`    | `deno task list:buttons` | Dumps button/link selectors from a page (used to discover MUI DataGrid pagination controls)                                                                        |

## Setup

Deno resolves `npm:playwright` automatically on first run. Playwright still needs its browser
binaries once per machine:

```bash
deno run -A npm:playwright install chromium
```

(The scrapers run with `-A` because Playwright spawns a browser process — see the task definitions
in `deno.json`.)

## Snapshot data files (committed for reference)

- `buttons.json` — selector dump used by the scrapers
- `gigs_data.json` — last successful scrape from the gigs table
- `raw_output.json` — last raw scraper output for diffing

Kept committed because they're small and useful for "did anything change since last time"
comparisons. Not authoritative — re-run the scripts to refresh.

## Working notes

- Originally written iteratively by Gemini CLI during the May 5–9 2026 booking-research sprint.
- Venue booking data is not tracked here. The venue master lives in Mongo and is managed through the
  web-jam-back `/venue` API; these scripts exist only to pull reference data from the public
  JoshMariaMusic site.
