// src/venue-mining/sweep.ts
// Generalized venue-mining sweeper supporting any city/metro area.
import { parse as parseYaml } from "@std/yaml";
import { parseArgs } from "@std/cli/parse-args";
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

export interface MetroPublication {
  name: string;
  url: string;
  api?: string;
  type?: string; // e.g. 'scenethink' | 'rss' | 'html'
}

export interface MetroEntry {
  slug: string;
  label: string;
  driveTier: string;
  publication: MetroPublication | null;
  lastSwept: string | null;
  notes?: string;
  coverageArea?: string[];
}

export interface SourcesRegistry {
  metros: MetroEntry[];
}

export interface CooldownStatus {
  isLocked: boolean;
  daysRemaining: number;
  unlockDate: string | null;
}

export interface SweepOptions {
  metro?: string;
  url?: string;
  city?: string;
  state?: string;
  pageLimit?: number;
  dryRun?: boolean;
  noDedup?: boolean;
  force?: boolean;
  sourcesPath?: string;
  fetchFn?: typeof fetch;
}

export interface SweepResult {
  metro?: MetroEntry;
  sourceUrl: string;
  sourceType: string;
  rawCount: number;
  candidates: HarvestedVenue[];
  tsmLeads: HarvestedVenue[];
  cooldownStatus?: CooldownStatus;
}

export const NON_MUSIC_ENTITY_KEYWORDS = [
  "sewing",
  "scrappy elephant",
  "library",
  "museum",
  "gallery",
  "monticello",
  "downtown mall",
  "bookshop",
  "book store",
  "church",
  "synagogue",
  "temple",
  "chapel",
  "ministry",
  "montessori",
  "school",
  "academy",
  "elementary",
  "high school",
  "park",
  "playground",
  "field",
  "loop park",
  "discovery museum",
  "hall 107",
  "hall 229a",
  "campbell hall",
  "auditorium",
  "jaba",
  "aging",
  "senior center",
  "nursing home",
  "nau hall",
  "bryan hall",
  "music library",
  "wtju",
  "recycling center",
  "waste",
  "solid waste",
  "litter cleanup",
  "tennis",
  "pickleball",
  "botanical garden",
];

export const LARGE_HALL_OR_THEATER_KEYWORDS = [
  "paramount theater",
  "jefferson theater",
  "ting pavilion",
  "john paul jones",
  "old cabell hall",
  "amphitheater",
  "amphitheatre",
  "coliseum",
  "arena",
  "stadium",
  "civic center",
  "performing arts center",
  "symphony hall",
  "opera house",
];

export function isNonMusicEntity(name: string): boolean {
  const norm = name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]/g, " ").trim();
  return NON_MUSIC_ENTITY_KEYWORDS.some((kw) => norm.includes(kw));
}

export function isLargeHallOrTheater(name: string): boolean {
  const norm = name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]/g, " ").trim();
  return LARGE_HALL_OR_THEATER_KEYWORDS.some((kw) => norm.includes(kw));
}

export async function loadSourcesRegistry(sourcesPath?: string): Promise<SourcesRegistry> {
  const p = sourcesPath ||
    new URL("../../skills/venue-mining/sources.yaml", import.meta.url).pathname;
  const content = await Deno.readTextFile(p);
  return parseYaml(content) as SourcesRegistry;
}

export function resolveMetro(query: string, registry: SourcesRegistry): MetroEntry | null {
  const norm = query.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]/g, " ").trim();
  // 1. Exact slug match
  const slugMatch = registry.metros.find((m) => {
    const s = m.slug.toLowerCase().trim();
    return s === norm || s.replace(/-/g, " ") === norm;
  });
  if (slugMatch) return slugMatch;

  // 2. Exact or substring match in label
  const labelMatch = registry.metros.find((m) => {
    const l = m.label.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
    return l === norm || l.includes(norm) || norm.includes(l);
  });
  return labelMatch || null;
}

