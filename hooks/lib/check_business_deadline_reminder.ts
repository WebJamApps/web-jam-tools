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

/**
 * Parses markdown text into deadline entries and flags malformed rows.
 */
export function parseDeadlines(markdown: string): ParseResult {
  const entries: DeadlineEntry[] = [];
  const malformed: MalformedEntry[] = [];

  const lines = markdown.split(/\r?\n/);
  let currentBlockItem: string | null = null;
  let currentBlockData: Partial<DeadlineEntry> = {};

  const flushBlock = () => {
    if (!currentBlockItem) return;
    const item = currentBlockItem;
    const dueDate = cleanCell(currentBlockData.dueDate);
    if (!dueDate) {
      malformed.push({ item, reason: "missing due date" });
    } else if (!isValidDate(dueDate)) {
      malformed.push({ item, reason: `invalid due date: '${dueDate}'` });
    } else {
      let warnDays = 30;
      if (currentBlockData.warnDays !== undefined) {
        warnDays = currentBlockData.warnDays;
      }
      const lastPaid = cleanCell(currentBlockData.lastPaidDate);
      if (lastPaid && !isAbsentValue(lastPaid) && !isValidDate(lastPaid)) {
        malformed.push({ item, reason: `invalid last paid date: '${lastPaid}'` });
      } else {
        entries.push({
          item,
          dueDate,
          amount: currentBlockData.amount,
          wherePaid: currentBlockData.wherePaid,
          warnDays,
          lastPaidDate: lastPaid,
          confirmation: currentBlockData.confirmation,
        });
      }
    }
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

      const dueDate = cleanCell(cells[1]);
      if (!dueDate || !isValidDate(dueDate)) {
        malformed.push({ item, reason: `invalid due date: '${dueDate}'` });
        continue;
      }

      const amount = cleanCell(cells[2]);
      const wherePaid = cleanCell(cells[3]);
      const warnRaw = cleanCell(cells[4]);

      let warnDays = 30;
      if (warnRaw && !isAbsentValue(warnRaw)) {
        if (/^\d+$/.test(warnRaw)) {
          warnDays = parseInt(warnRaw, 10);
        } else {
          malformed.push({ item, reason: `invalid warn days: '${warnRaw}'` });
          continue;
        }
      }

      const lastPaidDate = cleanCell(cells[5]);
      if (lastPaidDate && !isAbsentValue(lastPaidDate) && !isValidDate(lastPaidDate)) {
        malformed.push({ item, reason: `invalid last paid date: '${lastPaidDate}'` });
        continue;
      }

      const confirmation = cleanCell(cells[6]);

      entries.push({
        item,
        dueDate,
        amount: isAbsentValue(amount) ? undefined : amount,
        wherePaid: isAbsentValue(wherePaid) ? undefined : wherePaid,
        warnDays,
        lastPaidDate: isAbsentValue(lastPaidDate) ? undefined : lastPaidDate,
        confirmation: isAbsentValue(confirmation) ? undefined : confirmation,
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

    // Key-value pairs inside block format
    if (currentBlockItem && line.startsWith("-")) {
      const kvMatch = line.match(/^-\s*[*_]*([A-Za-z\s]+)[*_]*\s*:\s*(.+)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim().toLowerCase();
        const val = kvMatch[2].trim();
        if (key === "due" || key === "due date" || key === "when") {
          currentBlockData.dueDate = val;
        } else if (key === "amount") {
          currentBlockData.amount = isAbsentValue(val) ? undefined : val;
        } else if (key === "where" || key === "where paid") {
          currentBlockData.wherePaid = isAbsentValue(val) ? undefined : val;
        } else if (key === "warn" || key === "warn days") {
          if (/^\d+$/.test(val)) {
            currentBlockData.warnDays = parseInt(val, 10);
          } else {
            malformed.push({ item: currentBlockItem, reason: `invalid warn days: '${val}'` });
          }
        } else if (key === "last paid" || key === "last paid date" || key === "paid") {
          currentBlockData.lastPaidDate = isAbsentValue(val) ? undefined : val;
        } else if (key === "confirmation" || key === "conf") {
          currentBlockData.confirmation = isAbsentValue(val) ? undefined : val;
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
    if (entry.lastPaidDate && !isAbsentValue(entry.lastPaidDate)) {
      const [py, pm, pd] = entry.lastPaidDate.split("-").map(Number);
      const paidUtc = new Date(Date.UTC(py, pm - 1, pd));
      // For yearly obligations, the previous cycle was due 1 year prior.
      // A payment belongs to the current due cycle if paid on or after the due date
      // (on-time or late payment), or in advance within the current cycle's warning/advance
      // window (after the prior cycle's due date, up to max(warnDays, 90) days before due date).
      // Any payment on or before the previous cycle belongs to the prior obligation.
      const prevDueUtc = new Date(Date.UTC(y - 1, m - 1, Math.min(d, 28)));
      const advanceWindowMs = Math.max(entry.warnDays, 90) * 86400 * 1000;
      const cycleStartUtc = Math.max(
        dueUtc.getTime() - advanceWindowMs,
        prevDueUtc.getTime() + 86400 * 1000,
      );

      if (paidUtc.getTime() >= cycleStartUtc) {
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
