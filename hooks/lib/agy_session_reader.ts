/**
 * Antigravity native subagent parent-resolver for approval-token checks (web-jam-tools#1883).
 *
 * Kept in hooks/lib/ with no imports outside Node built-ins so both
 * `hooks/lib/check_issue_approval_token.ts` (`deno run --no-config`) and
 * `src/create-issue/lib.ts` share the exact same resolver.
 */

import { isAbsolute, join, relative } from "node:path";

export interface AgyTokenOwnerOptions {
  /** Calling conversation id (`conversationId`/`session_id` in hook, `AGY_CONVERSATION_ID` in CLI). */
  conversationId?: unknown;
  /** Calling transcript path (`transcript_path`/`transcriptPath` in hook, `AGY_TRANSCRIPT_PATH` in CLI). */
  transcriptPath?: unknown;
  /** Optional env lookup; defaults to `Deno.env.get`. */
  env?: (name: string) => string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `id` is non-empty, safe as a path component, and free of traversal/control chars. */
export function isSafeAgyConversationId(id: unknown): id is string {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id === "." || id === "..") return false;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return false;
  if (id.trim() !== id) return false;
  for (let i = 0; i < id.length; i++) {
    if (id.charCodeAt(i) < 32) return false;
  }
  return true;
}

/**
 * Validates that `transcriptPath` sits inside `<brain>/<childId>/.system_generated/...`
 * without `..` segments and returns the `<brain>` directory path.
 */
export function parseAntigravityBrainRoot(transcriptPath: unknown, childId: string): string {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) {
    throw new Error("Missing or empty Antigravity transcript_path");
  }
  if (!isAbsolute(transcriptPath)) {
    throw new Error(`Antigravity transcript_path must be absolute: ${transcriptPath}`);
  }
  if (transcriptPath.includes("\0") || transcriptPath.split(/[\\/]/).includes("..")) {
    throw new Error(`Antigravity transcript_path must not contain '..': ${transcriptPath}`);
  }
  const segments = transcriptPath.split("/");
  const brainIdx = segments.lastIndexOf("brain");
  if (brainIdx < 1 || segments.length <= brainIdx + 3) {
    throw new Error(
      `Antigravity transcript_path is outside <brain>/<conversation>/.system_generated/: ${transcriptPath}`,
    );
  }
  const pathConvId = segments[brainIdx + 1];
  const systemDir = segments[brainIdx + 2];
  const remainder = segments[brainIdx + 3];
  if (pathConvId !== childId || systemDir !== ".system_generated" || !remainder) {
    throw new Error(
      `Antigravity transcript_path must lie under <brain>/${childId}/.system_generated/: ${transcriptPath}`,
    );
  }
  return segments.slice(0, brainIdx + 1).join("/");
}

/**
 * Scans direct subdirectories `<brain>/<dir>` (`dir !== targetId`) for
 * `<brain>/<dir>/.system_generated/subagents/<targetId>.json`.
 *
 * Returns `null` when zero matching parent records exist, or the verified single parent id.
 * Fails closed (throws) when `<brain>` cannot be read, multiple parent records exist, a record
 * cannot be accessed/parsed, or its `conversationId` field does not equal `targetId`.
 */
function findSingleAgySubagentParentSync(brainRoot: string, targetId: string): string | null {
  let realBrainRoot: string;
  let entries: Deno.DirEntry[];
  try {
    realBrainRoot = Deno.realPathSync(brainRoot);
    const stat = Deno.statSync(realBrainRoot);
    if (!stat.isDirectory) {
      throw new Error(`Antigravity brain root is not a directory: ${brainRoot}`);
    }
    entries = [...Deno.readDirSync(realBrainRoot)];
  } catch (error) {
    throw new Error(`Could not read Antigravity brain directory ${brainRoot}: ${error}`);
  }

  const matches: Array<{ parentId: string; recordPath: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory || entry.name === targetId) continue;
    const recordPath = join(
      realBrainRoot,
      entry.name,
      ".system_generated",
      "subagents",
      `${targetId}.json`,
    );
    let stat: Deno.FileInfo;
    try {
      stat = Deno.statSync(recordPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw new Error(`Could not access Antigravity subagent record ${recordPath}: ${error}`);
    }
    if (!stat.isFile) {
      throw new Error(`Antigravity subagent record is not a file: ${recordPath}`);
    }
    matches.push({ parentId: entry.name, recordPath });
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous Antigravity subagent parent for ${targetId}: found records under ${
        matches.map((m) => m.parentId).sort().join(", ")
      }`,
    );
  }

  const { parentId, recordPath } = matches[0];
  if (!isSafeAgyConversationId(parentId)) {
    throw new Error(`Unsafe Antigravity parent conversationId: ${JSON.stringify(parentId)}`);
  }

  let realRecordPath: string;
  try {
    realRecordPath = Deno.realPathSync(recordPath);
  } catch (error) {
    throw new Error(`Could not resolve Antigravity subagent record ${recordPath}: ${error}`);
  }
  const rel = relative(realBrainRoot, realRecordPath);
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Antigravity subagent record ${recordPath} escapes brain directory ${brainRoot}`,
    );
  }

  let rawText: string;
  try {
    rawText = Deno.readTextFileSync(realRecordPath);
  } catch (error) {
    throw new Error(`Could not read Antigravity subagent record ${recordPath}: ${error}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Malformed JSON in Antigravity subagent record ${recordPath}: ${error}`);
  }
  if (!isRecord(parsed) || parsed.conversationId !== targetId) {
    const got = isRecord(parsed) ? parsed.conversationId : undefined;
    throw new Error(
      `Antigravity subagent record conversationId mismatch (expected ${targetId}, got ${
        String(got)
      }) in ${recordPath}`,
    );
  }
  return parentId;
}

/**
 * Resolves the single authoritative human-started Antigravity conversation ID that may own an
 * approval token for this call (either the root conversation itself, or its direct parent `P` when
 * this conversation is a depth-1 helper under `<brain>/<P>/.system_generated/subagents/<child>.json`).
 */
export function resolveAntigravityTokenOwnerSync(options: AgyTokenOwnerOptions = {}): string {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const childId = options.conversationId !== undefined
    ? options.conversationId
    : env("AGY_CONVERSATION_ID");
  if (!isSafeAgyConversationId(childId)) {
    throw new Error(
      `Missing or unsafe Antigravity conversationId: ${JSON.stringify(childId)}`,
    );
  }
  const transcriptPath = options.transcriptPath !== undefined
    ? options.transcriptPath
    : env("AGY_TRANSCRIPT_PATH");
  const brainRoot = parseAntigravityBrainRoot(transcriptPath, childId);
  const parentId = findSingleAgySubagentParentSync(brainRoot, childId);
  if (parentId === null) {
    return childId;
  }
  const grandparentId = findSingleAgySubagentParentSync(brainRoot, parentId);
  if (grandparentId !== null) {
    throw new Error(
      `Nested Antigravity helper ${childId} (parent ${parentId}, grandparent ${grandparentId}) cannot inherit an approval token`,
    );
  }
  return parentId;
}
