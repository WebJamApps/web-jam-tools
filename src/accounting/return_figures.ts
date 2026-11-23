// src/accounting/return_figures.ts
// The return-figure finder of the accounting skill (web-jam-tools#1864).
//
// Design: ~/Dropbox/web-jam-llms/songwriting/web-jam-music-media-design.md, "The accounting
// skill", the bullets "What never reaches an agent" and "The return-figure finder".
//
// Josh runs it in his own terminal, outside every agent, on the two filed returns saved in
// ~/Dropbox/financial-private/tax/<year>/. It reads each PDF's text with `pdftotext` and writes
// tax/<year>/return-figures.md in the books folder holding three figures, each with the form and
// line it came from. It finds each figure by the words printed beside it, copies nothing else from
// a return, and names any figure it cannot find. It runs the personal-number checker on what it is
// about to write and writes nothing when the checker finds anything.
//
// Three outcomes:
// - a figure's printed words are found on one row with an amount after its line number: written;
// - they are not found, or found with no readable amount: the figure is named as missing;
// - a PDF cannot be read, pdftotext cannot run, or the checker finds a protected number in the
//   output: the program refuses and writes nothing.

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import {
  describeKinds,
  detectPersonalNumbers,
  type PersonalNumberFinding,
} from "../../hooks/lib/detect_personal_numbers.ts";

export interface FigureSpec {
  /** What the figure is, as the output names it. */
  name: string;
  /** Which of the two returns holds it. */
  form: "federal" | "virginia";
  formName: string;
  /** The line number printed beside the figure. */
  line: string;
  /** The words printed beside the figure, by which it is found, any run of spaces between them. */
  words: RegExp;
  /** The line number as its own token, not part of a longer number. */
  linePattern: RegExp;
}

/** The three figures the design names, in the order the output lists them. */
export const FIGURES: readonly FigureSpec[] = [
  {
    name: "Federal adjusted gross income",
    form: "federal",
    formName: "Form 1040",
    line: "11a",
    words: /This\s+is\s+your\s+adjusted\s+gross\s+income/i,
    linePattern: /(?<![\w,])11a(?!\w)/i,
  },
  {
    name: "Federal total tax",
    form: "federal",
    formName: "Form 1040",
    line: "24",
    words: /This\s+is\s+your\s+total\s+tax/i,
    linePattern: /(?<![\w,])24(?!\w)/,
  },
  {
    name: "Virginia tax",
    form: "virginia",
    formName: "Form 760",
    line: "18",
    words: /Net\s+Amount\s+of\s+Tax/i,
    linePattern: /(?<![\w,])18(?!\w)/,
  },
];

export type FigureResult =
  | { spec: FigureSpec; found: true; amount: string }
  | { spec: FigureSpec; found: false; reason: string };

/** A refusal: nothing is written. */
export class ReturnFiguresRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReturnFiguresRefusal";
  }
}

// An amount as a return prints it: optional sign or parentheses, optional "$", whole dollars with
// or without thousands commas, then optional cents (".00", ". 00") or a lone trailing ".".
const AMOUNT =
  /^\(?\s*(-)?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d{1,12})(?:\s*\.\s*(\d{2})(?!\d)|\.(?!\s*\d))?\s*(\))?/;

/** Reads the amount at the start of `tail`, or null when the row holds anything else. */
function readAmount(tail: string): string | null {
  const t = tail.trim();
  if (/^-0-$/.test(t)) return "0";
  const m = t.match(AMOUNT);
  if (!m) return null;
  // Parentheses must pair: "(1,234)" is negative, "(1,234" or "1,234)" is not an amount.
  if (t.startsWith("(") !== Boolean(m[4])) return null;
  // Anything left on the row after the amount means the row is not one amount; nothing is guessed.
  if (t.slice(m[0].length).trim() !== "") return null;
  const negative = Boolean(m[1]) || Boolean(m[4]);
  const dollars = m[2].replace(/,/g, "").replace(/^0+(?=\d)/, "");
  const cents = m[3] && m[3] !== "00" ? `.${m[3]}` : "";
  const value = `${dollars}${cents}`;
  return negative && value !== "0" ? `-${value}` : value;
}

