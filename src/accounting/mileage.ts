// src/accounting/mileage.ts
// The mileage log from the gig list (web-jam-tools#1767). Behaviour is set by "The mileage log" in
// the music-media design's "The accounting skill"; this file carries the mechanics only.
//
// - Gigs come from web-jam-back's public GET /gig and venues from its authenticated GET /venue,
//   with the token the book-gig scripts already use. A gig links to its venue by `venueId`, else by
//   the exact normalized-name rule shared with web-jam-back (src/book-gig/venue_link.ts).
// - The home map point is read from `home-point.json` in the private books folder, never from this
//   repository, and is never printed.
// - Each venue's driving miles are looked up once through the free OSRM routing service. A line is
//   the round trip, home to the venue and back. A venue with no map pin is placed from its street
//   address by the free US Census geocoder, the same service web-jam-back uses for new pins.
// - The log itself keeps every figure: a line already holding miles is never looked up again, and
//   a new gig at a destination already in the log takes that destination's figure, so a figure Josh
//   corrected in the log is kept.
// - A gig with no venue record, a venue that cannot be placed on the map, and a lookup the routing
//   service could not answer each leave the line with no miles and are listed for Josh.

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import { expandHome } from "../design-issue/gate1.ts";
import {
  type BackendConfigOptions,
  buildHeaders,
  resolveBackendConfig,
} from "../book-gig/outreach_api.ts";
import {
  buildUnambiguousNameIndex,
  decodeHtmlEntities,
  type LinkableGig,
  type LinkableVenue,
  resolveGigVenueId,
} from "../book-gig/venue_link.ts";
import { parseCsvRows } from "./import.ts";

export const HOME_POINT_FILE = "home-point.json";
export const MILEAGE_HEADER = ["date", "destination", "purpose", "miles"];
export const GIG_PURPOSE = "Gig performance (round trip)";
export const ROUTING_BASE_URL = "https://router.project-osrm.org";
export const GEOCODER_BASE_URL = "https://geocoding.geo.census.gov";
export const GIG_TIME_ZONE = "America/New_York";
const METERS_PER_MILE = 1609.344;

export interface HomePoint {
  latitude: number;
  longitude: number;
}

export interface MileageLine {
  date: string;
  destination: string;
  purpose: string;
  miles: string;
}

export interface LineForJosh {
  date: string;
  destination: string;
  reason: string;
}

export interface MileageGig extends LinkableGig {
  city?: string;
  usState?: string;
}

export interface MileageVenue extends LinkableVenue {
  address?: string;
  city?: string;
  usState?: string;
  zipCode?: string;
  country?: string;
  location?: { type?: string; coordinates?: unknown };
}

export type OneWayLookup = (home: HomePoint, venue: HomePoint) => Promise<number | null>;
export type VenueLocator = (venue: MileageVenue) => Promise<HomePoint | null>;

export interface BuildMileageOptions {
  year: number;
  today: string;
  gigs: MileageGig[];
  venues: MileageVenue[];
  home: HomePoint;
  existing: MileageLine[];
  lookup: OneWayLookup;
  /** Places a venue on the map; defaults to its stored pin only. */
  locate?: VenueLocator;
}

export interface BuildMileageResult {
  lines: MileageLine[];
  noVenueRecord: LineForJosh[];
  noMiles: LineForJosh[];
  lookups: number;
}

export function getDefaultBooksDir(): string {
  const home = Deno.env.get("HOME") || "/home/joshua";
  return path.join(home, "Dropbox", "web-jam-llms", "financial", "books");
}

export function mileageLogPath(booksDir: string, year: number): string {
  return path.join(booksDir, `mileage-${year}.csv`);
}

