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
  /** Stable 1-based row number assigned at detection time, before any filtering. */
  index?: number;
  venueId: string;
  venueName: string;
  city: string;
  usState: string;
  touchType: TouchType;
  date: string; // YYYY-MM-DD or ""
  sentence: string;
  /** Set when the row is reported but never written (e.g. the venue already carries a touch of this type). */
  suppressed?: string;
  /** Set when the date came from --date rather than from the note itself. */
  dateSuppliedByFlag?: boolean;
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
  /** Rows shown in the approval table (dated and undated alike, never suppressed rows). */
  proposals: TouchProposal[];
  /** Rows detected but not proposable — reported so the decision stays visible. */
  suppressed: TouchProposal[];
  /** Proposed rows carrying no date: never written, reported so a date can be supplied. */
  skippedNoDate: TouchProposal[];
  applied: AppliedTouchResult[];
  summary: string;
}

export interface TouchConversionOptions extends BackendConfigOptions {
  apply?: boolean;
  venues?: VenueNotesRecord[];
  actor?: string;
  filterVenues?: string[];
  skipVenues?: string[];
  /** `<index|venueId|name fragment>=YYYY-MM-DD` entries filling the date on undated proposals. */
  dates?: string[];
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
 * Phone conversation patterns. Case-insensitive: every alternative names the phone explicitly.
 */
export const PHONE_CONVERSATION_RE =
  /\b(?:spoke\s+(?:on(?: the)?|by|over the)\s+phone|talked\s+(?:on(?: the)?|by|over the)\s+phone|phone\s+call\s+(?:successful|confirmed|with)|phone\s+conversation|called\s+(?:and spoke|them and spoke)|left voicemail)\b/i;

/**
 * "Spoke to <Name>" as evidence of a real conversation. Deliberately case-SENSITIVE on the name:
 * a capitalized proper name is the whole signal. Under /i this alternative matched "spoke with the
 * owner" and "spoke with the manager while I was there", classifying an in-person chat as a call.
 */
export const PHONE_CONVERSATION_NAME_RE = /\b[Ss]poke\s+(?:to|with)\s+[A-Z][a-z]+\b/;

/** True when the sentence records an actual phone conversation. */
export function isPhoneConversation(sentence: string): boolean {
  return PHONE_CONVERSATION_RE.test(sentence) || PHONE_CONVERSATION_NAME_RE.test(sentence);
}

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
 * A row the venue's existing touches already cover comes back marked `suppressed` — reported but
 * never written — unless it is an exact same-date duplicate, which returns null.
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

    if (PHONE_NUMBER_LABEL_RE.test(trimmedLine)) continue;

    // Split line into sentences (period followed by space, or semicolon).
    // Legacy spreadsheet metadata is discarded per sentence, not per line: imported rows routinely
    // concatenate metadata and prose ("Date called: 2026-05-09. Spoke on the phone with Liza."),
    // and dropping the whole line would lose the real conversation with it.
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
      } else if (!candidateCall && isPhoneConversation(s)) {
        const date = extractDateFromText(s) || extractDateFromText(trimmedLine);
        candidateCall = { sentence: s, date };
      }
    }
  }

  // Visit takes precedence over call
  const chosen = candidateVisit || candidateCall;
  if (!chosen) return null;

  const touchType: TouchType = candidateVisit ? "visit" : "call";
  const proposal: TouchProposal = {
    venueId: String(venue._id || venue.id || ""),
    venueName: String(venue.name || "Unknown Venue"),
    city: String(venue.city || ""),
    usState: String(venue.usState || ""),
    touchType,
    date: chosen.date,
    sentence: chosen.sentence,
  };

  if (hasExistingTouch(venue, touchType, chosen.date)) {
    // Same type, same date — a genuine duplicate, nothing to decide.
    if (chosen.date) return null;
    // Undated, and the venue carries some other touch of this type. That is a judgement call, so
    // report it rather than dropping it out of the table silently.
    return { ...proposal, suppressed: `venue already has a ${touchType} touch` };
  }

  return proposal;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when the string is a real calendar date in YYYY-MM-DD form. */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** True when the selector (stable row number, venue id, or name fragment) picks out this proposal. */
