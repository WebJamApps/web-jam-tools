/**
 * check_business_deadline_reminder.ts — Web Jam LLC business deadline reminder.
 *
 * Reads the deadline list from $BUSINESS_DEADLINES_PATH (or
 * $WEB_JAM_LLC_DEADLINES_PATH or default Dropbox location) and outputs a
 * SessionStart systemMessage JSON line when deadlines are due or overdue.
 */

export interface DeadlineEntry {
  item: string;
  dueDate: string;
  amount?: string;
  wherePaid?: string;
  warnDays: number;
  lastPaidDate?: string;
  confirmation?: string;
  paidThrough?: string;
}

export interface MalformedEntry {
  item: string;
  reason: string;
}

export interface ParseResult {
  entries: DeadlineEntry[];
  malformed: MalformedEntry[];
}

export interface EvaluatedDeadline {
  entry: DeadlineEntry;
  diffDays: number;
}

export interface EvaluationResult {
  due: EvaluatedDeadline[];
  malformed: MalformedEntry[];
}

export function isValidDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function cleanCell(cell: string | undefined): string {
  return (cell ?? "").trim();
}

function isAbsentValue(val: string | undefined): boolean {
  if (!val) return true;
  const lower = val.trim().toLowerCase();
  return lower === "" || lower === "-" || lower === "none" || lower === "n/a" || lower === "unpaid";
}

const DEFAULT_WARN_DAYS = 30;

// What may follow a leading date or year: nothing, whitespace, `.`, `,`, `;`,
// `—`, a parenthetical note, or a `-` that does not continue the number.
const NOTE_BOUNDARY = /^(?:$|\s|[.,;—(]|-(?!\d))/;

/** A leading valid YYYY-MM-DD date with an optional trailing note, else null. */
export function parseDateField(raw: string): string | null {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})([\s\S]*)$/);
  if (!m || !NOTE_BOUNDARY.test(m[2]) || !isValidDate(m[1])) return null;
  return m[1];
}

/** A leading valid YYYY-MM-DD date or YYYY year with an optional trailing note, else null. */
export function parsePaidThrough(raw: string): string | null {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2}|\d{4})([\s\S]*)$/);
  if (!m || !NOTE_BOUNDARY.test(m[2])) return null;
  if (m[1].length === 4) return m[1];
  return isValidDate(m[1]) ? m[1] : null;
}

/** A non-negative integer optionally followed by `day`, `days`, `days ahead` or `days before`, else null. */
export function parseWarnDays(raw: string): number | null {
  const m = raw.match(/^(\d+)(?:\s+days?(?:\s+(?:ahead|before))?)?$/i);
  return m ? parseInt(m[1], 10) : null;
}

interface RawFields {
  dueDate?: string;
  amount?: string;
  wherePaid?: string;
  warnDays?: string;
  lastPaidDate?: string;
  confirmation?: string;
  paidThrough?: string;
}

/** Validates one entry's raw fields; table rows and heading blocks share it. */
function buildEntry(item: string, raw: RawFields): DeadlineEntry | MalformedEntry {
  const dueRaw = cleanCell(raw.dueDate);
  if (!dueRaw) return { item, reason: "missing due date" };
  const dueDate = parseDateField(dueRaw);
  if (!dueDate) return { item, reason: `invalid due date: '${dueRaw}'` };

  const warnRaw = cleanCell(raw.warnDays);
  let warnDays = DEFAULT_WARN_DAYS;
  if (!isAbsentValue(warnRaw)) {
    const parsed = parseWarnDays(warnRaw);
    if (parsed === null) return { item, reason: `invalid warn days: '${warnRaw}'` };
    warnDays = parsed;
  }

  const lastPaidRaw = cleanCell(raw.lastPaidDate);
  let lastPaidDate: string | undefined;
  if (!isAbsentValue(lastPaidRaw)) {
    const parsed = parseDateField(lastPaidRaw);
    if (!parsed) return { item, reason: `invalid last paid date: '${lastPaidRaw}'` };
    lastPaidDate = parsed;
  }

  const paidThroughRaw = cleanCell(raw.paidThrough);
  let paidThrough: string | undefined;
  if (!isAbsentValue(paidThroughRaw)) {
    const parsed = parsePaidThrough(paidThroughRaw);
    if (!parsed) return { item, reason: `invalid paid through: '${paidThroughRaw}'` };
    paidThrough = parsed;
  }

  const optional = (v: string | undefined) => {
    const c = cleanCell(v);
    return isAbsentValue(c) ? undefined : c;
  };
  return {
    item,
    dueDate,
    amount: optional(raw.amount),
    wherePaid: optional(raw.wherePaid),
    warnDays,
    lastPaidDate,
    confirmation: optional(raw.confirmation),
    paidThrough,
  };
}

