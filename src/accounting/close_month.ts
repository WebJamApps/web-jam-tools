// src/accounting/close_month.ts
// Month-end close: asserts statement balances, snapshots journal, and generates reports (web-jam-tools#1764).

import * as path from "@std/path";
import { expandHome } from "../design-issue/gate1.ts";
import { formatTransaction } from "./entry.ts";
import { CloseMonthOptions, MonthCloseResult, Posting, Transaction } from "./types.ts";
import { computeAccountBalances, verifyJournalBalances } from "./verify.ts";

export function getLastDayOfMonth(year: number, month: number): string {
  // Month is 1-indexed (1 = Jan, 12 = Dec)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  const dd = String(lastDay).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export function generateBalanceSheetText(balances: Map<string, number>, asOfDate: string): string {
  const lines: string[] = [
    `Web Jam LLC Balance Sheet`,
    `As of ${asOfDate}`,
    `----------------------------------------------------`,
  ];

  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;

  lines.push("\nAssets:");
  for (const [account, bal] of balances.entries()) {
    if (account.startsWith("Assets:")) {
      lines.push(`  ${account.padEnd(36)}  $${bal.toFixed(2)}`);
      totalAssets += bal;
    }
  }
  lines.push(`Total Assets:                        $${totalAssets.toFixed(2)}`);

  lines.push("\nLiabilities:");
  for (const [account, bal] of balances.entries()) {
    if (account.startsWith("Liabilities:")) {
      lines.push(`  ${account.padEnd(36)}  $${bal.toFixed(2)}`);
      totalLiabilities += bal;
    }
  }
  lines.push(`Total Liabilities:                   $${totalLiabilities.toFixed(2)}`);

  lines.push("\nEquity:");
  for (const [account, bal] of balances.entries()) {
    if (account.startsWith("Equity:")) {
      lines.push(`  ${account.padEnd(36)}  $${bal.toFixed(2)}`);
      totalEquity += bal;
    }
  }
  lines.push(`Total Equity:                        $${totalEquity.toFixed(2)}`);

  return lines.join("\n") + "\n";
}

export function generateIncomeStatementText(
  balances: Map<string, number>,
  startDate: string,
  endDate: string,
): string {
  const lines: string[] = [
    `Web Jam LLC Income Statement`,
    `Period: ${startDate} to ${endDate}`,
    `----------------------------------------------------`,
  ];

  let totalIncome = 0;
  let totalExpenses = 0;

  lines.push("\nIncome:");
  for (const [account, bal] of balances.entries()) {
    if (account.startsWith("Income:")) {
      const positiveIncome = -bal; // In hledger income credits are negative
      lines.push(`  ${account.padEnd(36)}  $${positiveIncome.toFixed(2)}`);
      totalIncome += positiveIncome;
    }
  }
  lines.push(`Total Income:                        $${totalIncome.toFixed(2)}`);

  lines.push("\nExpenses:");
  for (const [account, bal] of balances.entries()) {
    if (account.startsWith("Expenses:")) {
      lines.push(`  ${account.padEnd(36)}  $${bal.toFixed(2)}`);
      totalExpenses += bal;
    }
  }
  lines.push(`Total Expenses:                      $${totalExpenses.toFixed(2)}`);
  lines.push(`\nNet Profit / (Loss):                 $${(totalIncome - totalExpenses).toFixed(2)}`);

  return lines.join("\n") + "\n";
}

export async function closeMonth(options: CloseMonthOptions): Promise<MonthCloseResult> {
  const journalPath = path.resolve(expandHome(options.journalPath));
  const booksDir = options.booksDir
    ? path.resolve(expandHome(options.booksDir))
    : path.dirname(journalPath);

  const closeDate = getLastDayOfMonth(options.year, options.month);
  const monthStr = String(options.month).padStart(2, "0");
  const closedDir = path.join(booksDir, "closed", `${options.year}-${monthStr}`);

  let existingContent = "";
  try {
    existingContent = await Deno.readTextFile(journalPath);
  } catch (_err) {
    throw new Error(`Cannot read journal file at ${journalPath}`);
  }

  // 1. Verify existing journal balances prior to close
  const preCheck = verifyJournalBalances(existingContent);
  if (!preCheck.valid) {
    throw new Error(
      `Cannot close month: existing journal has balance errors:\n${preCheck.errors.join("\n")}`,
    );
  }

  // 2. Prepare balance assertion postings for each provided account
  const postings: Posting[] = [];
  for (const [account, assertedBalance] of Object.entries(options.balances)) {
    postings.push({
      account,
      amount: 0,
      balanceAssertion: assertedBalance,
    });
  }

  const closeTx: Transaction = {
    date: closeDate,
    status: "*",
    description: `Close Month ${options.year}-${monthStr}`,
    postings,
    tags: {
      closed: `${options.year}-${monthStr}`,
    },
  };

  const closeTxFormatted = formatTransaction(closeTx);

  const prefix = existingContent.length > 0 && !existingContent.endsWith("\n\n")
    ? (existingContent.endsWith("\n") ? "\n" : "\n\n")
    : "";

  const newJournalContent = existingContent + prefix + closeTxFormatted;

  // 3. Verify that the updated journal with the assertions is valid
  const postCheck = verifyJournalBalances(newJournalContent);
  if (!postCheck.valid) {
    throw new Error(
      `Month-end close balance verification failed:\n${postCheck.errors.join("\n")}`,
    );
  }

  if (!options.dryRun) {
    // Write new journal
    await Deno.writeTextFile(journalPath, newJournalContent);

    // Create closed directory snapshot
    await Deno.mkdir(closedDir, { recursive: true });

    // Snapshot journal copy
    const snapshotPath = path.join(closedDir, `${options.year}.journal`);
    await Deno.writeTextFile(snapshotPath, newJournalContent);

    // Generate reports
    const balances = computeAccountBalances(newJournalContent, closeDate);
    const balanceSheet = generateBalanceSheetText(balances, closeDate);
    const bsPath = path.join(closedDir, "balance-sheet.txt");
    await Deno.writeTextFile(bsPath, balanceSheet);

    const startDate = `${options.year}-${monthStr}-01`;
    const incomeStatement = generateIncomeStatementText(balances, startDate, closeDate);
    const isPath = path.join(closedDir, "income-statement.txt");
    await Deno.writeTextFile(isPath, incomeStatement);

    return {
      year: options.year,
      month: options.month,
      closeDate,
      balances: options.balances,
      snapshotPath,
      reportPaths: [bsPath, isPath],
    };
  }

  return {
    year: options.year,
    month: options.month,
    closeDate,
    balances: options.balances,
    snapshotPath: path.join(closedDir, `${options.year}.journal`),
    reportPaths: [
      path.join(closedDir, "balance-sheet.txt"),
      path.join(closedDir, "income-statement.txt"),
    ],
  };
}
