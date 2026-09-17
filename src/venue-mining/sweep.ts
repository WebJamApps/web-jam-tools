// src/venue-mining/sweep.ts
// Generalized venue-mining sweeper supporting any city/metro area.
import { parse as parseYaml } from "@std/yaml";
import { parseArgs } from "@std/cli/parse-args";
import { fetchVenueMap } from "../book-gig/outreach_api.ts";

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
  lastSwept: string | Date | null;
  notes?: string;
  coverageArea?: string[];
  excludeKeywords?: string[];
}

export interface SourcesRegistry {
  metros: MetroEntry[];
}

export interface CooldownStatus {
  isLocked: boolean;
  daysRemaining: number;
  unlockDate: string | null;
  unparseable?: boolean;
}

export interface SweepOptions {
  metro?: string;
  url?: string;
  city?: string;
  state?: string;
  pageLimit?: number;
  noDedup?: boolean;
  force?: boolean;
  sourcesPath?: string;
  fetchFn?: typeof fetch;
  now?: Date;
}

export interface SweepResult {
  metro?: MetroEntry;
  sourceUrl: string;
  sourceType: string;
  rawCount: number;
  candidates: HarvestedVenue[];
  cooldownStatus?: CooldownStatus;
  deduplicated: boolean;
}

export const NON_MUSIC_ENTITY_KEYWORDS = [
  "sewing",
  "library",
  "museum",
  "gallery",
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
  "auditorium",
  "aging",
  "senior center",
  "nursing home",
  "music library",
  "recycling center",
  "waste",
  "solid waste",
  "litter cleanup",
  "tennis",
  "pickleball",
  "botanical garden",
];

export const LARGE_HALL_OR_THEATER_KEYWORDS = [
  "theater",
  "theatre",
  "pavilion",
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

export function isNonMusicEntity(name: string, extraKeywords: string[] = []): boolean {
  const norm = name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]/g, " ").trim();
  const padded = ` ${norm.replace(/\s+/g, " ")} `;
  const allKeywords = [...NON_MUSIC_ENTITY_KEYWORDS, ...extraKeywords];
  return allKeywords.some((kw) => {
    const normKw = kw.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]/g, " ").trim().replace(
      /\s+/g,
      " ",
    );
    return normKw.length > 0 && padded.includes(` ${normKw} `);
  });
}

export function isLargeHallOrTheater(name: string, extraKeywords: string[] = []): boolean {
  const norm = name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]/g, " ").trim();
  const padded = ` ${norm.replace(/\s+/g, " ")} `;
  const allKeywords = [...LARGE_HALL_OR_THEATER_KEYWORDS, ...extraKeywords];
  return allKeywords.some((kw) => {
    const normKw = kw.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]/g, " ").trim().replace(
      /\s+/g,
      " ",
    );
    return normKw.length > 0 && padded.includes(` ${normKw} `);
  });
}

