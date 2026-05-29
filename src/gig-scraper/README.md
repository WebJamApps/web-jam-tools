# gig-scraper

Playwright + xlsx scrapers used by the JoshMariaMusic gig booking workflow. Originally Node/CommonJS
scratch scripts; ported to **Deno** (TypeScript, `npm:` specifiers) on 2026-05-29 when web-jam-tools
went all-Deno for its JS/TS.

## Scripts

| Script               | Deno task                | Purpose                                                                                                                                                            |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scrape_gigs.ts`     | `deno task scrape:gigs`  | Scrape the gigs table from `joshandmariamusic.com` (Playwright, paginated MUI DataGrid); writes `Past Gigs Raw Data.txt` + `Past Gigs List.txt` next to the script |
| `scrape_songs.ts`    | `deno task scrape:songs` | Scrape the songs table from `joshandmariamusic.com/music/songs`; writes `page_debug.html` for inspection                                                           |
| `fetch_api_songs.ts` | `deno task fetch:songs`  | Hit the public `/song` JSON endpoint and filter by title — faster than scraping when you only need API-backed data                                                 |
| `read_excel.ts`      | `deno task read:xlsx`    | Read `~/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx` → `gig_booking_2025_data.json`                                                                  |
| `list_buttons.ts`    | `deno task list:buttons` | Dumps button/link selectors from a page (used to discover MUI DataGrid pagination controls)                                                                        |

## Setup

Deno resolves `npm:playwright` / `npm:xlsx` automatically on first run. Playwright still needs its
browser binaries once per machine:

```bash
deno run -A npm:playwright install chromium
```

(The scrapers run with `-A` because Playwright spawns a browser process — see the task definitions
in `deno.json`.)

## Snapshot data files (committed for reference)

- `buttons.json` — selector dump used by the scrapers
- `gigs_data.json` — last successful scrape from the gigs table
- `gig_booking_2025_data.json` — last parsed dump of the xlsx tracker
- `raw_output.json` — last raw scraper output for diffing

Kept committed because they're small and useful for "did anything change since last time"
comparisons. Not authoritative — re-run the scripts to refresh.

## Working notes

- Originally written iteratively by Gemini CLI during the May 5–9 2026 booking-research sprint.
- The xlsx master lives at `~/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx`; Drive
  working copy is in `My Drive/CLAUDE/`. See the JoshMariaMusic CLAUDE.md for the sync rules.
