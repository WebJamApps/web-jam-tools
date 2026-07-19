---
name: venue-mining
description: Mine net-new live-music venues for the gig-outreach DB from per-metro local events publications. Three seed modes — metro (seedless sweep), artist (harvest every venue an artist played), venue (verify/enrich one venue, incl. refreshing a DB record). Propose→Josh-approves→create via POST /venue (requires street address for every venue); auto-flip outreachEligible only on a viable booking/general email; NEVER pitches, NEVER scrapes Facebook. Registry + sweep cooldowns live in sources.yaml next to this file. Triggered by /venue-mining <metro|artist|venue> <name>, or Josh saying "mine venues", "venue sweep", "find venues in <metro>".
---

# venue-mining

Grow the venue DB (web-jam-back Mongo, master) with net-new, verified live-music
venues. This SKILL.md is the living spec (originally settled on web-jam-tools#126,
closed); the run log = `runs.md` next to this file. Success metric = net-new
venues created, NOT seed-calendar coverage.

## Invocation

- `/venue-mining metro <name>` — seedless sweep of one metro's events publication
- `/venue-mining artist <name>` — harvest every venue that artist has played
- `/venue-mining venue <name>` — verify viability + enrich contacts for ONE venue
  (also the refresh path for an existing DB record)

## sources.yaml (registry — same dir as this file)

One entry per metro: `slug, label, driveTier (<1.5h | 1.5-2.5h | 2.5-3.5h),
publication (name+url, null until discovered), lastSwept, notes`.

- **Cooldown: 6 months.** If `lastSwept` is under 6 months old, REFUSE the sweep
  and tell Josh when it unlocks — he can explicitly override.
- **Re-sweeps are incremental**: only scan issues/listings published since
  `lastSwept`, never the full archive again.
- Publication missing? Discovering the metro's "Rambler-equivalent" (a local
  events publication with real archive depth) is step one of that run, and the
  discovery gets committed back to sources.yaml in the run's wrap-up PR.
  National aggregators bot-block (403) and tourism calendars are noise — a
  local publication is the only source class that has worked.
- Region is capped at ~3.5h drive from Salem VA. Adding metros = Josh's call.

## Procedure

1. **Resolve source** — look up the metro in sources.yaml; enforce the cooldown;
   discover + record the publication if null.
2. **Harvest** (delegate: parallel Haiku subagents) — sweep the publication
   archive (12-mo for a first sweep, delta-since-lastSwept for re-sweeps).
   Collect venue names with dates/acts as evidence. Subagents do the fetching
   so the churn stays out of the main context.
3. **Dedupe** — `GET /venue`; match **by name** (never a remembered `_id` —
   AI-recalled ids are wrong). Drop venues already in the DB, active OR archived.
