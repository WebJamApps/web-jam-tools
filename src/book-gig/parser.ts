// src/book-gig/parser.ts — Natural date and location parser for /book-gig

import type {
  BookGigMode,
  CandidateVenue,
  ParsedBookGigArgs,
  TargetLocation,
  TargetWeekend,
} from "./types.ts";

export type { ParsedBookGigArgs };

/**
 * Match a candidate venue against a list of filter IDs or names (case-insensitive, normalized).
 */
export function matchesVenueFilter(venue: CandidateVenue, filterList: string[]): boolean {
  if (!filterList || filterList.length === 0) return false;
  const vId = (venue._id || "").toLowerCase().trim();
  const vName = (venue.name || "").toLowerCase().trim();
  const vNameClean = vName.replace(/[^a-z0-9]/g, "");

  return filterList.some((filterItem) => {
    const item = filterItem.toLowerCase().trim();
    if (!item) return false;
    if (vId === item || vName === item) return true;
    const itemClean = item.replace(/[^a-z0-9]/g, "");
    if (itemClean && itemClean === vNameClean) return true;
    return false;
  });
}

/**
 * Split command-line tokens into mode, target weekend, optional location, and venue filters.
 * Examples:
 *   ["--send", "Oct 16-18 2026", "Lynchburg, VA", "--venues", "id1,id2"]
 *   ["--send", "Oct 16-18 2026", "--skip", "id3"]
 *   ["--replies", "Oct 16-18 2026"]
 *   ["--check-replies"]
 *   ["Oct", "16-18", "2026", "Lynchburg,", "VA"]
 *   ["2026-10-16", "24502"]
 */
