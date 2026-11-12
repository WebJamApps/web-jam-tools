// src/accounting/entry.ts
// Format, create, and parse hledger journal entries (web-jam-tools#1764).

import * as path from "@std/path";
import { Posting, Transaction } from "./types.ts";

export function formatAmount(amount: number, commodity = "$"): string {
  const sign = amount < 0 ? "-" : "";
  const absVal = Math.abs(amount).toFixed(2);
  return `${commodity}${sign}${absVal}`;
}

export function formatPosting(p: Posting): string {
  const commodity = p.commodity || "$";
  const amountStr = `${commodity}${p.amount.toFixed(2)}`;
  if (p.balanceAssertion !== undefined) {
    const assertStr = `${commodity}${p.balanceAssertion.toFixed(2)}`;
    return `    ${p.account.padEnd(34)}  ${amountStr} = ${assertStr}`;
  }
  return `    ${p.account.padEnd(34)}  ${amountStr}`;
}

export function formatTransaction(tx: Transaction): string {
  const parts: string[] = [];
  const statusStr = tx.status ? ` ${tx.status}` : "";
  const codeStr = tx.code ? ` (${tx.code})` : "";
  parts.push(`${tx.date}${statusStr}${codeStr} ${tx.description}`);

  // Format metadata tags as comments
  if (tx.tags) {
    for (const [key, val] of Object.entries(tx.tags)) {
      if (val && val.trim() !== "") {
        parts.push(`    ; ${key}: ${val.trim()}`);
      }
    }
  }

  if (tx.comment && tx.comment.trim() !== "") {
    parts.push(`    ; ${tx.comment.trim()}`);
  }

  for (const p of tx.postings) {
    parts.push(formatPosting(p));
  }

  return parts.join("\n") + "\n";
}

export interface CreateEntryParams {
  date: string;
  description: string;
  amount: number;
  category: string;
  fromAccount?: string;
  purpose?: string;
  attendees?: string;
  owner?: string;
  receipt?: string;
  code?: string;
  isDraw?: boolean;
}

export function createEntry(params: CreateEntryParams): Transaction {
  const {
    date,
    description,
    amount,
    category,
    purpose,
    attendees,
    owner,
    receipt,
    code,
    isDraw,
  } = params;

  let fromAccount = params.fromAccount;
  const tags: Record<string, string> = {};

  if (purpose) tags["purpose"] = purpose;
  if (attendees) tags["attendees"] = attendees;
  if (owner) tags["owner"] = owner;
  if (receipt) tags["receipt"] = receipt;
  if (code) tags["id"] = code;

  // Determine source account if crossing between personal and business
  if (!fromAccount) {
    if (owner && isDraw) {
      // Personal purchase on business account: money owner withdrew
      fromAccount = `Equity:OwnerDraws:${owner}`;
    } else if (owner) {
      // Business expense paid personally: owner contribution
      fromAccount = `Equity:OwnerContributions:${owner}`;
    } else {
      fromAccount = "Liabilities:CreditCard";
    }
  }

  const postings: Posting[] = [
    { account: category, amount },
    { account: fromAccount, amount: -amount },
  ];

  return {
    date,
    code,
    description,
    postings,
    tags,
  };
}

export async function appendEntryToJournal(journalPath: string, tx: Transaction): Promise<void> {
  const formatted = formatTransaction(tx);
  const dir = path.dirname(journalPath);
  await Deno.mkdir(dir, { recursive: true });

  let existing = "";
  try {
    existing = await Deno.readTextFile(journalPath);
  } catch (_err) {
    // File may not exist yet
    existing = "";
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n\n")
    ? (existing.endsWith("\n") ? "\n" : "\n\n")
    : "";

  await Deno.writeTextFile(journalPath, existing + prefix + formatted);
}

export function parseJournal(content: string): Transaction[] {
  const transactions: Transaction[] = [];
  const lines = content.split(/\r?\n/);

  let currentTx: Partial<Transaction> | null = null;
  const dateRegex = /^(\d{4}-\d{2}-\d{2})(?:\s+([*!]))?(?:\s+\(([^)]+)\))?\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const headerMatch = line.match(dateRegex);
    if (headerMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      if (currentTx && currentTx.date && currentTx.postings && currentTx.postings.length > 0) {
        transactions.push(currentTx as Transaction);
      }
      currentTx = {
        date: headerMatch[1],
        status: (headerMatch[2] as "*" | "!") || undefined,
        code: headerMatch[3] || undefined,
        description: headerMatch[4].trim(),
        postings: [],
        tags: {},
      };
      continue;
    }

    if (currentTx && (line.startsWith(" ") || line.startsWith("\t"))) {
      // Metadata comment or tag
      if (trimmed.startsWith(";")) {
        const commentBody = trimmed.slice(1).trim();
        const tagMatch = commentBody.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
        if (tagMatch) {
          currentTx.tags = currentTx.tags || {};
          currentTx.tags[tagMatch[1]] = tagMatch[2].trim();
        } else {
          currentTx.comment = (currentTx.comment ? currentTx.comment + "; " : "") + commentBody;
        }
        continue;
      }

      // Posting line
      // Matches: Account:Name    [$]Amount [= [$]Assertion]
      const postingMatch = trimmed.match(
        /^([a-zA-Z0-9:_ -]+?)\s{2,}([-+]?\$?[-+]?[0-9,]+(?:\.[0-9]+)?)(?:\s*=\s*([\$]?[-+]?[0-9,]+(?:\.[0-9]+)?))?$/,
      );
      if (postingMatch) {
        const account = postingMatch[1].trim();
        const rawAmount = postingMatch[2].replace(/[$,]/g, "");
        const amount = parseFloat(rawAmount);

        let balanceAssertion: number | undefined;
        if (postingMatch[3]) {
          const rawAssertion = postingMatch[3].replace(/[$,]/g, "");
          balanceAssertion = parseFloat(rawAssertion);
        }

        currentTx.postings = currentTx.postings || [];
        currentTx.postings.push({
          account,
          amount,
          balanceAssertion,
        });
      }
    }
  }

  if (currentTx && currentTx.date && currentTx.postings && currentTx.postings.length > 0) {
    transactions.push(currentTx as Transaction);
  }

  return transactions;
}
