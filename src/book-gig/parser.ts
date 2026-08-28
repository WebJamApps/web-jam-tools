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
    } else if (lower === "--no-open") {
      noOpen = true;
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

  if (!rawArgs) {
    return {
      mode,
      includeVenues: resIncludes,
      excludeVenues: resExcludes,
      noOpen: resNoOpen,
      rawArgs: "",
    };
  }

  // Try matching date part first
  // Check if positionalArgs start with ISO date or natural month
  let dateTokens: string[] = [];
  let locTokens: string[] = [];

  const firstToken = positionalArgs[0].toLowerCase();
  if (firstToken.match(/^\d{4}-\d{2}-\d{2}$/)) {
    dateTokens = [positionalArgs[0]];
    locTokens = positionalArgs.slice(1);
  } else if (MONTH_MAP[firstToken.replace(/[^a-z]/g, "")] || firstToken === "weekend") {
    // Collect date tokens until we hit a location indicator (e.g. city or zip)
    let i = 0;
    while (i < positionalArgs.length) {
      const t = positionalArgs[i];
      if (i > 0 && (t.match(/^\d{5}$/) || t.includes(",") || (i >= 3 && isNaN(parseInt(t, 10))))) {
        break;
      }
      dateTokens.push(t);
      i++;
    }
    locTokens = positionalArgs.slice(i);
  } else {
    // If first token is not date, check if full rawArgs can parse as date
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
      // Otherwise treat everything as location or return raw
      return {
        mode,
        location: parseLocation(rawArgs) ?? undefined,
        includeVenues: resIncludes,
        excludeVenues: resExcludes,
        noOpen: resNoOpen,
        rawArgs,
      };
    }
  }

  let weekend: TargetWeekend | undefined;
  if (dateTokens.length > 0) {
    try {
      weekend = parseTargetWeekend(dateTokens.join(" "));
    } catch {
      // Ignore if unparseable, leave undefined for interactive fallback
    }
  }

  let location: TargetLocation | undefined;
  if (locTokens.length > 0) {
    location = parseLocation(locTokens.join(" ")) ?? undefined;
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

const KNOWN_METROS: Record<string, { slug: string; city: string; state: string; zips: string[] }> =
  {
    "roanoke": {
      slug: "roanoke",
      city: "Roanoke",
      state: "VA",
      zips: ["24011", "24012", "24013", "24014", "24015", "24016", "24017", "24018", "24019"],
    },
    "salem": { slug: "roanoke", city: "Salem", state: "VA", zips: ["24153"] },
    "lynchburg": {
      slug: "lynchburg",
      city: "Lynchburg",
      state: "VA",
      zips: ["24501", "24502", "24503", "24504"],
    },
    "forest": { slug: "lynchburg", city: "Forest", state: "VA", zips: ["24551"] },
    "bedford": { slug: "lynchburg", city: "Bedford", state: "VA", zips: ["24523"] },
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
    "charlottesville": {
      slug: "charlottesville",
      city: "Charlottesville",
      state: "VA",
      zips: ["22901", "22902", "22903"],
    },
    "greensboro": {
      slug: "greensboro-high-point",
      city: "Greensboro",
      state: "NC",
      zips: ["27401", "27402", "27403"],
    },
  };

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
    /(?:weekend\s+of\s+)?([a-z]+)\.?\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?(?:[,\s]+(\d{4}))?/i,
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
 * Parse an optional location string (e.g. "Lynchburg, VA", "24502", "Roanoke", "lynchburg")
 */
export function parseLocation(input?: string): TargetLocation | null {
  if (!input || !input.trim()) return null;
  const clean = input.trim();

  // 5-digit zipcode
  const zipMatch = clean.match(/^(\d{5})$/);
  if (zipMatch) {
    const zip = zipMatch[1];
    // Reverse-lookup known metro
    for (const metro of Object.values(KNOWN_METROS)) {
      if (metro.zips.includes(zip)) {
        return {
          raw: clean,
          city: metro.city,
          state: metro.state,
          zip,
          metroSlug: metro.slug,
        };
      }
    }
    return {
      raw: clean,
      zip,
    };
  }

  // City, State: "Lynchburg, VA" or "Lynchburg VA"
  const cityStateMatch = clean.match(/^([a-zA-Z\s.-]+),\s*([a-zA-Z]{2})$/);
  if (cityStateMatch) {
    const city = cityStateMatch[1].trim();
    const state = cityStateMatch[2].trim().toUpperCase();
    const slug = city.toLowerCase().replace(/\s+/g, "-");
    const matchedMetro = KNOWN_METROS[city.toLowerCase()]?.slug || slug;

    return {
      raw: clean,
      city,
      state,
      metroSlug: matchedMetro,
    };
  }

  // Bare City name or Metro slug
  const lower = clean.toLowerCase();
  if (KNOWN_METROS[lower]) {
    const metro = KNOWN_METROS[lower];
    return {
      raw: clean,
      city: metro.city,
      state: metro.state,
      metroSlug: metro.slug,
    };
  }

  return {
    raw: clean,
    city: clean,
    metroSlug: clean.toLowerCase().replace(/\s+/g, "-"),
  };
}
