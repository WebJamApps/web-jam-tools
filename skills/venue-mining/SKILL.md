---
name: venue-mining
description: Mine net-new live-music venues for the gig-outreach DB from per-metro local events publications. Three seed modes — metro (seedless sweep), artist (harvest every venue an artist played), venue (verify/enrich one venue, incl. refreshing a DB record). Propose→Josh-approves→create via POST /venue; auto-flip outreachEligible only on a viable booking/general email; NEVER pitches, NEVER scrapes Facebook. Registry + sweep cooldowns live in sources.yaml next to this file. Triggered by /venue-mining <metro|artist|venue> <name>, or Josh saying "mine venues", "venue sweep", "find venues in <metro>".
---

# venue-mining

Grow the venue DB (web-jam-back Mongo, master) with net-new, verified live-music
venues. Spec + run log = web-jam-tools#126. Success metric = net-new venues
created, NOT seed-calendar coverage.

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
   from the venue's OWN site. Note evidence counts (dates sampled, acts).
5. **Propose in chat** — ONE compact evidence table. Josh approves a subset.
   Keep it phone-readable: short lines, no walls of text.
6. **Create** — ONE batched script call doing all `POST /venue` upserts
   (single permission click). Every create: provenance in `notes` (publication,
   sweep date, issue ref) + `outreachEligible` per the email rule below.
7. **Wrap up** — run-log comment on web-jam-tools#126; update sources.yaml
   `lastSwept` (+ any new publication/lessons) via a small PR into dev.
   That PR MUST pass `--part-of` to create-draft-pr.sh — #126 is the standing
   run log and must never be auto-closed (the script defaults to `Closes #N`).

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
  on). FB-only leads → report; Josh can screenshot for vision as fallback.
- POST /venue only for NEW venues (it dedupes by email else name+city, and
  DUPLICATES on null city). Fixing a field on an existing record = `PUT
  /venue/<_id>` (partial merge). DELETE archives.
- API: `https://webjamsalem.herokuapp.com`, Bearer token at
  `~/WebJamApps/web-jam-llms/web-jam-llm.token`. Venue writes prompt for
  permission — run them from the main session, batched.
- Delegation: harvest/verify runs on Haiku subagents; the main session only
  resolves the source, reviews subagent output, talks to Josh, and does the
  batched writes. Subagent prompts must be self-contained (they have no session
  context) — see the delegate skill.
