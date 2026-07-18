# venue-mining run log

Append-only record of every /venue-mining sweep. Each wrap-up PR adds its run
entry here (newest at the bottom) in the same PR that updates `sources.yaml`.
Original spec + runs 1–3 discussion lived on web-jam-tools#126 (closed 2026-07-03
when the log moved here); the living procedure is `SKILL.md` next to this file.

## Run 1 — roanoke (2026-07-02, seed: Dan Carrell, pre-skill)

**Results:** 13 candidates → Josh kept 8 created (Martin's Downtown, Big Lick,
Twisted Track, Hanging Rock Tavern, 3rd Street Coffee House, Corned Beef & Co,
Pok-E-Joe's, Starr Hill Pilot); long-tail pass added 6 more (Floyd Country Store,
Golden Cactus, Montano's, Fork in the Alley, Living Proof Beer Co, The Alley Cat)
— **14 new venues total**, all `outreachEligible: false` + Rambler provenance.
Dan Carrell found as a bonus (Parkway Brewing 2025-12-13). Hotel Roanoke Foxx
City Jazz Club deliberately NOT added — saved as a TimShermanMusic lead.
Contact-hunt same day: all 4 contact-less venues got phone+website via PUT
(incl. booking email litterbox@alleycatlive.com).

**Vetting outcome (same day):** Josh authorized the best 7 with emails —
Martin's Downtown, Hanging Rock Tavern, 3rd Street Coffee House, Corned Beef &
Co, Starr Hill Pilot, Floyd Country Store, The Alley Cat — flipped
`outreachEligible:true` and cold-pitched via POST /outreach/batch (targetDates
Sept 25–27, cc Josh+Maria), 7/7 sent, in daily cadence. Held: Pok-E-Joe's
(catering inbox), Golden Cactus (thin evidence), 5 email-less venues. Send
required Josh flipping AdminOutreach Auto-approve ON (agent token can't hold
outreach:approve by design), flipped back off after.

**Lessons:**
1. Per-metro local events publications pay; national aggregators don't
   (Bandsintown/Songkick/Yelp 403 bot-block; tourism/downtown calendars noisy).
2. Give the agent exact fetch mechanics: `www.roanokerambler.com` (bare domain
   302s and reads as 404); index = /tag/happenings/ + /page/N/; never invent
   date-based URLs.
3. Spot-check coverage claims — agent covered 12 of 52 weekly posts yet claimed
   a full 12-month window.
4. Dedupe centrally, not in the subagent (pass 1 falsely claimed two venues
   were already in DB).
5. 12-month depth was NOT the time cost — source failures were. Keep 12 months.

## Run 2 — rock-hill-sc (2026-07-02, first /venue-mining SKILL run)

Publication discovered = **Rock Hill Connection** (rockhillconnection.com/events;
shallow archive — supplemented by Visit York County + venue sites;
heraldonline.com 403s). 40+ candidates → deduped (Slow Play, Lake Wylie already
in DB) → 16 verified → Josh approved 6 created: Replay Brewing*, Olive's Mud
Puddle* (Originals — songwriter/open-mic space), Model A Brewing*
(*=viable email → `outreachEligible:true` per skill rule), Rock Hill Brewing Co
(3rd-Wed songwriter night, best duo fit, FB-only), The Pump House, Amor Artis.
Rejected: Tap & Vine + Rooster Tavern (not in metro), Legal Remedy (taproom
closed), Middle James (closing), Illumination (private-events only).
Thin-evidence holds: Social Cork, Laurel Haven (weddings), Untamed Waters,
Tattooed Brews, D'Pour House.

**Lesson:** this metro is heavily FB-only — venue-site corroboration was the
workhorse. Also fixed mid-run: global WebFetch allowlist (no more per-fetch
permission clicks).

## Run 3 — gastonia (Gaston County side, 2026-07-03)

Publication = **Go Gaston NC** (gogastonnc.org — tourism board but its venue
directory earned its keep; Gaston Gazette not needed; runner-up
charlotteonthecheap.com). 14 candidates → dedupe dropped Primal Brewery + Durty
Bull (already in DB; Cavendish Brewing found CLOSED Jan 2026) → 7 verified →
Josh approved 3 created + PITCHED same session (Sept 25–27 batch, all viable
emails, `outreachEligible:true`): The Rooster (Gastonia, Originals — dedicated
local-musician venue), Gaston Pour House (Fri music + Gaston FolkSing), South
Point Social (Belmont; karaoke-mix flag). Held not-created: Nellie's Southern
Kitchen (house band Mon–Sat, no email) + Confluence (Cramerton; only email is
parent nonprofit retail@ — Josh to decide). Rejected: Warp & Weft (Lowell
MASSACHUSETTS, not NC — harvest geo-trap lesson), Bourbon Barrel (karaoke-only).
Charlotte proper remains unswept under this slug.

## Run 4 — lynchburg (2026-07-18)

Publication discovered = **Downtown Lynchburg Association**
(www.downtownlynchburg.com/calendar). 8 candidates → 6 created: **7 Rooftop Bar**
(haley@7rooftopbar.com, `outreachEligible:true`, Fri "Sunset Sessions"; sole
email yield), Starr Hill On Main, Palmera House, Super Rad Arcade Bar, The Water
Dog, Dish (all created `outreachEligible:false`, FB-only booking). Rejected as
too-large: Academy Center of the Arts, Lynchburg Amphitheater (TimShermanMusic
leads).

**Incident:** First POST for "Starr Hill On Main" used email `info@starrhill.com`
(shared Starr Hill chain booking inbox). Email dedup in `POST /venue` → it
**matched and overwrote the existing "Starr Hill Pilot Brewery" (Roanoke) record**,
clobbering its name, city, website, and notes. Restored via `PUT /venue/:id`;
original `outreachEligible` + notes restoration pending Josh's confirmation.

**Lesson:** For franchise/chain venues sharing a booking inbox, create WITHOUT the
shared email (falls back to name+city dedup), then add a location-specific contact
via PUT after creation.
