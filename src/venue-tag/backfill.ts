// src/venue-tag/backfill.ts
// Propose-then-apply CLI and classifier for backfilling venueType on unvetted venues (web-jam-tools#1126, D-79).

export type CanonicalVenueType = "PubFestivalBrewery" | "MidRangeCafeBar" | "Originals";

export interface VenueRecord {
  _id: string;
  name?: string;
  type?: string;
  venueType?: string | null;
  genre?: string | string[];
  notes?: string;
  description?: string;
  website?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ClassificationMatch {
  type: CanonicalVenueType;
  reason: string;
}

export interface ClassificationResult {
  venueId: string;
  name: string;
  currentType: string | null;
  proposedType: CanonicalVenueType;
  reason: string;
  isOverwritten: boolean;
}

export interface AffirmativeFlagResult {
  present: boolean;
  affirmative: boolean;
  error?: string;
}

export interface BackfillOptions {
  apply?: boolean;
  overwrite?: boolean;
  backendUrl?: string;
  token?: string;
  fetchFn?: typeof fetch;
  logger?: {
    log: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface BackfillResult {
  totalFetched: number;
  unvettedCount: number;
  proposed: ClassificationResult[];
  appliedCount: number;
  skippedCount: number;
  errors: Array<{ venueId: string; name: string; error: string }>;
  success: boolean;
}

export const DEFAULT_BACKEND_URL = "https://webjamsalem.herokuapp.com";

// Word-boundary matching patterns for entity classification (Rule 21)
const ORIGINALS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\blistening\s+rooms?\b/i, label: "listening room" },
  { pattern: /\boriginal\s+music\b/i, label: "original music" },
  { pattern: /\boriginals?\b/i, label: "originals" },
  { pattern: /\btheaters?\b/i, label: "theater" },
  { pattern: /\btheatres?\b/i, label: "theatre" },
  { pattern: /\bamphitheaters?\b/i, label: "amphitheater" },
  { pattern: /\bamphitheatres?\b/i, label: "amphitheatre" },
  { pattern: /\bauditoriums?\b/i, label: "auditorium" },
  { pattern: /\bconcert\s+halls?\b/i, label: "concert hall" },
  { pattern: /\bmusic\s+halls?\b/i, label: "music hall" },
  { pattern: /\bopera\s+house\b/i, label: "opera house" },
  { pattern: /\bperforming\s+arts\b/i, label: "performing arts" },
  { pattern: /\bsinger[-\s]songwriters?\b/i, label: "singer-songwriter" },
  { pattern: /\bsongwriters?\b/i, label: "songwriter" },
  { pattern: /\bshowcases?\b/i, label: "showcase" },
  { pattern: /\brock\s+clubs?\b/i, label: "rock club" },
  { pattern: /\bindie\s+clubs?\b/i, label: "indie club" },
  { pattern: /\blive\s+music\s+hall\b/i, label: "live music hall" },
];

const PUB_BREWERY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bbrewer(?:y|ies)\b/i, label: "brewery" },
  { pattern: /\bbrewing\b/i, label: "brewing" },
  { pattern: /\bbrewhouses?\b/i, label: "brewhouse" },
  { pattern: /\bbrewpubs?\b/i, label: "brewpub" },
  { pattern: /\bbrew\s+co\b/i, label: "brew co" },
  { pattern: /\bbeer\s+compan(?:y|ies)\b/i, label: "beer company" },
  { pattern: /\bpubs?\b/i, label: "pub" },
  { pattern: /\balehouses?\b/i, label: "alehouse" },
  { pattern: /\bale\s+houses?\b/i, label: "ale house" },
  { pattern: /\btaverns?\b/i, label: "tavern" },
  { pattern: /\bsaloons?\b/i, label: "saloon" },
  { pattern: /\btaphouses?\b/i, label: "taphouse" },
  { pattern: /\btap\s+houses?\b/i, label: "tap house" },
  { pattern: /\btaprooms?\b/i, label: "taproom" },
  { pattern: /\btap\s+rooms?\b/i, label: "tap room" },
  { pattern: /\bcider(?:y|ies)\b/i, label: "cidery" },
  { pattern: /\bciderworks\b/i, label: "ciderworks" },
  { pattern: /\bciders?\b/i, label: "cider" },
  { pattern: /\bmeadhalls?\b/i, label: "meadhall" },
  { pattern: /\bmeads?\b/i, label: "mead" },
  { pattern: /\bdistiller(?:y|ies)\b/i, label: "distillery" },
  { pattern: /\bdistilling\b/i, label: "distilling" },
  { pattern: /\bfestivals?\b/i, label: "festival" },
  { pattern: /\bfests?\b/i, label: "fest" },
  { pattern: /\bfairs?\b/i, label: "fair" },
  { pattern: /\bfarmers\s+markets?\b/i, label: "farmers market" },
  { pattern: /\bmarkets?\b/i, label: "market" },
  { pattern: /\bbeer\s+gardens?\b/i, label: "beer garden" },
  { pattern: /\bbiergartens?\b/i, label: "biergarten" },
];

