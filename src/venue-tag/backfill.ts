// src/venue-tag/backfill.ts
// Propose-then-apply CLI for unvetted venues; D-78/D-79 in the gig outreach design.
import {
  type ContextRequest,
  type ContextualClassification,
  createContextRequest,
  parseContextualClassifications,
  validateContextualClassifications,
} from "./contextual.ts";

export type CanonicalVenueType = "PubFestivalBrewery" | "MidRangeCafeBar" | "Originals";

export interface VenueRecord {
  _id: string;
  name?: string;
  city?: string;
  usState?: string;
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
  type: CanonicalVenueType | null;
  reason: string;
}

export interface ClassificationResult {
  venueId: string;
  name: string;
  city?: string;
  currentType: string | null;
  proposedType: CanonicalVenueType | null;
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
  contextualTypes?: ContextualClassification[];
  confirmProposal?: (proposed: readonly ClassificationResult[]) => boolean | Promise<boolean>;
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
  contextRequests: ContextRequest[];
}

export const DEFAULT_BACKEND_URL = "https://webjamsalem.herokuapp.com";

// Word-boundary matching patterns for entity classification (Rule 21)
const ORIGINALS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\blistening\s+rooms?\b/i, label: "listening room" },
  { pattern: /\bacoustic\s+stages?\b/i, label: "acoustic stage" },
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
  { pattern: /\bbeer\b/i, label: "beer" },
  { pattern: /\bwiner(?:y|ies)\b/i, label: "winery" },
  { pattern: /\bvineyards?\b/i, label: "vineyard" },
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
  { pattern: /\bcafés?(?![\p{L}\p{N}_])/iu, label: "café" },
  { pattern: /\bcoffees?\b/i, label: "coffee" },
  { pattern: /\bcoffeehouses?\b/i, label: "coffeehouse" },
  { pattern: /\bcoffee\s+shops?\b/i, label: "coffee shop" },
  { pattern: /\broaster(?:y|ies)\b/i, label: "roastery" },
  { pattern: /\broasters?\b/i, label: "roasters" },
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
  const occurrences = args.filter((arg) =>
    arg === `--${flagName}` || arg.startsWith(`--${flagName}=`)
  );
  if (occurrences.length > 1) {
    return { present: true, affirmative: false, error: `Repeated --${flagName} is not allowed.` };
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === `--${flagName}`) {
      // Check if following argument is a value instead of another flag
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        if (next === "true" || next === "yes" || next === "1") {
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
      const val = arg.slice(flagName.length + 3);
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
 * A single matching category is deterministic. Zero or competing categories
 * require the running agent's contextual LLM classification (D-78).
 */
export function classifyVenue(venue: VenueRecord): ClassificationMatch {
  const matches = new Map<CanonicalVenueType, string>();
  const legacyType = (venue.type || "").trim();
  if (legacyType) {
    const ltLower = legacyType.toLowerCase();
    if (ltLower === "originals" || ltLower === "listening room" || ltLower === "theater") {
      matches.set("Originals", `legacy type "${legacyType}"`);
    }
    if (
      ltLower === "brewery" || ltLower === "pub" || ltLower === "festival" ||
      ltLower === "farmersmarket" || ltLower === "tavern" ||
      ltLower === "taproom" || ltLower === "winery" || ltLower === "vineyard" ||
      ltLower === "pubfestivalbrewery"
    ) {
      matches.set("PubFestivalBrewery", `legacy type "${legacyType}"`);
    }
    if (
      ltLower === "coffeeshop" || ltLower === "cafe" || ltLower === "bar/restaurant" ||
      ltLower === "restaurant" || ltLower === "midrangecafebar"
    ) {
      matches.set("MidRangeCafeBar", `legacy type "${legacyType}"`);
    }
  }

  const name = (venue.name || "").trim();
  const genreText = Array.isArray(venue.genre)
    ? venue.genre.join(" ")
    : (typeof venue.genre === "string" ? venue.genre : "");
  const notesText = (venue.notes || "") + " " + (venue.description || "");

  const categories: Array<[CanonicalVenueType, typeof ORIGINALS_PATTERNS]> = [
    ["Originals", ORIGINALS_PATTERNS],
    ["PubFestivalBrewery", PUB_BREWERY_PATTERNS],
    ["MidRangeCafeBar", CAFE_BAR_PATTERNS],
  ];
  const fields = [["name", name], ["genre", genreText], ["notes", notesText], ["type", legacyType]];
  for (const [type, patterns] of categories) {
    for (const [field, text] of fields) {
      const match = patterns.find(({ pattern }) => pattern.test(text));
      if (match && !matches.has(type)) {
        matches.set(type, `${field} keyword "${match.label}"`);
      }
    }
  }
  if (matches.size === 1) {
    const [type, reason] = [...matches][0];
    return { type, reason };
  }
  return {
    type: null,
    reason: matches.size
      ? `competing categories (${
        [...matches.keys()].join(", ")
      }); contextual LLM classification required`
      : "no keyword match; contextual LLM classification required",
  };
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

  const data: unknown = await res.json();
  let records: unknown = data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    records = obj.venues ?? obj.data;
  }
  if (!Array.isArray(records)) throw new Error("GET /venue returned an invalid venue list.");
  const ids = new Set<string>();
  for (const value of records) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("GET /venue returned an invalid venue record.");
    }
    const record = value as Record<string, unknown>;
    if (typeof record._id !== "string" || !record._id.trim() || ids.has(record._id)) {
      throw new Error("GET /venue returned a missing or duplicate venue ID.");
    }
    ids.add(record._id);
    for (
      const field of [
        "name",
        "city",
        "usState",
        "type",
        "venueType",
        "notes",
        "description",
        "website",
        "status",
      ]
    ) {
      if (record[field] != null && typeof record[field] !== "string") {
        throw new Error(`GET /venue returned an invalid ${field} field.`);
      }
    }
    if (
      record.genre != null && typeof record.genre !== "string" &&
      !(Array.isArray(record.genre) && record.genre.every((genre) => typeof genre === "string"))
    ) throw new Error("GET /venue returned an invalid genre field.");
  }
  return records as VenueRecord[];
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
  const url = `${baseUrl.replace(/\/+$/, "")}/venue/${encodeURIComponent(venueId)}`;
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
    `| #   | Venue Name                      | City               | Current Type | Proposed Type      | Matched Rule / Reason`;
  const divider =
    `|-----|---------------------------------|--------------------|--------------|--------------------|-----------------------------------`;
  lines.push(header);
  lines.push(divider);

  for (let i = 0; i < proposed.length; i++) {
    const item = proposed[i];
    const num = String(i + 1).padEnd(3);
    const name = (item.name || "Unknown").padEnd(31);
    const city = (item.city || "(unknown)").padEnd(18);
    const current = (item.currentType || "(unset)").padEnd(12);
    const proposedType = (item.proposedType ?? "(needs context)").padEnd(18);
    const reason = item.reason;
    lines.push(`| ${num} | ${name} | ${city} | ${current} | ${proposedType} | ${reason}`);
  }

  return lines.join("\n");
}

