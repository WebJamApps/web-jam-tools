// src/accounting/clean_download.ts
// The download cleaner of the accounting skill (web-jam-tools#1863).
//
// Design: ~/Dropbox/web-jam-llms/songwriting/web-jam-music-media-design.md, "The accounting
// skill", the bullet "The download cleaner". Josh runs it in his own terminal, outside every
// agent, on one bank, card or Wave download saved in ~/Dropbox/financial-private/downloads/.
// It keeps each line's date, description, amount and the bank's line id, drops everything
// else (account, routing and card numbers included), runs the personal-number checker on what
// it is about to write, and writes nothing when the checker finds one. It prints how many
// lines it wrote and nothing from them; its refusals name a line number or the kind of number,
// never a line's content.

import * as path from "@std/path";
import { describeKinds, detectPersonalNumbers } from "../../hooks/lib/detect_personal_numbers.ts";

export interface CleanLine {
  date: string;
  description: string;
  amount: string;
  id: string;
}

export interface CleanOptions {
  /** The download to clean. */
  input: string;
  /** The books folder, `~/Dropbox/web-jam-llms/financial/books` by default. */
  booksDir: string;
  /** Write into `sweep/` instead of `statements/<year>/`. */
  sweep?: boolean;
}

export interface CleanResult {
  count: number;
  outputPath: string;
}

/** A refusal: the message never holds content from the download. */
export class CleanRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanRefusal";
  }
}

const CSV_HEADER = "date,description,amount,id";

/** YYYY-MM-DD from `2026-03-14`, `20260314…` (OFX), `3/14/2026` or `3/14/26`; null otherwise. */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validDate(m[1], m[2], m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})(?:\d{6}(?:\.\d+)?)?(?:\[[^\]]*\])?$/);
  if (m) return validDate(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
  if (m) {
    const year = m[3].length === 2 ? String(2000 + Number(m[3])) : m[3];
    return validDate(year, m[1].padStart(2, "0"), m[2].padStart(2, "0"));
  }
  return null;
}

/** The date when it is a real calendar date, February 30 and a year 0000 refused; null otherwise. */
function validDate(y: string, mo: string, d: string): string | null {
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > daysInMonth) return null;
  return `${y}-${mo}-${d}`;
}

/**
 * A signed amount with two decimals from `22.86`, `-22.86`, `$1,022.86`, `$-22.86` or `(22.86)`;
 * null otherwise. The syntax is checked before anything is normalised: a comma must separate
 * groups of three digits, so `12,34` is refused rather than read as 1234; digits past the cents
 * must be zeros, so nothing is rounded; and a sign inside parentheses, two signs, or spaces inside
 * the number are refused.
 */
