// src/venue-mining/sweep_cville.ts
// Automated venue-mining sweeper for Charlottesville VA (C-VILLE Weekly).
import { buildHeaders, resolveBackendConfig } from "../book-gig/outreach_api.ts";

export interface HarvestedEvent {
  title: string;
  date: string;
}

export interface HarvestedVenue {
  name: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  website?: string;
  eventCount: number;
  events: HarvestedEvent[];
}

export const NON_MUSIC_ENTITY_KEYWORDS = [
  "sewing",
  "scrappy elephant",
  "library",
  "museum",
  "monticello",
  "downtown mall",
  "bookshop",
  "church",
  "montessori",
  "school",
  "park",
  "field",
  "darden towe",
  "discovery museum",
  "resort farm",
  "center for arts & nature",
  "hall 107",
  "hall 229a",
  "campbell hall",
  "auditorium",
  "jaba",
  "aging",
  "commons at uva",
  "bryan hall",
  "nau hall",
  "music library",
  "wtju",
  "online",
  "pvcc",
  "the square",
  "recycling center",
  "waste",
  "solid waste",
  "litter cleanup",
  "tennis & pickleball",
  "botanical garden",
];

export const LARGE_HALL_OR_THEATER_KEYWORDS = [
  "paramount theater",
  "jefferson theater",
  "ting pavilion",
  "john paul jones",
  "old cabell hall",
];

export function isNonMusicEntity(name: string): boolean {
  const norm = name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]/g, " ").trim();
  return NON_MUSIC_ENTITY_KEYWORDS.some((kw) => norm.includes(kw));
}

export function isLargeHallOrTheater(name: string): boolean {
  const norm = name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]/g, " ").trim();
  return LARGE_HALL_OR_THEATER_KEYWORDS.some((kw) => norm.includes(kw));
}

export function isLocalCvilleArea(city?: string, state?: string): boolean {
  const st = (state || "").toUpperCase().trim();
  if (st && st !== "VA" && st !== "VIRGINIA" && st !== "USA") {
    return false;
  }
  const c = (city || "").toLowerCase().trim();
  if (!c) return true; // fallback to include if city is omitted but in C-VILLE local calendar
  const LOCAL_TOWNS = [
    "charlottesville",
    "crozet",
    "keswick",
    "scottsville",
    "earlysville",
    "north garden",
    "ivy",
    "free union",
    "barboursville",
    "palmyra",
    "albemarle",
  ];
  return LOCAL_TOWNS.some((t) => c.includes(t));
}

export function dedupeVenues(
  harvested: HarvestedVenue[],
  existingDbNames: string[],
): HarvestedVenue[] {
  const normalizedDb = existingDbNames.map((n) =>
    n.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]/g, " ").trim()
  );

  return harvested.filter((venue) => {
    const norm = venue.name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]/g, " ").trim();
    if (!norm) return false;
    return !normalizedDb.some((db) => {
      if (db === norm) return true;
      if (db.length > 5 && norm.length > 5 && (db.includes(norm) || norm.includes(db))) {
        return true;
      }
      return false;
    });
  });
}

export async function fetchCvilleMusicEvents(
  fetchFn: typeof fetch = fetch,
  pageLimit?: number,
): Promise<HarvestedVenue[]> {
  const venuesMap = new Map<string, HarvestedVenue>();
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    if (pageLimit && page > pageLimit) break;
    const url = `http://events.c-ville.com/cville/search.json?category=13&page=${page}`;
    try {
      const res = await fetchFn(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) break;
      const data = await res.json();
      totalPages = data.pages || 1;
      const events = data.events || [];

      for (const item of events) {
        const src = item._source;
        if (!src || !src.venue || !src.venue.name) continue;
        const v = src.venue;
        const nameKey = v.name.toLowerCase().replace(/['’]/g, "").trim();

        if (!venuesMap.has(nameKey)) {
          venuesMap.set(nameKey, {
            name: v.name.trim(),
            address: v.address?.trim(),
            city: v.city?.trim(),
            state: v.state?.trim(),
            zip: v.zip?.trim(),
            phone: v.phone?.trim(),
            website: v.url?.trim(),
            eventCount: 0,
            events: [],
          });
        }

        const existing = venuesMap.get(nameKey)!;
        existing.eventCount++;
        if (existing.events.length < 5) {
          existing.events.push({
            title: src.name?.trim() || "Live Music",
            date: src.starttime ? src.starttime.slice(0, 10) : "",
          });
        }
      }
    } catch {
      break;
    }
    page++;
  }

  return Array.from(venuesMap.values());
}

if (import.meta.main) {
  const args = Deno.args;
  const jsonOutput = args.includes("--json");
  const noDedup = args.includes("--no-dedup");

  console.log("Sweeping C-VILLE Weekly music calendar...");
  const rawVenues = await fetchCvilleMusicEvents();
  console.log(`Found ${rawVenues.length} raw venues across all pages.`);

  // Filter out non-music entities
  const musicVenues = rawVenues.filter((v) => !isNonMusicEntity(v.name));
  const localVenues = musicVenues.filter((v) => isLocalCvilleArea(v.city, v.state));
  const regularVenues = localVenues.filter((v) => !isLargeHallOrTheater(v.name));
  const tsmLeads = localVenues.filter((v) => isLargeHallOrTheater(v.name));

  let finalCandidates = regularVenues;

  if (!noDedup) {
    try {
      const { baseUrl, token } = await resolveBackendConfig();
      const res = await fetch(`${baseUrl}/venue`, { headers: buildHeaders(token) });
      if (res.ok) {
        const dbVenues: Array<{ name?: string }> = await res.json();
        const dbNames = dbVenues.map((v) => v.name || "");
        finalCandidates = dedupeVenues(regularVenues, dbNames);
        console.log(
          `Deduped against ${dbVenues.length} DB venues. Candidates remaining: ${finalCandidates.length}`,
        );
      }
    } catch (err) {
      console.warn(
        "Could not query DB for dedup, proceeding with local candidates:",
        (err as Error).message,
      );
    }
  }

  finalCandidates.sort((a, b) => b.eventCount - a.eventCount);

  if (jsonOutput) {
    console.log(JSON.stringify({ candidates: finalCandidates, tsmLeads }, null, 2));
  } else {
    console.log(`\n=== Top Candidates (${finalCandidates.length}) ===`);
    for (const c of finalCandidates.slice(0, 20)) {
      console.log(
        `- ${c.name} (${c.city || "Charlottesville"}, VA) | events: ${c.eventCount} | addr: ${
          c.address || "none"
        } | phone: ${c.phone || "none"} | url: ${c.website || "none"}`,
      );
    }
    if (tsmLeads.length > 0) {
      console.log(`\n=== TimShermanMusic Leads (${tsmLeads.length}) ===`);
      for (const t of tsmLeads) {
        console.log(`- ${t.name} (${t.city || "Charlottesville"}, VA) | events: ${t.eventCount}`);
      }
    }
  }
}
