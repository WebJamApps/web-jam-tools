// src/accounting/import.ts
// Import a clean CSV into the year's Beancount books through `rledger extract` (web-jam-tools#1866),
// as "Each month" in "The accounting skill" of web-jam-music-media-design.md sets out: the books'
// own importers.toml named with --config, the account's profile with --importer, and the year's
// books with --existing, so a line already in the books is skipped.

import { appendBlock, assertBeancountTarget, openLinesFor, updateBooks } from "./entry.ts";
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

/**
 * Imports one clean CSV. Three outcomes, per the issue: a line not in the books is imported with
 * its profile's category; a line already there, matched by `--existing`, is skipped, so running the
 * same file again adds nothing; and when `rledger` cannot run, `importers.toml` cannot be read, the
 * profile is not found, or the books with the new lines would fail `rledger check`, it refuses and
 * the books are left as they were. The extracted lines are staged and checked before they are
 * appended, under the books' lock.
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

    let run;
    try {
      run = await runRledger(rledger, [
        "extract",
        "--config",
        options.configPath,
        "--importer",
        options.importer,
        "--existing",
        books.target,
        options.csvPath,
      ]);
    } catch (err) {
      if (err instanceof RledgerUnavailable) {
        throw new Error(`${err.message}, so nothing was imported and the books were not changed.`);
      }
      throw err;
    }
    if (run.code !== 0) {
      throw new Error(
        `rledger extract refused (exit ${run.code}), so nothing was imported and the books were not changed:\n${run.stderr.trim()}`,
      );
    }

    const extracted = run.stdout.trim() ? run.stdout.trimEnd() + "\n" : "";
    const lines = extracted.split("\n");
    const importedCount = lines.filter((line) => TRANSACTION_HEADER.test(line)).length;
    if (importedCount === 0) return { importedCount: 0, extracted: "", openedAccounts: [] };

    const accounts = lines.flatMap((line) => POSTING_ACCOUNT.exec(line)?.[1] ?? []);
    const year = lines.find((line) => TRANSACTION_HEADER.test(line))!.slice(0, 4);
    const opens = openLinesFor(existing, accounts, year);
    const candidate = appendBlock(existing, opens + extracted);
    const openedAccounts = opens.split("\n").filter(Boolean).map((line) => line.split(/\s+/)[2]);

    await withCheckedCandidate(books.target, candidate, rledger, async () => {
      if (!options.dryRun) await books.replace(candidate);
    });
    return { importedCount, extracted, openedAccounts };
  });
}