/** Finds one figure in a return's text by the words printed beside it. */
export function findFigure(text: string, spec: FigureSpec): FigureResult {
  const rows = text.split(/\r?\n|\f/).filter((row) => spec.words.test(row));
  if (rows.length === 0) {
    return { spec, found: false, reason: "its printed words were not found" };
  }
  if (rows.length > 1) {
    return { spec, found: false, reason: "its printed words appear on more than one row" };
  }
  const row = rows[0];
  const match = row.match(spec.words)!;
  const rest = row.slice(match.index! + match[0].length);
  const labelMatch = rest.match(spec.linePattern);
  if (!labelMatch) {
    return { spec, found: false, reason: "its line number was not found beside its words" };
  }
  const tail = rest.slice(labelMatch.index! + labelMatch[0].length);
  // Dot leaders, spaces and a pre-printed ". 00" cents box are all a blank line holds.
  if (/^[.\s]*(?:00)?\s*$/.test(tail)) {
    return { spec, found: false, reason: "no amount is printed on its line" };
  }
  const amount = readAmount(tail);
  if (amount === null) {
    return { spec, found: false, reason: "the amount on its line could not be read" };
  }
  return { spec, found: true, amount };
}

/** Finds all three figures: the federal ones in the federal text, the Virginia one in its own. */
export function findFigures(federalText: string, virginiaText: string): FigureResult[] {
  return FIGURES.map((spec) =>
    findFigure(spec.form === "federal" ? federalText : virginiaText, spec)
  );
}

