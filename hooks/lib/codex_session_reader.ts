import { isAbsolute, join, relative } from "node:path";

export type CodexSessionEnvOptions = {
  env?: (name: string) => string | undefined;
};

export interface CodexSkillCall {
  name: string;
  arguments: string;
  text: string;
  timestamp?: string;
}

export interface CodexTypedSession {
  threadId: string;
  path: string;
  latestSkillCall: CodexSkillCall | null;
}

const CODEX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const supportedSources = ["cli", "vscode"];

/** Recursively list files ending with `suffix` under `dir`. */
export function findSessionFilesSync(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory) {
      out.push(...findSessionFilesSync(fullPath, suffix));
    } else if ((entry.isFile || entry.isSymlink) && entry.name.endsWith(suffix)) {
      out.push(fullPath);
    }
  }
  return out;
}

/** Async directory walk for Codex session files. */
export async function findSessionFiles(dir: string, suffix: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory) {
      out.push(...await findSessionFiles(fullPath, suffix));
    } else if ((entry.isFile || entry.isSymlink) && entry.name.endsWith(suffix)) {
      out.push(fullPath);
    }
  }
  return out;
}

function codexSessionsDir(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): string {
  let codexHome = env("CODEX_HOME");
  if (!codexHome) {
    const userHome = env("HOME");
    if (!userHome) {
      throw new Error("Cannot locate Codex sessions: CODEX_HOME and HOME are unset");
    }
    codexHome = join(userHome, ".codex");
  }
  return join(codexHome, "sessions");
}

