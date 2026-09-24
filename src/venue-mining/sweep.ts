// src/venue-mining/sweep.ts
// Generalized venue-mining sweeper supporting any city/metro area.
import { parse as parseYaml } from "@std/yaml";
import { parseArgs } from "@std/cli/parse-args";
import * as cheerio from "cheerio";
import { buildHeaders, fetchVenueMap, resolveBackendConfig } from "../book-gig/outreach_api.ts";

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
  publication?: MetroPublication | null;
  lastSwept?: string | Date | null;
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

export interface SweepHistoryRecord {
  _id?: string;
  metroSlug: string;
  sweptAt: string | Date;
  publication: MetroPublication;
  venuesCreatedCount: number;
  coverageArea?: string[];
  excludeKeywords?: string[];
  notes?: string;
  createdAt?: string | Date;
}

export interface SweepOptions {
  metro?: string;
  url?: string;
  type?: string;
  city?: string;
  state?: string;
  pageLimit?: number;
  noDedup?: boolean;
  force?: boolean;
  sourcesPath?: string;
  fetchFn?: typeof fetch;
  now?: Date;
  backendUrl?: string;
  token?: string;
  coverageArea?: string[];
  excludeKeywords?: string[];
}

export interface SweepResult {
  metro?: MetroEntry;
  sourceUrl: string;
  sourceType: string;
  /** Publication resolved from the newest sweep record; undefined when --url was given. */
  publication?: MetroPublication;
  rawCount: number;
  candidates: HarvestedVenue[];
  cooldownStatus?: CooldownStatus;
  deduplicated: boolean;
}