export async function loadSourcesRegistry(sourcesPath?: string): Promise<SourcesRegistry> {
  const p = sourcesPath ||
    new URL("../../skills/venue-mining/sources.yaml", import.meta.url).pathname;
  let content: string;
  try {
    content = await Deno.readTextFile(p);
  } catch (err) {
    throw new Error(`Failed to read sources file at '${p}': ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    throw new Error(`Failed to parse sources YAML at '${p}': ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || !("metros" in parsed)) {
    throw new Error(`Invalid sources registry at '${p}': missing 'metros' key`);
  }
  return parsed as SourcesRegistry;
}

export function resolveMetro(query: string, registry: SourcesRegistry): MetroEntry | null {
  const norm = query.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
  if (!norm) return null;

  // 1. Exact slug match
  const slugMatch = registry.metros.find((m) => {
    const s = m.slug.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
    return s === norm;
  });
  if (slugMatch) return slugMatch;

  // 2. Exact label match (ignoring case and punctuation)
  const labelMatch = registry.metros.find((m) => {
    const l = m.label.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
    return l === norm;
  });
  return labelMatch || null;
}

export function checkCooldown(
  lastSwept: string | Date | null,
  now: Date = new Date(),
): CooldownStatus {
  if (!lastSwept) return { isLocked: false, daysRemaining: 0, unlockDate: null };
  const sweptDate = lastSwept instanceof Date ? lastSwept : new Date(String(lastSwept));
  if (Number.isNaN(sweptDate.getTime())) {
    return { isLocked: true, daysRemaining: 0, unlockDate: null, unparseable: true };
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
  if (expectedState) {
    if (!venueState) {
      return false;
    }
    const vSt = venueState.toUpperCase().trim();
    const allowedStates = expectedState.split("-").map((s) => s.trim());
    if (!allowedStates.includes(vSt)) {
      return false;
    }
  }

  if (explicitCity) {
    if (!venueCity) {
      return false;
    }
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

  if (targetMetro) {
    if (!venueCity) {
      return false;
    }
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
    return false;
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
  sinceDate?: string | Date | null,
): Promise<HarvestedVenue[]> {
  const venuesMap = new Map<string, HarvestedVenue>();
  let page = 1;
  let totalPages = 1;

  const urlObj = new URL(endpointUrl);

  while (page <= totalPages) {
    if (pageLimit && page > pageLimit) break;
    urlObj.searchParams.set("page", String(page));
    const pageUrl = urlObj.toString();

    let res: Response;
    try {
      res = await fetchFn(pageUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    } catch (err) {
      throw new Error(`Failed to fetch page ${page} from '${pageUrl}': ${(err as Error).message}`);
    }

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status} fetching page ${page} from '${pageUrl}'`);
    }

    let data: {
      pages?: number;
      events?: Array<{
        _source?: {
          name?: string;
          starttime?: string;
          venue?: {
            name?: string;
            address?: string;
            city?: string;
            state?: string;
            zip?: string;
            phone?: string;
            url?: string;
          };
        };
      }>;
    };
    try {
      data = await res.json();
    } catch (err) {
      throw new Error(
        `Failed to parse JSON response on page ${page} from '${pageUrl}': ${
          (err as Error).message
        }`,
      );
    }

    totalPages = data.pages || 1;
    const events = data.events || [];

    for (const item of events) {
      const src = item._source;
      const v = src?.venue;
      if (!v || typeof v.name !== "string" || !v.name.trim()) continue;
      const venueName = v.name.trim();
      const nameKey = venueName.toLowerCase().replace(/['’]/g, "");

      const eventStart = src.starttime ? src.starttime.slice(0, 10) : "";
      const rawSince = sinceDate instanceof Date
        ? (Number.isNaN(sinceDate.getTime()) ? null : sinceDate.toISOString().slice(0, 10))
        : (typeof sinceDate === "string" && !Number.isNaN(new Date(sinceDate).getTime())
          ? sinceDate.slice(0, 10)
          : null);
      if (rawSince && eventStart && eventStart <= rawSince) {
        continue;
      }

      if (!venuesMap.has(nameKey)) {
        venuesMap.set(nameKey, {
          name: venueName,
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
          date: eventStart,
        });
      }
    }
    page++;
  }

  return Array.from(venuesMap.values());
}

export async function harvestEvents(
  sourceUrl: string,
  sourceType: string = "scenethink",
  fetchFn: typeof fetch = fetch,
  pageLimit?: number,
  sinceDate?: string | Date | null,
): Promise<HarvestedVenue[]> {
  if (sourceType !== "scenethink") {
    throw new Error(
      `Unsupported publication type '${sourceType}'. Only 'scenethink' is supported.`,
    );
  }
  return await fetchSceneThinkEvents(sourceUrl, fetchFn, pageLimit, sinceDate);
}

export async function runSweep(options: SweepOptions): Promise<SweepResult> {
  const fetchFn = options.fetchFn || fetch;
  const registry = await loadSourcesRegistry(options.sourcesPath);

  let targetMetro: MetroEntry | undefined;
  if (options.metro) {
    const found = resolveMetro(options.metro, registry);
    if (!found) {
      throw new Error(`metro '${options.metro}' not found in sources.yaml`);
    }
    targetMetro = found;
  }

  let sourceUrl = options.url;
  let sourceType = "scenethink";

  if (targetMetro) {
    const cooldown = checkCooldown(targetMetro.lastSwept, options.now);
    if (cooldown.unparseable) {
      if (!options.force) {
        throw new Error(
          `Sweep refused for metro '${targetMetro.slug}': 'lastSwept' field value '${targetMetro.lastSwept}' is unparseable as a date. Pass --force to override.`,
        );
      }
    } else if (cooldown.isLocked && !options.force) {
      throw new Error(
        `Sweep refused for metro '${targetMetro.slug}': 6-month cooldown active (${cooldown.daysRemaining} days remaining, unlocks ${cooldown.unlockDate}). Pass --force to override.`,
      );
    }
    if (!sourceUrl && targetMetro.publication) {
      if (!targetMetro.publication.type) {
        throw new Error(
          `Metro '${targetMetro.slug}' has publication '${targetMetro.publication.name}' with missing type. Only 'scenethink' is supported.`,
        );
      }
      if (targetMetro.publication.type !== "scenethink") {
        throw new Error(
          `Metro '${targetMetro.slug}' has unsupported publication type '${targetMetro.publication.type}'. Only 'scenethink' is supported.`,
        );
      }
      sourceUrl = targetMetro.publication.api || targetMetro.publication.url;
      sourceType = targetMetro.publication.type;
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

  const rawVenues = await harvestEvents(
    sourceUrl,
    sourceType,
    fetchFn,
    options.pageLimit,
    targetMetro?.lastSwept,
  );

  // Filter out non-music entities
  const musicVenues = rawVenues.filter((v) =>
    !isNonMusicEntity(v.name, targetMetro?.excludeKeywords)
  );

  // Geographic filtering
  const localVenues = musicVenues.filter((v) =>
    isLocalArea(v.city, v.state, targetMetro, options.city, options.state)
  );

  // Reject large halls, arenas, and theaters
  const regularVenues = localVenues.filter((v) => !isLargeHallOrTheater(v.name));

  let finalCandidates = regularVenues;
  let deduplicated = false;

  if (!options.noDedup) {
    let dedupError: Error | null = null;
    const trackingFetch: typeof fetch = async (input, init) => {
      let res: Response;
      try {
        res = await fetchFn(input, init);
      } catch (err) {
        dedupError = new Error(
          `Database query failed for deduplication at '${input}': ${(err as Error).message}`,
        );
        throw err;
      }
      if (!res.ok) {
        dedupError = new Error(
          `Database query failed with HTTP status ${res.status} at '${input}'`,
        );
        return res;
      }
      try {
        const cloned = res.clone();
        const data = await cloned.json();
        if (!Array.isArray(data)) {
          dedupError = new Error(
            `Database query at '${input}' returned invalid data: expected JSON array`,
          );
        }
      } catch (err) {
        dedupError = new Error(
          `Database query at '${input}' returned unparseable JSON: ${(err as Error).message}`,
        );
      }
      return res;
    };

    const venueMap = await fetchVenueMap({}, trackingFetch);
    if (dedupError) {
      throw dedupError;
    }
    const dbNames = Array.from(venueMap.values())
      .map((v) => v.name)
      .filter((n): n is string => Boolean(n));
    finalCandidates = dedupeVenues(regularVenues, dbNames);
    deduplicated = true;
  }

  finalCandidates.sort((a, b) => b.eventCount - a.eventCount);

  return {
    metro: targetMetro,
    sourceUrl,
    sourceType,
    rawCount: rawVenues.length,
    candidates: finalCandidates,
    cooldownStatus: targetMetro ? checkCooldown(targetMetro.lastSwept, options.now) : undefined,
    deduplicated,
  };
}

function printUsage() {
  console.log(`
venue-mining sweep: Mine live-music venues from supported SceneThink events publications.

Usage:
  deno task venue-mining:sweep [metro] [options]

Examples:
  deno task venue-mining:sweep charlottesville --force
  deno task venue-mining:sweep --url "http://events.c-ville.com/cville/search.json?category=13" --city Charlottesville --state VA
  deno task venue-mining:sweep --list

Options:
  -m, --metro <slug|name>   Target metro slug or name from sources.yaml
  -u, --url <url>           Direct calendar or API endpoint URL to sweep
  -c, --city <name>         Filter venues to target city
  -s, --state <code>        Filter venues to 2-letter state code (e.g. VA, NC, WV)
  -p, --pages <n>           Limit number of calendar pages to sweep
  --no-dedup                Skip deduplicating candidates against live database
  --force                   Bypass 6-month cooldown lock
  --json                    Output results as structured JSON
  --list                    List all registered metros and sweep status from sources.yaml
  -h, --help                Show this help message
`);
}

if (import.meta.main) {
  const flags = parseArgs(Deno.args, {
    boolean: ["help", "list", "no-dedup", "force", "json"],
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
      const cdInfo = cd.unparseable
        ? "[UNPARSEABLE lastSwept]"
        : cd.isLocked
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

  const rawPages = flags.pages || flags["page-limit"];
  let pageLimit: number | undefined;
  if (rawPages !== undefined) {
    const parsed = Number(rawPages);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error(`\nError: --pages must be a positive integer, got '${rawPages}'\n`);
      Deno.exit(1);
    }
    pageLimit = parsed;
  }

  const metroArg = flags.metro || (flags._[0] ? String(flags._[0]) : undefined);

  try {
    const result = await runSweep({
      metro: metroArg,
      url: flags.url,
      city: flags.city,
      state: flags.state,
      pageLimit,
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
      console.log(
        `Candidate venues${
          result.deduplicated ? "" : " (not deduplicated)"
        }: ${result.candidates.length}`,
      );

      console.log(`\n=== Top Candidates (${result.candidates.length}) ===`);
      for (const c of result.candidates.slice(0, 20)) {
        console.log(
          `- ${c.name} (${c.city || "Unknown"}, ${
            c.state || "Unknown"
          }) | events: ${c.eventCount} | addr: ${c.address || "none"} | phone: ${
            c.phone || "none"
          } | url: ${c.website || "none"}`,
        );
      }
    }
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}\n`);
    Deno.exit(1);
  }
}
