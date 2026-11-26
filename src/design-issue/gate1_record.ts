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
  readDecisionRecordDataRows,
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

/** One sweep note recorded by `deno task design:sweep-note <doc.md> <other.md> --reason "<why>"`. */
export interface SweepNote {
  otherPath: string;
  reason: string;
  recordedAt: string;
}

export type OtherDesignSweepStatus = "revised" | "noted" | "unreadable-noted";

/** One entry in the Gate 1 cross-design sweep record shown on the Gate 1 page. */
export interface OtherDesignSweepEntry {
  otherPath: string;
  lines: number[];
  terms: string[];
  status: OtherDesignSweepStatus;
  reason?: string;
  revisionDate?: string;
}

/** Snapshot of the cross-design sweep checked at Gate 1. */
export interface OtherDesignSweepResult {
  terms: string[];
  checkedAt: string;
  presentingDay: string;
  entries: OtherDesignSweepEntry[];
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
  decisionRowCount?: number; // number of decision-record data rows at last approval
  sweepNotes?: SweepNote[]; // Active sweep notes recorded for the current revision
  otherDesignSweep?: OtherDesignSweepResult; // Cross-design sweep recorded at Gate 1
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

/** Carry a rename without approving unrelated edits or refreshing stale premise rows. */
export function carryGate1Record(
  record: Gate1Record,
  docPath: string,
  before: string,
  after: string,
  replace: (text: string) => string,
): Gate1Record {
  const carried = structuredClone(record);
  carried.docPath = docPath;
  const beforeHash = computeFingerprint(before);
  if (record.presentedFingerprint === beforeHash) {
    carried.presentedFingerprint = computeFingerprint(after);
  }
  if (record.approvedAt && record.approvedFingerprint === beforeHash) {
    carried.approvedFingerprint = computeFingerprint(after);
    carried.premiseRows = record.premiseRows?.map((row) => ({
      premise: replace(row.premise),
      proof: replace(row.proof),
      proved: row.proved,
    }));
  }
  return carried;
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

const RECORD_LOCK_WAIT_MS = 10_000;
const RECORD_LOCK_RETRY_MS = 25;

/**
 * Runs `fn` while holding an exclusive OS file lock (flock) on `<record>.lock`, so a presentation,
 * approval, adoption or sweep note never writes over another's read-then-write of the same record
 * (web-jam-tools#1412). The kernel ties the lock to the open file and releases it only when the
 * holder unlocks or exits, so a paused holder keeps it and a dead one never needs evicting. The
 * lock file is never removed: removing it would let a waiter lock an unlinked file while another
 * command locks a new one. Refuses when the lock is held past `waitMs` or cannot be taken at all.
 */
export async function withGate1RecordLock<T>(
  recordPath: string,
  fn: () => Promise<T>,
  waitMs = RECORD_LOCK_WAIT_MS,
): Promise<T> {
  const lockPath = `${recordPath}.lock`;
  const cannotLock = (err: unknown) =>
    new Gate1RecordError(
      `Cannot lock Gate 1 record at ${recordPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  let file: Deno.FsFile;
  try {
    await Deno.mkdir(path.dirname(recordPath), { recursive: true });
    file = await Deno.open(lockPath, { create: true, write: true });
  } catch (err) {
    throw cannotLock(err);
  }
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      let locked: boolean;
      try {
        locked = await file.tryLock(true);
      } catch (err) {
        throw cannotLock(err);
      }
      if (locked) break;
      if (Date.now() >= deadline) {
        throw new Gate1RecordError(
          `Gate 1 record at ${recordPath} is locked by another command (${lockPath}); try again.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RECORD_LOCK_RETRY_MS));
    }
    try {
      return await fn();
    } finally {
      await file.unlock();
    }
  } finally {
    file.close();
  }
}