/** Reads the home map point from the books folder, refusing anything but two in-range numbers. */
export async function readHomePoint(booksDir: string): Promise<HomePoint> {
  const file = path.join(booksDir, HOME_POINT_FILE);
  let raw: string;
  try {
    raw = await Deno.readTextFile(file);
  } catch {
    throw new Error(
      `Cannot read the home map point at ${file}. Create it holding {"latitude": <number>, "longitude": <number>}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
  const { latitude, longitude } = (parsed ?? {}) as Record<string, unknown>;
  if (
    typeof latitude !== "number" || typeof longitude !== "number" ||
    !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 || Math.abs(longitude) > 180
  ) {
    throw new Error(
      `${file} must hold a numeric "latitude" (-90 to 90) and "longitude" (-180 to 180).`,
    );
  }
  return { latitude, longitude };
}

/** The gig's calendar date where it was played, as YYYY-MM-DD. */
export function gigLocalDate(datetime: unknown): string | null {
  if (datetime === undefined || datetime === null || datetime === "") return null;
  const when = new Date(datetime as string);
  if (Number.isNaN(when.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: GIG_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

function plainText(html: string | undefined): string {
  return decodeHtmlEntities((html || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function joinPlace(parts: Array<string | undefined>): string {
  return parts.map((p) => (p || "").trim()).filter(Boolean).join(", ");
}

export function venueDestination(venue: MileageVenue): string {
  return joinPlace([plainText(venue.name), venue.city, venue.usState]);
}

function unlinkedDestination(gig: MileageGig): string {
  return joinPlace([plainText(gig.venue), gig.city, gig.usState]) || "(gig with no venue named)";
}

export function venuePoint(venue: MileageVenue): HomePoint | null {
  const loc = venue.location;
  if (!loc || loc.type !== "Point" || !Array.isArray(loc.coordinates)) return null;
  const [longitude, latitude] = loc.coordinates;
  if (typeof longitude !== "number" || typeof latitude !== "number") return null;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return { latitude, longitude };
}

/**
 * A venue's stored pin, else its street address placed by the US Census geocoder (US addresses
 * only, as in web-jam-back's census-geocoder), else null.
 */
export function makeVenueLocator(fetchFn: typeof fetch = fetch): VenueLocator {
  return async (venue) => {
    const pinned = venuePoint(venue);
    if (pinned) return pinned;
    const street = (venue.address || "").trim();
    const country = (venue.country || "US").trim().toUpperCase();
    if (!street || country !== "US") return null;
    const params = new URLSearchParams({
      street,
      city: (venue.city || "").trim(),
      state: (venue.usState || "").trim(),
      zip: (venue.zipCode || "").trim(),
      benchmark: "Public_AR_Current",
      format: "json",
    });
    try {
      const res = await fetchFn(`${GEOCODER_BASE_URL}/geocoder/locations/address?${params}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const data = await res.json();
      const coords = data?.result?.addressMatches?.[0]?.coordinates;
      const x = coords?.x;
      const y = coords?.y;
      if (
        typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) ||
        !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90
      ) return null;
      return { latitude: y, longitude: x };
    } catch {
      return null;
    }
  };
}

export function formatMiles(miles: number): string {
  return miles.toFixed(1);
}

/** One-way driving miles from home to a point, or null when the routing service gives no answer. */
export function makeRoutingLookup(fetchFn: typeof fetch = fetch): OneWayLookup {
  return async (home, venue) => {
    const url =
      `${ROUTING_BASE_URL}/route/v1/driving/${home.longitude},${home.latitude};${venue.longitude},${venue.latitude}?overview=false`;
    try {
      const res = await fetchFn(url, { method: "GET", headers: { Accept: "application/json" } });
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const data = await res.json();
      const meters = data?.code === "Ok" ? data?.routes?.[0]?.distance : undefined;
      if (typeof meters !== "number" || !Number.isFinite(meters) || meters <= 0) return null;
      return meters / METERS_PER_MILE;
    } catch {
      return null;
    }
  };
}

async function fetchJsonArray(
  url: string,
  headers: Record<string, string>,
  what: string,
  fetchFn: typeof fetch,
): Promise<unknown[]> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: "GET", headers });
  } catch (err) {
    throw new Error(`Could not read ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Could not read ${what}: HTTP ${res.status}.`);
  }
  const data = await res.json().catch(() => null);
  if (!Array.isArray(data)) throw new Error(`Could not read ${what}: the answer was not a list.`);
  return data;
}

