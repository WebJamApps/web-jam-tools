// src/accounting/import.ts
// Import a clean CSV into the year's Beancount books through `rledger extract` (web-jam-tools#1866),
// as "Each month" in "The accounting skill" of web-jam-music-media-design.md sets out: the books'
// own importers.toml named with --config and the account's profile with --importer. A line carrying
// the bank's line id is matched against the books by its `bank_id` metadata, so a second identical
// same-day purchase with its own id is never mistaken for the first; a line with no id falls back
// to --existing naming the year's books.

import * as path from "@std/path";
import {
  appendBlock,
  assertBeancountTarget,
  openLinesFor,
  parseBeancount,
  quoteBeancount,
  updateBooks,
} from "./entry.ts";
import { RledgerUnavailable, runRledger, withCheckedCandidate } from "./verify.ts";

/** Splits CSV text into rows, keeping quoted commas and line breaks; the mileage log reads with it. */
export function parseCsvRows(csvContent: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < csvContent.length; i++) {
    const char = csvContent[i];
    if (char === '"') {
      if (inQuotes && csvContent[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && csvContent[i + 1] === "\n") i++;
      row.push(current);
      if (row.some((field) => field.trim())) rows.push(row);
      row = [];
      current = "";
    } else {
      current += char;
    }
  }
  if (inQuotes) throw new Error("CSV contains an unterminated quoted field");
  row.push(current);
  if (row.some((field) => field.trim())) rows.push(row);

  return rows;
}

export interface ImportOptions {
  /** The clean CSV the download cleaner wrote. */
  csvPath: string;
  /** The year's Beancount books; they must already exist. */
  booksPath: string;
  /** The books' own importers.toml. */
  configPath: string;
  /** The account's profile in importers.toml. */
  importer: string;
  /** The rustledger program; `rledger` on PATH unless a test names another. */
  rledger?: string;
  /** Report what would be imported and write nothing. */
  dryRun?: boolean;
}

export interface ImportResult {
  /** How many transactions were written, or would be on a dry run. */
  importedCount: number;
  /** The Beancount text of those transactions, as rustledger extracted them. */
  extracted: string;
  /** Accounts opened so the imported transactions pass the check. */
  openedAccounts: string[];
}

const TRANSACTION_HEADER = /^\d{4}-\d{2}-\d{2}\s+[*!]\s/;
const POSTING_ACCOUNT = /^\s+((?:Assets|Liabilities|Equity|Income|Expenses):\S+)/;

/** The download cleaner's header: the only CSV layout the import reads. */
const CLEAN_CSV_HEADER = ["date", "description", "amount", "id"];

/** One line of a clean CSV. */
interface CleanRow {
  date: string;
  description: string;
  amount: string;
  id: string;
}

const NOTHING_CHANGED = "nothing was imported and the books were not changed";

/** The rows of a clean CSV, refused unless it carries the download cleaner's header. */
function readCleanRows(content: string, csvPath: string): CleanRow[] {
  const rows = parseCsvRows(content);
  const header = (rows[0] ?? []).map((field) => field.trim().toLowerCase());
  if (header.join(",") !== CLEAN_CSV_HEADER.join(",")) {
    throw new Error(
      `${csvPath} is not a clean CSV: its first line must be ${
        CLEAN_CSV_HEADER.join(",")
      }, so ${NOTHING_CHANGED}.`,
    );
  }
  return rows.slice(1).map((row, i) => {
    const amount = (row[2] ?? "").trim();
    if (row.length !== CLEAN_CSV_HEADER.length || !amount || !Number.isFinite(Number(amount))) {
      throw new Error(
        `Line ${
          i + 2
        } of ${csvPath} is not a clean CSV line (date, description, amount, id), so ${NOTHING_CHANGED}.`,
      );
    }
    return { date: row[0].trim(), description: row[1], amount, id: row[3].trim() };
  });
}