export function normalizeAmount(raw: string): string | null {
  let s = raw.trim();
  let negative = false;
  const paren = s.match(/^\((.*)\)$/);
  if (paren) {
    negative = true;
    s = paren[1].trim();
  }
  const m = s.match(/^([+-]?)\$?([+-]?)(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?$/);
  if (!m) return null;
  const [, before, after, whole, fraction] = m;
  if (before && after) return null;
  if (whole === undefined && fraction === undefined) return null;
  const sign = before || after;
  if (paren && sign) return null;
  if (fraction !== undefined && /[^0]/.test(fraction.slice(2))) return null;
  if (sign === "-") negative = true;
  const cents = Number((whole ?? "0").replace(/,/g, "")) * 100 +
    Number((fraction ?? "").slice(0, 2).padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return formatCents(negative ? -cents : cents);
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function centsOf(amount: string): number {
  return Math.round(Number(amount) * 100);
}

/** Whether the text is an OFX file (Quicken QFX and QuickBooks QBO are OFX too). */
export function isOfx(text: string): boolean {
  return /OFXHEADER|<OFX>|<STMTTRN>/i.test(text);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/gi, "&");
}

/** One fixed pattern per OFX value the cleaner reads, so no pattern is built at run time. */
const OFX_VALUE_PATTERNS = {
  DTPOSTED: /<DTPOSTED>([^<\r\n]*)/i,
  TRNAMT: /<TRNAMT>([^<\r\n]*)/i,
  FITID: /<FITID>([^<\r\n]*)/i,
  NAME: /<NAME>([^<\r\n]*)/i,
  MEMO: /<MEMO>([^<\r\n]*)/i,
} as const;

function ofxValue(block: string, tag: keyof typeof OFX_VALUE_PATTERNS): string | undefined {
  const m = block.match(OFX_VALUE_PATTERNS[tag]);
  return m ? decodeEntities(m[1]).trim() : undefined;
}

/**
 * The aggregates of an OFX statement, each with the aggregate it must sit directly inside. In
 * both the legacy SGML form and the XML form, an aggregate always has its closing tag; only single
 * values may go unclosed in SGML. Other aggregates, such as the sign-on response or the account,
 * are not followed: they hold nothing the cleaner keeps.
 */
const OFX_PARENTS: Record<string, string[]> = {
  OFX: [],
  BANKMSGSRSV1: ["OFX"],
  CREDITCARDMSGSRSV1: ["OFX"],
  STMTTRNRS: ["BANKMSGSRSV1"],
  CCSTMTTRNRS: ["CREDITCARDMSGSRSV1"],
  STMTRS: ["STMTTRNRS"],
  CCSTMTRS: ["CCSTMTTRNRS"],
  BANKTRANLIST: ["STMTRS", "CCSTMTRS"],
  STMTTRN: ["BANKTRANLIST"],
};

const OFX_AGGREGATE_TAG =
  /<(\/?)(OFX|BANKMSGSRSV1|CREDITCARDMSGSRSV1|STMTTRNRS|CCSTMTTRNRS|STMTRS|CCSTMTRS|BANKTRANLIST|STMTTRN)>/gi;

/**
 * The body of each transaction in an OFX download, read as the statement's structure. Comments
 * are removed first, so a transaction inside a comment is never read. Every statement aggregate
 * must open directly inside its parent and close in order, so a file cut off inside a transaction
 * or with an unclosed statement element is refused, and the file must end with `</OFX>`.
 */
function ofxTransactionBlocks(raw: string): string[] {
  const text = raw.replace(/<!--[\s\S]*?-->/g, "");
  if (text.includes("<!--")) throw new CleanRefusal("the OFX file has a comment that never closes");
  const stack: string[] = [];
  const blocks: string[] = [];
  let lists = 0;
  let transactions = 0;
  let transactionStart = -1;
  let ofxEnd = -1;
  for (const tag of text.matchAll(OFX_AGGREGATE_TAG)) {
    const name = tag[2].toUpperCase();
    const top = stack.at(-1);
    if (tag[1] !== "/") {
      if (top === "STMTTRN") {
        throw new CleanRefusal(`transaction ${transactions} is cut off before it closes`);
      }
      const parents = OFX_PARENTS[name];
      const misplaced = parents.length === 0
        ? stack.length > 0 || ofxEnd !== -1
        : !parents.includes(top ?? "");
      if (misplaced) {
        throw new CleanRefusal(
          `the OFX file opens <${name}> outside ${
            parents.length === 0 ? "the top level" : parents.map((q) => `<${q}>`).join(" or ")
          }`,
        );
      }
      stack.push(name);
      if (name === "BANKTRANLIST") lists++;
      if (name === "STMTTRN") {
        transactions++;
        transactionStart = tag.index! + tag[0].length;
      }
    } else {
      if (top !== name) {
        throw new CleanRefusal(
          top === "STMTTRN"
            ? `transaction ${transactions} is cut off before it closes`
            : top === undefined
            ? `the OFX file closes <${name}> it never opened`
            : `the OFX file's <${top}> never closes`,
        );
      }
      stack.pop();
      if (name === "STMTTRN") blocks.push(text.slice(transactionStart, tag.index));
      if (name === "OFX") ofxEnd = tag.index! + tag[0].length;
    }
  }
  if (stack.includes("STMTTRN")) {
    throw new CleanRefusal(
      `transaction ${transactions} is cut off: the file ends before it closes`,
    );
  }
  if (stack.length > 0) throw new CleanRefusal(`the OFX file's <${stack.at(-1)}> never closes`);
  if (ofxEnd === -1) throw new CleanRefusal("the OFX file has no <OFX> statement");
  if (lists === 0) throw new CleanRefusal("the OFX file has no transaction list");
  if (text.slice(ofxEnd).trim() !== "") {
    throw new CleanRefusal("the OFX file has content after its closing </OFX>");
  }
  return blocks;
}

/** The lines of an OFX download: only the four kept fields leave this function. */
export function parseOfxLines(text: string): CleanLine[] {
  const lines: CleanLine[] = [];
  ofxTransactionBlocks(text).forEach((block, index) => {
    const n = index + 1;
    const date = normalizeDate(ofxValue(block, "DTPOSTED") ?? "");
    if (!date) throw new CleanRefusal(`transaction ${n} has a date the cleaner cannot read`);
    const amount = normalizeAmount(ofxValue(block, "TRNAMT") ?? "");
    if (amount === null) {
      throw new CleanRefusal(`transaction ${n} has an amount the cleaner cannot read`);
    }
    const id = ofxValue(block, "FITID") ?? "";
    if (!id) throw new CleanRefusal(`transaction ${n} has no transaction id (FITID)`);
    const name = ofxValue(block, "NAME") ?? "";
    const memo = ofxValue(block, "MEMO") ?? "";
    const description = name && memo && memo !== name ? `${name} ${memo}` : name || memo;
    lines.push({ date, description, amount, id });
  });
  return lines;
}

/**
 * Rows of a CSV text, honouring quoted fields with commas, quotes and line breaks. A quote may
 * only open a field and, once closed, may only be followed by spaces and then a comma or the end
 * of the row; anything else is refused rather than silently joined to the field.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  const src = text.replace(/^﻿/, "");
  const lineNumber = () => rows.length + 1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += c;
      }
    } else if (c === ",") {
      row.push(field);
      field = "";
      closedQuote = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closedQuote = false;
    } else if (closedQuote) {
      if (c !== " " && c !== "\t") {
        throw new CleanRefusal(`line ${lineNumber()} has text after a closing quote`);
      }
    } else if (c === '"') {
      if (field.trim() !== "") {
        throw new CleanRefusal(`line ${lineNumber()} has a quote inside an unquoted field`);
      }
      field = "";
      quoted = true;
    } else {
      field += c;
    }
  }
  if (quoted) throw new CleanRefusal("the file ends inside a quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

interface Columns {
  date: number;
  description: number;
  amount?: number;
  debit?: number;
  credit?: number;
  id?: number;
}

function pick(
  headers: string[],
  exact: string[],
  contains?: (h: string) => boolean,
): number | undefined {
  for (const name of exact) {
    const i = headers.indexOf(name);
    if (i !== -1) return i;
  }
  if (contains) {
    const i = headers.findIndex(contains);
    if (i !== -1) return i;
  }
  return undefined;
}

/** Which columns hold the kept fields, from a header row; undefined when it is not a header. */
export function columnsFromHeader(row: string[]): Columns | undefined {
  const h = row.map((cell) => cell.trim().toLowerCase());
  if (!h.some((cell) => cell.includes("date"))) return undefined;
  const date = pick(
    h,
    ["posting date", "posted date", "post date", "transaction date", "date"],
    (x) => x.includes("date"),
  );
  const description = pick(
    h,
    ["description", "transaction description", "payee", "name", "merchant", "details", "memo"],
    (x) => x.includes("description"),
  );
  const amount = pick(h, ["amount"], (x) => x.startsWith("amount"));
  const debit = pick(h, ["debit", "debit amount", "withdrawal", "withdrawals"]);
  const credit = pick(h, ["credit", "credit amount", "deposit", "deposits"]);
  const id = pick(h, [
    "transaction id",
    "id",
    "fitid",
    "reference",
    "reference number",
    "reference no",
    "transaction reference",
  ]);
  if (date === undefined || description === undefined) {
    throw new CleanRefusal("the header names no date or no description column");
  }
  if (amount === undefined && (debit === undefined || credit === undefined)) {
    throw new CleanRefusal("the header names no amount column and no debit and credit pair");
  }
  return amount !== undefined
    ? { date, description, amount, id }
    : { date, description, debit, credit, id };
}

/** The lines of a CSV download: only the four kept fields leave this function. */
export function parseCsvLines(text: string): CleanLine[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  let columns = columnsFromHeader(rows[0]);
  let body = rows.slice(1);
  if (!columns) {
    // No header: the cleaner's own column order, date, description, amount and an optional id.
    if (!normalizeDate(rows[0][0] ?? "")) {
      throw new CleanRefusal(
        "the cleaner cannot tell which columns hold the date, description and amount",
      );
    }
    // Only the cleaner's own layout is read without a header: three fields, or four with the
    // line id. Any other width, such as an amount split by an unquoted comma, is refused.
    if (rows[0].length !== 3 && rows[0].length !== 4) {
      throw new CleanRefusal(
        `line 1 has ${
          rows[0].length
        } fields; a download with no header must have 3 (date, description, amount) or 4 (with the line id)`,
      );
    }
    columns = { date: 0, description: 1, amount: 2, id: rows[0].length > 3 ? 3 : undefined };
    body = rows;
  }
  const firstLine = body === rows ? 1 : 2;
  // Every row has as many fields as the header, or as the first row when there is no header. A
  // row with more or fewer, such as an amount whose unquoted comma split it in two, is refused
  // rather than read with its fields shifted.
  const width = rows[0].length;
  return body.map((row, index) => {
    const n = index + firstLine;
    if (row.length !== width) {
      throw new CleanRefusal(
        `line ${n} has ${row.length} fields where ${
          body === rows ? "the first line" : "the header"
        } has ${width}`,
      );
    }
    const date = normalizeDate(row[columns.date] ?? "");
    if (!date) throw new CleanRefusal(`line ${n} has a date the cleaner cannot read`);
    let amount: string | null;
    if (columns.amount !== undefined) {
      amount = normalizeAmount(row[columns.amount] ?? "");
    } else {
      const debit = (row[columns.debit!] ?? "").trim();
      const credit = (row[columns.credit!] ?? "").trim();
      const d = debit === "" ? "0" : normalizeAmount(debit);
      const c = credit === "" ? "0" : normalizeAmount(credit);
      amount = d === null || c === null || (debit === "" && credit === "")
        ? null
        : formatCents(centsOf(c) - Math.abs(centsOf(d)));
    }
    if (amount === null) throw new CleanRefusal(`line ${n} has an amount the cleaner cannot read`);
    return {
      date,
      description: (row[columns.description] ?? "").trim(),
      amount,
      id: columns.id !== undefined ? (row[columns.id] ?? "").trim() : "",
    };
  });
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The clean CSV the cleaner writes: a header and one row of four fields per line. */
export function cleanCsv(lines: CleanLine[]): string {
  const rows = lines.map((l) =>
    [l.date, csvField(l.description), l.amount, csvField(l.id)].join(",")
  );
  return [CSV_HEADER, ...rows].join("\n") + "\n";
}

/** The lines of a download, whichever kind it is. */
export function parseDownload(text: string): CleanLine[] {
  if (/^\s*!(Type|Option|Account)/i.test(text)) {
    throw new CleanRefusal(
      "the file is in the QIF format; download a CSV or a Quicken or QuickBooks (OFX) file instead",
    );
  }
  return isOfx(text) ? parseOfxLines(text) : parseCsvLines(text);
}

/** Where the clean file goes: `statements/<year>/` by the latest line's year, or `sweep/`. */
export function outputPathFor(options: CleanOptions, lines: CleanLine[]): string {
  const name = `${path.basename(options.input).replace(/\.[^.]+$/, "")}.csv`;
  if (options.sweep) return path.join(options.booksDir, "sweep", name);
  const year = lines.map((l) => l.date.slice(0, 4)).sort().at(-1)!;
  return path.join(options.booksDir, "statements", year, name);
}

/**
 * Cleans one download. Refuses, writing nothing, when the file cannot be read or parsed, holds
 * no lines, would overwrite a file, or holds a protected number in what would be written.
 */
export async function cleanDownload(options: CleanOptions): Promise<CleanResult> {
  let text: string;
  try {
    text = await Deno.readTextFile(options.input);
  } catch (error) {
    throw new CleanRefusal(`could not read the file (${(error as Error).name})`);
  }
  const lines = parseDownload(text);
  if (lines.length === 0) throw new CleanRefusal("the file holds no lines to keep");
  const csv = cleanCsv(lines);
  let findings;
  try {
    findings = detectPersonalNumbers(csv);
  } catch (error) {
    throw new CleanRefusal(`the personal-number checker could not run (${(error as Error).name})`);
  }
  if (findings.length > 0) {
    throw new CleanRefusal(
      `a line to be written holds what looks like ${
        describeKinds(findings)
      }. Personal numbers never reach the books; remove it from that line's description at the bank's download and run the cleaner again`,
    );
  }
  const outputPath = outputPathFor(options, lines);
  // createNew claims the name only when no file holds it, so an existing record is never
  // replaced. If writing the contents then fails, the file this run created is removed, so a
  // failed attempt leaves no file and the name stays free. Every step needs write access only,
  // which is all the task has on the books folder.
  let file: Deno.FsFile;
  try {
    await Deno.mkdir(path.dirname(outputPath), { recursive: true });
    file = await Deno.open(outputPath, { write: true, createNew: true });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw new CleanRefusal(
        `${outputPath} already exists, and the cleaner never overwrites a record`,
      );
    }
    throw new CleanRefusal(`could not write ${outputPath} (${(error as Error).name})`);
  }
  try {
    const bytes = new TextEncoder().encode(csv);
    let written = 0;
    while (written < bytes.length) written += await file.write(bytes.subarray(written));
    file.close();
  } catch (error) {
    try {
      file.close();
    } catch {
      // already closed
    }
    await Deno.remove(outputPath).catch(() => {});
    throw new CleanRefusal(`could not write ${outputPath} (${(error as Error).name})`);
  }
  return { count: lines.length, outputPath };
}

const USAGE = "usage: deno task accounting:clean-download <file> [--sweep] [--books-dir <path>]";

/** The command line; returns the exit code. */
export async function main(args: string[]): Promise<number> {
  let input: string | undefined;
  let sweep = false;
  let booksDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--sweep") sweep = true;
    else if (a === "--books-dir") booksDir = args[++i];
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return 0;
    } else if (a.startsWith("-") || input !== undefined) {
      console.error(USAGE);
      return 1;
    } else input = a;
  }
  if (!input || (booksDir === undefined && args.includes("--books-dir"))) {
    console.error(USAGE);
    return 1;
  }
  const home = Deno.env.get("HOME");
  if (!booksDir && !home) {
    console.error(
      "clean-download: HOME is not set, so the books folder cannot be found; nothing was written.",
    );
    return 1;
  }
  booksDir ??= path.join(home!, "Dropbox", "web-jam-llms", "financial", "books");
  try {
    const result = await cleanDownload({ input, booksDir, sweep });
    console.log(
      `Wrote ${result.count} line${result.count === 1 ? "" : "s"} to ${result.outputPath}`,
    );
    return 0;
  } catch (error) {
    const reason = error instanceof CleanRefusal
      ? error.message
      : `unexpected ${(error as Error).name}`;
    console.error(`clean-download refused ${input}: ${reason}. Nothing was written.`);
    return 1;
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