export function parseBookGigArgs(args: string[]): ParsedBookGigArgs {
  if (!args || args.length === 0) {
    return { mode: "preview", rawArgs: "" };
  }

  let mode: BookGigMode = "preview";
  let noOpen = false;
  let linkVenueName: string | undefined;
  let explicitLocationStr: string | undefined;
  const includeVenues: string[] = [];
  const excludeVenues: string[] = [];
  const positionalArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i].trim();
    if (!arg) continue;
    const lower = arg.toLowerCase();

    if (lower === "--send") {
      mode = "send";
    } else if (lower === "--replies" || lower === "--check-replies") {
      mode = "replies";
    } else if (lower === "--link-gig" || lower === "--link") {
      mode = "link-gig";
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        i++;
        linkVenueName = args[i].trim();
      }
    } else if (lower.startsWith("--link-gig=") || lower.startsWith("--link=")) {
      mode = "link-gig";
      const eqIdx = arg.indexOf("=");
      linkVenueName = arg.slice(eqIdx + 1).trim();
    } else if (lower === "--no-open") {
      noOpen = true;
    } else if (lower === "--cities" || lower === "--locations" || lower === "--location") {
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        i++;
        explicitLocationStr = args[i];
      }
    } else if (
      lower.startsWith("--cities=") ||
      lower.startsWith("--locations=") ||
      lower.startsWith("--location=")
    ) {
      const eqIdx = arg.indexOf("=");
      explicitLocationStr = arg.slice(eqIdx + 1);
    } else if (lower === "--venues" || lower === "--include") {
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        i++;
        const vals = args[i].split(",").map((s) => s.trim()).filter(Boolean);
        includeVenues.push(...vals);
      }
    } else if (lower.startsWith("--venues=") || lower.startsWith("--include=")) {
      const eqIdx = arg.indexOf("=");
      const valStr = arg.slice(eqIdx + 1);
      const vals = valStr.split(",").map((s) => s.trim()).filter(Boolean);
      includeVenues.push(...vals);
    } else if (lower === "--skip" || lower === "--exclude") {
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        i++;
        const vals = args[i].split(",").map((s) => s.trim()).filter(Boolean);
        excludeVenues.push(...vals);
      }
    } else if (lower.startsWith("--skip=") || lower.startsWith("--exclude=")) {
      const eqIdx = arg.indexOf("=");
      const valStr = arg.slice(eqIdx + 1);
      const vals = valStr.split(",").map((s) => s.trim()).filter(Boolean);
      excludeVenues.push(...vals);
    } else {
      positionalArgs.push(arg);
    }
  }

  const rawArgs = positionalArgs.join(" ").trim();
  const resIncludes = includeVenues.length > 0 ? Array.from(new Set(includeVenues)) : undefined;
  const resExcludes = excludeVenues.length > 0 ? Array.from(new Set(excludeVenues)) : undefined;
  const resNoOpen = noOpen ? true : undefined;

  if (mode === "link-gig") {
    if (!linkVenueName && positionalArgs.length > 0) {
      linkVenueName = positionalArgs.join(" ").trim();
    }
    return {
      mode: "link-gig",
      linkVenueName,
      noOpen: resNoOpen,
      rawArgs,
    };
  }

  let location: TargetLocation | undefined;
  if (explicitLocationStr) {
    location = parseLocation(explicitLocationStr) ?? undefined;
  }

  if (!rawArgs) {
    return {
      mode,
      location,
      includeVenues: resIncludes,
      excludeVenues: resExcludes,
      noOpen: resNoOpen,
      rawArgs: "",
    };
  }

  // If explicit location was given, try parsing rawArgs as weekend
  if (location) {
    let weekend: TargetWeekend | undefined;
    try {
      weekend = parseTargetWeekend(rawArgs);
    } catch {
      // ignore
    }
    return {
      mode,
      weekend,
      location,
      includeVenues: resIncludes,
      excludeVenues: resExcludes,
      noOpen: resNoOpen,
      rawArgs,
    };
  }

  // 1. Try parsing full rawArgs as weekend date first
  // e.g. "Oct 16-18 2026", "2026-10-16", "weekend of Oct 16 2026", "October 16-18, 2026"
  try {
    const weekend = parseTargetWeekend(rawArgs);
    return {
      mode,
      weekend,
      includeVenues: resIncludes,
      excludeVenues: resExcludes,
      noOpen: resNoOpen,
      rawArgs,
    };
  } catch {
    // rawArgs is not purely a target weekend date
  }

  // 2. Check for compound date expression: "<date> and <location>", "<date>, <location>", or "<date> <location>"
  // e.g. "Oct 16-18 and Lynchburg, Blacksburg, Martinsville, Salem, Roanoke, and surrounding areas"
  // e.g. "October 16-18, 2026, Lynchburg, VA"
  // e.g. "Oct 16-18 2026 Lynchburg, VA"
  // e.g. "2026-10-16 24502"
  const compoundMatch = rawArgs.match(
    /^((?:weekend\s+of\s+)?[a-z]+\.?\s+\d{1,2}(?:\s*[-–]\s*\d{1,2})?(?:[,\s]+\d{4})?|\d{4}-\d{2}-\d{2}(?:\s*(?:to|\/|-)\s*\d{4}-\d{2}-\d{2})?)\s*(?:and\s+|,|\s+)(.+)$/i,
  );

  if (compoundMatch) {
    const candidateDateStr = compoundMatch[1].trim();
    const candidateLocStr = compoundMatch[2].trim();
    let weekend: TargetWeekend | undefined;
    try {
      weekend = parseTargetWeekend(candidateDateStr);
    } catch {
      // date parsing failed
    }

    if (weekend) {
      location = parseLocation(candidateLocStr) ?? undefined;
      return {
        mode,
        weekend,
        location,
        includeVenues: resIncludes,
        excludeVenues: resExcludes,
        noOpen: resNoOpen,
        rawArgs,
      };
    }
  }

  // 3. If not date or compound date+location, treat rawArgs as location
  location = parseLocation(rawArgs) ?? undefined;
  return {
    mode,
    location,
    includeVenues: resIncludes,
    excludeVenues: resExcludes,
    noOpen: resNoOpen,
    rawArgs,
  };
}

