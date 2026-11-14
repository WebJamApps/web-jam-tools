// src/accounting/import.ts
// Reconcile and import statement transactions into the journal with duplicate prevention (web-jam-tools#1764).

import * as path from "@std/path";
import { parseJournal } from "./entry.ts";
import { AccountRule, BankTransaction, ImportOptions, ImportResult, Transaction } from "./types.ts";

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

export function parseStatementCsv(csvContent: string): BankTransaction[] {
  const rows = parseCsvRows(csvContent);
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const dateIdx = header.findIndex((h) => h === "date" || h.includes("posted"));
  const descIdx = header.findIndex((h) =>
    h === "description" || h === "payee" || h === "name" || h === "memo"
  );
  const amtIdx = header.findIndex((h) => h === "amount");
  const idIdx = header.findIndex((h) =>
    h === "id" || h === "fitid" || h === "transactionid" || h === "ref"
  );
  const memoIdx = header.findIndex((h) => h === "memo" && h !== header[descIdx]);

  if (dateIdx === -1 || amtIdx === -1) {
    throw new Error("CSV statement missing required 'date' or 'amount' columns");
  }

  const transactions: BankTransaction[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length <= dateIdx || row.length <= amtIdx) continue;

    const date = row[dateIdx].trim();
    const rawAmt = row[amtIdx].replace(/[$,]/g, "").trim();
    if (!date || !rawAmt) continue;

    const amount = parseFloat(rawAmt);
    const payee = descIdx !== -1 && row[descIdx]
      ? row[descIdx].trim().replace(/\s*\r?\n\s*/g, " ")
      : "Unknown Payee";
    const memo = memoIdx !== -1 && row[memoIdx]
      ? row[memoIdx].trim().replace(/\s*\r?\n\s*/g, " ")
      : undefined;
    const id = idIdx !== -1 && row[idIdx] && row[idIdx].trim() !== ""
      ? row[idIdx].trim()
      : `${date}_${amount}_${payee.replace(/\s+/g, "")}`;

    transactions.push({
      date,
      amount,
      payee,
      memo,
      id,
    });
  }

  return transactions;
}

export function extractExistingIds(journalContent: string): Set<string> {
  const ids = new Set<string>();
  const parsedTxs = parseJournal(journalContent);

  for (const tx of parsedTxs) {
    if (tx.code) ids.add(tx.code);
    if (tx.tags && tx.tags["id"]) ids.add(tx.tags["id"]);
    if (tx.tags && tx.tags["fitid"]) ids.add(tx.tags["fitid"]);

    // Also track date + description + amount signature as fallback
    for (const p of tx.postings) {
      ids.add(`${tx.date}_${p.amount}_${tx.description.replace(/\s+/g, "")}`);
    }
  }

  return ids;
}

export function loadAccountRules(rulesText?: string): AccountRule[] {
  const rules: AccountRule[] = [];
  if (!rulesText) return rules;

  const lines = rulesText.split(/\r?\n/);
  let currentPattern: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;

    // Check for indented directive following "if <pattern>"
    if ((line.startsWith(" ") || line.startsWith("\t")) && currentPattern) {
      const accMatch = trimmed.match(/^account[12]?\s+([A-Za-z0-9:_ -]+)$/i);
      if (accMatch) {
        rules.push({
          pattern: currentPattern,
          category: accMatch[1].trim(),
        });
        currentPattern = null;
        continue;
      }
    }

    // Single-line format: if <pattern> account2 <category>
    const singleLineMatch = trimmed.match(
      /^if(?:\s+%description)?\s+(.+?)\s+account[12]?\s+([A-Za-z0-9:_ -]+)$/i,
    );
    if (singleLineMatch) {
      rules.push({
        pattern: singleLineMatch[1].trim().toLowerCase(),
        category: singleLineMatch[2].trim(),
      });
      currentPattern = null;
      continue;
    }

    // Multi-line header: if <pattern>
    const ifMatch = trimmed.match(/^if(?:\s+%description)?\s+(.+)$/i);
    if (ifMatch) {
      currentPattern = ifMatch[1].trim().toLowerCase();
      continue;
    }
  }

  return rules;
}