function matchesSelector(proposal: TouchProposal, selector: string): boolean {
  const s = selector.toLowerCase().trim();
  return s === String(proposal.index ?? "") ||
    s === proposal.venueId.toLowerCase() ||
    proposal.venueName.toLowerCase().includes(s);
}

/**
 * Fills in dates supplied on the command line as `<index|venueId|name fragment>=YYYY-MM-DD`.
 * Throws on a malformed entry, an impossible date, or a selector matching no row — a typo must not
 * quietly leave a row undated on a one-time write.
 */
export function applyDateFills(
  proposals: TouchProposal[],
  fills: string[],
): TouchProposal[] {
  const result = proposals.map((p) => ({ ...p }));

  for (const raw of fills) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.lastIndexOf("=");
    if (eq <= 0 || eq === entry.length - 1) {
      throw new Error(
        `Invalid --date entry "${entry}". Expected <index|venueId|name fragment>=YYYY-MM-DD.`,
      );
    }
    const selector = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (!isValidIsoDate(value)) {
      throw new Error(`Invalid --date value "${value}" in "${entry}". Expected YYYY-MM-DD.`);
    }

    const matched = result.filter((p) => matchesSelector(p, selector));
    if (matched.length === 0) {
      throw new Error(`--date selector "${selector}" matched no proposed row.`);
    }
    for (const p of matched) {
      p.date = value;
      p.dateSuppliedByFlag = true;
    }
  }

  return result;
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
    const num = String(p.index ?? idx + 1).padEnd(3);
    const name = p.venueName.slice(0, 28).padEnd(28);
    const loc = [p.city, p.usState].filter(Boolean).join(", ").slice(0, 20).padEnd(20);
    const type = p.touchType.slice(0, 10).padEnd(10);
    const date = (p.date || "— none").slice(0, 10).padEnd(10);
    const sentence = p.sentence.replace(/\r?\n/g, " ").slice(0, 54).padEnd(54);
    lines.push(`│ ${num} │ ${name} │ ${loc} │ ${type} │ ${date} │ ${sentence} │`);
  });

  lines.push(
    `└─────┴──────────────────────────────┴──────────────────────┴────────────┴────────────┴────────────────────────────────────────────────────────┘`,
  );

  return lines.join("\n");
}