const CAFE_BAR_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bcafes?\b/i, label: "cafe" },
  { pattern: /\bcafés?\b/i, label: "café" },
  { pattern: /\bcoffees?\b/i, label: "coffee" },
  { pattern: /\bcoffeehouses?\b/i, label: "coffeehouse" },
  { pattern: /\bcoffee\s+shops?\b/i, label: "coffee shop" },
  { pattern: /\broaster(?:y|ies)\b/i, label: "roastery" },
  { pattern: /\broasters?\b/i, label: "roasters" },
  { pattern: /\bwiner(?:y|ies)\b/i, label: "winery" },
  { pattern: /\bvineyards?\b/i, label: "vineyard" },
  { pattern: /\bwine\s+bars?\b/i, label: "wine bar" },
  { pattern: /\bcellars?\b/i, label: "cellars" },
  { pattern: /\bbistros?\b/i, label: "bistro" },
  { pattern: /\blounges?\b/i, label: "lounge" },
  { pattern: /\bbars?\b/i, label: "bar" },
  { pattern: /\bgrills?\b/i, label: "grill" },
  { pattern: /\brestaurants?\b/i, label: "restaurant" },
  { pattern: /\bdiners?\b/i, label: "diner" },
  { pattern: /\beater(?:y|ies)\b/i, label: "eatery" },
  { pattern: /\bkitchens?\b/i, label: "kitchen" },
  { pattern: /\bbaker(?:y|ies)\b/i, label: "bakery" },
  { pattern: /\btea\s+houses?\b/i, label: "tea house" },
  { pattern: /\bteahouses?\b/i, label: "teahouse" },
  { pattern: /\bdelis?\b/i, label: "deli" },
  { pattern: /\bcantinas?\b/i, label: "cantina" },
  { pattern: /\bpizzerias?\b/i, label: "pizzeria" },
  { pattern: /\btrattorias?\b/i, label: "trattoria" },
  { pattern: /\bsteakhouses?\b/i, label: "steakhouse" },
];

/**
 * Parses confirmation and affirmative flags according to Rule 19:
 * Only exact affirmative values (bare flag, or =true/=yes/=1) evaluate to confirmed.
 * Negative, empty, or malformed values fail closed and return an error.
 */
export function parseAffirmativeFlag(
  flagName: string,
  args: string[],
): AffirmativeFlagResult {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === `--${flagName}`) {
      // Check if following argument is a value instead of another flag
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        const lower = next.toLowerCase();
        if (lower === "true" || lower === "yes" || lower === "1") {
          return { present: true, affirmative: true };
        }
        return {
          present: true,
          affirmative: false,
          error:
            `Invalid value "${next}" for --${flagName}. Must be affirmative ("true", "yes", "1") or bare flag.`,
        };
      }
      return { present: true, affirmative: true };
    }
    if (arg.startsWith(`--${flagName}=`)) {
      const val = arg.slice(flagName.length + 3).trim().toLowerCase();
      if (val === "true" || val === "yes" || val === "1") {
        return { present: true, affirmative: true };
      }
      return {
        present: true,
        affirmative: false,
        error:
          `Invalid value "${val}" for --${flagName}. Must be affirmative ("true", "yes", "1") or bare flag.`,
      };
    }
  }
  return { present: false, affirmative: false };
}