export function checkCooldown(lastSwept: string | null, now: Date = new Date()): CooldownStatus {
  if (!lastSwept) return { isLocked: false, daysRemaining: 0, unlockDate: null };
  const sweptDate = new Date(lastSwept);
  if (Number.isNaN(sweptDate.getTime())) {
    return { isLocked: false, daysRemaining: 0, unlockDate: null };
  }

  const COOLDOWN_DAYS = 180; // 6 months
  const unlockMs = sweptDate.getTime() + (COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const unlockDate = new Date(unlockMs);
  const diffDays = Math.ceil((unlockMs - now.getTime()) / (24 * 60 * 60 * 1000));

  if (diffDays > 0) {
    return {
      isLocked: true,
      daysRemaining: diffDays,
      unlockDate: unlockDate.toISOString().slice(0, 10),
    };
  }
  return { isLocked: false, daysRemaining: 0, unlockDate: null };
}

export function parseStateFromLabel(label: string): string | null {
  const match = label.match(/\b([A-Z]{2}(?:-[A-Z]{2})?)\b/);
  return match ? match[1] : null;
}

export function isLocalArea(
  venueCity?: string,
  venueState?: string,
  targetMetro?: { slug?: string; label?: string; coverageArea?: string[] },
  explicitCity?: string,
  explicitState?: string,
): boolean {
  const expectedState = explicitState ||
    (targetMetro?.label ? parseStateFromLabel(targetMetro.label) : null);
  if (expectedState && venueState) {
    const vSt = venueState.toUpperCase().trim();
    const allowedStates = expectedState.split("-").map((s) => s.trim());
    if (!allowedStates.includes(vSt) && vSt !== "USA") {
      return false;
    }
  }

  if (explicitCity && venueCity) {
    const expCityNorm = explicitCity.toLowerCase().trim();
    const vCityNorm = venueCity.toLowerCase().trim();
    if (!vCityNorm.includes(expCityNorm) && !expCityNorm.includes(vCityNorm)) {
      if (
        targetMetro?.coverageArea &&
        targetMetro.coverageArea.some((c) => vCityNorm.includes(c.toLowerCase()))
      ) {
        return true;
      }
      return false;
    }
    return true;
  }

  if (targetMetro && venueCity) {
    const vCityNorm = venueCity.toLowerCase().trim();
    if (targetMetro.coverageArea && targetMetro.coverageArea.length > 0) {
      return targetMetro.coverageArea.some((c) => vCityNorm.includes(c.toLowerCase()));
    }
    const metroWords = (targetMetro.label || targetMetro.slug || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && w !== "county" && w !== "river" && w !== "valley");
    if (metroWords.length > 0 && metroWords.some((w) => vCityNorm.includes(w))) {
      return true;
    }
  }

  return true;
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

export async function fetchSceneThinkEvents(
  endpointUrl: string,
  fetchFn: typeof fetch = fetch,
  pageLimit?: number,
): Promise<HarvestedVenue[]> {
  const venuesMap = new Map<string, HarvestedVenue>();
  let page = 1;
  let totalPages = 1;

  const urlObj = new URL(endpointUrl);
  if (!urlObj.searchParams.has("category") && !urlObj.pathname.includes("search.json")) {
    urlObj.pathname = `${urlObj.pathname.replace(/\/+$/, "")}/search.json`;
    urlObj.searchParams.set("category", "13");
  }

  while (page <= totalPages) {
    if (pageLimit && page > pageLimit) break;
    urlObj.searchParams.set("page", String(page));
    try {
      const res = await fetchFn(urlObj.toString(), { headers: { "User-Agent": "Mozilla/5.0" } });
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

export async function harvestEvents(
  sourceUrl: string,
  sourceType: string = "auto",
  fetchFn: typeof fetch = fetch,
  pageLimit?: number,
): Promise<HarvestedVenue[]> {
  if (
    sourceType === "scenethink" || sourceUrl.includes("search.json") ||
    sourceUrl.includes("events.")
  ) {
    return await fetchSceneThinkEvents(sourceUrl, fetchFn, pageLimit);
  }
  return await fetchSceneThinkEvents(sourceUrl, fetchFn, pageLimit);
}

export async function runSweep(options: SweepOptions): Promise<SweepResult> {
  const fetchFn = options.fetchFn || fetch;
  const registry = await loadSourcesRegistry(options.sourcesPath);

  let targetMetro: MetroEntry | undefined;
  if (options.metro) {
    const found = resolveMetro(options.metro, registry);
    if (found) targetMetro = found;
  }

  let sourceUrl = options.url;
  let sourceType = "scenethink";

  if (targetMetro) {
    const cooldown = checkCooldown(targetMetro.lastSwept);
    if (cooldown.isLocked && !options.force) {
      throw new Error(
        `Sweep refused for metro '${targetMetro.slug}': 6-month cooldown active (${cooldown.daysRemaining} days remaining, unlocks ${cooldown.unlockDate}). Pass --force to override.`,
      );
    }
    if (!sourceUrl && targetMetro.publication) {
      sourceUrl = targetMetro.publication.api || targetMetro.publication.url;
      if (targetMetro.publication.type) {
        sourceType = targetMetro.publication.type;
      }
    }
  }

  if (!sourceUrl) {
    if (targetMetro) {
      throw new Error(
        `Metro '${targetMetro.slug}' has no publication configured in sources.yaml. Discovering the local events publication is step one. Pass --url <calendar-url> to sweep directly.`,
      );
    }
    throw new Error(
      "No target metro or calendar URL provided. Run with --help for usage instructions.",
    );
  }

  const rawVenues = await harvestEvents(sourceUrl, sourceType, fetchFn, options.pageLimit);

  // Filter out non-music entities
  const musicVenues = rawVenues.filter((v) => !isNonMusicEntity(v.name));

  // Geographic filtering
  const localVenues = musicVenues.filter((v) =>
    isLocalArea(v.city, v.state, targetMetro, options.city, options.state)
  );

  // Classify regular duo venues vs TSM leads (arenas, large halls, theaters)
  const regularVenues = localVenues.filter((v) => !isLargeHallOrTheater(v.name));
  const tsmLeads = localVenues.filter((v) => isLargeHallOrTheater(v.name));

  let finalCandidates = regularVenues;

  if (!options.noDedup && !options.dryRun) {
    try {
      const { baseUrl, token } = await resolveBackendConfig();
      const res = await fetchFn(`${baseUrl}/venue`, { headers: buildHeaders(token) });
      if (res.ok) {
        const dbVenues: Array<{ name?: string }> = await res.json();
        const dbNames = dbVenues.map((v) => v.name || "");
        finalCandidates = dedupeVenues(regularVenues, dbNames);
      }
    } catch (err) {
      console.warn(
        "Warning: Could not query DB for dedup, using raw candidates:",
        (err as Error).message,
      );
    }
  }

  finalCandidates.sort((a, b) => b.eventCount - a.eventCount);

  return {
    metro: targetMetro,
    sourceUrl,
    sourceType,
    rawCount: rawVenues.length,
    candidates: finalCandidates,
    tsmLeads,
    cooldownStatus: targetMetro ? checkCooldown(targetMetro.lastSwept) : undefined,
  };
}

// Backwards-compatible exports for Charlottesville sweep
export const fetchCvilleMusicEvents = (fetchFn?: typeof fetch, pageLimit?: number) =>
  fetchSceneThinkEvents(
    "http://events.c-ville.com/cville/search.json?category=13",
    fetchFn,
    pageLimit,
  );

export const isLocalCvilleArea = (city?: string, state?: string) =>
  isLocalArea(city, state, {
    slug: "charlottesville",
    label: "Charlottesville VA",
    coverageArea: [
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
    ],
  });

function printUsage() {
  console.log(`
venue-mining sweep: Mine live-music venues from local events publications across any metro area.

Usage:
  deno task venue-mining:sweep [metro] [options]

Examples:
  deno task venue-mining:sweep charlottesville
  deno task venue-mining:sweep roanoke-salem --force
  deno task venue-mining:sweep --url "http://events.c-ville.com/cville/search.json?category=13" --city Charlottesville --state VA
  deno task venue-mining:sweep --list

Options:
  -m, --metro <slug|name>   Target metro slug or name from sources.yaml
  -u, --url <url>           Direct calendar or API endpoint URL to sweep
  -c, --city <name>         Filter venues to target city
  -s, --state <code>        Filter venues to 2-letter state code (e.g. VA, NC, WV)
  -p, --pages <n>           Limit number of calendar pages to sweep
  --dry-run                 Run sweep without querying live database for deduplication
  --no-dedup                Skip deduplicating candidates against live database
  --force                   Bypass 6-month cooldown lock
  --json                    Output results as structured JSON
  --list                    List all registered metros and sweep status from sources.yaml
  -h, --help                Show this help message
`);
}

if (import.meta.main) {
  const flags = parseArgs(Deno.args, {
    boolean: ["help", "list", "dry-run", "no-dedup", "force", "json"],
    string: ["metro", "url", "city", "state", "pages", "page-limit", "sources"],
    alias: {
      h: "help",
      m: "metro",
      u: "url",
      c: "city",
      s: "state",
      p: "pages",
    },
  });

  if (flags.help) {
    printUsage();
    Deno.exit(0);
  }

  if (flags.list) {
    const registry = await loadSourcesRegistry(flags.sources);
    console.log(`\nRegistered Metros (${registry.metros.length}):\n`);
    for (const m of registry.metros) {
      const cd = checkCooldown(m.lastSwept);
      const cdInfo = cd.isLocked
        ? `[LOCKED: ${cd.daysRemaining}d left until ${cd.unlockDate}]`
        : "[READY]";
      const pubInfo = m.publication
        ? `${m.publication.name} (${m.publication.url})`
        : "None (publication missing)";
      console.log(
        `- ${m.slug.padEnd(20)} | ${m.label.padEnd(30)} | ${cdInfo.padEnd(25)} | ${pubInfo}`,
      );
    }
    Deno.exit(0);
  }

  const metroArg = flags.metro || (flags._[0] ? String(flags._[0]) : undefined);
  const pageLimit = flags.pages || flags["page-limit"]
    ? parseInt(flags.pages || flags["page-limit"]!, 10)
    : undefined;

  try {
    const result = await runSweep({
      metro: metroArg,
      url: flags.url,
      city: flags.city,
      state: flags.state,
      pageLimit,
      dryRun: flags["dry-run"],
      noDedup: flags["no-dedup"],
      force: flags.force,
      sourcesPath: flags.sources,
    });

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const metroLabel = result.metro
        ? `${result.metro.label} (${result.metro.slug})`
        : "Ad-hoc URL";
      console.log(`\nSwept: ${metroLabel}`);
      console.log(`Source: ${result.sourceUrl}`);
      console.log(`Raw venues discovered: ${result.rawCount}`);
      console.log(`Candidate venues: ${result.candidates.length}`);
      console.log(`TimShermanMusic leads (theaters/arenas): ${result.tsmLeads.length}`);

      console.log(`\n=== Top Candidates (${result.candidates.length}) ===`);
      for (const c of result.candidates.slice(0, 20)) {
        console.log(
          `- ${c.name} (${c.city || "Unknown"}, ${
            c.state || "VA"
          }) | events: ${c.eventCount} | addr: ${c.address || "none"} | phone: ${
            c.phone || "none"
          } | url: ${c.website || "none"}`,
        );
      }

      if (result.tsmLeads.length > 0) {
        console.log(`\n=== TimShermanMusic Leads (${result.tsmLeads.length}) ===`);
        for (const t of result.tsmLeads) {
          console.log(
            `- ${t.name} (${t.city || "Unknown"}, ${t.state || "VA"}) | events: ${t.eventCount}`,
          );
        }
      }
    }
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}\n`);
    Deno.exit(1);
  }
}