export interface MetroListEntry {
  slug: string;
  label: string;
  driveTier: string;
  lastSwept: string | Date | null;
  publication: MetroPublication | null;
  cooldownStatus: CooldownStatus;
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

export const SWEEP_HISTORY_TIMEOUT_MS = 30_000;

export async function fetchSweepHistory(options: {
  metroSlug?: string;
  backendUrl?: string;
  token?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<SweepHistoryRecord[]> {
  const config = await resolveBackendConfig({
    backendUrl: options.backendUrl,
    token: options.token,
  });
  const fetchFn = options.fetchFn || fetch;
  const headers = buildHeaders(config.token);

  let url = `${config.baseUrl}/venue-mining/sweep`;
  if (options.metroSlug) {
    url += `?metroSlug=${encodeURIComponent(options.metroSlug)}`;
  }

  let res: Response;
  try {
    res = await fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? SWEEP_HISTORY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `Sweep history query failed at '${url}': ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `Sweep history query failed with HTTP status ${res.status} at '${url}'`,
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(
      `Sweep history query at '${url}' returned unparseable JSON: ${(err as Error).message}`,
    );
  }

  if (!Array.isArray(data)) {
    throw new Error(
      `Sweep history query at '${url}' returned invalid data: expected JSON array`,
    );
  }

  return data as SweepHistoryRecord[];
}

export async function listMetros(options: {
  sourcesPath?: string;
  backendUrl?: string;
  token?: string;
  fetchFn?: typeof fetch;
  now?: Date;
} = {}): Promise<MetroListEntry[]> {
  const registry = await loadSourcesRegistry(options.sourcesPath);
  const allSweeps = await fetchSweepHistory({
    backendUrl: options.backendUrl,
    token: options.token,
    fetchFn: options.fetchFn,
  });

  const newestMap = new Map<string, SweepHistoryRecord>();
  for (const sweep of allSweeps) {
    if (!newestMap.has(sweep.metroSlug)) {
      newestMap.set(sweep.metroSlug, sweep);
    }
  }

  return registry.metros.map((m) => {
    const newest = newestMap.get(m.slug);
    const lastSwept = newest ? newest.sweptAt : null;
    const publication = newest ? newest.publication : null;
    const cooldownStatus = checkCooldown(lastSwept, options.now);
    return {
      slug: m.slug,
      label: m.label,
      driveTier: m.driveTier,
      lastSwept,
      publication,
      cooldownStatus,
    };
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

export function parseDateHeader(header: string): string {
  const m = header.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return "";
  const months: Record<string, string> = {
    January: "01",
    February: "02",
    March: "03",
    April: "04",
    May: "05",
    June: "06",
    July: "07",
    August: "08",
    September: "09",
    October: "10",
    November: "11",
    December: "12",
  };
  const month = months[m[1]];
  if (!month) return "";
  const day = m[2].padStart(2, "0");
  const year = m[3];
  return `${year}-${month}-${day}`;
}

function cleanHtmlText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim();
}

/**
 * Parses Charlotte on the Cheap's events markup (both card and table event formats)
 * into the canonical HarvestedVenue[] shape.
 */
export function parseCharlotteOnTheCheapHtml(
  html: string,
  sinceDate?: string | Date | null,
): HarvestedVenue[] {
  const $ = cheerio.load(html);
  const venuesMap = new Map<string, HarvestedVenue>();
  let currentDate = "";

  const rawSince = sinceDate instanceof Date
    ? (Number.isNaN(sinceDate.getTime()) ? null : sinceDate.toISOString().slice(0, 10))
    : (typeof sinceDate === "string" && !Number.isNaN(new Date(sinceDate).getTime())
      ? sinceDate.slice(0, 10)
      : null);

  const addEvent = (title: string, rawLoc: string, date: string) => {
    if (!title || !rawLoc) return;
    const rawLocLower = rawLoc.toLowerCase();
    if (
      rawLocLower === "various locations" ||
      rawLocLower.includes("participating locations") ||
      rawLocLower === "charlotte" ||
      rawLocLower === "virtual" ||
      rawLocLower.includes("online event")
    ) {
      return;
    }

    if (rawSince && date && date <= rawSince) {
      return;
    }

    let name = rawLoc;
    let city = "Charlotte";
    let state = "NC";

    const stMatch = name.match(/,\s*([A-Z]{2})$/);
    if (stMatch) {
      state = stMatch[1];
      name = name.slice(0, stMatch.index).trim();
    }

    const commaIdx = name.lastIndexOf(",");
    if (commaIdx > 0) {
      const possibleCity = name.slice(commaIdx + 1).trim();
      const possibleVenue = name.slice(0, commaIdx).trim();
      if (possibleCity.length >= 3 && !/\d/.test(possibleCity)) {
        city = possibleCity;
        name = possibleVenue;
      }
    }

    const nameKey = name.toLowerCase().replace(/['’]/g, "").trim();
    if (!nameKey) return;

    if (!venuesMap.has(nameKey)) {
      venuesMap.set(nameKey, {
        name,
        city,
        state,
        eventCount: 0,
        events: [],
      });
    }

    const existing = venuesMap.get(nameKey)!;
    existing.eventCount++;
    if (existing.events.length < 5) {
      existing.events.push({
        title: title || "Live Event",
        date,
      });
    }
  };

  $("h2.lotc-event, div.row.event").each((_, el) => {
    if ($(el).is("h2.lotc-event")) {
      currentDate = parseDateHeader($(el).text().trim());
    } else if ($(el).is("div.row.event")) {
      const table = $(el).find("table.table-events");
      if (table.length > 0) {
        table.find("tbody tr").each((_, tr) => {
          const tds = $(tr).find("td");
          if (tds.length >= 4) {
            const title = cleanHtmlText(
              $(tds[0]).find("a").text() || $(tds[0]).text(),
            );
            const rawLoc = cleanHtmlText($(tds[3]).text());
            addEvent(title, rawLoc, currentDate);
          }
        });
      } else {
        const title = cleanHtmlText(
          $(el).find("h3 a").text() || $(el).find("h3").text(),
        );
        const meta = $(el).find("p.meta").text();
        const parts = meta.split("|").map((p) => cleanHtmlText(p)).filter(Boolean);
        const rawLoc = parts.length > 0 ? parts[parts.length - 1] : "";
        addEvent(title, rawLoc, currentDate);
      }
    }
  });

  return Array.from(venuesMap.values());
}

/**
 * Fetches and parses Charlotte on the Cheap events calendar into HarvestedVenue[] shape.
 */
export async function fetchCharlotteOnTheCheapEvents(
  sourceUrl: string,
  fetchFn: typeof fetch = fetch,
  pageLimit?: number,
  sinceDate?: string | Date | null,
): Promise<HarvestedVenue[]> {
  if (pageLimit !== undefined && pageLimit > 1) {
    console.warn(
      `Charlotte on the Cheap: only the first events page is read; --pages ${pageLimit} has no effect.`,
    );
  }
  let targetUrl = sourceUrl;
  try {
    const parsed = new URL(sourceUrl);
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/events/";
      targetUrl = parsed.toString();
    }
  } catch {
    // If not a valid URL, leave targetUrl unchanged
  }

  let res: Response;
  try {
    res = await fetchFn(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  } catch (err) {
    throw new Error(`Failed to fetch events from '${targetUrl}': ${(err as Error).message}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP error ${res.status} fetching events from '${targetUrl}'`);
  }

  const html = await res.text();
  return parseCharlotteOnTheCheapHtml(html, sinceDate);
}

export type EventParserFn = (
  sourceUrl: string,
  fetchFn?: typeof fetch,
  pageLimit?: number,
  sinceDate?: string | Date | null,
) => Promise<HarvestedVenue[]>;

export const EVENT_PARSER_REGISTRY: Record<string, EventParserFn> = {
  scenethink: fetchSceneThinkEvents,
  charlotteonthecheap: fetchCharlotteOnTheCheapEvents,
  "charlotte-on-the-cheap": fetchCharlotteOnTheCheapEvents,
};

/** Names every registered parser type, for errors that refuse an unsupported one. */
function supportedTypesNote(): string {
  return `Supported types: ${Object.keys(EVENT_PARSER_REGISTRY).join(", ")}.`;
}

export function registerEventParser(type: string, parser: EventParserFn): void {
  EVENT_PARSER_REGISTRY[type.toLowerCase().trim()] = parser;
}

export function getEventParser(
  sourceType: string,
  sourceUrl?: string,
): EventParserFn | undefined {
  const normType = sourceType.toLowerCase().trim();
  if (normType in EVENT_PARSER_REGISTRY) {
    return EVENT_PARSER_REGISTRY[normType];
  }
  // The live sweep history records the `charlotte` metro's Charlotte on the Cheap publication as
  // the generic `type: "html"`, so that record reaches this parser by its URL. Every other
  // `html` publication (e.g. Visit Damascus) still has no parser and is refused.
  if (normType === "html" && sourceUrl && /charlotteonthecheap\.com/i.test(sourceUrl)) {
    return fetchCharlotteOnTheCheapEvents;
  }
  return undefined;
}

export async function harvestEvents(
  sourceUrl: string,
  sourceType: string = "scenethink",
  fetchFn: typeof fetch = fetch,
  pageLimit?: number,
  sinceDate?: string | Date | null,
): Promise<HarvestedVenue[]> {
  const parser = getEventParser(sourceType, sourceUrl);
  if (!parser) {
    throw new Error(
      `Unsupported publication type '${sourceType}'. ${supportedTypesNote()}`,
    );
  }
  return await parser(sourceUrl, fetchFn, pageLimit, sinceDate);
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
  let sourceType = options.type || "scenethink";
  let publication: MetroPublication | undefined;
  let lastSwept: string | Date | null = null;
  let activeCoverageArea: string[] | undefined = options.coverageArea;
  let activeExcludeKeywords: string[] | undefined = options.excludeKeywords;
  let cooldownStatus: CooldownStatus | undefined;

  if (targetMetro) {
    // Fail closed: sweep history query failure throws immediately and is NOT bypassed by --force
    const history = await fetchSweepHistory({
      metroSlug: targetMetro.slug,
      backendUrl: options.backendUrl,
      token: options.token,
      fetchFn,
    });

    const newestRecord = history.length > 0 ? history[0] : null;
    lastSwept = newestRecord?.sweptAt || null;
    cooldownStatus = checkCooldown(lastSwept, options.now);

    if (cooldownStatus.unparseable) {
      if (!options.force) {
        throw new Error(
          `Sweep refused for metro '${targetMetro.slug}': 'lastSwept' field value '${lastSwept}' is unparseable as a date. Pass --force to override.`,
        );
      }
    } else if (cooldownStatus.isLocked && !options.force) {
      throw new Error(
        `Sweep refused for metro '${targetMetro.slug}': 6-month cooldown active (${cooldownStatus.daysRemaining} days remaining, unlocks ${cooldownStatus.unlockDate}). Pass --force to override.`,
      );
    }

    if (!sourceUrl && newestRecord?.publication) {
      const effectiveType = options.type || newestRecord.publication.type;
      if (!effectiveType) {
        throw new Error(
          `Metro '${targetMetro.slug}' has publication '${newestRecord.publication.name}' with missing type. Pass --type to choose a parser. ${supportedTypesNote()}`,
        );
      }
      const candidateUrl = newestRecord.publication.api || newestRecord.publication.url;
      const parser = getEventParser(effectiveType, candidateUrl);
      if (!parser) {
        throw new Error(
          `Metro '${targetMetro.slug}' has unsupported publication type '${effectiveType}'. ${supportedTypesNote()}`,
        );
      }
      sourceUrl = candidateUrl;
      sourceType = effectiveType;
      publication = newestRecord.publication;
    }

    if (!activeCoverageArea || activeCoverageArea.length === 0) {
      activeCoverageArea = newestRecord?.coverageArea;
    }
    if (!activeExcludeKeywords || activeExcludeKeywords.length === 0) {
      activeExcludeKeywords = newestRecord?.excludeKeywords;
    }
  }

  if (!sourceUrl) {
    if (targetMetro) {
      throw new Error(
        `Metro '${targetMetro.slug}' has no publication configured in sweep history. Discovering the local events publication is step one. Pass --url <calendar-url> to sweep directly.`,
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
    lastSwept,
  );

  // Filter out non-music entities
  const musicVenues = rawVenues.filter((v) => !isNonMusicEntity(v.name, activeExcludeKeywords));

  // Geographic filtering
  const targetMetroForGeo = targetMetro
    ? {
      slug: targetMetro.slug,
      label: targetMetro.label,
      coverageArea: activeCoverageArea,
    }
    : undefined;

  const localVenues = musicVenues.filter((v) =>
    isLocalArea(v.city, v.state, targetMetroForGeo, options.city, options.state)
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

    const venueMap = await fetchVenueMap(
      { backendUrl: options.backendUrl, token: options.token },
      trackingFetch,
    );
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
    metro: targetMetro
      ? {
        ...targetMetro,
        lastSwept,
        coverageArea: activeCoverageArea,
        excludeKeywords: activeExcludeKeywords,
      }
      : undefined,
    sourceUrl,
    sourceType,
    publication,
    rawCount: rawVenues.length,
    candidates: finalCandidates,
    cooldownStatus,
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
  -m, --metro <slug|name>     Target metro slug or name from sources.yaml
  -u, --url <url>             Direct calendar or API endpoint URL to sweep
  -t, --type <type>           Publication format type (e.g. scenethink, charlotteonthecheap)
  -c, --city <name>           Filter venues to target city
  -s, --state <code>          Filter venues to 2-letter state code (e.g. VA, NC, WV)
  -p, --pages <n>             Limit number of calendar pages to sweep
  --coverage-area <towns>     Override coverage area with comma-separated list of towns
  --exclude-keywords <words>  Override non-music exclude keywords with comma-separated list
  --no-dedup                  Skip deduplicating candidates against live database
  --force                     Bypass 6-month cooldown lock (does NOT bypass API failure)
  --json                      Output results as structured JSON
  --list                      List all registered metros and sweep status from database
  --backend-url <url>         Backend base URL (default: WEB_JAM_BACK_URL or production)
  --token <token>             Auth Bearer token (default: WEB_JAM_LLM_TOKEN or local file)
  -h, --help                  Show this help message
`);
}

function parseList(val: unknown): string[] | undefined {
  if (typeof val !== "string" || !val.trim()) return undefined;
  return val.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

if (import.meta.main) {
  const flags = parseArgs(Deno.args, {
    boolean: ["help", "list", "no-dedup", "force", "json"],
    string: [
      "metro",
      "url",
      "type",
      "city",
      "state",
      "pages",
      "page-limit",
      "sources",
      "coverage-area",
      "exclude-keywords",
      "backend-url",
      "token",
    ],
    alias: {
      h: "help",
      m: "metro",
      u: "url",
      t: "type",
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
    try {
      const metros = await listMetros({
        sourcesPath: flags.sources,
        backendUrl: flags["backend-url"],
        token: flags.token,
      });
      console.log(`\nRegistered Metros (${metros.length}):\n`);
      for (const m of metros) {
        const cd = m.cooldownStatus;
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
    } catch (err) {
      console.error(`\nError listing metros: ${(err as Error).message}\n`);
      Deno.exit(1);
    }
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
      type: flags.type,
      city: flags.city,
      state: flags.state,
      pageLimit,
      noDedup: flags["no-dedup"],
      force: flags.force,
      sourcesPath: flags.sources,
      coverageArea: parseList(flags["coverage-area"]),
      excludeKeywords: parseList(flags["exclude-keywords"]),
      backendUrl: flags["backend-url"],
      token: flags.token,
    });

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const metroLabel = result.metro
        ? `${result.metro.label} (${result.metro.slug})`
        : "Ad-hoc URL";
      console.log(`\nSwept: ${metroLabel}`);
      console.log(`Source: ${result.sourceUrl}`);
      // Settings this run used — pass them to venue-mining:record-sweep.
      if (result.publication) {
        const p = result.publication;
        console.log(
          `Publication: ${p.name} | url: ${p.url} | api: ${p.api || "none"} | type: ${
            p.type || "none"
          }`,
        );
      }
      if (result.metro) {
        console.log(`Coverage area: ${result.metro.coverageArea?.join(",") || "none"}`);
        console.log(`Exclude keywords: ${result.metro.excludeKeywords?.join(",") || "none"}`);
      }
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