const MONTH_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const MONTH_NAMES = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const METRO_SURROUNDING: Record<string, string[]> = {
  "lynchburg": [
    "Forest",
    "Bedford",
    "Rustburg",
    "Madison Heights",
    "Amherst",
    "Appomattox",
    "Moneta",
  ],
  "blacksburg-christiansburg": [
    "Christiansburg",
    "Radford",
    "Floyd",
    "Pembroke",
    "Pulaski",
    "Giles",
  ],
  "blacksburg": [
    "Christiansburg",
    "Radford",
    "Floyd",
    "Pembroke",
    "Pulaski",
    "Giles",
  ],
  "christiansburg": [
    "Blacksburg",
    "Radford",
    "Floyd",
    "Pembroke",
    "Pulaski",
    "Giles",
  ],
  "martinsville": [
    "Bassett",
    "Collinsville",
    "Spencer",
    "Stuart",
    "Stanleytown",
    "Rocky Mount",
    "Axton",
    "Ridgeway",
    "Fieldale",
  ],
  "roanoke-salem": [
    "Vinton",
    "Daleville",
    "Troutville",
    "Cave Spring",
    "Rocky Mount",
    "Botetourt",
    "Blue Ridge",
    "Catawba",
    "Natural Bridge",
    "Moneta",
    "Wirtz",
    "Huddleston",
  ],
  "roanoke": [
    "Vinton",
    "Daleville",
    "Troutville",
    "Cave Spring",
    "Rocky Mount",
    "Botetourt",
    "Blue Ridge",
    "Catawba",
    "Natural Bridge",
    "Moneta",
    "Wirtz",
    "Huddleston",
  ],
  "salem": [
    "Vinton",
    "Daleville",
    "Troutville",
    "Cave Spring",
    "Rocky Mount",
    "Botetourt",
    "Blue Ridge",
    "Catawba",
    "Natural Bridge",
    "Moneta",
    "Wirtz",
    "Huddleston",
  ],
  "charlottesville": [
    "Crozet",
    "Waynesboro",
    "Keswick",
    "Scottsville",
  ],
  "harrisonburg": [
    "Staunton",
    "Bridgewater",
    "Grottoes",
    "Elkton",
  ],
  "staunton": [
    "Harrisonburg",
    "Waynesboro",
    "Verona",
  ],
  "greensboro-high-point": [
    "High Point",
    "Winston-Salem",
    "Burlington",
    "Kernersville",
  ],
  "greensboro": [
    "High Point",
    "Winston-Salem",
    "Burlington",
    "Kernersville",
  ],
  "winston-salem": [
    "Greensboro",
    "High Point",
    "Kernersville",
    "Clemmons",
  ],
  "charlotte": [
    "Gastonia",
    "Belmont",
    "Matthews",
    "Concord",
    "Huntersville",
    "Pineville",
    "Fort Mill",
    "Rock Hill",
  ],
  "gastonia": [
    "Belmont",
    "Charlotte",
    "Mount Holly",
    "Bessemer City",
  ],
  "belmont": [
    "Gastonia",
    "Charlotte",
    "Mount Holly",
  ],
  "rock-hill": [
    "Fort Mill",
    "Charlotte",
    "Tega Cay",
  ],
  "fort-mill": [
    "Rock Hill",
    "Charlotte",
    "Tega Cay",
  ],
};

export const KNOWN_METROS: Record<
  string,
  { slug: string; city: string; state: string; zips: string[] }
