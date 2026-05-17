# gig-scraper

One-off Playwright + xlsx scrapers used by the JoshMariaMusic gig booking workflow. Originally lived as scratch space at `~/WebJamApps/gig-scraper/`; moved into this repo on 2026-05-13 so the scripts have version history and a defined home.

## Scripts

| Script | npm alias | Purpose |
| --- | --- | --- |
| `scrape_gigs.js` | `npm run scrape:gigs` | Scrape the gigs table from `joshandmariamusic.com` (Playwright, paginated MUI DataGrid) |
| `scrape_songs.js` | `npm run scrape:songs` | Scrape the songs table from `joshandmariamusic.com/music/songs`; writes `page_debug.html` for inspection |
| `fetch_api_songs.js` | `npm run fetch:songs` | Hit the public `/song` JSON endpoint and filter by title — faster than scraping when you only need API-backed data |
| `read_excel.js` | `npm run read:xlsx` | Read `Gig Booking Worksheet 2025.xlsx` (expects to find it relative to the script) |
| `list_buttons.js` | `npm run list:buttons` | Small helper that dumps button selectors from a page (used to discover MUI DataGrid pagination controls) |

## Setup

```bash
cd web-jam-tools/gig-scraper
npm install                 # pulls playwright + xlsx
npx playwright install      # downloads browser binaries (one-time, ~200 MB)
```

## Snapshot data files (committed for reference)

- `buttons.json` — selector dump used by the scrapers
- `gigs_data.json` — last successful scrape from `joshandmariamusic.com` gigs table
- `gig_booking_2025_data.json` — last parsed dump of the xlsx tracker
- `raw_output.json` — last raw scraper output for diffing

These are kept committed because they're small and useful for "did anything change since last time" comparisons. They're not authoritative — re-run the scripts to refresh.

## Working notes

- Originally written iteratively by Gemini CLI during the May 5–9 2026 booking-research sprint. The original directory contained `scrape_songs_v2.js` / `scrape_songs_v3.js` / `fetch_api_songs_v2.js` artifacts; only the final working versions were carried over here.
- Two non-regenerable outputs were moved to `My Drive/GEMINI/` rather than this repo:
  - `Phone Call Priority List - 2026-05-06.md`
  - `Cleaned Venues.txt`
- The xlsx master lives at `~/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx`; Drive working copy is in `My Drive/CLAUDE/`. See the JoshMariaMusic CLAUDE.md for the sync rules.