/**
 * Classifies a venue into one of the canonical venueType enums:
 * 'PubFestivalBrewery', 'MidRangeCafeBar', 'Originals'.
 * Precedence:
 * 1. Legacy venue.type if explicitly set and recognizable.
 * 2. Word-boundary keywords in venue name & genre for Originals.
 * 3. Word-boundary keywords in venue name & genre for PubFestivalBrewery.
 * 4. Word-boundary keywords in venue name & genre for MidRangeCafeBar.
 * 5. Word-boundary keywords in notes / description.
 * 6. Default fallback to MidRangeCafeBar (D-78).
 */
export function classifyVenue(venue: VenueRecord): ClassificationMatch {
  // 1. Check legacy venue.type field
  const legacyType = (venue.type || "").trim();
  if (legacyType) {
    const ltLower = legacyType.toLowerCase();
    if (ltLower === "originals" || ltLower === "listening room" || ltLower === "theater") {
      return { type: "Originals", reason: `legacy type "${legacyType}"` };
    }
    if (
      ltLower === "brewery" || ltLower === "pub" || ltLower === "festival" ||
      ltLower === "farmersmarket" || ltLower === "bar/restaurant" || ltLower === "tavern" ||
      ltLower === "taproom"
    ) {
      return { type: "PubFestivalBrewery", reason: `legacy type "${legacyType}"` };
    }
    if (
      ltLower === "coffeeshop" || ltLower === "cafe" || ltLower === "winery" ||
      ltLower === "restaurant"
    ) {
      return { type: "MidRangeCafeBar", reason: `legacy type "${legacyType}"` };
    }
  }

  const name = (venue.name || "").trim();
  const genreText = Array.isArray(venue.genre)
    ? venue.genre.join(" ")
    : (typeof venue.genre === "string" ? venue.genre : "");
  const notesText = (venue.notes || "") + " " + (venue.description || "");

  // Helper to match patterns against text
  const matchPattern = (
    text: string,
    patterns: Array<{ pattern: RegExp; label: string }>,
  ): string | null => {
    if (!text) return null;
    for (const item of patterns) {
      if (item.pattern.test(text)) {
        return item.label;
      }
    }
    return null;
  };

  // 2. Originals check on name & genre
  let label = matchPattern(name, ORIGINALS_PATTERNS);
  if (label) return { type: "Originals", reason: `name keyword "${label}"` };
  label = matchPattern(genreText, ORIGINALS_PATTERNS);
  if (label) return { type: "Originals", reason: `genre keyword "${label}"` };

  // 3. PubFestivalBrewery check on name & genre
  label = matchPattern(name, PUB_BREWERY_PATTERNS);
  if (label) return { type: "PubFestivalBrewery", reason: `name keyword "${label}"` };
  label = matchPattern(genreText, PUB_BREWERY_PATTERNS);
  if (label) return { type: "PubFestivalBrewery", reason: `genre keyword "${label}"` };

  // 4. MidRangeCafeBar check on name & genre
  label = matchPattern(name, CAFE_BAR_PATTERNS);
  if (label) return { type: "MidRangeCafeBar", reason: `name keyword "${label}"` };
  label = matchPattern(genreText, CAFE_BAR_PATTERNS);
  if (label) return { type: "MidRangeCafeBar", reason: `genre keyword "${label}"` };

  // 5. Notes & description checks
  label = matchPattern(notesText, ORIGINALS_PATTERNS);
  if (label) return { type: "Originals", reason: `notes keyword "${label}"` };
  label = matchPattern(notesText, PUB_BREWERY_PATTERNS);
  if (label) return { type: "PubFestivalBrewery", reason: `notes keyword "${label}"` };
  label = matchPattern(notesText, CAFE_BAR_PATTERNS);
  if (label) return { type: "MidRangeCafeBar", reason: `notes keyword "${label}"` };

  // 6. Default fallback
  return { type: "MidRangeCafeBar", reason: "default fallback (no keyword match)" };
}

/**
 * Resolves the authentication token from options, env, or local token file.
 */
export function resolveToken(tokenOption?: string): string | null {
  if (tokenOption) return tokenOption;
  const envToken = Deno.env.get("WEB_JAM_LLM_TOKEN");
  if (envToken) return envToken;
  try {
    const home = Deno.env.get("HOME");
    if (home) {
      const fileToken = Deno.readTextFileSync(`${home}/Dropbox/web-jam-llms/web-jam-llm.token`)
        .trim();
      if (fileToken) return fileToken;
    }
  } catch {
    // Ignore if not present
  }
  return null;
}