/**
 * Executes backfill analysis and optional PATCH dispatch.
 */
export async function runBackfill(options: BackfillOptions = {}): Promise<BackfillResult> {
  for (const value of [options.apply, options.overwrite]) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error("Apply and overwrite options must be boolean.");
    }
  }
  const logger = options.logger || console;
  const baseUrl = options.backendUrl || Deno.env.get("WEB_JAM_BACK_URL") || DEFAULT_BACKEND_URL;
  const token = options.token !== undefined ? (options.token || null) : resolveToken();
  const fetchFn = options.fetchFn || fetch;
  const apply = Boolean(options.apply);
  const overwrite = Boolean(options.overwrite);
  const contextualTypes = validateContextualClassifications(
    options.contextualTypes === undefined ? [] : options.contextualTypes,
  );

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
  const contextRequests: ContextRequest[] = [];
  const decisions = new Map(contextualTypes.map((decision) => [decision.venueId, decision]));
  for (const v of targetVenues) {
    const current = v.venueType ? String(v.venueType).trim() : null;
    let match = classifyVenue(v);
    const decision = decisions.get(v._id);
    if (decision || !match.type) {
      const request = await createContextRequest(v);
      if (decision) {
        if (decision.contextHash !== request.contextHash) {
          throw new Error(`Context changed for venue ${v._id}; rerun contextual classification.`);
        }
        if (match.type) {
          throw new Error(
            `Venue ${v._id} has a deterministic classification; remove its contextual override.`,
          );
        }
        match = {
          type: decision.type,
          reason: `contextual LLM classification: ${decision.reason}`,
        };
        decisions.delete(v._id);
      } else {
        contextRequests.push(request);
      }
    }

    // If overwrite mode, only include if current differs from proposed
    if (overwrite && current === match.type) {
      continue;
    }

    proposed.push({
      venueId: String(v._id),
      name: v.name || "Unknown",
      city: v.city,
      currentType: current,
      proposedType: match.type,
      reason: match.reason,
      isOverwritten: Boolean(current && current !== match.type),
    });
  }
  if (decisions.size) {
    throw new Error("Contextual classifications include venues outside the current target batch.");
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
  if (contextRequests.length) {
    logger.log(
      `${contextRequests.length} venues require contextual LLM classification. No default type is assigned.`,
    );
    logger.log(
      "Export with --context-json; ask the running agent to infer types from this context, then supply --contextual-types <JSON>.",
    );
  }
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
        contextRequests,
      };
    }

    if (contextRequests.length) {
      throw new Error(
        "Backfill refused: resolve every contextual classification before applying the batch.",
      );
    }
    const confirmed = await (options.confirmProposal ?? confirmProposalInteractively)(proposed);
    if (confirmed !== true) {
      throw new Error(
        "Backfill refused: the displayed proposal was not confirmed. No records were written.",
      );
    }

    logger.log(`Applying venueType classifications to ${proposed.length} venues...`);
    for (const item of proposed) {
      try {
        if (!item.proposedType) throw new Error("Unresolved venue classification.");
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
    contextRequests,
  };
}

