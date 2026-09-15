// src/book-gig/convert_touches.ts
// One-time script converting conversations recorded in venue notes into call and visit contact-history entries (D-68 / web-jam-tools#1006)

import { parseArgs } from "@std/cli/parse-args";
import { type BackendConfigOptions, buildHeaders, resolveBackendConfig } from "./outreach_api.ts";

export type TouchType = "call" | "visit";

export interface VenueNotesRecord {
  _id?: unknown;
  id?: string;
  name?: string;
  city?: string;
  usState?: string;
  status?: string;
  notes?: string;
  priorContactNotes?: string;
  bookingNotes?: string;
  contactNotes?: string;
  touches?: Array<{
    type?: string;
    date?: string | Date;
    note?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface TouchProposal {
  venueId: string;
  venueName: string;
  city: string;
  usState: string;
  touchType: TouchType;
  date: string; // YYYY-MM-DD or ""
  sentence: string;
}

export interface AppliedTouchResult {
  venueId: string;
  venueName: string;
  touchType: TouchType;
  date: string;
  sentence: string;
  success: boolean;
  error?: string;
}

export interface TouchConversionResult {
  proposals: TouchProposal[];
  applied: AppliedTouchResult[];
  summary: string;
}

export interface TouchConversionOptions extends BackendConfigOptions {
  apply?: boolean;
  venues?: VenueNotesRecord[];
  actor?: string;
  filterVenues?: string[];
  skipVenues?: string[];
}

/**
 * Prefix regex identifying legacy spreadsheet metadata lines that must be ignored.
 */
export const LEGACY_METADATA_LINE_RE =
  /^\s*(?:Date called|Status(?:\s*\(sheet\))?|Type of gig|Callback)\s*:/im;

/**
 * Line or sentence segment that is purely a phone contact number label.
 */
export const PHONE_NUMBER_LABEL_RE =
  /^\s*(?:cell|phone|tel|taproom phone|direct phone)\s*:\s*[\d\(\)\-\.\s]+/i;

/**
 * Phrases indicating instructions or hypothetical mentions rather than actual recorded conversations.
 */
export const NON_CONVERSATION_INSTRUCTION_RE =
  /\b(?:to book|to ask|would be better|need to (?:call|text)|will call|please call|should call|phone-only contact|booking requires phone|books in-person or via facebook)\b/i;

/**
 * In-person conversation or visit patterns.
 */
export const IN_PERSON_CONVERSATION_RE =
  /\b(?:in[- ]person visit|visited?\s+(?:in[- ]person|the venue|them)|spoke\s+(?:in[- ]person|at the venue)|talked\s+(?:in[- ]person|at the venue)|met\s+in[- ]person|stopped by\s+(?:in[- ]person|the venue)|after in[- ]person visit)\b/i;

/**
 * Phone conversation patterns.
 */
export const PHONE_CONVERSATION_RE =
  /\b(?:spoke\s+(?:on(?: the)?|by|over the)\s+phone|talked\s+(?:on(?: the)?|by|over the)\s+phone|phone\s+call\s+(?:successful|confirmed|with)|phone\s+conversation|called\s+(?:and spoke|them and spoke)|left voicemail|spoke\s+(?:to|with)\s+[A-Z][a-z]+)\b/i;

/**
 * Parse an ISO date or Month DD, YYYY date from text context. Returns YYYY-MM-DD or "".
 */
export function extractDateFromText(text: string): string {
  if (!text) return "";
  // 1. Check ISO YYYY-MM-DD
  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  // 2. Check Month DD, YYYY or Month DD YYYY
  const monthMap: Record<string, string> = {
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    may: "05",
    jun: "06",
    june: "06",
    jul: "07",
    july: "07",
    aug: "08",
    august: "08",
    sep: "09",
    sept: "09",
    september: "09",
    oct: "10",
    october: "10",
    nov: "11",
    november: "11",
    dec: "12",
    december: "12",
  };

  const monthMatch = text.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i,
  );
  if (monthMatch) {
    const month = monthMap[monthMatch[1].toLowerCase()];
    if (month) {
      const day = monthMatch[2].padStart(2, "0");
      const year = monthMatch[3];
      return `${year}-${month}-${day}`;
    }
  }

  return "";
}

/**
 * Checks if the venue already carries an equivalent touch in its touches array.
 */
export function hasExistingTouch(
  venue: VenueNotesRecord,
  touchType: TouchType,
  date?: string,
): boolean {
  if (!Array.isArray(venue.touches)) return false;
  return venue.touches.some((t) => {
    if (t.type !== touchType) return false;
    if (date && t.date) {
      const d = typeof t.date === "string" ? t.date : new Date(t.date).toISOString();
      return d.slice(0, 10) === date;
    }
    return true;
  });
}

/**
 * Evaluates active venue notes for genuine conversations.
 * Proposes exactly one touch per venue, with visit taking precedence over call.
 */
export function detectVenueConversationTouch(
  venue: VenueNotesRecord,
): TouchProposal | null {
  if (venue.status === "archived") return null;

  const notesList = [
    venue.notes,
    venue.priorContactNotes,
    venue.bookingNotes,
    venue.contactNotes,
  ].filter(Boolean);

  if (notesList.length === 0) return null;

  const combinedNotes = notesList.join("\n");
  if (!combinedNotes.trim()) return null;

  const lines = combinedNotes.split(/\r?\n/);

  let candidateVisit: { sentence: string; date: string } | null = null;
  let candidateCall: { sentence: string; date: string } | null = null;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // Ignore legacy spreadsheet lines
    if (LEGACY_METADATA_LINE_RE.test(trimmedLine)) continue;
    if (PHONE_NUMBER_LABEL_RE.test(trimmedLine)) continue;

    // Split line into sentences (period followed by space, or semicolon)
    const sentences = trimmedLine
      .split(/(?<=[.!?])\s+|;\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const s of sentences) {
      if (NON_CONVERSATION_INSTRUCTION_RE.test(s)) continue;
      if (LEGACY_METADATA_LINE_RE.test(s)) continue;
      if (PHONE_NUMBER_LABEL_RE.test(s)) continue;

      if (!candidateVisit && IN_PERSON_CONVERSATION_RE.test(s)) {
        const date = extractDateFromText(s) || extractDateFromText(trimmedLine);
        candidateVisit = { sentence: s, date };
      } else if (!candidateCall && PHONE_CONVERSATION_RE.test(s)) {
        const date = extractDateFromText(s) || extractDateFromText(trimmedLine);
        candidateCall = { sentence: s, date };
      }
    }
  }

