// src/accounting/verify.ts
// Verify transaction balance equality and balance assertions (web-jam-tools#1764).

import { parseJournal } from "./entry.ts";
import { VerificationResult } from "./types.ts";

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
