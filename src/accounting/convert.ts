// src/accounting/convert.ts
// Bank file converter: translates Quicken/QuickBooks files (QFX, OFX, QBO, QIF) to CSV (web-jam-tools#1764).

import * as path from "@std/path";
import { BankTransaction, ConvertOptions, ConvertResult } from "./types.ts";

export function detectBankFormat(content: string): "ofx" | "qif" | "csv" | "unknown" {
  const trimmed = content.trim();
  if (
    trimmed.includes("<OFX>") ||
    trimmed.includes("OFXHEADER:") ||
    trimmed.includes("<STMTTRN>") ||
    trimmed.includes("<BANKTRANLIST>") ||
    trimmed.includes("<CCSTMTRS>")
  ) {
    return "ofx";
  }

  if (
    trimmed.startsWith("!Type:") ||
    trimmed.startsWith("!Option:") ||
    /^[DPTMN]\S+/m.test(trimmed) && trimmed.includes("^")
  ) {
    return "qif";
  }

  if (trimmed.includes(",") && /date/i.test(trimmed.slice(0, 200))) {
    return "csv";
  }

  return "unknown";
}

/**
 * Normalizes an OFX/QFX/QBO date string (e.g. "20261110120000[-5:EST]" or "20261110") to YYYY-MM-DD.
 */
export function normalizeOfxDate(rawDate: string): string {
  const clean = rawDate.trim();
  const match = clean.match(/^(\d{4})(\d{2})(\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return clean;
}

/**
 * Normalizes a QIF date string (e.g. "11/10/2026", "11/10'26", or "2026-11-10") to YYYY-MM-DD.
 */
export function normalizeQifDate(rawDate: string): string {
  const clean = rawDate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return clean;
  }

  // MM/DD/YYYY or M/D/YYYY
  const m1 = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    const mm = m1[1].padStart(2, "0");
    const dd = m1[2].padStart(2, "0");
    return `${m1[3]}-${mm}-${dd}`;
  }

  // MM/DD'YY or MM/DD'YYYY
  const m2 = clean.match(/^(\d{1,2})\/(\d{1,2})'(\d{2,4})$/);
  if (m2) {
    const mm = m2[1].padStart(2, "0");
    const dd = m2[2].padStart(2, "0");
    let yyyy = m2[3];
    if (yyyy.length === 2) {
      const yr = parseInt(yyyy, 10);
      yyyy = String(yr >= 70 ? 1900 + yr : 2000 + yr);
    }
    return `${yyyy}-${mm}-${dd}`;
  }

  return clean;
}

/**
 * Parses OFX, QFX, or QBO text into BankTransaction records.
 */
export function parseOfx(content: string): BankTransaction[] {
  const transactions: BankTransaction[] = [];

  // Match all <STMTTRN> blocks
  // In SGML-style OFX, tags may not have closing </STMTTRN>
  const stmtRegex = /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>)|$)/gi;
  let match: RegExpExecArray | null;

  while ((match = stmtRegex.exec(content)) !== null) {
    const block = match[1];
    if (!block.trim()) continue;

    const dtMatch = block.match(/<DTPOSTED>([^<\r\n]+)/i);
    const amtMatch = block.match(/<TRNAMT>([^<\r\n]+)/i);
    const fitidMatch = block.match(/<FITID>([^<\r\n]+)/i);
    const nameMatch = block.match(/<NAME>([^<\r\n]+)/i);
    const memoMatch = block.match(/<MEMO>([^<\r\n]+)/i);
    const typeMatch = block.match(/<TRNTYPE>([^<\r\n]+)/i);

    if (dtMatch && amtMatch) {
      const date = normalizeOfxDate(dtMatch[1]);
      const amount = parseFloat(amtMatch[1].trim());
      const payee = nameMatch ? nameMatch[1].trim() : "Unknown Payee";
      const memo = memoMatch ? memoMatch[1].trim() : "";
      const id = fitidMatch
        ? fitidMatch[1].trim()
        : `${date}_${amount}_${payee.replace(/\s+/g, "")}`;
      const type = typeMatch ? typeMatch[1].trim() : undefined;

      transactions.push({
        date,
        amount,
        payee,
        memo,
        id,
        type,
      });
    }
  }

  return transactions;
}

/**
 * Parses QIF text into BankTransaction records.
 */
export function parseQif(content: string): BankTransaction[] {
  const transactions: BankTransaction[] = [];
  const lines = content.split(/\r?\n/);

  let currentDate = "";
  let currentAmount = 0;
  let currentPayee = "";
  let currentMemo = "";
  let currentId = "";
  let inTx = false;
  let txIndex = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("!")) {
      continue;
    }

    if (trimmed === "^") {
      if (inTx && currentDate) {
        txIndex++;
        const id = currentId || `${currentDate}_${currentAmount}_${txIndex}`;
        transactions.push({
          date: currentDate,
          amount: currentAmount,
          payee: currentPayee || "Unknown Payee",
          memo: currentMemo,
          id,
        });
      }
      currentDate = "";
      currentAmount = 0;
      currentPayee = "";
      currentMemo = "";
      currentId = "";
      inTx = false;
      continue;
    }

    inTx = true;
    const code = trimmed[0];
    const val = trimmed.slice(1).trim();

    switch (code) {
      case "D":
        currentDate = normalizeQifDate(val);
        break;
      case "T":
      case "U":
        currentAmount = parseFloat(val.replace(/[$,]/g, ""));
        break;
      case "P":
        currentPayee = val;
        break;
      case "M":
        currentMemo = val;
        break;
      case "N":
        currentId = val;
        break;
    }
  }

  if (inTx && currentDate) {
    txIndex++;
    const id = currentId || `${currentDate}_${currentAmount}_${txIndex}`;
    transactions.push({
      date: currentDate,
      amount: currentAmount,
      payee: currentPayee || "Unknown Payee",
      memo: currentMemo,
      id,
    });
  }

  return transactions;
}

export function escapeCsvField(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n") || val.includes("\r")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function transactionsToCsv(transactions: BankTransaction[]): string {
  const lines: string[] = ["date,description,amount,id,memo"];

  for (const tx of transactions) {
    const cols = [
      tx.date,
      escapeCsvField(tx.payee),
      tx.amount.toFixed(2),
      escapeCsvField(tx.id),
      escapeCsvField(tx.memo || ""),
    ];
    lines.push(cols.join(","));
  }

  return lines.join("\n") + "\n";
}

export async function convertBankFile(options: ConvertOptions): Promise<ConvertResult> {
  const content = await Deno.readTextFile(options.inputPath);
  const detected = options.format && options.format !== "auto"
    ? options.format
    : detectBankFormat(content);

  let txs: BankTransaction[] = [];
  if (detected === "ofx" || detected === "qfx" || detected === "qbo") {
    txs = parseOfx(content);
  } else if (detected === "qif") {
    txs = parseQif(content);
  } else if (detected === "csv") {
    // Already CSV
    return {
      csv: content,
      count: content.split(/\r?\n/).filter((l) => l.trim().length > 0).length - 1,
      outputPath: options.outputPath,
    };
  } else {
    throw new Error(`Unsupported bank file format for ${options.inputPath}`);
  }

  const csv = transactionsToCsv(txs);

  if (options.outputPath) {
    const dir = path.dirname(options.outputPath);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(options.outputPath, csv);
  }

  return {
    csv,
    count: txs.length,
    outputPath: options.outputPath,
  };
}