/** Refuses when the design document can no longer be read or no longer has `fingerprint`. */
async function refuseIfDocChanged(
  absDocPath: string,
  fingerprint: string,
  refusal: string,
): Promise<void> {
  let latest: string;
  try {
    latest = await Deno.readTextFile(absDocPath);
  } catch (err) {
    throw new Gate1RecordError(
      `Cannot read design document at ${absDocPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (computeFingerprint(latest) !== fingerprint) throw new Gate1RecordError(refusal);
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

/** Count of decision-record data rows in the document (0 when no decision record exists). */
export function countDecisionRecordRows(content: string): number {
  return readDecisionRecordDataRows(content.split(/\r?\n/)).length;
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
    const info = await Deno.stat(recordPath);
    if (info.mode !== null && (info.mode & 0o444) === 0) {
      throw new Deno.errors.PermissionDenied("record has no read permissions");
    }
    text = await Deno.readTextFile(recordPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      try {
        await Deno.lstat(recordPath);
      } catch (statError) {
        if (statError instanceof Deno.errors.NotFound) return null;
      }
    }
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
  const rows = (parsed as Gate1Record).premiseRows;
  if (
    rows !== undefined &&
    (!Array.isArray(rows) || rows.some((row) =>
      row === null || typeof row !== "object" ||
      typeof row.premise !== "string" || typeof row.proof !== "string" ||
      typeof row.proved !== "string"
    ))
  ) {
    throw new Gate1RecordError(
      `Cannot parse Gate 1 record at ${recordPath}: malformed premise rows`,
    );
  }
  const sweepNotes = (parsed as Gate1Record).sweepNotes;
  const decisionRowCount = (parsed as Gate1Record).decisionRowCount;
  if (
    decisionRowCount !== undefined &&
    (typeof decisionRowCount !== "number" || !Number.isInteger(decisionRowCount) ||
      decisionRowCount < 0)
  ) {
    throw new Gate1RecordError(
      `Cannot parse Gate 1 record at ${recordPath}: malformed decisionRowCount`,
    );
  }
  if (
    sweepNotes !== undefined &&
    (!Array.isArray(sweepNotes) ||
      sweepNotes.some((note) =>
        note === null || typeof note !== "object" ||
        typeof note.otherPath !== "string" || typeof note.reason !== "string" ||
        typeof note.recordedAt !== "string"
      ))
  ) {
    throw new Gate1RecordError(
      `Cannot parse Gate 1 record at ${recordPath}: malformed sweepNotes`,
    );
  }
  const otherDesignSweep = (parsed as Gate1Record).otherDesignSweep;
  if (otherDesignSweep !== undefined) {
    const validStatus = (s: unknown) =>
      s === "revised" || s === "noted" || s === "unreadable-noted";
    if (
      otherDesignSweep === null || typeof otherDesignSweep !== "object" ||
      !Array.isArray(otherDesignSweep.terms) ||
      otherDesignSweep.terms.some((t) => typeof t !== "string") ||
      typeof otherDesignSweep.checkedAt !== "string" ||
      typeof otherDesignSweep.presentingDay !== "string" ||
      !Array.isArray(otherDesignSweep.entries) ||
      otherDesignSweep.entries.some((e) =>
        e === null || typeof e !== "object" ||
        typeof e.otherPath !== "string" ||
        !Array.isArray(e.lines) || e.lines.some((l) => typeof l !== "number") ||
        !Array.isArray(e.terms) || e.terms.some((t) => typeof t !== "string") ||
        !validStatus(e.status)
      )
    ) {
      throw new Gate1RecordError(
        `Cannot parse Gate 1 record at ${recordPath}: malformed otherDesignSweep`,
      );
    }
  }
  return parsed as Gate1Record;
}

/**
 * Opens a Gate 1 record on disk each time a design document is presented.
 * Clears any earlier approval, keeps the stored premise rows and active sweep notes, and refuses
 * (leaving the file untouched) when an existing record cannot be read or parsed.
 */
export async function openGate1Record(
  docPath: string,
  content: string,
  options?: { stateDir?: string; otherDesignSweep?: OtherDesignSweepResult },
): Promise<{ record: Gate1Record; recordPath: string }> {
  const absDocPath = path.resolve(expandHome(docPath.trim()));
  const dir = getGate1StateDir(options?.stateDir);
  const recordPath = getGate1RecordPath(absDocPath, dir);
  return await withGate1RecordLock(recordPath, async () => {
    const existing = await readExistingRecord(recordPath);

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
    if (existing?.decisionRowCount !== undefined) {
      record.decisionRowCount = existing.decisionRowCount;
    }
    if (existing?.sweepNotes !== undefined && existing.sweepNotes.length > 0) {
      record.sweepNotes = existing.sweepNotes;
    }
    if (options?.otherDesignSweep !== undefined) {
      record.otherDesignSweep = options.otherDesignSweep;
    }

    await Deno.writeTextFile(recordPath, JSON.stringify(record, null, 2) + "\n");
    return { record, recordPath };
  });
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
  options?: {
    stateDir?: string;
    /** Refuses (throws) unless Josh typed the reply after `presentedAt` (web-jam-tools#1412). */
    verifyReply?: (presentedAt: string) => Promise<unknown>;
  },
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

  // The reply check needs a real presentation time: without one it would have no cutoff, and a
  // reply to any earlier presentation would pass (web-jam-tools#1412).
  if (typeof record.presentedAt !== "string" || Number.isNaN(Date.parse(record.presentedAt))) {
    throw new Gate1RecordError(
      `Gate 1 record for ${absDocPath} holds no usable presentation time (${
        JSON.stringify(record.presentedAt)
      }) — refusing to approve Gate 1. Present the document with deno task design:gate1 first.`,
    );
  }

  if (options?.verifyReply) await options.verifyReply(record.presentedAt);

  // The reply check can take a while; approve only the presentation it checked against, reading
  // the record and document again under the lock so a newer presentation is never written over.
  return await withGate1RecordLock(recordPath, async () => {
    const current = await readExistingRecord(recordPath);
    if (
      !current || current.presentedAt !== record.presentedAt ||
      current.presentedFingerprint !== record.presentedFingerprint
    ) {
      throw new Gate1RecordError(
        `Gate 1 record for ${absDocPath} was presented again while the reply was being checked — refusing to approve the earlier presentation. Approve the current presentation instead.`,
      );
    }
    if (current.approvedAt) {
      throw new Gate1RecordError(
        `Gate 1 record for ${absDocPath} is not open (already approved at ${current.approvedAt}). Re-present the document with deno task design:gate1 to clear approval and re-open.`,
      );
    }
    await refuseIfDocChanged(
      absDocPath,
      currentFingerprint,
      `Document changed while the reply was being checked — refusing to approve Gate 1. Re-present the document with deno task design:gate1 first.`,
    );

    current.approvedAt = new Date().toISOString();
    current.reply = reply;
    current.approvedFingerprint = currentFingerprint;
    current.premiseRows = premiseRowsForApproval(content);
    current.premiseRowsSource = "approval";
    current.premiseRowsStoredAt = current.approvedAt;
    current.decisionRowCount = countDecisionRecordRows(content);
    delete current.premiseRowsAdoptionReply;
    // Clear active sweep notes after approval (the presented sweep snapshot stays in
    // otherDesignSweep) so a later revision must re-verify or re-note any hits in other designs.
    delete current.sweepNotes;

    await Deno.writeTextFile(recordPath, JSON.stringify(current, null, 2) + "\n");
    return { record: current, recordPath };
  });
}

/**
 * Records a sweep note (`deno task design:sweep-note <doc.md> <other.md> --reason "<why>"`) on
 * `<doc.md>`'s Gate 1 record explaining why `<other.md>` is unaffected or cannot be read.
 * Refuses when `<doc.md>`, `<other.md>`, or `--reason` is empty, when `<other.md>` resolves to
 * `<doc.md>` itself, or when an existing Gate 1 record cannot be read or parsed. Creates the
 * record if none exists yet without approving Gate 1.
 */
export async function recordSweepNote(
  docPath: string,
  otherPath: string,
  reason: string,
  options?: { stateDir?: string; nowImpl?: () => Date },
): Promise<{ record: Gate1Record; recordPath: string }> {
  if (!docPath || docPath.trim() === "") {
    throw new Gate1RecordError("Design document path is required.");
  }
  if (!otherPath || otherPath.trim() === "") {
    throw new Gate1RecordError("Other design document path is required.");
  }
  if (!reason || reason.trim() === "") {
    throw new Gate1RecordError("Reason is empty — refusing to record sweep note.");
  }

  const absDocPath = path.resolve(expandHome(docPath.trim()));
  const absOtherPath = path.resolve(expandHome(otherPath.trim()));
  const resolveReal = (p: string): string => {
    try {
      return Deno.realPathSync(p);
    } catch {
      return p;
    }
  };
  if (absDocPath === absOtherPath || resolveReal(absDocPath) === resolveReal(absOtherPath)) {
    throw new Gate1RecordError(
      `Cannot record a sweep note for the presented document itself (${absOtherPath}).`,
    );
  }

  const dir = getGate1StateDir(options?.stateDir);
  const recordPath = getGate1RecordPath(absDocPath, dir);
  return await withGate1RecordLock(recordPath, async () => {
    const existing = await readExistingRecord(recordPath);
    const now = options?.nowImpl?.() ?? new Date();
    const trimmedReason = reason.trim();

    const record: Gate1Record = existing ?? {
      docPath: absDocPath,
      presentedFingerprint: "",
      presentedAt: "",
    };

    const realOther = resolveReal(absOtherPath);
    const nextNotes = (record.sweepNotes ?? []).filter((n) => {
      const absExisting = path.resolve(expandHome(n.otherPath));
      return absExisting !== absOtherPath && resolveReal(absExisting) !== realOther;
    });
    nextNotes.push({
      otherPath: absOtherPath,
      reason: trimmedReason,
      recordedAt: now.toISOString(),
    });
    record.sweepNotes = nextNotes;

    await Deno.writeTextFile(recordPath, JSON.stringify(record, null, 2) + "\n");
    return { record, recordPath };
  });
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
  options?: {
    stateDir?: string;
    now?: Date;
    /** Refuses (throws) unless Josh typed the reply (web-jam-tools#1412). */
    verifyReply?: () => Promise<unknown>;
  },
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
  if (options?.verifyReply) await options.verifyReply();

  // Read the record again under the lock: the reply check can take a while, and a presentation
  // or sweep note written meanwhile must be kept.
  return await withGate1RecordLock(recordPath, async () => {
    const latest = await readExistingRecord(recordPath);
    if (latest?.premiseRows && latest.premiseRows.length > 0) {
      throw new Gate1RecordError(
        `Gate 1 record for ${absDocPath} already holds ${latest.premiseRows.length} premise row(s) — adoption happens once per document; the stored rows now change only through Gate 1.`,
      );
    }
    // The rows were read before the reply check; store them only if the document still holds them.
    await refuseIfDocChanged(
      absDocPath,
      computeFingerprint(content),
      `Document changed while the reply was being checked — refusing to adopt its premise rows. Run deno task design:gate1-adopt again on the current document.`,
    );
    const record: Gate1Record = latest ?? {
      docPath: absDocPath,
      presentedFingerprint: "",
      presentedAt: "",
    };
    record.premiseRows = rows;
    record.premiseRowsSource = "adoption";
    record.premiseRowsStoredAt = now.toISOString();
    record.premiseRowsAdoptionReply = reply;

    await Deno.writeTextFile(recordPath, JSON.stringify(record, null, 2) + "\n");
    return { record, recordPath };
  });
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

  return await readExistingRecord(recordPath);
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
  const sweep = result.record?.otherDesignSweep;
  if (sweep) {
    lines.push(
      `  Other designs sweep: ${sweep.entries.length} hit(s)/note(s) for ${
        sweep.terms.map((t) => `"${t}"`).join(", ")
      } (${sweep.presentingDay})`,
    );
  }
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