function assertRolloutInsideSessionsDirSync(rolloutPath: unknown, sessionsDir: string): string {
  if (typeof rolloutPath !== "string" || !rolloutPath) {
    throw new Error("Missing or empty Codex transcript_path");
  }
  if (!isAbsolute(rolloutPath)) {
    throw new Error(`Codex transcript_path must be absolute: ${rolloutPath}`);
  }
  if (rolloutPath.split(/[\\/]/).includes("..")) {
    throw new Error(`Codex transcript_path must not contain '..': ${rolloutPath}`);
  }
  let realSessionsDir: string;
  try {
    realSessionsDir = Deno.realPathSync(sessionsDir);
  } catch (error) {
    throw new Error(`Could not resolve Codex sessions directory ${sessionsDir}: ${error}`);
  }
  let realRolloutPath: string;
  try {
    realRolloutPath = Deno.realPathSync(rolloutPath);
  } catch (error) {
    throw new Error(`Could not resolve Codex session file ${rolloutPath}: ${error}`);
  }
  let stat: Deno.FileInfo;
  try {
    stat = Deno.statSync(realRolloutPath);
  } catch (error) {
    throw new Error(`Could not stat Codex session file ${realRolloutPath}: ${error}`);
  }
  if (!stat.isFile) {
    throw new Error(`Codex session path is not a file: ${realRolloutPath}`);
  }
  const rel = relative(realSessionsDir, realRolloutPath);
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Codex session file ${rolloutPath} is outside sessions store ${sessionsDir}`);
  }
  return realRolloutPath;
}

function locateUniqueRolloutSync(sessionsDir: string, threadId: string): string {
  let files: string[];
  try {
    files = findSessionFilesSync(sessionsDir, `-${threadId}.jsonl`);
  } catch (error) {
    throw new Error(`Could not search for session ${threadId} under ${sessionsDir}: ${error}`);
  }
  if (files.length === 0) {
    throw new Error(`No session file ends with ${threadId} under ${sessionsDir}`);
  }
  if (files.length !== 1) {
    throw new Error(`Multiple session files end with ${threadId}: ${files.sort().join(", ")}`);
  }
  return assertRolloutInsideSessionsDirSync(files[0], sessionsDir);
}

/** Locate and read this session, refusing any ambiguous or unreadable input. */
export async function readCodexSession(
  options: CodexSessionEnvOptions = {},
): Promise<{ threadId: string; path: string; text: string }> {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const id = env("CODEX_THREAD_ID");
  if (!id) throw new Error("Not a Codex session: CODEX_THREAD_ID is unset or empty");
  if (!CODEX_UUID_RE.test(id)) {
    throw new Error(`CODEX_THREAD_ID is not a session id: ${id}`);
  }
  const directory = codexSessionsDir(env);
  let files: string[];
  try {
    files = await findSessionFiles(directory, `-${id}.jsonl`);
  } catch (error) {
    throw new Error(`Could not search for session ${id} under ${directory}: ${error}`);
  }
  if (files.length === 0) throw new Error(`No session file ends with ${id} under ${directory}`);
  if (files.length !== 1) {
    throw new Error(`Multiple session files end with ${id}: ${files.sort().join(", ")}`);
  }
  const path = files[0];
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    throw new Error(`Could not read session file ${path}: ${error}`);
  }
  return { threadId: id, path, text };
}

function parseSessionRecords(text: string, path: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`Cannot read complete session records from ${path}`);
    }
    if (!isRecord(record)) throw new Error(`Invalid session record in ${path}`);
    records.push(record);
  }
  return records;
}

function extractSessionMeta(
  records: Record<string, unknown>[],
  path: string,
): Record<string, unknown> {
  const metadata = records.filter((record) => record.type === "session_meta");
  if (metadata.length !== 1 || !isRecord(metadata[0].payload)) {
    throw new Error(`Expected one session_meta in ${path}`);
  }
  return metadata[0].payload;
}

/** Returns true if `meta` describes a direct human-started Codex CLI or VS Code TUI session. */
export function isHumanStartedCodexMeta(meta: Record<string, unknown>): boolean {
  return typeof meta.source === "string" &&
    supportedSources.includes(meta.source) &&
    meta.originator === "codex-tui" &&
    (meta.thread_source === undefined || meta.thread_source === "user") &&
    (meta.parent_thread_id === undefined || meta.parent_thread_id === null);
}

function extractNestedParentThreadId(meta: Record<string, unknown>, path: string): string {
  if (!isRecord(meta.source) || !isRecord(meta.source.subagent)) {
    throw new Error(`Not a supported human-started or direct helper Codex session: ${path}`);
  }
  const threadSpawn = meta.source.subagent.thread_spawn;
  if (!isRecord(threadSpawn)) {
    throw new Error(`Missing subagent thread_spawn metadata in ${path}`);
  }
  if (threadSpawn.depth !== undefined && threadSpawn.depth !== 1) {
    throw new Error(
      `Nested Codex subagent depth ${String(threadSpawn.depth)} is not allowed: ${path}`,
    );
  }
  const parentId = threadSpawn.parent_thread_id;
  if (typeof parentId !== "string" || !CODEX_UUID_RE.test(parentId)) {
    throw new Error(`Invalid or missing subagent parent_thread_id in ${path}`);
  }
  return parentId;
}

export interface CodexTokenOwnerOptions extends CodexSessionEnvOptions {
  /** Thread UUID to resolve; defaults to `env("CODEX_THREAD_ID")`. */
  threadId?: string;
  /** Rollout file path supplied by a Codex hook payload (`transcript_path`). */
  rolloutPath?: unknown;
  /** When true, require `rolloutPath` instead of scanning the sessions store by UUID. */
  requireRolloutPath?: boolean;
}

/**
 * Resolves the single authoritative human-started Codex session ID that may own an approval token
 * for `threadId` (either `threadId` itself, or its direct parent when `threadId` is a depth-1 helper).
 */
export function resolveCodexTokenOwnerSync(options: CodexTokenOwnerOptions = {}): string {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const threadId = options.threadId ?? env("CODEX_THREAD_ID");
  if (!threadId) {
    throw new Error("Not a Codex session: CODEX_THREAD_ID is unset or empty");
  }
  if (!CODEX_UUID_RE.test(threadId)) {
    throw new Error(`Codex session id is not a valid session id: ${threadId}`);
  }
  const sessionsDir = codexSessionsDir(env);
  const path = options.requireRolloutPath
    ? assertRolloutInsideSessionsDirSync(options.rolloutPath, sessionsDir)
    : locateUniqueRolloutSync(sessionsDir, threadId);
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (error) {
    throw new Error(`Could not read session file ${path}: ${error}`);
  }
  const meta = extractSessionMeta(parseSessionRecords(text, path), path);
  if (meta.id !== threadId) {
    throw new Error(`Not a supported Codex session (${String(meta.id)} !== ${threadId}): ${path}`);
  }
  if (isHumanStartedCodexMeta(meta)) {
    return threadId;
  }
  if (
    (meta.originator !== undefined && meta.originator !== "codex-tui") ||
    (meta.thread_source !== undefined && meta.thread_source !== "subagent")
  ) {
    throw new Error(`Not a supported human-started or direct helper Codex session: ${path}`);
  }
  const nestedParentId = extractNestedParentThreadId(meta, path);
  if (meta.parent_thread_id !== undefined && meta.parent_thread_id !== null) {
    if (typeof meta.parent_thread_id !== "string" || meta.parent_thread_id !== nestedParentId) {
      throw new Error(
        `Conflicting parent_thread_id (${
          String(meta.parent_thread_id)
        } vs ${nestedParentId}) in ${path}`,
      );
    }
  }
  if (nestedParentId === threadId) {
    throw new Error(`Codex session cannot be its own parent_thread_id: ${path}`);
  }
  const parentPath = locateUniqueRolloutSync(sessionsDir, nestedParentId);
  let parentText: string;
  try {
    parentText = Deno.readTextFileSync(parentPath);
  } catch (error) {
    throw new Error(`Could not read parent session file ${parentPath}: ${error}`);
  }
  const parentMeta = extractSessionMeta(parseSessionRecords(parentText, parentPath), parentPath);
  if (parentMeta.id !== nestedParentId || !isHumanStartedCodexMeta(parentMeta)) {
    throw new Error(
      `Parent Codex session ${nestedParentId} is not a supported human-started session: ${parentPath}`,
    );
  }
  return nestedParentId;
}

/** Only the leading typed call counts; prose quoting a skill cannot grant authority. */
export function codexSkillCall(text: string): CodexSkillCall | null {
  const match = text.trim().match(
    /^[$/]((?:[a-zA-Z0-9_-]+:)?[a-zA-Z0-9_-]+)(?:[\s,.;!?]+([\s\S]*)|$)/,
  );
  if (!match) return null;
  return { name: match[1].toLowerCase(), arguments: match[2] ?? "", text };
}

/** Read a human-started terminal or VS Code session; unknown or damaged input refuses. */
export async function readCodexTypedSession(
  options: CodexSessionEnvOptions = {},
): Promise<CodexTypedSession> {
  const { threadId, path, text } = await readCodexSession(options);
  const records = parseSessionRecords(text, path);
  const meta = extractSessionMeta(records, path);
  if (meta.id !== threadId || !isHumanStartedCodexMeta(meta)) {
    throw new Error(`Not a supported human-started Codex session: ${path}`);
  }
  let latestSkillCall: CodexSkillCall | null = null;
  for (const record of records) {
    if (record.type !== "response_item" || !isRecord(record.payload)) continue;
    const message = record.payload;
    if (message.type !== "message" || message.role !== "user") continue;
    if (!Array.isArray(message.content) || message.content.length === 0) {
      throw new Error(`Unreadable user message in ${path}`);
    }
    const parts: string[] = [];
    for (const part of message.content) {
      if (!isRecord(part)) throw new Error(`Invalid user content in ${path}`);
      if (part.type === "input_text") {
        if (typeof part.text !== "string") throw new Error(`Unreadable user text in ${path}`);
        parts.push(part.text);
      } else if (part.type !== "input_image") {
        throw new Error(`Unknown user content type in ${path}`);
      }
    }
    const call = codexSkillCall(parts.join("\n"));
    if (call) {
      latestSkillCall = typeof record.timestamp === "string"
        ? { ...call, timestamp: record.timestamp }
        : call;
    }
  }
  return { threadId, path, latestSkillCall };
}