function csvField(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function cleanCsvText(rows: CleanRow[]): string {
  return [
    CLEAN_CSV_HEADER.join(","),
    ...rows.map((r) => [r.date, r.description, r.amount, r.id].map(csvField).join(",")),
  ].join("\n") + "\n";
}

/**
 * Runs `rledger extract` on `rows`, written owner-only beside the books (the only folder the
 * import's task may write) and removed afterwards, and returns what it printed.
 */
async function extractRows(
  rows: CleanRow[],
  booksTarget: string,
  options: ImportOptions,
  rledger: string,
  existing: boolean,
): Promise<string> {
  const staged = path.join(
    path.dirname(booksTarget),
    `.${path.basename(booksTarget)}.${crypto.randomUUID()}.import.csv`,
  );
  try {
    await Deno.writeTextFile(staged, cleanCsvText(rows), { createNew: true, mode: 0o600 });
    const args = ["extract", "--config", options.configPath, "--importer", options.importer];
    if (existing) args.push("--existing", booksTarget);
    let run;
    try {
      run = await runRledger(rledger, [...args, staged]);
    } catch (err) {
      if (err instanceof RledgerUnavailable) {
        throw new Error(`${err.message}, so ${NOTHING_CHANGED}.`);
      }
      throw err;
    }
    if (run.code !== 0) {
      throw new Error(
        `rledger extract refused (exit ${run.code}), so ${NOTHING_CHANGED}:\n${run.stderr.trim()}`,
      );
    }
    return run.stdout;
  } finally {
    await Deno.remove(staged).catch(() => {});
  }
}

/** The transactions in rustledger's output, each as its lines; anything else is refused. */
function transactionBlocks(output: string): string[][] {
  const blocks: string[][] = [];
  for (const line of output.split(/\r?\n/)) {
    if (TRANSACTION_HEADER.test(line)) {
      blocks.push([line]);
    } else if (line.trim()) {
      if (blocks.length === 0) {
        throw new Error(
          `rledger extract printed '${line.trim()}' before any transaction, so the bank line ids could not be matched; ${NOTHING_CHANGED}.`,
        );
      }
      blocks[blocks.length - 1].push(line);
    }
  }
  return blocks;
}

/**
 * Imports one clean CSV, as "Each month" in the design sets out.
 *
 * A line with a bank line id is left out when the books already hold that id as `bank_id`
 * metadata or the same file carries it earlier, and an amount of exactly zero is left out as
 * `rledger extract` leaves it out. The remaining lines go through `rledger extract` without
 * `--existing`, so two identical same-day purchases with their own ids are both kept; the import
 * refuses unless it gets back one transaction per line, in order and on the same dates, and then
 * writes each line's `bank_id`. A line with no id goes through `rledger extract --existing` naming
 * the year's books, so running the same file again adds nothing.
 *
 * It refuses, leaving the books as they were, when the CSV or the books cannot be read, `rledger`
 * cannot run, `importers.toml` cannot be read, the profile is not found, the extracted lines do
 * not match the CSV lines, or the books with the new lines would fail `rledger check`. Accounts
 * the new lines use are opened on January 1 of the earliest new line's year.
 */
export async function importStatement(options: ImportOptions): Promise<ImportResult> {
  assertBeancountTarget(options.booksPath, "accounting:import");
  const rledger = options.rledger ?? "rledger";

  return await updateBooks(options.booksPath, "accounting:import", async (books) => {
    let existing: string;
    try {
      existing = await Deno.readTextFile(books.target);
    } catch (err) {
      throw new Error(
        `Cannot read the books at ${books.target}, so the import cannot tell what is already in them: ${
          err instanceof Error ? err.message : String(err)
        }. Nothing was written.`,
      );
    }
    let csvContent: string;
    try {
      csvContent = await Deno.readTextFile(options.csvPath);
    } catch (err) {
      throw new Error(
        `Cannot read the clean CSV at ${options.csvPath}: ${
          err instanceof Error ? err.message : String(err)
        }. Nothing was written.`,
      );
    }
    const rows = readCleanRows(csvContent, options.csvPath);

    const known = new Set(
      parseBeancount(existing).map((tx) => tx.tags.bank_id).filter((id): id is string => !!id),
    );
    const withId: CleanRow[] = [];
    const withoutId: CleanRow[] = [];
    for (const row of rows) {
      if (!row.id) {
        withoutId.push(row);
      } else if (Number(row.amount) !== 0 && !known.has(row.id)) {
        known.add(row.id);
        withId.push(row);
      }
    }

    const parts: string[] = [];
    if (withId.length > 0) {
      const blocks = transactionBlocks(
        await extractRows(withId, books.target, options, rledger, false),
      );
      const misaligned = blocks.length !== withId.length ||
        blocks.some((block, i) => block[0].slice(0, 10) !== withId[i].date);
      if (misaligned) {
        throw new Error(
          `rledger extract returned ${blocks.length} transaction(s) for ${withId.length} bank line(s), or on different dates, so the bank line ids could not be matched; ${NOTHING_CHANGED}.`,
        );
      }
      parts.push(
        ...blocks.map((block, i) =>
          [block[0], `  bank_id: ${quoteBeancount(withId[i].id)}`, ...block.slice(1)].join("\n")
        ),
      );
    }
    if (withoutId.length > 0) {
      const output = await extractRows(withoutId, books.target, options, rledger, true);
      if (output.trim()) parts.push(output.trimEnd());
    }

    const extracted = parts.length > 0 ? parts.join("\n") + "\n" : "";
    const lines = extracted.split("\n");
    const dates = lines.filter((line) => TRANSACTION_HEADER.test(line)).map((l) => l.slice(0, 10));
    if (dates.length === 0) return { importedCount: 0, extracted: "", openedAccounts: [] };

    const accounts = lines.flatMap((line) => POSTING_ACCOUNT.exec(line)?.[1] ?? []);
    const year = dates.sort()[0].slice(0, 4);
    const opens = openLinesFor(existing, accounts, year);
    const candidate = appendBlock(existing, opens + extracted);
    const openedAccounts = opens.split("\n").filter(Boolean).map((line) => line.split(/\s+/)[2]);

    await withCheckedCandidate(books.target, candidate, rledger, async () => {
      if (!options.dryRun) await books.replace(candidate);
    });
    return { importedCount: dates.length, extracted, openedAccounts };
  });
}
