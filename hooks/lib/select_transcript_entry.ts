/**
 * Shared transcript-entry selector (web-jam-tools#565).
 *
 * Selects the last genuine main-thread assistant transcript entry from a
 * Claude Code transcript JSONL file.
 *
 * Excludes:
 *   - isSidechain: true entries (subagent transcript lines interleaved into
 *     the same transcript file)
 *   - isApiErrorMessage: true entries (synthetic assistant-typed entries
 *     carrying error text inserted on API errors/retries)
 *
 * Used by:
 *   - hooks/require-issue-citation-titles.sh (Stop hook, web-jam-tools#565)
 *   - hooks/opus-delegation-gate.sh (PreToolUse hook, web-jam-tools#641)
 *   - hooks/haiku-only-gmail-gate.sh (PreToolUse hook, web-jam-tools#566)
 *   - hooks/require-clear-communication.sh (Stop hook, web-jam-tools#596)
 *
 * CLI usage:
 *   deno run --allow-read hooks/lib/select_transcript_entry.ts [--text|--model|--json|--opus-gate] [path/to/transcript.jsonl]
 *   printf '%s' "$input" | deno run --allow-read hooks/lib/select_transcript_entry.ts [--text|--model|--json|--opus-gate]
 */

export interface TranscriptContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface TranscriptMessage {
  role?: string;
  model?: string;
  content?: string | TranscriptContentBlock[];
  [key: string]: unknown;
}

export interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  message?: TranscriptMessage;
  [key: string]: unknown;
}

export interface SelectOptions {
  /**
   * If true (default), selects the last assistant entry in the current turn
   * that carries non-empty text content.
   * If false, selects the last assistant entry in the current turn regardless
   * of whether it carries text (e.g. for model extraction).
   */
  requireText?: boolean;
}

/**
 * Checks if a transcript entry represents a genuine user turn boundary
 * (i.e. a prompt typed by the user, not a tool_result fed back during the assistant's turn).
 */
export function isUserTurnBoundary(entry: TranscriptEntry | null | undefined): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.isSidechain === true) return false;
  if (entry.isApiErrorMessage === true) return false;

  const isUser = entry.type === "user" || entry.message?.role === "user";
  if (!isUser) return false;

  if (entry.type === "tool_result") return false;

  const content = entry.message?.content;
  if (Array.isArray(content)) {
    const hasToolResult = content.some(
      (b) => b && typeof b === "object" && (b.type === "tool_result" || "tool_use_id" in b),
    );
    if (hasToolResult) return false;
  }

  return true;
}

/**
 * Selects the last genuine main-thread assistant transcript entry from the current turn.
 *
 * Traverses entries in reverse chronological order (from the end of the array)
 * and bounds the search to the current turn (stops at the most recent user entry
 * and never reads past it).
 *
 * Excludes:
 *   - entries before the most recent genuine user entry (turn boundary)
 *   - entries where isSidechain == true
 *   - entries where isApiErrorMessage == true
 *   - entries with null / undefined message or content
 *   - entries without text content when options.requireText is true (default)
 *
 * @param entries Array of parsed transcript entries in chronological order.
 * @param options Selection options (requireText defaults to true).
 * @returns The matching assistant entry in the current turn, or null if none match.
 */
export function selectLastAssistantEntry(
  entries: readonly TranscriptEntry[],
  options?: SelectOptions,
): TranscriptEntry | null {
  const requireText = options?.requireText ?? true;

  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isUserTurnBoundary(entries[i])) {
      lastUserIdx = i;
      break;
    }
  }

  for (let i = entries.length - 1; i > lastUserIdx; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;

    const isAssistant = entry.type === "assistant" || entry.message?.role === "assistant";
    if (!isAssistant) continue;

    if (entry.isSidechain === true) continue;
    if (entry.isApiErrorMessage === true) continue;

    if (!entry.message || entry.message.content === null || entry.message.content === undefined) {
      continue;
    }

    if (requireText) {
      const text = extractEntryText(entry);
      if (text.trim() === "") {
        continue;
      }
    }

    return entry;
  }
  return null;
}

/**
 * Extracts concatenated text content from a transcript entry.
 *
 * If message.content is a string, returns it directly.
 * If message.content is an array of content blocks, filters for blocks with
 * type == "text" and joins their text values with newlines.
 */
export function extractEntryText(entry: TranscriptEntry | null | undefined): string {
  if (!entry || !entry.message) return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is TranscriptContentBlock & { text: string } =>
        Boolean(block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
      )
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * Extracts the model identifier string from a transcript entry.
 */
export function extractEntryModel(entry: TranscriptEntry | null | undefined): string {
  if (!entry || !entry.message || typeof entry.message !== "object") return "";
  const model = entry.message.model;
  return typeof model === "string" ? model : "";
}

/**
 * Selects the most recent genuine user prompt from a transcript.
 * Traverses entries in reverse chronological order and returns the first entry
 * where isUserTurnBoundary(entry) is true.
 */
export function selectLastUserEntry(
  entries: readonly TranscriptEntry[],
): TranscriptEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isUserTurnBoundary(entries[i])) {
      return entries[i];
    }
  }
  return null;
}