const BLOCK_KEYS: Record<string, keyof RawFields> = {
  "due": "dueDate",
  "due date": "dueDate",
  "when": "dueDate",
  "amount": "amount",
  "where": "wherePaid",
  "where paid": "wherePaid",
  "warn": "warnDays",
  "warn days": "warnDays",
  "last paid": "lastPaidDate",
  "last paid date": "lastPaidDate",
  "last payment": "lastPaidDate",
  "paid": "lastPaidDate",
  "confirmation": "confirmation",
  "conf": "confirmation",
  "paid through": "paidThrough",
  "paid cycle": "paidThrough",
  "paid for": "paidThrough",
};

/**
 * Parses markdown text into deadline entries and flags malformed rows.
 */
export function parseDeadlines(markdown: string): ParseResult {
  const entries: DeadlineEntry[] = [];
  const malformed: MalformedEntry[] = [];

  const record = (item: string, raw: RawFields) => {
    const result = buildEntry(item, raw);
    if ("reason" in result) malformed.push(result);
    else entries.push(result);
  };

  const lines = markdown.split(/\r?\n/);
  let currentBlockItem: string | null = null;
  let currentBlockData: RawFields = {};

  const flushBlock = () => {
    if (!currentBlockItem) return;
    record(currentBlockItem, currentBlockData);
    currentBlockItem = null;
    currentBlockData = {};
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Check for table row
    if (line.startsWith("|") && line.endsWith("|")) {
      flushBlock();
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());

      // Skip separator row
      if (cells.every((c) => /^[-:\s]+$/.test(c))) {
        continue;
      }

      // Check for header row
      const firstLower = cells[0].toLowerCase();
      if (firstLower === "item" || firstLower === "what is due" || firstLower === "name") {
        continue;
      }

      // Table data row
      const item = cleanCell(cells[0]);
      if (!item) {
        continue; // empty item row
      }

      if (cells.length < 2) {
        malformed.push({ item, reason: "insufficient columns in table row" });
        continue;
      }

      record(item, {
        dueDate: cells[1],
        amount: cells[2],
        wherePaid: cells[3],
        warnDays: cells[4],
        lastPaidDate: cells[5],
        confirmation: cells[6],
        paidThrough: cells[7],
      });
      continue;
    }

    // Header starting block format
    const headerMatch = line.match(/^#{2,4}\s+(.+)$/);
    if (headerMatch) {
      flushBlock();
      currentBlockItem = headerMatch[1].trim();
      currentBlockData = {};
      continue;
    }

    // Key-value bullets inside block format. The key's `*`/`_` emphasis is
    // stripped whether the colon sits outside (`**Due**:`) or inside (`**Due:**`).
    if (currentBlockItem && line.startsWith("-")) {
      const kvMatch = line.match(/^-\s*([^:]+):(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].replace(/[*_]/g, "").trim().toLowerCase();
        // Own keys only: a label such as "Constructor" must not resolve to an
        // Object.prototype property.
        const field = Object.hasOwn(BLOCK_KEYS, key) ? BLOCK_KEYS[key] : undefined;
        if (field) {
          currentBlockData[field] = kvMatch[2].replace(/^[*_]+/, "").trim();
        }
      }
    }
  }

  flushBlock();
  return { entries, malformed };
}

/**
 * Evaluates parsed deadlines against the current date.
 */