> = {
  "roanoke": {
    slug: "roanoke",
    city: "Roanoke",
    state: "VA",
    zips: ["24011", "24012", "24013", "24014", "24015", "24016", "24017", "24018", "24019"],
  },
  "salem": { slug: "roanoke", city: "Salem", state: "VA", zips: ["24153"] },
  "vinton": { slug: "roanoke", city: "Vinton", state: "VA", zips: ["24179"] },
  "daleville": { slug: "roanoke", city: "Daleville", state: "VA", zips: ["24083"] },
  "troutville": { slug: "roanoke", city: "Troutville", state: "VA", zips: ["24175"] },
  "cave spring": { slug: "roanoke", city: "Cave Spring", state: "VA", zips: ["24018"] },
  "rocky mount": { slug: "roanoke", city: "Rocky Mount", state: "VA", zips: ["24151"] },
  "botetourt": { slug: "roanoke", city: "Botetourt", state: "VA", zips: ["24066"] },
  "moneta": { slug: "roanoke", city: "Moneta", state: "VA", zips: ["24121"] },
  "smith mountain lake": {
    slug: "roanoke",
    city: "Smith Mountain Lake",
    state: "VA",
    zips: ["24121"],
  },
  "blue ridge": { slug: "roanoke", city: "Blue Ridge", state: "VA", zips: ["24064"] },
  "catawba": { slug: "roanoke", city: "Catawba", state: "VA", zips: ["24070"] },
  "natural bridge": { slug: "roanoke", city: "Natural Bridge", state: "VA", zips: ["24578"] },
  "roanoke-salem": {
    slug: "roanoke-salem",
    city: "Roanoke",
    state: "VA",
    zips: [
      "24011",
      "24012",
      "24013",
      "24014",
      "24015",
      "24016",
      "24017",
      "24018",
      "24019",
      "24153",
    ],
  },
  "wirtz": { slug: "roanoke-salem", city: "Wirtz", state: "VA", zips: ["24184"] },
  "huddleston": { slug: "roanoke-salem", city: "Huddleston", state: "VA", zips: ["24104"] },
  "lynchburg": {
    slug: "lynchburg",
    city: "Lynchburg",
    state: "VA",
    zips: ["24501", "24502", "24503", "24504"],
  },
  "forest": { slug: "lynchburg", city: "Forest", state: "VA", zips: ["24551"] },
  "bedford": { slug: "lynchburg", city: "Bedford", state: "VA", zips: ["24523"] },
  "rustburg": { slug: "lynchburg", city: "Rustburg", state: "VA", zips: ["24588"] },
  "madison heights": { slug: "lynchburg", city: "Madison Heights", state: "VA", zips: ["24572"] },
  "amherst": { slug: "lynchburg", city: "Amherst", state: "VA", zips: ["24521"] },
  "appomattox": { slug: "lynchburg", city: "Appomattox", state: "VA", zips: ["24522"] },
  "blacksburg": {
    slug: "blacksburg-christiansburg",
    city: "Blacksburg",
    state: "VA",
    zips: ["24060", "24061"],
  },
  "christiansburg": {
    slug: "blacksburg-christiansburg",
    city: "Christiansburg",
    state: "VA",
    zips: ["24073"],
  },
  "radford": {
    slug: "blacksburg-christiansburg",
    city: "Radford",
    state: "VA",
    zips: ["24141", "24142", "24143"],
  },
  "floyd": { slug: "blacksburg-christiansburg", city: "Floyd", state: "VA", zips: ["24091"] },
  "pembroke": { slug: "blacksburg-christiansburg", city: "Pembroke", state: "VA", zips: ["24136"] },
  "pulaski": { slug: "blacksburg-christiansburg", city: "Pulaski", state: "VA", zips: ["24301"] },
  "blacksburg-christiansburg": {
    slug: "blacksburg-christiansburg",
    city: "Blacksburg",
    state: "VA",
    zips: ["24060", "24061", "24073"],
  },
  "martinsville": {
    slug: "martinsville",
    city: "Martinsville",
    state: "VA",
    zips: ["24112", "24113", "24114", "24115"],
  },
  "bassett": { slug: "martinsville", city: "Bassett", state: "VA", zips: ["24055"] },
  "collinsville": { slug: "martinsville", city: "Collinsville", state: "VA", zips: ["24078"] },
  "spencer": { slug: "martinsville", city: "Spencer", state: "VA", zips: ["24165"] },
  "stuart": { slug: "martinsville", city: "Stuart", state: "VA", zips: ["24171"] },
  "stanleytown": { slug: "martinsville", city: "Stanleytown", state: "VA", zips: ["24168"] },
  "charlottesville": {
    slug: "charlottesville",
    city: "Charlottesville",
    state: "VA",
    zips: ["22901", "22902", "22903"],
  },
  "crozet": { slug: "charlottesville", city: "Crozet", state: "VA", zips: ["22932"] },
  "waynesboro": { slug: "charlottesville", city: "Waynesboro", state: "VA", zips: ["22980"] },
  "harrisonburg": {
    slug: "harrisonburg",
    city: "Harrisonburg",
    state: "VA",
    zips: ["22801", "22802"],
  },
  "staunton": { slug: "staunton", city: "Staunton", state: "VA", zips: ["24401", "24402"] },
  "greensboro": {
    slug: "greensboro-high-point",
    city: "Greensboro",
    state: "NC",
    zips: ["27401", "27402", "27403"],
  },
  "high point": {
    slug: "greensboro-high-point",
    city: "High Point",
    state: "NC",
    zips: ["27260", "27262", "27265"],
  },
  "winston-salem": {
    slug: "greensboro-high-point",
    city: "Winston-Salem",
    state: "NC",
    zips: ["27101", "27103", "27105"],
  },
  "burlington": {
    slug: "greensboro-high-point",
    city: "Burlington",
    state: "NC",
    zips: ["27215", "27217"],
  },
  "charlotte": {
    slug: "charlotte",
    city: "Charlotte",
    state: "NC",
    zips: ["28202", "28203", "28204", "28205", "28208"],
  },
  "gastonia": {
    slug: "gastonia",
    city: "Gastonia",
    state: "NC",
    zips: ["28052", "28054", "28056"],
  },
  "belmont": {
    slug: "belmont",
    city: "Belmont",
    state: "NC",
    zips: ["28012"],
  },
  "rock hill": {
    slug: "rock-hill",
    city: "Rock Hill",
    state: "SC",
    zips: ["29730", "29732"],
  },
  "fort mill": {
    slug: "fort-mill",
    city: "Fort Mill",
    state: "SC",
    zips: ["29708", "29715"],
  },
};

