// src/accounting/mileage.ts
// The mileage log from the gig list (web-jam-tools#1767). Behaviour is set by "The mileage log" in
// the music-media design's "The accounting skill"; this file carries the mechanics only.
//
// - Gigs come from web-jam-back's public GET /gig and venues from its authenticated GET /venue,
//   with the token the book-gig scripts already use. A gig links to its venue by `venueId`, else by
//   the exact normalized-name rule shared with web-jam-back (src/book-gig/venue_link.ts).
// - The home map point is read from `home-point.json` in the private books folder, never from this
//   repository, and is never printed.
// - Each venue's driving miles are looked up once through the free OSRM routing service, as one
//   route from home to the venue and back home. A venue with no map pin is placed from its street
//   address by the free US Census geocoder, the same service web-jam-back uses for new pins. Each
//   lookup has a deadline, so a stalled service leaves the line with no miles instead of stopping
//   the log.
// - Each line holds the date, destination, purpose and miles, then the gig and venue record ids a
//   generated line came from. A log written before those two columns still reads; its gig lines
//   are matched to their gigs on the next run.
// - The log itself keeps every figure and every line. A line already holding miles is never looked
//   up again, and a new gig at a venue already in the log takes that venue's figure, so a figure
//   Josh corrected is kept. When the log holds different figures for one venue, none is carried
//   forward: the new line is left for Josh.
// - A gig with no venue record, a venue that cannot be placed on the map, a lookup the routing
//   service could not answer, and a gig that more than one line could be each leave the log as it
//   is for that gig and are listed for Josh.
// - The new log is staged in a temporary file, then, holding a lock that every mileage run takes,
//   the log is re-read and replaced. An edit saved, or another run's log published, since this run
//   read the log is never overwritten: the run refuses and writes nothing.
// - A blank line generated for a gig follows the venue its gig now links to, so a figure is always
//   saved under the venue it was looked up for. A blank line whose destination or purpose was
//   changed by hand is left as it is and listed for Josh.

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
export const MILEAGE_HEADER = ["date", "destination", "purpose", "miles", "gig", "venue"];
/** The first line of a log written before the gig and venue columns. */
const LEGACY_HEADER = MILEAGE_HEADER.slice(0, 4);
export const GIG_PURPOSE = "Gig performance (round trip)";
export const ROUTING_BASE_URL = "https://router.project-osrm.org";
export const GEOCODER_BASE_URL = "https://geocoding.geo.census.gov";
export const GIG_TIME_ZONE = "America/New_York";
/** How long one routing or geocoding request, its answer included, may take. */
export const LOOKUP_TIMEOUT_MS = 20_000;
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
  /** The gig record a generated line came from; empty for a drive Josh added. */
  gig?: string;
  /** The venue record of that gig; empty when there is none. */
  venue?: string;
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

/** Driving miles from home to the venue and back home, or null when there is no answer. */
export type RoundTripLookup = (home: HomePoint, venue: HomePoint) => Promise<number | null>;
export type VenueLocator = (venue: MileageVenue) => Promise<HomePoint | null>;

export interface BuildMileageOptions {
  year: number;
  /** Only gigs that started before this moment are logged. */
  now: Date;
  gigs: MileageGig[];
  venues: MileageVenue[];
  home: HomePoint;
  existing: MileageLine[];
  lookup: RoundTripLookup;
  /** Places a venue on the map; defaults to its stored pin only. */
  locate?: VenueLocator;
}

