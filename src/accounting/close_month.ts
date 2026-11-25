// src/accounting/close_month.ts
// Month-end close in the year's Beancount books (web-jam-tools#1866), as "Each month" and
// "Verifying monthly work" in "The accounting skill" of web-jam-music-media-design.md set out: each
// account's statement balance becomes a `balance` line dated the first day of the following month,
// so a purchase on the statement's last day is counted and any later edit that changes the month's
// totals fails `rledger check`; the candidate books are checked before the close, its dated copy of
// the books and the month's reports are published under closed/<year>-<month>/.

import * as path from "@std/path";
import {
  appendBlock,
  assertBeancountAccount,
  assertBeancountTarget,
  BOOKS_COMMODITY,
  updateBooks,
} from "./entry.ts";
import { RledgerUnavailable, runRledger, withCheckedCandidate } from "./verify.ts";

export interface CloseMonthOptions {
  year: number;
  /** 1 to 12. */
  month: number;
  /** Each account's statement balance on the month's last day. */
  balances: Record<string, number>;
  /** The year's Beancount books; they must already exist. */
  booksPath: string;
  /** The books folder that holds closed/; the books' own folder unless named. */
  booksDir?: string;
  /** The rustledger program; `rledger` on PATH unless a test names another. */
  rledger?: string;
  /** Check the close and write nothing. */
  dryRun?: boolean;
}

export interface MonthCloseResult {
  year: number;
  month: number;
  /** The date on the `balance` lines: the first day of the following month. */
  balanceDate: string;
  balances: Record<string, number>;
  /** The dated copy of the books under closed/<year>-<month>/. */
  snapshotPath: string;
  reportPaths: string[];
}

/** The first day of the month after `month` of `year`, as YYYY-MM-DD. */
export function firstDayOfNextMonth(year: number, month: number): string {
  const next = new Date(Date.UTC(year, month, 1));
  return next.toISOString().slice(0, 10);
}

/** The `balance` lines the close appends, one per account, in account order. */
export function balanceLines(balances: Record<string, number>, balanceDate: string): string {
  return Object.keys(balances).sort().map((account) =>
    `${balanceDate} balance ${account} ${balances[account].toFixed(2)} ${BOOKS_COMMODITY}`
  ).join("\n") + "\n";
}

async function report(rledger: string, books: string, title: string, query: string) {
  let run;
  try {
    run = await runRledger(rledger, ["query", "--no-cache", books, query]);
  } catch (err) {
    if (err instanceof RledgerUnavailable) throw new Error(`${err.message}; nothing was written.`);
    throw err;
  }
  if (run.code !== 0) {
    throw new Error(
      `rledger query for the ${title} failed (exit ${run.code}); nothing was written:\n${run.stderr.trim()}`,
    );
  }
  return `${title}\n\n${run.stdout.trimEnd()}\n`;
}

/**
 * Closes one month. It refuses, leaving the books and closed/ as they were, when the month is
 * already closed, an account or amount is not valid, the books cannot be read, `rledger` cannot run,
 * or the books with the `balance` lines fail `rledger check` (a statement balance that does not
 * match the books). Otherwise it writes the dated copy and the reports, then the books.
 */
export async function closeMonth(options: CloseMonthOptions): Promise<MonthCloseResult> {
  assertBeancountTarget(options.booksPath, "accounting:close-month");
  if (!Number.isInteger(options.month) || options.month < 1 || options.month > 12) {
    throw new Error(`'${options.month}' is not a month from 1 to 12; nothing was written.`);
  }
  const accounts = Object.keys(options.balances);
  if (accounts.length === 0) {
    throw new Error("No statement balance was given; nothing was written.");
  }
  for (const account of accounts) {
    assertBeancountAccount(account);
    if (!Number.isFinite(options.balances[account])) {
      throw new Error(`The balance for ${account} is not a number; nothing was written.`);
    }
  }

  const rledger = options.rledger ?? "rledger";
  const mm = String(options.month).padStart(2, "0");
  const firstDay = `${options.year}-${mm}-01`;
  const balanceDate = firstDayOfNextMonth(options.year, options.month);
  const booksDir = options.booksDir ?? path.dirname(options.booksPath);
  const closedDir = path.join(booksDir, "closed", `${options.year}-${mm}`);
  const snapshotPath = path.join(closedDir, path.basename(options.booksPath));
  const reportPaths = [
    path.join(closedDir, "balance-sheet.txt"),
    path.join(closedDir, "income-statement.txt"),
  ];

  return await updateBooks(options.booksPath, "accounting:close-month", async (books) => {
    if (await exists(closedDir)) {
      throw new Error(
        `${options.year}-${mm} is already closed (${closedDir} exists); nothing was written.`,
      );
    }
    let existing: string;
    try {
      existing = await Deno.readTextFile(books.target);
    } catch (err) {
      throw new Error(
        `Cannot read the books at ${books.target}: ${
          err instanceof Error ? err.message : String(err)
        }. Nothing was written.`,
      );
    }
    const closed = appendBlock(existing, balanceLines(options.balances, balanceDate));

    await withCheckedCandidate(books.target, closed, rledger, async (candidate) => {
      const balanceSheet = await report(
        rledger,
        candidate,
        `Web Jam LLC balance sheet before ${balanceDate}`,
        `SELECT account, sum(position) AS balance WHERE date < ${balanceDate} AND account ~ '^(Assets|Liabilities|Equity):' GROUP BY account ORDER BY account`,
      );
      const incomeStatement = await report(
        rledger,
        candidate,
        `Web Jam LLC income statement, ${firstDay} to the day before ${balanceDate}`,
        `SELECT account, sum(position) AS total WHERE date >= ${firstDay} AND date < ${balanceDate} AND account ~ '^(Income|Expenses):' GROUP BY account ORDER BY account`,
      );
      if (options.dryRun) return;

      await Deno.mkdir(closedDir, { recursive: true, mode: 0o700 });
      try {
        await Deno.writeTextFile(snapshotPath, closed, { createNew: true, mode: 0o600 });
        await Deno.writeTextFile(reportPaths[0], balanceSheet, { createNew: true, mode: 0o600 });
        await Deno.writeTextFile(reportPaths[1], incomeStatement, { createNew: true, mode: 0o600 });
        await books.replace(closed);
      } catch (err) {
        await Deno.remove(closedDir, { recursive: true }).catch(() => {});
        throw err;
      }
    });

    return {
      year: options.year,
      month: options.month,
      balanceDate,
      balances: options.balances,
      snapshotPath,
      reportPaths,
    };
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await Deno.lstat(target);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