4. **Verify** (delegate: Haiku, batched) — for each new candidate: real venue,
   recurring live-music programming, size fit (reject theaters/large halls —
   optionally offer as a TimShermanMusic lead), find email + phone + website
   + **street address** from the venue's OWN site. Collect address from sources
   in this order: (a) venue's website (contact/about/footer), (b) venue's public
   Google Business listing, (c) the publication being swept. For JS-heavy sites,
   use Playwright to render the page before extracting. The address must be
   good enough to drive to: real street number + street name (not "downtown
   <city>", not a PO box, not a chain HQ mailing address). Prefer the exact
   address as shown in Google Business. **If a venue has no usable address after
   exhausting these sources, skip it and report it to Josh** (see Skipped Venues
   below). Note evidence counts (dates sampled, acts).
5. **Propose in chat** — ONE compact evidence table including: venue name, city,
   state, address, email, phone, website. Josh approves a subset. Keep it
   phone-readable: short lines, no walls of text. Show addresses exactly as
   sourced (backend normalizes them).
6. **Create** — ONE batched script call doing all `POST /venue` upserts
   (single permission click). Every create: provenance in `notes` (publication,
   sweep date, issue ref) + `outreachEligible` per the email rule below.
   **Every venue MUST have a street address.** A proposed venue without an
   address is NOT created — no placeholder, no "TBD". The backend requires it
   and uses it to dedupe records. When confirming creation, show the
   server-returned address value (the backend may have normalized it).
7. **Wrap up** — file a small issue for the run if one doesn't exist yet
   (`venue sweep: <slug>`), then one PR into dev that closes it, containing BOTH
   the run entry appended to `runs.md` (results, holds/rejects, lessons) AND the
   sources.yaml update (`lastSwept` + any new publication). No long-running
   tracking issue: every issue this skill touches gets closed by its PR
   (create-draft-pr.sh emits `Closes #N` by default).

## Skipped venues (real candidates dropped for lack of address)

If a venue is a real, recurring live-music venue, size-fit, and otherwise venue-mining-ready
but has no usable address after exhausting website + Google Business + publication sources,
it is handed to Josh as a skipped venue, not silently lost. The end-of-sweep report lists:

- Venue name
- City
- Which sources were already checked and came up empty (so Josh doesn't repeat work)
- Links to help Josh finish the lookup: the venue's website URL and its Facebook page URL if one
  was visible (linking is fine; scraping is not)

Josh supplies the address via `/venue-mining venue <name>` in `venue` mode, and the agent creates
the venue record once the address is sourced.

## Address enrichment for existing venues (`venue` seed mode)

When using `/venue-mining venue <name>` to verify or refresh an existing venue record, if the
record currently has no address, the agent attempts to source one via website + Google Business
+ publication. If an address is found, it is sent via `PUT /venue/<_id>` (partial merge, not
a gate). This is an enrichment opportunity, not a blocker for the main `verify` task.

## Eligibility rule (settled 2026-07-02)

- Viable email found on the venue's own site = **booking@ or general info@** →
  create with `outreachEligible: true`.
- Obviously-wrong-purpose inbox (catering@, events-form-only, private-parties@)
  or no email → `outreachEligible: false`; note why.
- **NEVER pitch.** No POST /outreach/*, no template sends, no eligibility flips
  on venues this run didn't create. Outreach stays behind Josh's approve gate
  (AdminOutreach auto-approve switch; the agent token can't hold
  outreach:approve by design).

## Guardrails

- **NEVER scrape Facebook** (risks the account the JaMmusic/CLC feeds depend
  on). Link to FB pages in skipped-venue reports is fine; scraping is not.
  FB-only leads → report; Josh can screenshot for vision as fallback.
- **Street address is REQUIRED for every POST /venue.** No placeholder, no "TBD",
  no null — the backend rejects it. If the agent cannot find an address after
  exhausting its sources (website via Playwright + Google Business + publication),
  the venue is skipped and reported to Josh. Never invent an address.
- POST /venue only for NEW venues (it dedupes by email else name+city, and
  DUPLICATES on null city). Fixing a field on an existing record = `PUT
  /venue/<_id>` (partial merge). DELETE archives.
- **Send addresses as typed**, without client-side formatting or abbreviation —
  the backend (web-jam-back#987) normalizes them. When confirming a create,
  show the server-returned value.
- API: `https://webjamsalem.herokuapp.com`, Bearer token at
  `~/WebJamApps/web-jam-llms/web-jam-llm.token`. Venue writes prompt for
  permission — run them from the main session, batched.
- Delegation: harvest/verify runs on Haiku subagents; the main session only
  resolves the source, reviews subagent output, talks to Josh, and does the
  batched writes. Subagent prompts must be self-contained (they have no session
  context) — see the delegate skill.

## POST /venue example payload (with required address)

```json
{
  "name": "Starr Hill Brewing",
  "city": "Roanoke",
  "usState": "VA",
  "address": "2027 Mountain Ave SE",
  "email": "events@starrhill.com",
  "phone": "+1-540-555-0123",
  "website": "https://starrhill.com",
  "outreachEligible": true,
  "notes": "First sweep of Roanoke Rambler, 2026-07-19. Issue wjt#208."
}
```

Every field except `phone` is expected; `phone` may be null if not found. The `address`
field is mandatory.