export interface BuildMileageResult {
  lines: MileageLine[];
  noVenueRecord: LineForJosh[];
  noMiles: LineForJosh[];
  /** Gigs that more than one line could be, whose lines were left as they are. */
  ambiguous: LineForJosh[];
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

/** The moment a gig starts, or null when it has no readable time. */
function gigStart(datetime: unknown): Date | null {
  if (datetime === undefined || datetime === null || datetime === "") return null;
  const when = new Date(datetime as string);
  return Number.isNaN(when.getTime()) ? null : when;
}

/** The gig's calendar date where it was played, as YYYY-MM-DD. */
export function gigLocalDate(datetime: unknown): string | null {
  const when = gigStart(datetime);
  if (!when) return null;
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
 * GETs a JSON answer within `timeoutMs`, the response body included. Null on any failure: an error
 * status, a network error, an unreadable body, or the deadline passing.
 */
async function fetchJsonWithin(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const answer = (async () => {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return await res.json();
  })().catch(() => null);
  try {
    return await Promise.race([answer, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A venue's stored pin, else its street address placed by the US Census geocoder (US addresses
 * only, as in web-jam-back's census-geocoder), else null.
 */
export function makeVenueLocator(
  fetchFn: typeof fetch = fetch,
  timeoutMs = LOOKUP_TIMEOUT_MS,
): VenueLocator {
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
    const data = await fetchJsonWithin(
      fetchFn,
      `${GEOCODER_BASE_URL}/geocoder/locations/address?${params}`,
      timeoutMs,
    ) as { result?: { addressMatches?: Array<{ coordinates?: { x?: unknown; y?: unknown } }> } };
    const coords = data?.result?.addressMatches?.[0]?.coordinates;
    const x = coords?.x;
    const y = coords?.y;
    if (
      typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) ||
      !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90
    ) return null;
    return { latitude: y, longitude: x };
  };
}

export function formatMiles(miles: number): string {
  return miles.toFixed(1);
}

/**
 * Round-trip driving miles: one ordered route from home to the venue and back home, so a return
 * leg that differs (one-way streets, turn restrictions) is counted as driven. Null when the
 * routing service gives no answer in time.
 */
export function makeRoutingLookup(
  fetchFn: typeof fetch = fetch,
  timeoutMs = LOOKUP_TIMEOUT_MS,
): RoundTripLookup {
  return async (home, venue) => {
    const homeAt = `${home.longitude},${home.latitude}`;
    const url =
      `${ROUTING_BASE_URL}/route/v1/driving/${homeAt};${venue.longitude},${venue.latitude};${homeAt}?overview=false`;
    const data = await fetchJsonWithin(fetchFn, url, timeoutMs) as {
      code?: unknown;
      routes?: Array<{ distance?: unknown }>;
    } | null;
    const meters = data?.code === "Ok" ? data?.routes?.[0]?.distance : undefined;
    if (typeof meters !== "number" || !Number.isFinite(meters) || meters <= 0) return null;
    return meters / METERS_PER_MILE;
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

/** Reads a log with the gig and venue columns, or one written before them. */
export function parseMileageLog(content: string): MileageLine[] {
  const rows = parseCsvRows(content);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase()).join(",");
  if (header !== MILEAGE_HEADER.join(",") && header !== LEGACY_HEADER.join(",")) {
    throw new Error(`The mileage log's first line must be "${MILEAGE_HEADER.join(",")}".`);
  }
  return rows.slice(1).map((r) => ({
    date: (r[0] ?? "").trim(),
    destination: (r[1] ?? "").trim(),
    purpose: (r[2] ?? "").trim(),
    miles: (r[3] ?? "").trim(),
    gig: (r[4] ?? "").trim(),
    venue: (r[5] ?? "").trim(),
  }));
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatMileageLog(lines: MileageLine[]): string {
  const out = [MILEAGE_HEADER.join(",")];
  for (const l of lines) {
    out.push(
      [l.date, l.destination, l.purpose, l.miles, l.gig ?? "", l.venue ?? ""].map(csvField).join(
        ",",
      ),
    );
  }
  return out.join("\n") + "\n";
}

interface PlayedGig {
  date: string;
  destination: string;
  venue?: MileageVenue;
  /** The gig's record id, else its date and venue. */
  id: string;
  /** The destination a line for this gig holds when no venue record is linked. */
  unlinked: string;
}

/** Merges the year's played gigs into the existing log; pure apart from the lookups it is given. */
export async function buildMileageLog(options: BuildMileageOptions): Promise<BuildMileageResult> {
  const { year, now, gigs, venues, home, existing, lookup } = options;
  const locate: VenueLocator = options.locate ?? ((venue) => Promise.resolve(venuePoint(venue)));

  // Every existing line is kept, in its own copy: two drives on one day to one place stay two.
  const lines: MileageLine[] = existing.map((l) => ({
    ...l,
    gig: l.gig ?? "",
    venue: l.venue ?? "",
  }));
  const linesByGig = new Map<string, MileageLine[]>();
  for (const line of lines) {
    if (line.gig) linesByGig.set(line.gig, [...(linesByGig.get(line.gig) ?? []), line]);
  }

  const venueById = new Map<string, MileageVenue>();
  for (const v of venues) {
    if (v && v._id !== undefined && v._id !== null) venueById.set(String(v._id), v);
  }
  const nameIndex = buildUnambiguousNameIndex(venues);

  const played: PlayedGig[] = gigs
    .flatMap((gig) => {
      const start = gigStart(gig.datetime);
      if (!start || start.getTime() > now.getTime()) return [];
      const date = gigLocalDate(start)!;
      if (!date.startsWith(`${year}-`)) return [];
      const venueId = resolveGigVenueId(gig, nameIndex);
      const venue = venueId ? venueById.get(venueId) : undefined;
      const unlinked = unlinkedDestination(gig);
      const destination = venue ? venueDestination(venue) : unlinked;
      const recordId = gig._id === undefined || gig._id === null ? "" : String(gig._id);
      const id = recordId || `${date} ${venue ? String(venue._id) : destination}`;
      return [{ date, destination, venue, id, unlinked }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // A gig line written before the gig column is matched to its gig by date and destination, only
  // when exactly one such line and exactly one such gig pair up. A drive Josh added under another
  // purpose is never taken for a gig.
  const unmatched = lines.filter((l) => !l.gig && l.purpose === GIG_PURPOSE);
  const candidates = new Map<PlayedGig, MileageLine[]>();
  const claims = new Map<MileageLine, number>();
  for (const gig of played) {
    if (linesByGig.has(gig.id)) continue;
    const found = unmatched.filter((l) => l.date === gig.date && l.destination === gig.destination);
    candidates.set(gig, found);
    for (const l of found) claims.set(l, (claims.get(l) ?? 0) + 1);
  }
  for (const [gig, found] of candidates) {
    if (found.length !== 1 || claims.get(found[0]) !== 1) continue;
    found[0].gig = gig.id;
    if (!found[0].venue && gig.venue) found[0].venue = String(gig.venue._id);
    linesByGig.set(gig.id, [found[0]]);
  }

  // Each venue's figures in the log, by venue record, so two venues sharing a name and city never
  // share a figure.
  const figures = new Map<string, Set<string>>();
  const addFigure = (venueId: string, miles: string) =>
    figures.set(venueId, new Set([...(figures.get(venueId) ?? []), miles]));
  for (const l of lines) if (l.venue && l.miles) addFigure(l.venue, l.miles);

  const outcomeByVenue = new Map<string, { miles: number } | { reason: string }>();
  const noVenueRecord: LineForJosh[] = [];
  const noMiles: LineForJosh[] = [];
  const ambiguous: LineForJosh[] = [];
  let lookups = 0;

  for (const gig of played) {
    const { date, destination, venue } = gig;
    const matched = linesByGig.get(gig.id);
    const found = candidates.get(gig) ?? [];
    if ((matched && matched.length > 1) || (!matched && found.length > 0)) {
      ambiguous.push({
        date,
        destination,
        reason: "more than one line in the log could be this gig, so they were left as they are",
      });
      continue;
    }
    let line = matched?.[0];
    if (line?.miles) continue;
    if (!line) {
      line = { date, destination, purpose: GIG_PURPOSE, miles: "", gig: gig.id, venue: "" };
      lines.push(line);
    }

    if (!venue) {
      noVenueRecord.push({ date, destination, reason: "no venue record for this gig" });
      continue;
    }

    const venueId = String(venue._id);
    if (line.venue !== venueId) {
      // The gig now links to another venue than the blank line records (a lookup failed, then the
      // gig was relinked). A line still as generated takes the new venue and its destination, so
      // the figure looked up below is saved under the venue it was looked up for. A line whose
      // destination or purpose Josh changed is his: it is left as it is.
      const previous = line.venue ? venueById.get(line.venue) : undefined;
      const generated = new Set([destination, gig.unlinked]);
      if (previous) generated.add(venueDestination(previous));
      if (line.purpose !== GIG_PURPOSE || !generated.has(line.destination)) {
        noMiles.push({
          date,
          destination: line.destination,
          reason:
            "this line was changed by hand and its gig now links to a different venue; set its venue and miles by hand",
        });
        continue;
      }
      line.venue = venueId;
      line.destination = destination;
    }
    const known = [...(figures.get(venueId) ?? [])];
    let miles = "";
    let reason = "";
    if (known.length === 1) {
      miles = known[0];
    } else if (known.length > 1) {
      reason = `the log holds different figures for this venue (${
        known.sort().join(", ")
      }); make those lines agree, then run again`;
    } else {
      let outcome = outcomeByVenue.get(venueId);
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
          const roundTrip = await lookup(home, point);
          outcome = roundTrip === null
            ? { reason: "the routing service gave no answer" }
            : { miles: roundTrip };
        }
        outcomeByVenue.set(venueId, outcome);
      }
      if ("miles" in outcome) {
        miles = formatMiles(outcome.miles);
        addFigure(venueId, miles);
      } else {
        reason = outcome.reason;
      }
    }

    line.miles = miles;
    if (!miles) noMiles.push({ date, destination, reason });
  }

  const sorted = [...lines].sort((a, b) =>
    a.date.localeCompare(b.date) || a.destination.localeCompare(b.destination)
  );
  return { lines: sorted, noVenueRecord, noMiles, ambiguous, lookups };
}

export interface RunMileageOptions extends BackendConfigOptions {
  year: number;
  booksDir: string;
  now?: Date;
  fetchFn?: typeof fetch;
  lookupTimeoutMs?: number;
}

export interface RunMileageResult extends BuildMileageResult {
  logPath: string;
}

async function readLogText(logPath: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(logPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/**
 * Runs `publish` while holding the log's lock, so two mileage runs never check and replace the log
 * at once. The lock is `<log>.lock` beside the log, held with an OS file lock and removed before it
 * is let go; a run that was waiting on a lock file already removed opens a fresh one and waits
 * again, so only one run ever holds the lock that is on disk.
 */
async function whileHoldingLogLock<T>(logPath: string, publish: () => Promise<T>): Promise<T> {
  const lockPath = `${logPath}.lock`;
  for (;;) {
    const lock = await Deno.open(lockPath, { create: true, write: true });
    let held = false;
    try {
      await lock.lock(true);
      const [onDisk, ours] = await Promise.all([
        Deno.stat(lockPath).catch(() => null),
        lock.stat(),
      ]);
      held = onDisk !== null && onDisk.ino === ours.ino && onDisk.dev === ours.dev;
      if (held) return await publish();
    } finally {
      if (held) await Deno.remove(lockPath).catch(() => {});
      lock.close();
    }
  }
}

export async function runMileage(options: RunMileageOptions): Promise<RunMileageResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  const logPath = mileageLogPath(options.booksDir, options.year);

  // Everything local is read and checked before any network call.
  const home = await readHomePoint(options.booksDir);
  const before = await readLogText(logPath);
  const existing = before === null ? [] : parseMileageLog(before);

  const { gigs, venues } = await fetchGigsAndVenues(options, fetchFn);
  const result = await buildMileageLog({
    year: options.year,
    now: options.now ?? new Date(),
    gigs,
    venues,
    home,
    existing,
    lookup: makeRoutingLookup(fetchFn, timeoutMs),
    locate: makeVenueLocator(fetchFn, timeoutMs),
  });

  // The new log is staged first, so the check below sits right before the replace. Under the lock,
  // an edit saved or another run's log published since this run read the log is kept: this run
  // writes nothing.
  const tmpPath = await Deno.makeTempFile({
    dir: options.booksDir,
    prefix: `mileage-${options.year}.`,
    suffix: ".tmp",
  });
  try {
    await Deno.writeTextFile(tmpPath, formatMileageLog(result.lines));
    await whileHoldingLogLock(logPath, async () => {
      if (await readLogText(logPath) !== before) {
        throw new Error(
          `${logPath} changed while the routes were being looked up, so nothing was written. Run again to add the gigs to the saved log.`,
        );
      }
      await Deno.rename(tmpPath, logPath);
    });
  } catch (err) {
    await Deno.remove(tmpPath).catch(() => {});
    throw err;
  }
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

Writes mileage-<year>.csv in the books folder (date, destination, purpose, miles, gig, venue).
Reads the home map point from ${HOME_POINT_FILE} in the books folder.`);
    return 0;
  }

  const year = flags.year ? Number(flags.year) : Number(gigLocalDate(new Date())!.slice(0, 4));
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
    printForJosh("Gigs more than one line could be, left as they are, for Josh", result.ambiguous);
    return 0;
  } catch (err) {
    console.error(`[accounting:mileage] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await runMileageCli(Deno.args));
}