export const US_STATES: Set<string> = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC",
]);

function formatIso(year: number, month: number, day: number): string {
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

/**
 * Parse natural or ISO weekend string into a structured TargetWeekend.
 * E.g. "Oct 16-18 2026", "2026-10-16", "weekend of Oct 16", "October 16-18"
 */
export function parseTargetWeekend(input: string, referenceYear = 2026): TargetWeekend {
  const clean = input.trim();
  if (!clean) {
    throw new Error("Target weekend cannot be empty");
  }

  // Check ISO range: "2026-10-16 to 2026-10-18" or "2026-10-16/2026-10-18"
  const isoRangeMatch = clean.match(
    /^(\d{4})-(\d{2})-(\d{2})\s*(?:to|\/|-)\s*(\d{4})-(\d{2})-(\d{2})$/i,
  );
  if (isoRangeMatch) {
    const y1 = parseInt(isoRangeMatch[1], 10);
    const m1 = parseInt(isoRangeMatch[2], 10);
    const d1 = parseInt(isoRangeMatch[3], 10);
    const y2 = parseInt(isoRangeMatch[4], 10);
    const m2 = parseInt(isoRangeMatch[5], 10);
    const d2 = parseInt(isoRangeMatch[6], 10);

    const start = formatIso(y1, m1, d1);
    const end = formatIso(y2, m2, d2);
    const label = `${MONTH_NAMES[m1]} ${d1}–${d2}, ${y1}`;
    const days = [];
    for (let d = d1; d <= d2; d++) days.push(d);

    return {
      start,
      end,
      rawText: clean,
      label,
      year: y1,
      month: m1,
      days,
    };
  }

  // Check single ISO date: "2026-10-16" -> assumes Friday start, extends to Sunday
  const isoSingleMatch = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoSingleMatch) {
    const year = parseInt(isoSingleMatch[1], 10);
    const month = parseInt(isoSingleMatch[2], 10);
    const day = parseInt(isoSingleMatch[3], 10);

    const endDate = new Date(Date.UTC(year, month - 1, day + 2));

    const start = formatIso(year, month, day);
    const end = formatIso(
      endDate.getUTCFullYear(),
      endDate.getUTCMonth() + 1,
      endDate.getUTCDate(),
    );
    const label = `${MONTH_NAMES[month]} ${day}–${endDate.getUTCDate()}, ${year}`;

    return {
      start,
      end,
      rawText: clean,
      label,
      year,
      month,
      days: [day, day + 1, day + 2],
    };
  }

  // Check natural date: "Oct 16-18 2026", "October 16-18, 2026", "weekend of Oct 16 2026", "Oct 16, 2026"
  const naturalMatch = clean.match(
    /^(?:weekend\s+of\s+)?([a-z]+)\.?\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?(?:[,\s]+(\d{4}))?$/i,
  );
  if (naturalMatch) {
    const monthStr = naturalMatch[1].toLowerCase();
    const month = MONTH_MAP[monthStr];
    if (!month) {
      throw new Error(`Unrecognized month: "${naturalMatch[1]}"`);
    }

    const startDay = parseInt(naturalMatch[2], 10);
    const endDay = naturalMatch[3] ? parseInt(naturalMatch[3], 10) : startDay + 2;
    const year = naturalMatch[4] ? parseInt(naturalMatch[4], 10) : referenceYear;

    const start = formatIso(year, month, startDay);
    const end = formatIso(year, month, endDay);
    const label = `${MONTH_NAMES[month]} ${startDay}–${endDay}, ${year}`;
    const days = [];
    for (let d = startDay; d <= endDay; d++) days.push(d);

    return {
      start,
      end,
      rawText: clean,
      label,
      year,
      month,
      days,
    };
  }

  throw new Error(
    `Unable to parse target weekend from: "${clean}". Use format like "Oct 16-18 2026" or "2026-10-16".`,
  );
}

