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
 *   - hooks/opus-no-delegation-warning.sh (Stop hook, web-jam-tools#566)
 *   - hooks/haiku-only-gmail-gate.sh (PreToolUse hook, web-jam-tools#566)
 *
 * CLI usage:
 *   deno run --allow-read hooks/lib/select_transcript_entry.ts [--text|--model|--json] [path/to/transcript.jsonl]
 *   printf '%s' "$input" | deno run --allow-read hooks/lib/select_transcript_entry.ts [--text|--model|--json]
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

/**
 * Selects the last genuine main-thread assistant transcript entry.
 *
 * Traverses entries in reverse chronological order (from the end of the array)
 * and returns the first entry that matches all criteria:
 *   - type == "assistant" or message.role == "assistant"
 *   - message.content is not null / undefined
 *   - isSidechain is not true
 *   - isApiErrorMessage is not true
 *
 * @param entries Array of parsed transcript entries in chronological order.
 * @returns The last matching assistant entry, or null if none match.
 */
export function selectLastAssistantEntry(
  entries: readonly TranscriptEntry[],
): TranscriptEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;

    const isAssistant = entry.type === "assistant" || entry.message?.role === "assistant";
    if (!isAssistant) continue;

    if (entry.isSidechain === true) continue;
    if (entry.isApiErrorMessage === true) continue;

    if (!entry.message || entry.message.content === null || entry.message.content === undefined) {
      continue;
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
    let mode: "text" | "model" | "json" = "text";
    let filePath: string | null = null;

    for (const arg of Deno.args) {
      if (arg === "--text" || arg === "-t") {
        mode = "text";
      } else if (arg === "--model" || arg === "-m") {
        mode = "model";
      } else if (arg === "--json" || arg === "-j") {
        mode = "json";
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

    const selected = selectLastAssistantEntry(entries);

    if (mode === "text") {
      const text = extractEntryText(selected);
      if (text !== "") {
        console.log(text);
      }
    } else if (mode === "model") {
      const model = extractEntryModel(selected);
      if (model !== "") {
        console.log(model);
      }
    } else if (mode === "json") {
      if (selected) {
        console.log(JSON.stringify(selected));
      }
    }
  } catch {
    // Fail-open
    Deno.exit(0);
  }
}