/**
 * Fetches all venues from GET /venue.
 */
export async function fetchVenues(
  baseUrl: string,
  token?: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<VenueRecord[]> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/venue`;
  const res = await fetchFn(url, { headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GET /venue failed: HTTP ${res.status} ${res.statusText} — ${errText}`);
  }

  const data = await res.json();
  if (Array.isArray(data)) return data as VenueRecord[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    return (obj.venues ?? obj.data ?? []) as VenueRecord[];
  }
  return [];
}

/**
 * Updates a venue's venueType via PATCH /venue/:id.
 */
export async function updateVenueType(
  venueId: string,
  venueType: CanonicalVenueType,
  baseUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/venue/${venueId}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };

  const res = await fetchFn(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ venueType }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `PATCH /venue/${venueId} failed: HTTP ${res.status} ${res.statusText} — ${errText}`,
    );
  }
}

/**
 * Formats proposed classification results as an ASCII table.
 */
export function formatClassificationTable(proposed: ClassificationResult[]): string {
  if (proposed.length === 0) {
    return "No unvetted venues requiring classification.";
  }

  const lines: string[] = [];
  const header =
    `| #   | Venue Name                      | Current Type | Proposed Type      | Matched Rule / Reason`;
  const divider =
    `|-----|---------------------------------|--------------|--------------------|-----------------------------------`;
  lines.push(header);
  lines.push(divider);

  for (let i = 0; i < proposed.length; i++) {
    const item = proposed[i];
    const num = String(i + 1).padEnd(3);
    const name = (item.name || "Unknown").slice(0, 31).padEnd(31);
    const current = (item.currentType || "(unset)").slice(0, 12).padEnd(12);
    const proposedType = item.proposedType.slice(0, 18).padEnd(18);
    const reason = item.reason;
    lines.push(`| ${num} | ${name} | ${current} | ${proposedType} | ${reason}`);
  }

  return lines.join("\n");
}

/**
 * Executes backfill analysis and optional PATCH dispatch.
 */