/**
 * Parse an optional location string (e.g. "Lynchburg, VA", "24502", "Roanoke", "Lynchburg, Blacksburg, Martinsville, Salem, Roanoke, and surrounding areas")
 */
export function parseLocation(input?: string): TargetLocation | null {
  if (!input || !input.trim()) return null;
  const raw = input.trim();
  let working = raw;

  // Reject standalone numeric strings that are not valid 5-digit zip codes (e.g. 4-digit years like "2026")
  if (/^\d+$/.test(working) && working.length !== 5) {
    return null;
  }

  // 1. Detect and extract "and surrounding areas", "surrounding areas", "and surrounding", etc.
  let includeSurrounding = false;
  const surroundingRegex =
    /(?:,\s*)?(?:\band\s+)?(?:the\s+)?surrounding(?:\s+regional)?\s+areas?\b/i;
  const surroundingShortRegex = /(?:,\s*)?(?:\band\s+)?surrounding\b/i;

  if (surroundingRegex.test(working)) {
    includeSurrounding = true;
    working = working.replace(surroundingRegex, "").trim();
  } else if (surroundingShortRegex.test(working)) {
    includeSurrounding = true;
    working = working.replace(surroundingShortRegex, "").trim();
  }

  // Reject if remaining working string is purely numeric and not a 5-digit zip code
  if (/^\d+$/.test(working) && working.length !== 5) {
    return null;
  }

  // 2. Check 5-digit zipcode
  const zipMatch = working.match(/^(\d{5})$/);
  if (zipMatch) {
    const zip = zipMatch[1];
    for (const metro of Object.values(KNOWN_METROS)) {
      if (metro.zips.includes(zip)) {
        const surrounding = METRO_SURROUNDING[metro.slug] || [];
        return {
          raw,
          city: metro.city,
          state: metro.state,
          zip,
          metroSlug: metro.slug,
          cities: [metro.city],
          includeSurrounding: includeSurrounding || undefined,
          surroundingCities: includeSurrounding
            ? surrounding.filter((c) => c !== metro.city)
            : undefined,
        };
      }
    }
    return {
      raw,
      zip,
      includeSurrounding: includeSurrounding || undefined,
    };
  }

  // Reject strings without any alphabetic characters (e.g. "2026-10-16", symbols/numbers only)
  if (!/[a-zA-Z]/.test(working)) {
    return null;
  }

  // 3. Single City, State check (e.g. "Lynchburg, VA" or "Lynchburg VA")
  const singleCityStateMatch = working.match(/^([a-zA-Z\s.-]+),\s*([a-zA-Z]{2})$/);
  if (singleCityStateMatch && US_STATES.has(singleCityStateMatch[2].toUpperCase())) {
    const city = singleCityStateMatch[1].trim();
    const state = singleCityStateMatch[2].trim().toUpperCase();
    const cityLower = city.toLowerCase();
    const metro = KNOWN_METROS[cityLower];
    const metroSlug = metro?.slug || cityLower.replace(/\s+/g, "-");
    const surrounding = METRO_SURROUNDING[metroSlug] || METRO_SURROUNDING[cityLower] || [];

    return {
      raw,
      city,
      state,
      metroSlug,
      cities: [city],
      includeSurrounding: includeSurrounding || undefined,
      surroundingCities: includeSurrounding
        ? surrounding.filter((c) => c.toLowerCase() !== cityLower)
        : (surrounding.length > 0
          ? surrounding.filter((c) => c.toLowerCase() !== cityLower)
          : undefined),
    };
  }

  // 4. Multi-city / compound list parsing:
  // Split on commas first, then handle "and"
  // E.g. "Lynchburg, Blacksburg, Martinsville, Salem, Roanoke"
  // E.g. "Lynchburg and Roanoke"
  // E.g. "Lynchburg, Blacksburg, and Roanoke"
  const commaParts = working.split(",").map((p) => p.trim()).filter(Boolean);
  const rawCityTokens: string[] = [];
  let detectedState: string | undefined;

  for (let i = 0; i < commaParts.length; i++) {
    let part = commaParts[i];
    // Check if this part is just a 2-letter state code like "VA"
    if (part.length === 2 && US_STATES.has(part.toUpperCase())) {
      detectedState = part.toUpperCase();
      continue;
    }
    // Check if part ends with state like "Lynchburg VA"
    const stateSuffixMatch = part.match(/^(.*?)\s+([a-zA-Z]{2})$/);
    if (stateSuffixMatch && US_STATES.has(stateSuffixMatch[2].toUpperCase())) {
      part = stateSuffixMatch[1].trim();
      detectedState = stateSuffixMatch[2].toUpperCase();
    }

    // Split part on "and" if it contains "and"
    const andParts = part.split(/\band\b/i).map((p) => p.trim()).filter(Boolean);
    for (const ap of andParts) {
      if (ap.length === 2 && US_STATES.has(ap.toUpperCase())) {
        detectedState = ap.toUpperCase();
      } else if (ap && /[a-zA-Z]/.test(ap) && !/^\d+$/.test(ap)) {
        rawCityTokens.push(ap);
      }
    }
  }

  if (rawCityTokens.length === 0) {
    return null;
  }

  // Normalize each city token: capitalize nicely or match to KNOWN_METROS
  const cities: string[] = [];
  const metroSlugs: string[] = [];
  const surroundingSet = new Set<string>();

  for (const rawToken of rawCityTokens) {
    const lowerToken = rawToken.toLowerCase();
    const known = KNOWN_METROS[lowerToken];
    const cityName = known ? known.city : rawToken.replace(/\b\w/g, (c) => c.toUpperCase());
    if (!cities.includes(cityName)) {
      cities.push(cityName);
    }
    const slug = known?.slug || lowerToken.replace(/\s+/g, "-");
    if (!metroSlugs.includes(slug)) {
      metroSlugs.push(slug);
    }
    if (known?.state && !detectedState) {
      detectedState = known.state;
    }
    // Collect surrounding cities
    const surroundingList = METRO_SURROUNDING[slug] || METRO_SURROUNDING[lowerToken] || [];
    for (const sc of surroundingList) {
      surroundingSet.add(sc);
    }
  }

  // Remove target cities from surroundingCities set
  for (const c of cities) {
    surroundingSet.delete(c);
  }
  const surroundingCities = Array.from(surroundingSet);

  const primaryCity = cities[0];
  const primarySlug = metroSlugs[0] || primaryCity.toLowerCase().replace(/\s+/g, "-");

  return {
    raw,
    city: primaryCity,
    state: detectedState,
    metroSlug: primarySlug,
    cities,
    includeSurrounding: includeSurrounding || undefined,
    surroundingCities: includeSurrounding
      ? surroundingCities
      : (surroundingCities.length > 0 ? surroundingCities : undefined),
  };
}
