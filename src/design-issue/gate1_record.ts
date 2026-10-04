// src/design-issue/gate1_record.ts
// Gate 1 disk record helper for design-issue:
// - Stores Gate 1 status records under ~/.claude/state/design-gate1/<hash>.json
//   (hash is SHA-256 of the design document's absolute path).
// - Manages openGate1Record, approveGate1Record, getGate1Status, and loadGate1Record.
// - References: web-jam-tools#1155, design doc decisions 57-60.

import crypto from "node:crypto";
import * as path from "@std/path";
import { expandHome } from "./gate1.ts";
import {
  isTableSeparatorRow,
  isValidIsoDate,
  type LoadBearingPremisesTable,
  readLoadBearingPremisesTable,
  stripCellDecoration,
  toLocalIsoDate,
  validateLoadBearingPremisesTableStructure,
} from "./lint_doc.ts";

/** One stored row of the document's `## Load-bearing premises` table. */
export interface PremiseRow {
  premise: string;
  proof: string;
  proved: string; // the row's Proved cell, trimmed
}

export interface Gate1Record {
  docPath: string; // Absolute path to design document
  presentedFingerprint: string; // SHA-256 hex of document content when presented
  presentedAt: string; // ISO 8601 timestamp
  approvedAt?: string; // ISO 8601 timestamp when approved
  reply?: string; // Verbatim text of approving reply
  approvedFingerprint?: string; // SHA-256 hex covered by approval
  premiseRows?: PremiseRow[]; // premise rows as last approved or adopted
  premiseRowsSource?: "approval" | "adoption"; // where premiseRows came from
  premiseRowsStoredAt?: string; // ISO 8601 timestamp the rows were stored
  premiseRowsAdoptionReply?: string; // Josh's reply verbatim, adoption only
}

export type Gate1StatusType =
  | "not presented"
  | "open"
  | "approved"
  | "changed since approval";

export interface Gate1StatusResult {
  status: Gate1StatusType;
  docPath: string;
  recordPath: string;
  record?: Gate1Record;
  reply?: string;
  approvedAt?: string;
  currentFingerprint?: string;
  presentedFingerprint?: string;
  approvedFingerprint?: string;
}

export class Gate1RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Gate1RecordError";
  }
}

/**
 * Computes SHA-256 hex digest of a string.
 */
