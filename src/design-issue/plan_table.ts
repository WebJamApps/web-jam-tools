// src/design-issue/plan_table.ts
// Gate 2 plan-table parser for `deno task design:lint-plan` (web-jam-tools#795).
//
// Parses the Gate 2 issue-plan markdown table (skills/design-issue/SKILL.md, "Propose the plan
// table") out of a design document into a clean, typed output contract: header cells, well-formed
// data rows, and malformed rows kept distinguishable from well-formed ones. Parser only -- no
// validation of cell values (model tiers, repos, priorities, etc.). That is a separate dependent
// issue; this module exports its types so that issue can consume this one's output directly.

import * as path from "@std/path";
import { expandHome } from "./gate1.ts";

/** The Gate 2 plan table's header cells, verbatim from `skills/design-issue/SKILL.md`. */
export const PLAN_TABLE_HEADER = [
  "#",
  "Proposed title",
  "Epic / child of",
  "Model tier",
  "Priority",
  "Repo",
  "Tests",
  "Closes when",
] as const;

/** A well-formed plan table data row: its cell count matches the header. */
export interface PlanTableRow {
  /** 1-based line number in the source document this row was read from. */
  line: number;
  /** Cell text, in column order, trimmed of surrounding whitespace and tab/space padding. */
  cells: string[];
}

/**
 * A plan table data row whose cell count did not match the header column count. Never
 * silently truncated or padded to fit -- reported here instead, distinguishable from
 * `PlanTableRow` so a consumer cannot mistake a malformed row for a well-formed one.
 */
export interface MalformedPlanTableRow {
  /** 1-based line number in the source document this row was read from. */
  line: number;
  /** Cell text as parsed, in column order, trimmed of surrounding whitespace. */
  cells: string[];
  /** Number of columns the table's header declares. */
  expectedCellCount: number;
  /** Number of cells actually found on this row. */
  actualCellCount: number;
}

/** The parsed Gate 2 plan table. */
export interface ParsedPlanTable {
  /** 1-based line number of the header row. */
  headerLine: number;
  /** Header cell text, in column order, trimmed of surrounding whitespace. */
  headerCells: string[];
  /** Well-formed data rows -- cell count matches the header. */
  rows: PlanTableRow[];
  /** Malformed data rows -- cell count did not match the header. See `MalformedPlanTableRow`. */
  malformedRows: MalformedPlanTableRow[];
}

/**
 * Splits one markdown table row line into its cell text, in column order.
 *
 * Handles both the leading/trailing-pipe row style (`| a | b |`) and the pipe-less style
 * (`a | b`); an escaped pipe (`\|`) inside a cell is unescaped to a literal `|` and never
 * splits the cell; a pipe inside an inline code span (`` `a|b` ``, of any backtick run
 * length) never splits the cell either. Each returned cell is trimmed of surrounding
 * whitespace, including tabs and multi-space padding.
 */
export function splitTableRowCells(rawLine: string): string[] {
  const line = rawLine.trim();
  const cells: string[] = [];
  let current = "";
  let i = 0;
  const n = line.length;
  let inCode = false;
  let codeFenceLen = 0;

  while (i < n) {
    const ch = line[i];

    if (!inCode && ch === "\\" && i + 1 < n && line[i + 1] === "|") {
      current += "|";
      i += 2;
      continue;
    }

    if (ch === "`") {
      let j = i;
      while (j < n && line[j] === "`") j++;
      const runLen = j - i;
      if (!inCode) {
        inCode = true;
        codeFenceLen = runLen;
      } else if (runLen === codeFenceLen) {
        inCode = false;
      }
      current += line.slice(i, j);
      i = j;
      continue;
    }

    if (!inCode && ch === "|") {
      cells.push(current);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  cells.push(current);

  const trimmed = cells.map((c) => c.trim());
  if (trimmed.length > 0 && trimmed[0] === "") trimmed.shift();
  if (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
  return trimmed;
}

function isFenceLine(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

function isAlignmentCell(cell: string): boolean {
  return /^:?-+:?$/.test(cell.trim());
}

function isAlignmentRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(isAlignmentCell);
}

function normalizeHeaderCell(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, " ");
}

function headerMatchesPlanTable(cells: string[]): boolean {
  if (cells.length !== PLAN_TABLE_HEADER.length) return false;
  return cells.every(
    (c, idx) => normalizeHeaderCell(c) === normalizeHeaderCell(PLAN_TABLE_HEADER[idx]),
  );
}

/**
 * Parses the Gate 2 plan table out of a design document's markdown content.
 *
 * The plan table is identified by its header row content (matching `PLAN_TABLE_HEADER`),
 * never by its position in the document -- so an unrelated table earlier in the document is
 * skipped rather than mistaken for the plan table. A table inside a fenced code block
 * (``` or ~~~) is never treated as the plan table. Line endings are normalized so CRLF and
 * LF source files parse identically. A table ends at a blank line or at end of file.
 *
 * Returns `null` when the document contains no table whose header matches
 * `PLAN_TABLE_HEADER`.
 */
export function parsePlanTable(markdown: string): ParsedPlanTable | null {
  const lines = markdown.split(/\r?\n/);
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isFenceLine(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (!line.includes("|")) continue;

    const nextLine = lines[i + 1];
    if (nextLine === undefined || inCodeBlock || isFenceLine(nextLine)) continue;

    const headerCells = splitTableRowCells(line);
    const alignmentCells = splitTableRowCells(nextLine);

    if (
      alignmentCells.length === 0 ||
      alignmentCells.length !== headerCells.length ||
      !isAlignmentRow(alignmentCells)
    ) {
      continue;
    }

    // A real table header + alignment row pair. Read its data rows either way, so a
    // non-matching table's rows are never mistaken for a second header candidate.
    let j = i + 2;
    const dataRows: Array<{ line: number; cells: string[] }> = [];
    for (; j < lines.length; j++) {
      const dataLine = lines[j];
      if (dataLine.trim() === "" || isFenceLine(dataLine)) break;
      dataRows.push({ line: j + 1, cells: splitTableRowCells(dataLine) });
    }

    if (headerMatchesPlanTable(headerCells)) {
      const rows: PlanTableRow[] = [];
      const malformedRows: MalformedPlanTableRow[] = [];
      for (const row of dataRows) {
        if (row.cells.length === headerCells.length) {
          rows.push(row);
        } else {
          malformedRows.push({
            ...row,
            expectedCellCount: headerCells.length,
            actualCellCount: row.cells.length,
          });
        }
      }
      return {
        headerLine: i + 1,
        headerCells,
        rows,
        malformedRows,
      };
    }

    // Not the plan table -- skip past its rows so they are never re-scanned as candidates.
    i = j - 1;
  }

  return null;
}

/**
 * Reads a design document from disk and parses its Gate 2 plan table.
 * Throws if the file cannot be read; returns `null` (never throws) if the file has no plan
 * table, per `parsePlanTable`.
 */
export async function parsePlanTableFromFile(filePath: string): Promise<ParsedPlanTable | null> {
  if (!filePath || filePath.trim() === "") {
    throw new Error("Plan document path is required");
  }

  const absPath = path.resolve(expandHome(filePath.trim()));

  let content: string;
  try {
    content = await Deno.readTextFile(absPath);
  } catch (err) {
    throw new Error(
      `Plan document not found or cannot be read at ${absPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return parsePlanTable(content);
}