  // Visit takes precedence over call
  const chosen = candidateVisit || candidateCall;
  if (!chosen) return null;

  const touchType: TouchType = candidateVisit ? "visit" : "call";
  const venueId = String(venue._id || venue.id || "");
  const venueName = String(venue.name || "Unknown Venue");
  const city = String(venue.city || "");
  const usState = String(venue.usState || "");

  // Skip if already in touches
  if (hasExistingTouch(venue, touchType, chosen.date)) {
    return null;
  }

  return {
    venueId,
    venueName,
    city,
    usState,
    touchType,
    date: chosen.date,
    sentence: chosen.sentence,
  };
}

/**
 * Format proposals into a single aligned console table.
 */
export function renderProposalsTable(proposals: TouchProposal[]): string {
  if (proposals.length === 0) {
    return "  (No conversation touches proposed from venue notes)";
  }

  const lines: string[] = [];
  lines.push(
    `┌─────┬──────────────────────────────┬──────────────────────┬────────────┬────────────┬────────────────────────────────────────────────────────┐`,
  );
  lines.push(
    `│ #   │ Venue Name                   │ Location             │ Type       │ Date       │ Source Sentence                                        │`,
  );
  lines.push(
    `├─────┼──────────────────────────────┼──────────────────────┼────────────┼────────────┼────────────────────────────────────────────────────────┤`,
  );

  proposals.forEach((p, idx) => {
    const num = String(idx + 1).padEnd(3);
    const name = p.venueName.slice(0, 28).padEnd(28);
    const loc = [p.city, p.usState].filter(Boolean).join(", ").slice(0, 20).padEnd(20);
    const type = p.touchType.slice(0, 10).padEnd(10);
    const date = (p.date || "—").slice(0, 10).padEnd(10);
    const sentence = p.sentence.replace(/\r?\n/g, " ").slice(0, 54).padEnd(54);
    lines.push(`│ ${num} │ ${name} │ ${loc} │ ${type} │ ${date} │ ${sentence} │`);
  });

  lines.push(
    `└─────┴──────────────────────────────┴──────────────────────┴────────────┴────────────┴────────────────────────────────────────────────────────┘`,
  );

  return lines.join("\n");
}

/**
 * Propose-then-write pipeline: scans venues, outputs single proposal table,
 * and writes via POST /venue/:id/touch ONLY when options.apply is true.
 */
