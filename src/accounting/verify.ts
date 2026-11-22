// src/accounting/verify.ts
// Check the Beancount books with `rledger check` (web-jam-tools#1865), and keep the journal
// balance checks month close uses until web-jam-tools#1866.

import { assertBeancountTarget, parseJournal } from "./entry.ts";
import { BooksCheckResult, VerificationResult } from "./types.ts";

export interface CheckBooksOptions {
  /** The rustledger program to run; `rledger` on PATH unless a test names another. */
  rledger?: string;
}

/**
 * Runs `rledger check` on the year's Beancount books: `pass` when it exits 0, `fail` with its
 * diagnostic when it exits 1, and `refuse` when the books cannot be read, `rledger` cannot be run,
 * or it exits any other way. `--no-cache` keeps it from writing a cache file beside the books.
 */
export async function checkBooks(
  booksPath: string,
  options: CheckBooksOptions = {},
): Promise<BooksCheckResult> {
  assertBeancountTarget(booksPath, "accounting:verify");
  try {
    const info = await Deno.stat(booksPath);
    if (!info.isFile) {
      return { outcome: "refuse", message: `${booksPath} is not a file, so it cannot be checked.` };
    }
    await Deno.readTextFile(booksPath);
  } catch (err) {
    return {
      outcome: "refuse",
      message: `Cannot read the books at ${booksPath}, so they cannot be checked: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const program = options.rledger ?? "rledger";
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(program, {
      args: ["check", "--no-cache", booksPath],
      env: { NO_COLOR: "1" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (err) {
    const reason = err instanceof Deno.errors.NotFound
      ? `${program} is not installed or not on PATH`
      : `${program} could not be run: ${err instanceof Error ? err.message : String(err)}`;
    return { outcome: "refuse", message: `${reason}, so the books cannot be checked.` };
  }

  const decoder = new TextDecoder();
  const text = [decoder.decode(output.stdout), decoder.decode(output.stderr)]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  if (output.code === 0) return { outcome: "pass", message: text };
  if (output.code === 1) return { outcome: "fail", message: text };
  return {
    outcome: "refuse",
    message: `${program} check exited ${output.code}, so the books could not be checked${
      text ? `:\n${text}` : "."
    }`,
  };
}

export function verifyJournalBalances(journalContent: string): VerificationResult {
  const transactions = parseJournal(journalContent).sort((a, b) => a.date.localeCompare(b.date));
  const errors: string[] = [];
  let assertionsChecked = 0;

  // Running balance map for each account
  const runningBalances = new Map<string, number>();

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];

    // 1. Transaction internal balance check (sum of postings must equal 0)
    let txSum = 0;
    for (const p of tx.postings) {
      txSum += p.amount;
    }

    // Rounding safety to 2 decimal places
    if (Math.abs(Math.round(txSum * 100) / 100) > 0.001) {
      errors.push(
        `Transaction '${tx.date} ${tx.description}' is unbalanced (net sum: ${txSum.toFixed(2)})`,
      );
    }

    // 2. Update running balances and check assertions
    for (const p of tx.postings) {
      const prev = runningBalances.get(p.account) || 0;
      const next = Math.round((prev + p.amount) * 100) / 100;
      runningBalances.set(p.account, next);

      if (p.balanceAssertion !== undefined) {
        assertionsChecked++;
        const asserted = Math.round(p.balanceAssertion * 100) / 100;
        if (Math.abs(next - asserted) > 0.001) {
          errors.push(
            `Balance assertion failed for '${p.account}' at ${tx.date}: expected $${
              asserted.toFixed(2)
            }, calculated balance was $${next.toFixed(2)}`,
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    assertionsChecked,
  };
}

export function computeAccountBalances(
  journalContent: string,
  asOfDate?: string,
): Map<string, number> {
  const transactions = parseJournal(journalContent).sort((a, b) => a.date.localeCompare(b.date));
  const balances = new Map<string, number>();

  for (const tx of transactions) {
    if (asOfDate && tx.date > asOfDate) {
      continue;
    }

    for (const p of tx.postings) {
      const prev = balances.get(p.account) || 0;
      balances.set(p.account, Math.round((prev + p.amount) * 100) / 100);
    }
  }

  return balances;
}
