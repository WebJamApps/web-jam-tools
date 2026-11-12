import {
  readCodexSession,
  type RunningModelOptions,
} from "../../src/shared/codex_running_model.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const supportedSources = ["cli", "vscode"];

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
  options: Pick<RunningModelOptions, "env"> = {},
): Promise<CodexTypedSession> {
  const { threadId, path, text } = await readCodexSession(options);
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
  const metadata = records.filter((record) => record.type === "session_meta");
  if (metadata.length !== 1 || !isRecord(metadata[0].payload)) {
    throw new Error(`Expected one session_meta in ${path}`);
  }
  const meta = metadata[0].payload;
  if (
    meta.id !== threadId || typeof meta.source !== "string" ||
    !supportedSources.includes(meta.source) || meta.originator !== "codex-tui" ||
    (meta.thread_source !== undefined && meta.thread_source !== "user") ||
    (meta.parent_thread_id !== undefined && meta.parent_thread_id !== null)
  ) {
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