/**
 * Propose-then-write pipeline: scans venues, outputs single proposal table, and writes via
 * POST /venue/:id/touch ONLY when options.apply is true.
 * A row carrying no date is never written: the backend defaults a missing date to Date.now, which
 * would stamp the record with the day the script ran rather than the day anything happened.
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

  // 1. Propose touches across all venues, numbering every detected row once so the numbers Josh
  //    reads in the table stay stable under --venues / --skip / --date.
  const detected: TouchProposal[] = [];
  for (const v of rawVenues) {
    const proposal = detectVenueConversationTouch(v);
    if (proposal) {
      detected.push({ ...proposal, index: detected.length + 1 });
    }
  }
  const suppressed = detected.filter((p) => p.suppressed);
  let allProposals = detected.filter((p) => !p.suppressed);

  // 2. Fill any dates supplied on the command line, before filtering, so --date selectors refer to
  //    the same row numbers as the table.
  if (options.dates && options.dates.length > 0) {
    allProposals = applyDateFills(allProposals, options.dates);
  }

  // 3. Filter / skip if options provided — matched against the stable row number.
  let filtered = allProposals;
  if (options.filterVenues && options.filterVenues.length > 0) {
    const filters = options.filterVenues.map((f) => f.toLowerCase().trim());
    filtered = filtered.filter((p) => filters.some((f) => matchesSelector(p, f)));
  }

  if (options.skipVenues && options.skipVenues.length > 0) {
    const skips = options.skipVenues.map((s) => s.toLowerCase().trim());
    filtered = filtered.filter((p) => !skips.some((s) => matchesSelector(p, s)));
  }

  const tableStr = renderProposalsTable(filtered);
  console.log("\n======================================================");
  console.log("  📞 book-gig: Venue Conversation Touch Conversion (D-68)");
  console.log("======================================================");
  console.log(`Proposed Contact Touches from Venue Notes (${filtered.length} found):\n`);
  console.log(tableStr);

  const suppliedDates = filtered.filter((p) => p.dateSuppliedByFlag);
  if (suppliedDates.length > 0) {
    console.log("\nDates supplied with --date (not read from the note):");
    for (const p of suppliedDates) {
      console.log(`  #${p.index} ${p.venueName} → ${p.date}`);
    }
  }

  if (suppressed.length > 0) {
    console.log(`\nSuppressed (${suppressed.length}) — reported, never written:`);
    for (const p of suppressed) {
      console.log(
        `  #${p.index} ${p.venueName}: ${p.suppressed} — proposed ${p.touchType} from "${p.sentence}"`,
      );
    }
  }

  const skippedNoDate = filtered.filter((p) => !p.date);
  if (skippedNoDate.length > 0) {
    console.log(
      `\n⚠ ${skippedNoDate.length} row(s) carry no date and will NOT be written — the record would` +
        ` otherwise be stamped with today's date, which is not when the conversation happened.`,
    );
    for (const p of skippedNoDate) {
      console.log(`  #${p.index} ${p.venueName} — supply one with --date "${p.index}=YYYY-MM-DD"`);
    }
  }

  const applied: AppliedTouchResult[] = [];
  const writable = filtered.filter((p) => p.date);

  // 4. Propose-only / Dry Run check
  if (!options.apply) {
    let summary =
      `Dry run: proposed ${filtered.length} touches across ${filtered.length} venues. No touches were written. To write these touches, run with --apply (or --approve).`;
    if (skippedNoDate.length > 0) {
      summary +=
        ` ${skippedNoDate.length} of them carry no date and will be skipped until a date is supplied with --date.`;
    }
    console.log(`\n[dry-run] ${summary}\n`);
    return {
      proposals: filtered,
      suppressed,
      skippedNoDate,
      applied: [],
      summary,
    };
  }

  // 5. Approved write execution — dated rows only
  console.log(`\nApplying ${writable.length} approved touches to backend...`);
  const actor = options.actor || "Josh";

  for (const p of writable) {
    const touchUrl = `${baseUrl}/venue/${p.venueId}/touch`;
    const payload: Record<string, unknown> = {
      type: p.touchType,
      note: p.sentence,
      actor,
      date: `${p.date}T00:00:00.000Z`,
    };

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
  let summary = `Successfully wrote ${successCount} of ${applied.length} approved touches.`;
  if (skippedNoDate.length > 0) {
    summary +=
      ` Skipped ${skippedNoDate.length} undated row(s) — supply a date with --date and re-run.`;
  }
  console.log(`\n[touch-conversion] ${summary}\n`);

  return {
    proposals: filtered,
    suppressed,
    skippedNoDate,
    applied,
    summary,
  };
}

if (import.meta.main) {
  const flags = parseArgs(Deno.args, {
    boolean: ["apply", "approve", "dry-run", "help"],
    string: ["venues", "skip", "backend-url", "token", "actor", "date"],
    collect: ["date"],
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
A proposal with no date in the note is reported but never written — supply the date with --date.

Options:
  --apply, --approve       Apply the approved touches via POST /venue/:id/touch
  --dry-run                Preview proposals without writing (default)
  --venues <list>          Comma-separated venue IDs, names, or row numbers to process
  --skip <list>            Comma-separated venue IDs, names, or row numbers to skip
  --date <sel>=<date>      Fill an undated row's date, e.g. --date "3=2026-05-18"
                           (repeatable; <sel> is a row number, venue ID, or name fragment)
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
  const dates = (flags.date as string[] | undefined)?.filter(Boolean);

  try {
    await executeTouchConversion({
      apply,
      backendUrl: flags["backend-url"],
      token: flags.token,
      actor: flags.actor,
      filterVenues,
      skipVenues,
      dates,
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}