/** Confirmation applies to the freshly printed batch, never an earlier preview. */
export function confirmProposalInteractively(proposed: readonly ClassificationResult[]): boolean {
  if (!Deno.stdin.isTerminal()) return false;
  return prompt(
    `Apply all ${proposed.length} displayed venue classifications? Type yes to confirm:`,
  ) === "yes";
}

/**
 * Entrypoint for CLI invocations.
 */
export async function runBackfillCli(
  args: string[],
  deps: {
    logger?: { log: (msg: string) => void; error: (msg: string) => void };
    fetchFn?: typeof fetch;
    confirmProposal?: BackfillOptions["confirmProposal"];
  } = {},
): Promise<number> {
  const logger = deps.logger || console;

  if (args.includes("--help") || args.includes("-h")) {
    logger.log(
      `Usage: deno task venue-tag:backfill-types [options]

Queries unvetted venues (!venueType) from GET /venue, classifies them into
canonical types (PubFestivalBrewery, MidRangeCafeBar, Originals), and displays
a formatted preview table by default. Ambiguous or unmatched venues require
contextual LLM decisions from the running agent. --apply displays the fresh
proposal and requires an interactive yes before sending any PATCH requests.

Options:
  --apply                Confirm the displayed proposal, then PATCH /venue/:id
  --dry-run              Preview only (default; cannot combine with --apply)
  --overwrite            Allow overwriting existing venueType values if different
  --context-json         Export unresolved venue context as JSON (preview only)
  --contextual-types <JSON>  Agent-inferred [{venueId, contextHash, type, reason}]
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

  try {
    const values = new Map<string, string>();
    let contextJson = false;
    let dryRun = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (/^--(?:apply|overwrite)(?:=|$)/.test(arg)) {
        if (!arg.includes("=") && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) i++;
      } else if (arg === "--dry-run") {
        dryRun = true;
      } else if (arg === "--context-json") {
        contextJson = true;
      } else {
        const equal = arg.indexOf("=");
        const name = equal < 0 ? arg : arg.slice(0, equal);
        if (!["--backend-url", "--token", "--contextual-types"].includes(name)) {
          throw new Error(
            "Unknown option or unexpected argument. Use --help for supported options.",
          );
        }
        const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
        if (!value || value.startsWith("--") || values.has(name)) {
          throw new Error(`Provide exactly one nonempty value for ${name}.`);
        }
        values.set(name, value);
      }
    }
    if (applyFlag.affirmative && (dryRun || contextJson)) {
      throw new Error("--apply cannot be combined with --dry-run or --context-json.");
    }
    const contextualTypes = values.has("--contextual-types")
      ? parseContextualClassifications(values.get("--contextual-types")!)
      : [];
    const result = await runBackfill({
      apply: applyFlag.affirmative,
      overwrite: overwriteFlag.affirmative,
      backendUrl: values.get("--backend-url"),
      token: values.get("--token"),
      contextualTypes,
      fetchFn: deps.fetchFn,
      confirmProposal: deps.confirmProposal,
      logger: contextJson ? { log: () => {}, error: (message) => logger.error(message) } : logger,
    });
    if (contextJson) logger.log(JSON.stringify(result.contextRequests, null, 2));
    return 0;
  } catch (err) {
    logger.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