export function categorizeTransaction(
  payee: string,
  amount: number,
  rules: AccountRule[] = [],
): string {
  const lower = payee.toLowerCase();
  for (const rule of rules) {
    if (rule.pattern && lower.includes(rule.pattern.toLowerCase())) {
      return rule.category;
    }
  }

  // Built-in rule defaults
  if (lower.includes("penn station") || lower.includes("restaurant") || lower.includes("cafe")) {
    return "Expenses:Meals";
  }
  if (
    lower.includes("github") || lower.includes("anthropic") || lower.includes("openai") ||
    lower.includes("google")
  ) {
    return "Expenses:Software";
  }
  if (lower.includes("office depot") || lower.includes("staples")) {
    return "Expenses:Supplies";
  }
  if (lower.includes("state corp") || lower.includes("scc")) {
    return "Expenses:RegistrationFees";
  }

  return amount >= 0 ? "Income:Uncategorized" : "Expenses:Uncategorized";
}

export async function importStatement(options: ImportOptions): Promise<ImportResult> {
  const statementContent = await Deno.readTextFile(options.statementPath);
  const bankTxs = parseStatementCsv(statementContent);

  let journalContent = "";
  try {
    journalContent = await Deno.readTextFile(options.journalPath);
  } catch (_err) {
    journalContent = "";
  }

  let rules: AccountRule[] = [];
  if (options.rulesPath) {
    try {
      const rulesText = await Deno.readTextFile(options.rulesPath);
      rules = loadAccountRules(rulesText);
    } catch (_err) {
      // rule file optional
    }
  }

  const existingIds = extractExistingIds(journalContent);
  const account = options.account || "Assets:Checking:Truist";

  const newTransactions: Transaction[] = [];
  let skippedCount = 0;

  for (const btx of bankTxs) {
    // Duplicate check
    const sig = `${btx.date}_${btx.amount}_${btx.payee.replace(/\s+/g, "")}`;
    // Bank IDs distinguish otherwise identical transactions; id-less rows use
    // the signature generated by parseStatementCsv as their fallback ID.
    if (existingIds.has(btx.id)) {
      skippedCount++;
      continue;
    }

    const category = categorizeTransaction(btx.payee, btx.amount, rules);

    // Double-entry balancing:
    // If bank amount is negative (-22.86): checking/card was decreased by 22.86, expense is +22.86
    // If bank amount is positive (+200.00): checking was increased by 200.00, income is -200.00
    const tx: Transaction = {
      date: btx.date,
      code: btx.id,
      description: btx.payee,
      postings: [
        {
          account: category,
          amount: -btx.amount,
        },
        {
          account,
          amount: btx.amount,
        },
      ],
      tags: {
        id: btx.id,
      },
    };

    if (btx.memo) {
      tx.tags["memo"] = btx.memo;
    }

    newTransactions.push(tx);
    existingIds.add(btx.id);
    existingIds.add(sig);
  }

  if (newTransactions.length > 0 && !options.dryRun) {
    const linesToAdd: string[] = [];
    for (const tx of newTransactions) {
      const parts: string[] = [];
      const codeStr = tx.code ? ` (${tx.code})` : "";
      parts.push(`${tx.date}${codeStr} ${tx.description}`);
      for (const [k, v] of Object.entries(tx.tags)) {
        parts.push(`    ; ${k}: ${v}`);
      }
      for (const p of tx.postings) {
        const amtStr = `$${p.amount.toFixed(2)}`;
        parts.push(`    ${p.account.padEnd(34)}  ${amtStr}`);
      }
      linesToAdd.push(parts.join("\n"));
    }

    const dir = path.dirname(options.journalPath);
    await Deno.mkdir(dir, { recursive: true });

    const prefix = journalContent.length > 0 && !journalContent.endsWith("\n\n")
      ? (journalContent.endsWith("\n") ? "\n" : "\n\n")
      : "";

    await Deno.writeTextFile(
      options.journalPath,
      journalContent + prefix + linesToAdd.join("\n\n") + "\n",
    );
  }

  return {
    importedCount: newTransactions.length,
    skippedCount,
    transactions: newTransactions,
  };
}