export function computeFingerprint(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Computes SHA-256 hex digest of the document's absolute path.
 */
export function hashDocPath(absDocPath: string): string {
  return crypto.createHash("sha256").update(absDocPath, "utf8").digest("hex");
}

/**
 * Resolves the directory where Gate 1 records are stored:
 * Precedence: explicit overrideDir -> DESIGN_GATE1_STATE_DIR -> $HOME/.claude/state/design-gate1
 */
export function getGate1StateDir(overrideDir?: string): string {
  if (overrideDir) return overrideDir;
  const envOverride = Deno.env.get("DESIGN_GATE1_STATE_DIR");
  if (envOverride) return envOverride;
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/home/joshua";
  return path.join(home, ".claude", "state", "design-gate1");
}

/**
 * Resolves the absolute path to the JSON file for a given design document.
 */
export function getGate1RecordPath(docPath: string, stateDir?: string): string {
  const absDocPath = path.resolve(expandHome(docPath.trim()));
  const hash = hashDocPath(absDocPath);
  const dir = getGate1StateDir(stateDir);
  return path.join(dir, `${hash}.json`);
}

export interface ParsedPremisesTable {
  headingFound: boolean;
  headerFound: boolean;
  missingColumns: string[]; // of Premise, Proof, Proved
  rows: PremiseRow[];
  table: LoadBearingPremisesTable; // the table as lint_doc.ts read it
}

/**
 * The document's premise rows, taken from the one reader of the `## Load-bearing premises` table
 * (`readLoadBearingPremisesTable` in lint_doc.ts) so the rows stored are the rows the checker
 * judged. Columns are matched by header name, never by position. Never throws.
 */
export function parsePremisesTable(content: string): ParsedPremisesTable {
  const table = readLoadBearingPremisesTable(content.split(/\r?\n/));
  const { headingFound, headerRow } = table;
  if (!headerRow) return { headingFound, headerFound: false, missingColumns: [], rows: [], table };
  const col = (name: RegExp) => headerRow.cells.findIndex((c) => name.test(stripCellDecoration(c)));
  const premiseIdx = col(/^premise$/i);
  const proofIdx = col(/^proof$/i);
  const provedIdx = col(/^proved$/i);
  const missingColumns: string[] = [];
  if (premiseIdx === -1) missingColumns.push("Premise");
  if (proofIdx === -1) missingColumns.push("Proof");
  if (provedIdx === -1) missingColumns.push("Proved");
  const rows: PremiseRow[] = [];
  for (const row of table.rows) {
    if (row === headerRow || isTableSeparatorRow(row.cells)) continue;
    rows.push({
      premise: (premiseIdx === -1 ? "" : row.cells[premiseIdx] ?? "").trim(),
      proof: (proofIdx === -1 ? "" : row.cells[proofIdx] ?? "").trim(),
      proved: (provedIdx === -1 ? "" : row.cells[provedIdx] ?? "").trim(),
    });
  }
  return { headingFound, headerFound: true, missingColumns, rows, table };
}

/** Rows stored on approval: the rows as they stand; a document without a table stores none. */
function premiseRowsForApproval(content: string): PremiseRow[] {
  return parsePremisesTable(content).rows;
}

/** Strict reading for adoption: refuses a missing or malformed table or a bad Proved date. */
function premiseRowsForAdoption(content: string, todayIso: string): PremiseRow[] {
  const parsed = parsePremisesTable(content);
  if (!parsed.headingFound) {
    throw new Gate1RecordError(
      "The design document has no '## Load-bearing premises' heading — refusing to adopt.",
    );
  }
  if (!parsed.headerFound) {
    throw new Gate1RecordError(
      "The '## Load-bearing premises' section has no table — refusing to adopt.",
    );
  }
  if (parsed.missingColumns.length > 0) {
    throw new Gate1RecordError(
      `The premises table has no ${
        parsed.missingColumns.map((c) => `'${c}'`).join(", ")
      } column — refusing to adopt.`,
    );
  }
  if (parsed.rows.length === 0) {
    throw new Gate1RecordError("The premises table has no data rows — refusing to adopt.");
  }
  for (const row of parsed.rows) {
    const date = stripCellDecoration(row.proved);
    if (!isValidIsoDate(date)) {
      throw new Gate1RecordError(
        `Premise row "${row.premise}" has a missing or malformed Proved date: "${row.proved}" — refusing to adopt.`,
      );
    }
    if (date > todayIso) {
      throw new Gate1RecordError(
        `Premise row "${row.premise}" has a Proved date (${date}) later than today (${todayIso}) — refusing to adopt.`,
      );
    }
  }
  // The same structure checks design:lint-doc applies to this table: a row whose cell count
  // differs from the header's, duplicate rows, or a separator row out of place.
  const structural = validateLoadBearingPremisesTableStructure(
    parsed.table.rows,
    parsed.table.headerRow!,
  );
  if (structural.length > 0) {
    throw new Gate1RecordError(
      `The premises table is malformed: ${structural[0].message} — refusing to adopt.`,
    );
  }
  return parsed.rows;
}

/** Reads an existing record: null when none exists, throws when it cannot be read or parsed. */
async function readExistingRecord(recordPath: string): Promise<Gate1Record | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(recordPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw new Gate1RecordError(
      `Cannot read Gate 1 record at ${recordPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Gate1RecordError(
      `Cannot parse Gate 1 record at ${recordPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Gate1RecordError(`Cannot parse Gate 1 record at ${recordPath}: not a JSON object`);
  }
  return parsed as Gate1Record;
}

/**
 * Opens a Gate 1 record on disk each time a design document is presented.
 * Clears any earlier approval, keeps the stored premise rows, and refuses (leaving the file
 * untouched) when an existing record cannot be read or parsed.
 */
export async function openGate1Record(
  docPath: string,
  content: string,
  options?: { stateDir?: string },
): Promise<{ record: Gate1Record; recordPath: string }> {
  const absDocPath = path.resolve(expandHome(docPath.trim()));
  const dir = getGate1StateDir(options?.stateDir);
  const recordPath = getGate1RecordPath(absDocPath, dir);

  const existing = await readExistingRecord(recordPath);

  await Deno.mkdir(dir, { recursive: true });

  const record: Gate1Record = {
    docPath: absDocPath,
    presentedFingerprint: computeFingerprint(content),
    presentedAt: new Date().toISOString(),
  };
  if (existing?.premiseRows !== undefined) record.premiseRows = existing.premiseRows;
  if (existing?.premiseRowsSource !== undefined) {
    record.premiseRowsSource = existing.premiseRowsSource;
  }
  if (existing?.premiseRowsStoredAt !== undefined) {
    record.premiseRowsStoredAt = existing.premiseRowsStoredAt;
  }
  if (existing?.premiseRowsAdoptionReply !== undefined) {
    record.premiseRowsAdoptionReply = existing.premiseRowsAdoptionReply;
  }

  await Deno.writeTextFile(recordPath, JSON.stringify(record, null, 2) + "\n");
  return { record, recordPath };
}

/**
 * Approves an open Gate 1 record on disk:
 * - Refuses if reply is empty
 * - Refuses if design document cannot be read
 * - Refuses if record file cannot be read or parsed
 * - Refuses if no record exists for the document
 * - Refuses if record is not open (already approved)
 * - Refuses if document fingerprint has changed since it was presented
 * - Otherwise records the approving reply verbatim and current document fingerprint, and
 *   stores the document's premise rows as they stand, replacing any stored before
 */
export async function approveGate1Record(
  docPath: string,
  reply: string,
  options?: { stateDir?: string },
): Promise<{ record: Gate1Record; recordPath: string }> {
  const absDocPath = path.resolve(expandHome(docPath.trim()));

  if (!reply || reply.trim() === "") {
    throw new Gate1RecordError(
      "Reply is empty — refusing to approve Gate 1. Explicit approving reply text is required.",
    );
  }

  let content: string;
  try {
    content = await Deno.readTextFile(absDocPath);
  } catch (err) {
    throw new Gate1RecordError(
      `Cannot read design document at ${absDocPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const dir = getGate1StateDir(options?.stateDir);
  const recordPath = getGate1RecordPath(absDocPath, dir);

  let recordText: string;
  try {
    recordText = await Deno.readTextFile(recordPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Gate1RecordError(
        `No Gate 1 record exists for ${absDocPath}. Present the document with deno task design:gate1 first.`,
      );
    }
    throw new Gate1RecordError(
      `Cannot read Gate 1 record at ${recordPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let record: Gate1Record;
  try {
    record = JSON.parse(recordText);
  } catch (err) {
    throw new Gate1RecordError(
      `Cannot parse Gate 1 record at ${recordPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!record.presentedFingerprint) {
    throw new Gate1RecordError(
      `Gate 1 record for ${absDocPath} was created by adoption and the document was never presented. Present it with deno task design:gate1 first.`,
    );
  }

  if (record.approvedAt) {
    throw new Gate1RecordError(
      `Gate 1 record for ${absDocPath} is not open (already approved at ${record.approvedAt}). Re-present the document with deno task design:gate1 to clear approval and re-open.`,
    );
  }

  const currentFingerprint = computeFingerprint(content);
  if (currentFingerprint !== record.presentedFingerprint) {
    throw new Gate1RecordError(
      `Document fingerprint (${currentFingerprint}) has changed since it was presented (${record.presentedFingerprint}) — refusing to approve Gate 1. Re-present the document with deno task design:gate1 first.`,
    );
  }

  record.approvedAt = new Date().toISOString();
  record.reply = reply;
  record.approvedFingerprint = currentFingerprint;
  record.premiseRows = premiseRowsForApproval(content);
  record.premiseRowsSource = "approval";
  record.premiseRowsStoredAt = record.approvedAt;
  delete record.premiseRowsAdoptionReply;

  await Deno.writeTextFile(recordPath, JSON.stringify(record, null, 2) + "\n");
  return { record, recordPath };
}

/**
 * Adopts a document's current premise rows into its Gate 1 record (a document approved before
 * rows were kept). Stores rows and the reply and nothing else: never writes approval fields.
 * Refuses when: the reply is empty; the document or record cannot be read or parsed; the record
 * already holds premise rows; the premises table is missing or malformed; or a row's Proved date
 * is missing, malformed or later than today. Creates the record when none exists.
 */
export async function adoptGate1Record(
  docPath: string,
  reply: string,
  options?: { stateDir?: string; now?: Date },
): Promise<{ record: Gate1Record; recordPath: string }> {
  const absDocPath = path.resolve(expandHome(docPath.trim()));
  if (!reply || reply.trim() === "") {
    throw new Gate1RecordError(
      "Reply is empty — refusing to adopt. Josh's reply, verbatim, is required.",
    );
  }
  let content: string;
  try {
    content = await Deno.readTextFile(absDocPath);
  } catch (err) {
    throw new Gate1RecordError(
      `Cannot read design document at ${absDocPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const dir = getGate1StateDir(options?.stateDir);
  const recordPath = getGate1RecordPath(absDocPath, dir);
  const existing = await readExistingRecord(recordPath);
  if (existing?.premiseRows && existing.premiseRows.length > 0) {
    throw new Gate1RecordError(
      `Gate 1 record for ${absDocPath} already holds ${existing.premiseRows.length} premise row(s) — adoption happens once per document; the stored rows now change only through Gate 1.`,
    );
  }
  const now = options?.now ?? new Date();
  const rows = premiseRowsForAdoption(content, toLocalIsoDate(now));

  const record: Gate1Record = existing ?? {
    docPath: absDocPath,
    presentedFingerprint: "",
    presentedAt: "",
  };
  record.premiseRows = rows;
  record.premiseRowsSource = "adoption";
  record.premiseRowsStoredAt = now.toISOString();
  record.premiseRowsAdoptionReply = reply;

  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(recordPath, JSON.stringify(record, null, 2) + "\n");
  return { record, recordPath };
}

/**
 * Returns the Gate 1 status for a design document:
 * - "not presented": no record exists on disk
 * - "open": record exists but has not been approved yet
 * - "approved": record is approved and document content matches approved fingerprint
 * - "changed since approval": record was approved but document content changed
 */
export async function getGate1Status(
  docPath: string,
  options?: { stateDir?: string },
): Promise<Gate1StatusResult> {
  const absDocPath = path.resolve(expandHome(docPath.trim()));
  const dir = getGate1StateDir(options?.stateDir);
  const recordPath = getGate1RecordPath(absDocPath, dir);

  let recordText: string;
  try {
    recordText = await Deno.readTextFile(recordPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return {
        status: "not presented",
        docPath: absDocPath,
        recordPath,
      };
    }
    throw new Gate1RecordError(
      `Cannot read Gate 1 record at ${recordPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let record: Gate1Record;
  try {
    record = JSON.parse(recordText);
  } catch (err) {
    throw new Gate1RecordError(
      `Cannot parse Gate 1 record at ${recordPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let content: string;
  try {
    content = await Deno.readTextFile(absDocPath);
  } catch (err) {
    throw new Gate1RecordError(
      `Cannot read design document at ${absDocPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const currentFingerprint = computeFingerprint(content);

  // A record created by adoption holds stored rows but the document was never presented, so
  // there is no open Gate 1 to ask about (same test approveGate1Record refuses on).
  if (!record.approvedAt && !record.presentedFingerprint) {
    return {
      status: "not presented",
      docPath: absDocPath,
      recordPath,
      record,
      currentFingerprint,
    };
  }

  if (!record.approvedAt) {
    return {
      status: "open",
      docPath: absDocPath,
      recordPath,
      record,
      presentedFingerprint: record.presentedFingerprint,
      currentFingerprint,
    };
  }

  if (currentFingerprint === record.approvedFingerprint) {
    return {
      status: "approved",
      docPath: absDocPath,
      recordPath,
      record,
      reply: record.reply,
      approvedAt: record.approvedAt,
      approvedFingerprint: record.approvedFingerprint,
      currentFingerprint,
    };
  }

  return {
    status: "changed since approval",
    docPath: absDocPath,
    recordPath,
    record,
    reply: record.reply,
    approvedAt: record.approvedAt,
    approvedFingerprint: record.approvedFingerprint,
    currentFingerprint,
  };
}

/**
 * Loads a Gate 1 record if it exists, or returns null if not found.
 */
export async function loadGate1Record(
  docPath: string,
  options?: { stateDir?: string },
): Promise<Gate1Record | null> {
  const absDocPath = path.resolve(expandHome(docPath.trim()));
  const dir = getGate1StateDir(options?.stateDir);
  const recordPath = getGate1RecordPath(absDocPath, dir);

  try {
    const text = await Deno.readTextFile(recordPath);
    return JSON.parse(text) as Gate1Record;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return null;
    }
    throw new Gate1RecordError(
      `Cannot read Gate 1 record at ${recordPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Formats Gate1StatusResult into human-readable lines.
 */
export function formatGate1Status(result: Gate1StatusResult): string[] {
  const lines: string[] = [];
  switch (result.status) {
    case "not presented":
      lines.push("[design:gate1-status] not presented");
      lines.push(
        result.record
          ? `  The Gate 1 record for ${result.docPath} holds adopted premise rows only; the document has not been presented`
          : `  No Gate 1 record exists for ${result.docPath}`,
      );
      break;
    case "open":
      lines.push("[design:gate1-status] open");
      if (result.record?.presentedAt) {
        lines.push(`  Presented at: ${result.record.presentedAt}`);
      }
      if (result.presentedFingerprint) {
        lines.push(`  Presented fingerprint: ${result.presentedFingerprint}`);
      }
      break;
    case "approved":
      lines.push(`[design:gate1-status] approved: "${result.reply ?? ""}"`);
      lines.push(`Gate 1 approval recorded ${result.approvedAt ?? ""}: "${result.reply ?? ""}"`);
      if (result.approvedFingerprint) {
        lines.push(`  Approved fingerprint: ${result.approvedFingerprint}`);
      }
      break;
    case "changed since approval":
      lines.push("[design:gate1-status] changed since approval");
      lines.push(`  Current fingerprint:  ${result.currentFingerprint}`);
      lines.push(`  Approved fingerprint: ${result.approvedFingerprint}`);
      lines.push(`  Gate 1 approval recorded ${result.approvedAt ?? ""}: "${result.reply ?? ""}"`);
      break;
  }
  const rowLine = formatStoredRowsLine(result.record);
  if (rowLine) lines.push(rowLine);
  return lines;
}

/** One line: stored premise-row count, source (approval or adoption) and its date. */
function formatStoredRowsLine(record?: Gate1Record): string | null {
  if (!record?.premiseRows) return null;
  const source = record.premiseRowsSource ?? "unknown";
  // The local calendar day, as the Proved-date checks use: a UTC slice shows the next day for
  // rows stored in the evening.
  const storedAt = new Date(record.premiseRowsStoredAt ?? "");
  const date = Number.isNaN(storedAt.getTime()) ? "" : toLocalIsoDate(storedAt);
  return `  Stored premise rows: ${record.premiseRows.length} (source: ${source}, ${date})`;
}