/**
 * Recovers the active session model from a transcript.
 * Checks the current turn's assistant entry first; if none is present (e.g. before the
 * assistant entry is flushed), falls back to traversing reverse-chronologically for
 * the latest genuine (non-sidechain, non-error) assistant entry across the session.
 */
export function selectSessionModel(entries: readonly TranscriptEntry[]): string {
  const currentTurn = selectLastAssistantEntry(entries, { requireText: false });
  if (currentTurn) {
    const m = extractEntryModel(currentTurn);
    if (m) return m;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;
    const isAssistant = entry.type === "assistant" || entry.message?.role === "assistant";
    if (!isAssistant) continue;
    if (entry.isSidechain === true || entry.isApiErrorMessage === true) continue;
    const m = extractEntryModel(entry);
    if (m) return m;
  }
  return "";
}

export interface OpusGateInfo {
  model: string;
  hasEscape: boolean;
  lastUserText: string;
}

/**
 * Extracts session model and escape phrase grant information for the Opus delegation gate.
 */
export function getOpusGateInfo(entries: readonly TranscriptEntry[]): OpusGateInfo {
  const model = selectSessionModel(entries);
  const lastUser = selectLastUserEntry(entries);
  const lastUserText = extractEntryText(lastUser);
  const hasEscape = lastUserText.toLowerCase().includes("opus edit ok");
  return {
    model,
    hasEscape,
    lastUserText,
  };
}

/**
 * Parses JSONL transcript string into an array of TranscriptEntry objects.
 * Silently skips empty or invalid JSON lines.
 */
export function parseTranscriptJsonl(jsonl: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const lines = jsonl.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        entries.push(parsed);
      }
    } catch {
      // ignore invalid json lines (fail-open)
    }
  }
  return entries;
}

/**
 * Reads transcript entries from a file path, raw JSONL string, or JSON payload.
 */
export async function loadTranscript(pathOrInput: string): Promise<TranscriptEntry[]> {
  const trimmed = pathOrInput.trim();
  if (!trimmed) return [];

  // Check if input is a JSON payload like {"transcript_path": "/path/to/..."}
  if (trimmed.startsWith("{")) {
    try {
      const payload = JSON.parse(trimmed);
      if (payload && typeof payload.transcript_path === "string" && payload.transcript_path) {
        try {
          const content = await Deno.readTextFile(payload.transcript_path);
          return parseTranscriptJsonl(content);
        } catch {
          return [];
        }
      }
      if (payload && typeof payload === "object") {
        return [payload];
      }
    } catch {
      // not a single json object, continue to file read or jsonl parse
    }
  }

  // Try reading as a file path
  try {
    const content = await Deno.readTextFile(trimmed);
    return parseTranscriptJsonl(content);
  } catch {
    // Treat trimmed as raw JSONL text
    return parseTranscriptJsonl(trimmed);
  }
}

if (import.meta.main) {
  try {
    let mode: "text" | "model" | "json" | "opus-gate" = "text";
    let filePath: string | null = null;

    for (const arg of Deno.args) {
      if (arg === "--text" || arg === "-t") {
        mode = "text";
      } else if (arg === "--model" || arg === "-m") {
        mode = "model";
      } else if (arg === "--json" || arg === "-j") {
        mode = "json";
      } else if (arg === "--opus-gate" || arg === "--delegation-gate") {
        mode = "opus-gate";
      } else if (!arg.startsWith("-")) {
        filePath = arg;
      }
    }

    let entries: TranscriptEntry[] = [];

    if (filePath && filePath !== "-") {
      try {
        const content = await Deno.readTextFile(filePath);
        entries = parseTranscriptJsonl(content);
      } catch {
        entries = [];
      }
    } else {
      // Read from stdin
      const buf = new Uint8Array(1024);
      let raw = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          const n = await Deno.stdin.read(buf);
          if (n === null || n === 0) break;
          raw += decoder.decode(buf.subarray(0, n));
        }
      } catch {
        raw = "";
      }
      entries = await loadTranscript(raw);
    }

    if (mode === "text") {
      const selected = selectLastAssistantEntry(entries, { requireText: true });
      const text = extractEntryText(selected);
      if (text !== "") {
        console.log(text);
      }
    } else if (mode === "model") {
      const selected = selectLastAssistantEntry(entries, { requireText: false });
      const model = extractEntryModel(selected);
      if (model !== "") {
        console.log(model);
      }
    } else if (mode === "json") {
      const selected = selectLastAssistantEntry(entries, { requireText: true });
      if (selected) {
        console.log(JSON.stringify(selected));
      }
    } else if (mode === "opus-gate") {
      const info = getOpusGateInfo(entries);
      console.log(JSON.stringify(info));
    }
  } catch {
    // Fail-open
    Deno.exit(0);
  }
}
