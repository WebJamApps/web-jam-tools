// src/design-issue/gate1_record.ts
// Gate 1 disk record helper for design-issue:
// - Stores Gate 1 status records under ~/.claude/state/design-gate1/<hash>.json
//   (hash is SHA-256 of the design document's absolute path).
// - Manages openGate1Record, approveGate1Record, getGate1Status, and loadGate1Record.
// - References: web-jam-tools#1155, design doc decisions 57-60.

import crypto from "node:crypto";
import * as path from "@std/path";
import { expandHome } from "./gate1.ts";

export interface Gate1Record {
  docPath: string; // Absolute path to design document
  presentedFingerprint: string; // SHA-256 hex of document content when presented
  presentedAt: string; // ISO 8601 timestamp
  approvedAt?: string; // ISO 8601 timestamp when approved
  reply?: string; // Verbatim text of approving reply
  approvedFingerprint?: string; // SHA-256 hex covered by approval
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

/**
 * Opens a Gate 1 record on disk each time a design document is presented.
 * Clears any earlier approval.
 */
export async function openGate1Record(
  docPath: string,
  content: string,
  options?: { stateDir?: string },
): Promise<{ record: Gate1Record; recordPath: string }> {
  const absDocPath = path.resolve(expandHome(docPath.trim()));
  const dir = getGate1StateDir(options?.stateDir);
  const recordPath = getGate1RecordPath(absDocPath, dir);

  await Deno.mkdir(dir, { recursive: true });

  const record: Gate1Record = {
    docPath: absDocPath,
    presentedFingerprint: computeFingerprint(content),
    presentedAt: new Date().toISOString(),
  };

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
 * - Otherwise records the approving reply verbatim and current document fingerprint
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
      lines.push(`  No Gate 1 record exists for ${result.docPath}`);
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
  return lines;
}