export async function runBackfill(options: BackfillOptions = {}): Promise<BackfillResult> {
  const logger = options.logger || console;
  const baseUrl = options.backendUrl || Deno.env.get("WEB_JAM_BACK_URL") || DEFAULT_BACKEND_URL;
  const token = options.token !== undefined ? (options.token || null) : resolveToken();
  const fetchFn = options.fetchFn || fetch;
  const apply = Boolean(options.apply);
  const overwrite = Boolean(options.overwrite);

  if (apply && !token) {
    throw new Error(
      "Missing authentication token for --apply. Export WEB_JAM_LLM_TOKEN or pass --token <token>.",
    );
  }

  // 1. Fetch live venues
  const allVenues = await fetchVenues(baseUrl, token, fetchFn);

  // 2. Filter venues: unvetted (!venueType) unless overwrite=true
  const targetVenues = allVenues.filter((v) => {
    // Only active venues
    if (v.status === "archived") return false;
    const hasType = Boolean(v.venueType && typeof v.venueType === "string" && v.venueType.trim());
    if (overwrite) return true;
    return !hasType;
  });

  // 3. Classify target venues
  const proposed: ClassificationResult[] = [];
  for (const v of targetVenues) {
    const current = v.venueType ? String(v.venueType).trim() : null;
    const match = classifyVenue(v);

    // If overwrite mode, only include if current differs from proposed
    if (overwrite && current === match.type) {
      continue;
    }

    proposed.push({
      venueId: String(v._id),
      name: v.name || "Unknown",
      currentType: current,
      proposedType: match.type,
      reason: match.reason,
      isOverwritten: Boolean(current && current !== match.type),
    });
  }

  // 4. Counts breakdown
  const typeCounts = {
    PubFestivalBrewery: proposed.filter((p) => p.proposedType === "PubFestivalBrewery").length,
    MidRangeCafeBar: proposed.filter((p) => p.proposedType === "MidRangeCafeBar").length,
    Originals: proposed.filter((p) => p.proposedType === "Originals").length,
  };

  logger.log(
    `Fetched ${allVenues.length} total venues; found ${proposed.length} venues to classify.`,
  );
  logger.log(
    `Type breakdown: ${typeCounts.PubFestivalBrewery} PubFestivalBrewery, ${typeCounts.MidRangeCafeBar} MidRangeCafeBar, ${typeCounts.Originals} Originals.`,
  );
  logger.log("");
  logger.log(formatClassificationTable(proposed));
  logger.log("");

  let appliedCount = 0;
  let skippedCount = 0;
  const errors: Array<{ venueId: string; name: string; error: string }> = [];

  // 5. If --apply, dispatch PATCH requests
  if (apply) {
    if (proposed.length === 0) {
      logger.log("No venues to update.");
      return {
        totalFetched: allVenues.length,
        unvettedCount: targetVenues.length,
        proposed,
        appliedCount: 0,
        skippedCount: 0,
        errors: [],
        success: true,
      };
    }

    logger.log(`Applying venueType classifications to ${proposed.length} venues...`);
    for (const item of proposed) {
      try {
        await updateVenueType(item.venueId, item.proposedType, baseUrl, token!, fetchFn);
        appliedCount++;
        logger.log(`  ✓ Updated "${item.name}" (${item.venueId}) -> ${item.proposedType}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ venueId: item.venueId, name: item.name, error: message });
        logger.error(`  ✗ Failed to update "${item.name}" (${item.venueId}): ${message}`);
        // Fail closed on error (AC 3)
        throw new Error(
          `Backfill aborted: failed to update "${item.name}" (${item.venueId}): ${message}`,
        );
      }
    }
    logger.log(`\nSuccessfully applied classifications to ${appliedCount} venues.`);
  } else {
    skippedCount = proposed.length;
    logger.log("Notice: Dry-run preview mode. No records were written to the database.");
    logger.log("To apply these proposed updates, re-run with: --apply");
  }

  return {
    totalFetched: allVenues.length,
    unvettedCount: targetVenues.length,
    proposed,
    appliedCount,
    skippedCount,
    errors,
    success: errors.length === 0,
  };
}

/**
 * Entrypoint for CLI invocations.
 */
export async function runBackfillCli(
  args: string[],
  deps: {
    logger?: { log: (msg: string) => void; error: (msg: string) => void };
    fetchFn?: typeof fetch;
  } = {},
): Promise<number> {
  const logger = deps.logger || console;

  if (args.includes("--help") || args.includes("-h")) {
    logger.log(
      `Usage: deno task venue-tag:backfill-types [options]

Queries unvetted venues (!venueType) from GET /venue, classifies them into
canonical types (PubFestivalBrewery, MidRangeCafeBar, Originals), and displays
a formatted preview table by default. When invoked with --apply, sends PATCH
requests to update venue records.

Options:
  --apply                Apply proposed classifications via PATCH /venue/:id (default: dry run)
  --overwrite            Allow overwriting existing venueType values if different
  --backend-url <url>    Backend base URL (default: WEB_JAM_BACK_URL or https://webjamsalem.herokuapp.com)
  --token <token>        Bearer token (default: WEB_JAM_LLM_TOKEN or Dropbox token file)
  --help, -h             Show this help message
`,
    );
    return 0;
  }

  // Parse affirmative flags fail-closed
  const applyFlag = parseAffirmativeFlag("apply", args);
  if (applyFlag.present && !applyFlag.affirmative) {
    logger.error(`Error: ${applyFlag.error}`);
    return 1;
  }

  const overwriteFlag = parseAffirmativeFlag("overwrite", args);
  if (overwriteFlag.present && !overwriteFlag.affirmative) {
    logger.error(`Error: ${overwriteFlag.error}`);
    return 1;
  }

  // Parse options
  let backendUrl: string | undefined;
  let token: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--backend-url" && args[i + 1]) {
      backendUrl = args[i + 1];
    } else if (args[i].startsWith("--backend-url=")) {
      backendUrl = args[i].slice(14);
    } else if (args[i] === "--token" && args[i + 1]) {
      token = args[i + 1];
    } else if (args[i].startsWith("--token=")) {
      token = args[i].slice(8);
    }
  }

  try {
    await runBackfill({
      apply: applyFlag.affirmative,
      overwrite: overwriteFlag.affirmative,
      backendUrl,
      token,
      fetchFn: deps.fetchFn,
      logger,
    });
    return 0;
  } catch (err) {
    logger.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