export function evaluateDeadlines(
  parseResult: ParseResult,
  now: Date,
): EvaluationResult {
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const due: EvaluatedDeadline[] = [];

  for (const entry of parseResult.entries) {
    const [y, m, d] = entry.dueDate.split("-").map(Number);
    const dueUtc = new Date(Date.UTC(y, m - 1, d));
    const diffDays = Math.round(
      (dueUtc.getTime() - todayUtc.getTime()) / (86400 * 1000),
    );

    let isPaid = false;
    if (entry.paidThrough && !isAbsentValue(entry.paidThrough)) {
      if (isValidDate(entry.paidThrough)) {
        isPaid = entry.paidThrough >= entry.dueDate;
      } else if (/^\d{4}$/.test(entry.paidThrough)) {
        isPaid = parseInt(entry.paidThrough, 10) >= y;
      }
    } else if (entry.lastPaidDate && !isAbsentValue(entry.lastPaidDate)) {
      const [py, pm, pd] = entry.lastPaidDate.split("-").map(Number);
      const paidUtc = new Date(Date.UTC(py, pm - 1, pd));
      // For yearly obligations, the previous cycle was due 1 year prior (handling Feb 29 leap years)
      const prevDay = (m === 2 && d === 29) ? 28 : d;
      const prevDueUtc = new Date(Date.UTC(y - 1, m - 1, prevDay));

      // Any payment strictly after the previous cycle's due date belongs to the
      // current due cycle, regardless of whether paid days or months in advance.
      // Payments on or before the previous cycle's due date belong to the prior obligation.
      if (paidUtc.getTime() > prevDueUtc.getTime()) {
        isPaid = true;
      }
    }

    const isOverdue = diffDays < 0;
    const inWindow = diffDays <= entry.warnDays;

    if (isOverdue) {
      if (!isPaid) {
        due.push({ entry, diffDays });
      }
    } else if (inWindow) {
      if (!isPaid) {
        due.push({ entry, diffDays });
      }
    }
  }

  return { due, malformed: parseResult.malformed };
}

/**
 * Formats evaluation results into a human-readable reminder string.
 * Returns null if no deadlines are due and no entries are malformed.
 */
export function formatDeadlineReminder(evaluation: EvaluationResult): string | null {
  const { due, malformed } = evaluation;
  if (due.length === 0 && malformed.length === 0) {
    return null;
  }

  const lines: string[] = [];

  for (const { entry, diffDays } of due) {
    let timing = "";
    if (diffDays === 0) {
      timing = "due today";
    } else if (diffDays > 0) {
      timing = `due in ${diffDays} day${diffDays === 1 ? "" : "s"}`;
    } else {
      const overdue = Math.abs(diffDays);
      timing = `${overdue} day${overdue === 1 ? "" : "s"} overdue`;
    }

    let itemPart = entry.item;
    if (entry.amount && !isAbsentValue(entry.amount)) {
      itemPart += ` (${entry.amount})`;
    }

    let line = `${itemPart} is ${timing} (${entry.dueDate})`;
    if (entry.wherePaid && !isAbsentValue(entry.wherePaid)) {
      line += ` at ${entry.wherePaid}`;
    }
    lines.push(line);
  }

  for (const err of malformed) {
    lines.push(`Malformed entry: "${err.item}" (${err.reason})`);
  }

  if (lines.length === 1) {
    return `Web Jam LLC deadline: ${lines[0]}`;
  }
  return `Web Jam LLC deadlines:\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

/**
 * Main routine: resolves file path, reads, parses, evaluates, and formats.
 */
export function checkBusinessDeadlineReminder(options?: {
  filePath?: string;
  now?: Date;
}): string | null {
  const filePath = options?.filePath ??
    Deno.env.get("BUSINESS_DEADLINES_PATH") ??
    Deno.env.get("WEB_JAM_LLC_DEADLINES_PATH") ??
    `${Deno.env.get("HOME")}/Dropbox/web-jam-llms/songwriting/web-jam-llc-deadlines.md`;

  let now = options?.now;
  if (!now) {
    const envNow = Deno.env.get("BUSINESS_DEADLINES_NOW");
    if (envNow && isValidDate(envNow)) {
      const [y, m, d] = envNow.split("-").map(Number);
      now = new Date(Date.UTC(y, m - 1, d));
    } else {
      now = new Date();
    }
  }

  let content: string;
  try {
    content = Deno.readTextFileSync(filePath);
  } catch {
    // Missing or unreadable list file is silent
    return null;
  }

  const parsed = parseDeadlines(content);
  const evaluated = evaluateDeadlines(parsed, now);
  return formatDeadlineReminder(evaluated);
}

if (import.meta.main) {
  try {
    const reminder = checkBusinessDeadlineReminder();
    if (reminder !== null) {
      console.log(JSON.stringify({ systemMessage: reminder }));
    }
  } catch {
    // Silently proceed on unexpected error to never block session start
  }
}