export async function executeTouchConversion(
  options: TouchConversionOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<TouchConversionResult> {
  const { baseUrl, token } = await resolveBackendConfig(options);
  const headers = buildHeaders(token);

  let rawVenues: VenueNotesRecord[] = [];
  if (options.venues) {
    rawVenues = options.venues;
  } else {
    const res = await fetchFn(`${baseUrl}/venue`, { headers });
    if (!res.ok) {
      throw new Error(
        `Failed to fetch venues from ${baseUrl}/venue: HTTP ${res.status} ${await res.text()}`,
      );
    }
    const data = await res.json();
    if (Array.isArray(data)) {
      rawVenues = data as VenueNotesRecord[];
    } else if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      rawVenues = (obj.venues ?? obj.data ?? []) as VenueNotesRecord[];
    }
  }

  // 1. Propose touches across all venues
  const allProposals: TouchProposal[] = [];
  for (const v of rawVenues) {
    const proposal = detectVenueConversationTouch(v);
    if (proposal) {
      allProposals.push(proposal);
    }
  }

  // 2. Filter / skip if options provided
  let filtered = allProposals;
  if (options.filterVenues && options.filterVenues.length > 0) {
    const filters = options.filterVenues.map((f) => f.toLowerCase().trim());
    filtered = filtered.filter((p, idx) => {
      const idxStr = String(idx + 1);
      return filters.some(
        (f) =>
          f === idxStr ||
          f === p.venueId.toLowerCase() ||
          p.venueName.toLowerCase().includes(f),
      );
    });
  }

  if (options.skipVenues && options.skipVenues.length > 0) {
    const skips = options.skipVenues.map((s) => s.toLowerCase().trim());
    filtered = filtered.filter((p, idx) => {
      const idxStr = String(idx + 1);
      return !skips.some(
        (s) =>
          s === idxStr ||
          s === p.venueId.toLowerCase() ||
          p.venueName.toLowerCase().includes(s),
      );
    });
  }

  const tableStr = renderProposalsTable(filtered);
  console.log("\n======================================================");
  console.log("  📞 book-gig: Venue Conversation Touch Conversion (D-68)");
  console.log("======================================================");
  console.log(`Proposed Contact Touches from Venue Notes (${filtered.length} found):\n`);
  console.log(tableStr);

  const applied: AppliedTouchResult[] = [];

  // 3. Propose-only / Dry Run check
  if (!options.apply) {
    const summary =
      `Dry run: proposed ${filtered.length} touches across ${filtered.length} venues. No touches were written. To write these touches, run with --apply (or --approve).`;
    console.log(`\n[dry-run] ${summary}\n`);
    return {
      proposals: filtered,
      applied: [],
      summary,
    };
  }

  // 4. Approved write execution
  console.log(`\nApplying ${filtered.length} approved touches to backend...`);
  const actor = options.actor || "Josh";

  for (const p of filtered) {
    const touchUrl = `${baseUrl}/venue/${p.venueId}/touch`;
    const payload: Record<string, unknown> = {
      type: p.touchType,
      note: p.sentence,
      actor,
    };
    if (p.date) {
      payload.date = `${p.date}T00:00:00.000Z`;
    }

    try {
      const touchRes = await fetchFn(touchUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!touchRes.ok) {
        const errText = await touchRes.text();
        console.error(`  ✗ ${p.venueName} (${p.venueId}): HTTP ${touchRes.status} ${errText}`);
        applied.push({
          venueId: p.venueId,
          venueName: p.venueName,
          touchType: p.touchType,
          date: p.date,
          sentence: p.sentence,
          success: false,
          error: `HTTP ${touchRes.status}: ${errText}`,
        });
      } else {
        console.log(`  ✓ ${p.venueName} (${p.venueId}): ${p.touchType} touch recorded`);
        applied.push({
          venueId: p.venueId,
          venueName: p.venueName,
          touchType: p.touchType,
          date: p.date,
          sentence: p.sentence,
          success: true,
        });
      }
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`  ✗ ${p.venueName} (${p.venueId}): ${msg}`);
      applied.push({
        venueId: p.venueId,
        venueName: p.venueName,
        touchType: p.touchType,
        date: p.date,
        sentence: p.sentence,
        success: false,
        error: msg,
      });
    }
  }

  const successCount = applied.filter((a) => a.success).length;
  const summary = `Successfully wrote ${successCount} of ${applied.length} approved touches.`;
  console.log(`\n[touch-conversion] ${summary}\n`);

  return {
    proposals: filtered,
    applied,
    summary,
  };
}

if (import.meta.main) {
  const flags = parseArgs(Deno.args, {
    boolean: ["apply", "approve", "dry-run", "help"],
    string: ["venues", "skip", "backend-url", "token", "actor"],
    alias: {
      a: "apply",
      h: "help",
    },
    default: {
      apply: false,
      approve: false,
      "dry-run": false,
    },
  });

  if (flags.help) {
    console.log(`
Usage: deno task book-gig:convert-touches [options]

Converts recorded phone calls and in-person visits in venue notes into structured touches.

Options:
  --apply, --approve       Apply the approved touches via POST /venue/:id/touch
  --dry-run                Preview proposals without writing (default)
  --venues <list>          Comma-separated venue IDs, names, or indices to process
  --skip <list>            Comma-separated venue IDs, names, or indices to skip
  --actor <name>           Actor recorded on touch (default: "Josh")
  --backend-url <url>      Override backend API URL
  --token <token>          Override API Bearer token
  --help, -h               Show this help message
`);
    Deno.exit(0);
  }

  const apply = (flags.apply || flags.approve) && !flags["dry-run"];
  const filterVenues = flags.venues ? flags.venues.split(",").map((s) => s.trim()) : undefined;
  const skipVenues = flags.skip ? flags.skip.split(",").map((s) => s.trim()) : undefined;

  try {
    await executeTouchConversion({
      apply,
      backendUrl: flags["backend-url"],
      token: flags.token,
      actor: flags.actor,
      filterVenues,
      skipVenues,
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}