/** The file the finder writes. It holds the three figures and nothing else from the returns. */
export function renderFiguresMarkdown(year: string, results: FigureResult[]): string {
  const lines = [
    `# ${year} return figures`,
    "",
    `Written by \`deno task accounting:return-figures\` from the filed ${year} federal and Virginia returns.`,
    "It holds these three figures and nothing else from the returns.",
    "",
    "| Figure | Form and line | Amount |",
    "| --- | --- | --- |",
  ];
  for (const r of results) {
    const where = `${r.spec.formName}, line ${r.spec.line}`;
    lines.push(`| ${r.spec.name} | ${where} | ${r.found ? r.amount : "missing"} |`);
  }
  const missing = results.filter((r) => !r.found);
  if (missing.length > 0) {
    lines.push("", "## Missing", "", "Type each of these to the agent from the filed return:", "");
    for (const r of missing) {
      if (!r.found) {
        lines.push(`- ${r.spec.name} (${r.spec.formName}, line ${r.spec.line}): ${r.reason}.`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

export type TextExtractor = (pdfPath: string) => Promise<string>;

/** Reads a PDF's text with `pdftotext -layout`, keeping each printed row on one line. */
export async function extractPdfText(pdfPath: string, bin = "pdftotext"): Promise<string> {
  const name = path.basename(pdfPath);
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(bin, {
      args: ["-layout", "-enc", "UTF-8", pdfPath, "-"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new ReturnFiguresRefusal(
        "pdftotext is not installed (sudo apt-get install poppler-utils).",
      );
    }
    throw new ReturnFiguresRefusal(
      `pdftotext could not run: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!output.success) {
    throw new ReturnFiguresRefusal(`pdftotext could not read ${name}.`);
  }
  return new TextDecoder().decode(output.stdout);
}

export interface ReturnFiguresOptions {
  federalPdf: string;
  virginiaPdf: string;
  year: string;
  /** ~/Dropbox/financial-private/tax: each PDF must be inside its <year> folder. */
  privateTaxDir: string;
  /** ~/Dropbox/web-jam-llms/financial/books: the output goes in its tax/<year> folder. */
  booksDir: string;
  extractText?: TextExtractor;
  detect?: (text: string) => PersonalNumberFinding[];
}

export interface ReturnFiguresResult {
  outputPath: string;
  results: FigureResult[];
}

/**
 * The requested year's folder as it really is on disk. The folder must resolve to the <year>
 * folder of the tax folder itself: a 2025 folder that is a link to 2024, or to anywhere else, is
 * refused before any return is read, so one year's returns are never written up as another's.
 */
async function resolveYearDir(privateTaxDir: string, year: string): Promise<string> {
  let realTaxDir: string;
  try {
    realTaxDir = await Deno.realPath(privateTaxDir);
  } catch {
    throw new ReturnFiguresRefusal(`The folder ${privateTaxDir} cannot be read.`);
  }
  const yearDir = path.join(privateTaxDir, year);
  let realYearDir: string;
  try {
    realYearDir = await Deno.realPath(yearDir);
  } catch {
    throw new ReturnFiguresRefusal(`The folder ${yearDir} cannot be read.`);
  }
  if (realYearDir !== path.join(realTaxDir, year)) {
    throw new ReturnFiguresRefusal(
      `The folder ${yearDir} leads somewhere other than the ${year} folder of ${privateTaxDir}; the returns must be saved in that year's own folder.`,
    );
  }
  return realYearDir;
}

/** `realDir` is a folder already resolved by resolveYearDir. */
async function resolveInside(
  file: string,
  realDir: string,
  dir: string,
  label: string,
): Promise<string> {
  let real: string;
  try {
    real = await Deno.realPath(file);
  } catch {
    throw new ReturnFiguresRefusal(`The ${label} return ${file} cannot be read.`);
  }
  if (!real.startsWith(realDir + path.SEPARATOR)) {
    throw new ReturnFiguresRefusal(`The ${label} return must be saved in ${dir}.`);
  }
  const info = await Deno.stat(real);
  if (!info.isFile) {
    throw new ReturnFiguresRefusal(`The ${label} return ${file} is not a file.`);
  }
  return real;
}

/**
 * Finds the three figures and writes return-figures.md. Throws ReturnFiguresRefusal, having
 * written nothing, when a return cannot be read, pdftotext cannot run, the output already exists,
 * or the checker finds a protected number in what would be written.
 */
export async function runReturnFigures(opts: ReturnFiguresOptions): Promise<ReturnFiguresResult> {
  if (!/^\d{4}$/.test(opts.year)) {
    throw new ReturnFiguresRefusal("--year must be a four-digit year, such as 2025.");
  }
  const yearDir = path.join(opts.privateTaxDir, opts.year);
  const realYearDir = await resolveYearDir(opts.privateTaxDir, opts.year);
  const federal = await resolveInside(opts.federalPdf, realYearDir, yearDir, "federal");
  const virginia = await resolveInside(opts.virginiaPdf, realYearDir, yearDir, "Virginia");

  const extract = opts.extractText ?? ((p: string) => extractPdfText(p));
  const federalText = await extract(federal);
  const virginiaText = await extract(virginia);
  for (const [label, text] of [["federal", federalText], ["Virginia", virginiaText]]) {
    if (text.trim() === "") {
      throw new ReturnFiguresRefusal(
        `The ${label} return holds no readable text (a scanned image cannot be read).`,
      );
    }
  }

  const results = findFigures(federalText, virginiaText);
  const markdown = renderFiguresMarkdown(opts.year, results);
  const findings = (opts.detect ?? detectPersonalNumbers)(markdown);
  if (findings.length > 0) {
    throw new ReturnFiguresRefusal(
      `The checker found ${describeKinds(findings)} in what would be written; nothing was written.`,
    );
  }

  const outDir = path.join(opts.booksDir, "tax", opts.year);
  const outputPath = path.join(outDir, "return-figures.md");
  await Deno.mkdir(outDir, { recursive: true });
  // The record is written in full to a temporary file beside it, then linked into place. Linking
  // never replaces an existing file, so an existing record is kept, and a write that fails leaves
  // the record's name free for the next run. The temporary file is removed either way.
  const temp = path.join(outDir, `.return-figures.${crypto.randomUUID()}.tmp`);
  try {
    await Deno.writeTextFile(temp, markdown, { createNew: true });
    try {
      await Deno.link(temp, outputPath);
    } catch (err) {
      if (err instanceof Deno.errors.AlreadyExists) {
        throw new ReturnFiguresRefusal(
          `${outputPath} already exists; rename it first if the figures are to be found again.`,
        );
      }
      throw err;
    }
  } finally {
    await Deno.remove(temp).catch(() => {});
  }
  return { outputPath, results };
}

const USAGE = `Usage: deno task accounting:return-figures <federal.pdf> <virginia.pdf> --year <year>

Reads the two filed returns from ~/Dropbox/financial-private/tax/<year>/ and writes
~/Dropbox/web-jam-llms/financial/books/tax/<year>/return-figures.md holding the federal adjusted
gross income (Form 1040, line 11a), the federal total tax (Form 1040, line 24) and the Virginia tax
(Form 760, line 18). Run it in your own terminal, never with Claude Code's "!".
One PDF holding both returns may be given twice.`;

/** The command line. Prints which figures were found and which are missing, never an amount. */
export async function runReturnFiguresCli(args: string[], home: string): Promise<number> {
  const flags = parseArgs(args, { string: ["year"], boolean: ["help"], alias: { h: "help" } });
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  const files = flags._.map(String);
  if (files.length !== 2 || !flags.year) {
    console.error(USAGE);
    return 1;
  }
  try {
    const { outputPath, results } = await runReturnFigures({
      federalPdf: path.resolve(files[0]),
      virginiaPdf: path.resolve(files[1]),
      year: flags.year,
      privateTaxDir: path.join(home, "Dropbox", "financial-private", "tax"),
      booksDir: path.join(home, "Dropbox", "web-jam-llms", "financial", "books"),
    });
    console.log(`[accounting:return-figures] Wrote ${outputPath}`);
    for (const r of results) {
      const where = `${r.spec.formName}, line ${r.spec.line}`;
      console.log(
        r.found
          ? `  found:   ${r.spec.name} (${where})`
          : `  missing: ${r.spec.name} (${where}): ${r.reason}`,
      );
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[accounting:return-figures] Refused, nothing written: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await runReturnFiguresCli(Deno.args, Deno.env.get("HOME") ?? ""));
}