export async function fetchGigsAndVenues(
  options: BackendConfigOptions,
  fetchFn: typeof fetch = fetch,
): Promise<{ gigs: MileageGig[]; venues: MileageVenue[] }> {
  const { baseUrl, token } = await resolveBackendConfig(options);
  if (!token) {
    throw new Error(
      "No web-jam-back token found (WEB_JAM_LLM_TOKEN or ~/Dropbox/web-jam-llms/web-jam-llm.token).",
    );
  }
  const headers = buildHeaders(token);
  const gigs = await fetchJsonArray(`${baseUrl}/gig`, headers, "the gig list", fetchFn);
  const venues = await fetchJsonArray(`${baseUrl}/venue`, headers, "the venue list", fetchFn);
  return { gigs: gigs as MileageGig[], venues: venues as MileageVenue[] };
}

export function parseMileageLog(content: string): MileageLine[] {
  const rows = parseCsvRows(content);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  if (header.join(",") !== MILEAGE_HEADER.join(",")) {
    throw new Error(`The mileage log's first line must be "${MILEAGE_HEADER.join(",")}".`);
  }
  return rows.slice(1).map((r) => ({
    date: (r[0] ?? "").trim(),
    destination: (r[1] ?? "").trim(),
    purpose: (r[2] ?? "").trim(),
    miles: (r[3] ?? "").trim(),
  }));
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatMileageLog(lines: MileageLine[]): string {
  const out = [MILEAGE_HEADER.join(",")];
  for (const l of lines) {
    out.push([l.date, l.destination, l.purpose, l.miles].map(csvField).join(","));
  }
  return out.join("\n") + "\n";
}

function lineKey(date: string, destination: string): string {
  return `${date}\u0000${destination}`;
}

/** Merges the year's played gigs into the existing log; pure apart from the lookup it is given. */
export async function buildMileageLog(options: BuildMileageOptions): Promise<BuildMileageResult> {
  const { year, today, gigs, venues, home, existing, lookup } = options;
  const locate: VenueLocator = options.locate ?? ((venue) => Promise.resolve(venuePoint(venue)));

  const lines = new Map<string, MileageLine>();
  const figureByDestination = new Map<string, { date: string; miles: string }>();
  for (const line of existing) {
    lines.set(lineKey(line.date, line.destination), line);
    if (line.miles) {
      const known = figureByDestination.get(line.destination);
      if (!known || line.date >= known.date) {
        figureByDestination.set(line.destination, { date: line.date, miles: line.miles });
      }
    }
  }

  const venueById = new Map<string, MileageVenue>();
  for (const v of venues) {
    if (v && v._id !== undefined && v._id !== null) venueById.set(String(v._id), v);
  }
  const nameIndex = buildUnambiguousNameIndex(venues);

  const outcomeByVenue = new Map<string, { oneWay: number } | { reason: string }>();
  const noVenueRecord: LineForJosh[] = [];
  const noMiles: LineForJosh[] = [];
  let lookups = 0;

  const played = gigs
    .map((gig) => ({ gig, date: gigLocalDate(gig.datetime) }))
    .filter((g): g is { gig: MileageGig; date: string } =>
      g.date !== null && g.date.startsWith(`${year}-`) && g.date <= today
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const { gig, date } of played) {
    const venueId = resolveGigVenueId(gig, nameIndex);
    const venue = venueId ? venueById.get(venueId) : undefined;
    const destination = venue ? venueDestination(venue) : unlinkedDestination(gig);
    const key = lineKey(date, destination);
    const existingLine = lines.get(key);

    if (existingLine?.miles) continue;

    if (!venue) {
      lines.set(key, existingLine ?? { date, destination, purpose: GIG_PURPOSE, miles: "" });
      noVenueRecord.push({ date, destination, reason: "no venue record for this gig" });
      continue;
    }

    let miles = figureByDestination.get(destination)?.miles ?? "";
    let reason = "";
    if (!miles) {
      const id = String(venue._id);
      let outcome = outcomeByVenue.get(id);
      if (!outcome) {
        const point = await locate(venue);
        if (!point) {
          outcome = {
            reason: (venue.address || "").trim()
              ? "the venue's street address could not be placed on the map"
              : "the venue record has no map pin or street address",
          };
        } else {
          lookups++;
          const oneWay = await lookup(home, point);
          outcome = oneWay === null ? { reason: "the routing service gave no answer" } : { oneWay };
        }
        outcomeByVenue.set(id, outcome);
      }
      if ("oneWay" in outcome) {
        miles = formatMiles(outcome.oneWay * 2);
        figureByDestination.set(destination, { date, miles });
      } else {
        reason = outcome.reason;
      }
    }

    lines.set(key, {
      date,
      destination,
      purpose: existingLine?.purpose || GIG_PURPOSE,
      miles,
    });
    if (!miles) noMiles.push({ date, destination, reason });
  }

  const sorted = [...lines.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.destination.localeCompare(b.destination)
  );
  return { lines: sorted, noVenueRecord, noMiles, lookups };
}

export interface RunMileageOptions extends BackendConfigOptions {
  year: number;
  booksDir: string;
  today?: string;
  fetchFn?: typeof fetch;
}

export interface RunMileageResult extends BuildMileageResult {
  logPath: string;
}

export async function runMileage(options: RunMileageOptions): Promise<RunMileageResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const today = options.today ?? gigLocalDate(new Date())!;
  const logPath = mileageLogPath(options.booksDir, options.year);

  // Everything local is read and checked before any network call.
  const home = await readHomePoint(options.booksDir);
  let existing: MileageLine[] = [];
  try {
    existing = parseMileageLog(await Deno.readTextFile(logPath));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  const { gigs, venues } = await fetchGigsAndVenues(options, fetchFn);
  const result = await buildMileageLog({
    year: options.year,
    today,
    gigs,
    venues,
    home,
    existing,
    lookup: makeRoutingLookup(fetchFn),
    locate: makeVenueLocator(fetchFn),
  });

  const tmpPath = `${logPath}.tmp`;
  await Deno.writeTextFile(tmpPath, formatMileageLog(result.lines));
  await Deno.rename(tmpPath, logPath);
  return { ...result, logPath };
}

function printForJosh(title: string, items: LineForJosh[]): void {
  if (items.length === 0) return;
  console.log(`\n${title}:`);
  for (const i of items) console.log(`- ${i.date} ${i.destination}: ${i.reason}`);
}

export async function runMileageCli(args: string[]): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["help"],
    string: ["year", "books-dir"],
    alias: { h: "help", y: "year" },
  });
  if (flags.help) {
    console.log(`Build the year's mileage log from the gig list.

Usage:
  deno task accounting:mileage [--year <year>] [--books-dir <dir>]

Writes mileage-<year>.csv in the books folder (date, destination, purpose, miles).
Reads the home map point from ${HOME_POINT_FILE} in the books folder.`);
    return 0;
  }

  const year = flags.year ? Number(flags.year) : new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    console.error("Error: --year must be a four-digit year.");
    return 1;
  }
  const booksDir = flags["books-dir"]
    ? path.resolve(expandHome(flags["books-dir"]))
    : getDefaultBooksDir();

  try {
    const result = await runMileage({ year, booksDir });
    const withMiles = result.lines.filter((l) => l.miles).length;
    console.log(
      `[accounting:mileage] Wrote ${result.lines.length} line(s) to ${result.logPath} (${withMiles} with miles, ${result.lookups} routing lookup(s)).`,
    );
    printForJosh("Gigs with no venue record, for Josh", result.noVenueRecord);
    printForJosh("Lines left with no miles, for Josh", result.noMiles);
    return 0;
  } catch (err) {
    console.error(`[accounting:mileage] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await runMileageCli(Deno.args));
}
