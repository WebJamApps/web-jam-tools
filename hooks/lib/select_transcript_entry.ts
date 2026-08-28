/**
 * Shared transcript-entry selector (web-jam-tools#565).
 *
 * Selects the last genuine main-thread assistant transcript entry from a
 * Claude Code transcript JSONL file.
 *
 * Antigravity adapter (web-jam-tools#841): the two surfaces write different shapes, and
 * they mark a subagent differently.
 *
 *   - Claude Code writes one transcript per session, interleaving a subagent's entries
 *     into it flagged `isSidechain: true`, and each entry carries a `message` object.
 *   - Antigravity writes one transcript PER CONVERSATION under
 *     `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`,
 *     with entries shaped `{type, source, step_index, status, created_at}` plus `content`
 *     (a plain string) and/or `tool_calls`. A subagent's entries are never in the parent's
 *     transcript at all — the subagent gets its own conversationId and its own file, so
 *     there is no in-transcript flag to read and none is invented here.
 *
 * A subagent turn is therefore determined by conversation identity alone, which the
 * surface assigns and no model writes. `type`/`source` are never used for that decision:
 * a subagent's opening prompt is filed as USER_INPUT/USER_EXPLICIT exactly like a person's,
 * so a source-based check would let a subagent authorize itself.
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
  /** Antigravity: entry role source (USER_EXPLICIT, MODEL, SYSTEM). Never a human/agent discriminator. */
  source?: string;
  /** Antigravity: position of the entry within its own conversation. */
  step_index?: number;
  /** Antigravity: the entry's text, carried as a plain string rather than inside a message object. */
  content?: string | TranscriptContentBlock[];
  /**
   * Antigravity: the conversation the entry was recorded in. Never present in the transcript
   * file itself — attached as provenance by loadTranscript() from the hook payload (or from
   * the transcript path), because conversation identity is assigned by the surface and is the
   * only trustworthy subagent discriminator on that surface.
   */
  conversationId?: string;
  /** Antigravity: session model, attached as provenance by loadTranscript() from the hook payload. */
  modelName?: string;
  [key: string]: unknown;
}

/**
 * Antigravity session provenance, recovered from a hook payload.
 *
 * Antigravity gives a subagent its own conversation, its own artifact directory and its own
 * transcript file, so nothing inside a transcript entry says which conversation wrote it.
 * These payload-level fields carry that fact into the reader.
 */
export interface AntigravitySessionContext {
  conversationId: string;
  modelName: string;
  transcriptPath: string;
}

/**
 * The Antigravity entry type recording a prompt.
 *
 * This names the KIND of entry (a prompt, as opposed to a model response or a system
 * message). It is deliberately NOT a human-vs-agent signal: a subagent's opening prompt,
 * composed by the parent model and never typed by a person, is recorded as
 * {"type":"USER_INPUT","source":"USER_EXPLICIT","step_index":0} — byte for byte what a
 * person's own prompt looks like. Only conversation identity separates the two.
 */
export const ANTIGRAVITY_PROMPT_ENTRY_TYPE = "USER_INPUT";

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
 * Detects the Antigravity entry shape.
 *
 * Structural rather than a type allowlist: an Antigravity entry has no `message` object and
 * carries the `source` + `step_index` pair that every entry in that store has. Matching on
 * the observed `type` values instead would silently drop any type this scan did not see.
 */
export function isAntigravityEntry(entry: TranscriptEntry | null | undefined): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.message !== undefined && entry.message !== null) return false;
  return typeof entry.type === "string" &&
    typeof entry.source === "string" &&
    typeof entry.step_index === "number";
}

/**
 * Recovers a conversationId from an Antigravity transcript path.
 *
 * The store is keyed by conversation: `.../brain/<conversationId>/.system_generated/...`.
 * Returns "" for any path that is not in that store — never a guess from another segment.
 */
export function conversationIdFromTranscriptPath(path: string | null | undefined): string {
  if (typeof path !== "string" || path === "") return "";
  const match = path.match(/(?:^|\/)brain\/([^/]+)\//);
  return match ? match[1] : "";
}

/**
 * Returns the conversation an entry was recorded in, or "" when that is unknown.
 * Unknown is a real answer here: it means the entry reached the reader without provenance.
 */
export function entryConversationId(entry: TranscriptEntry | null | undefined): string {
  if (!entry || typeof entry !== "object") return "";
  return typeof entry.conversationId === "string" ? entry.conversationId : "";
}

/**
 * Reads Antigravity session provenance out of a hook payload.
 *
 * Returns null for a payload carrying neither a conversationId nor an Antigravity
 * transcript path — i.e. anything that is not an Antigravity hook payload.
 */
export function parseAntigravityPayload(
  payload: Record<string, unknown> | null | undefined,
): AntigravitySessionContext | null {
  if (!payload || typeof payload !== "object") return null;
  const transcriptPath = typeof payload.transcriptPath === "string" ? payload.transcriptPath : "";
  const payloadId = typeof payload.conversationId === "string" ? payload.conversationId : "";
  const conversationId = payloadId || conversationIdFromTranscriptPath(transcriptPath);
  if (!conversationId && !transcriptPath) return null;
  return {
    conversationId,
    modelName: typeof payload.modelName === "string" ? payload.modelName : "",
    transcriptPath,
  };
}

/**
 * Attaches session provenance to every Antigravity entry.
 *
 * Entries as written to disk carry neither conversationId nor model, so both are supplied
 * from the payload (or the path) at load time. An entry that already carries provenance
 * keeps it; Claude Code entries pass through untouched.
 */
export function tagAntigravityEntries(
  entries: readonly TranscriptEntry[],
  context: Partial<AntigravitySessionContext>,
): TranscriptEntry[] {
  const conversationId = context.conversationId ?? "";
  const modelName = context.modelName ?? "";
  if (!conversationId && !modelName) return [...entries];
  return entries.map((entry) => {
    if (!isAntigravityEntry(entry)) return entry;
    const tagged: TranscriptEntry = { ...entry };
    if (conversationId && !tagged.conversationId) tagged.conversationId = conversationId;
    if (modelName && typeof tagged.modelName !== "string") tagged.modelName = modelName;
    return tagged;
  });
}

/**
 * Reports whether an entry was recorded in a conversation other than the session's own —
 * i.e. it belongs to a subagent (or to some other session entirely).
 *
 * Conversation identity is the discriminator because the surface assigns it; `type` and
 * `source` are never consulted. Returns false when either identity is unknown: absent
 * provenance is not evidence of a different conversation. Callers deciding whether to
 * TRUST an entry must use isOwnSessionUserTurnBoundary(), which fails closed instead.
 */
export function isSubagentConversationEntry(
  entry: TranscriptEntry | null | undefined,
  sessionConversationId: string | null | undefined,
): boolean {
  const entryId = entryConversationId(entry);
  const sessionId = typeof sessionConversationId === "string" ? sessionConversationId : "";
  if (!entryId || !sessionId) return false;
  return entryId !== sessionId;
}

/**
 * Surface-aware turn-boundary test: is this entry a prompt belonging to the session's own
 * conversation?
 *
 * Claude Code entries delegate to isUserTurnBoundary(), whose isSidechain exclusion already
 * separates a subagent's turn from the session's own.
 *
 * Antigravity entries count only when the entry's conversation is known, the session's own
 * conversation is known, and the two are equal. Fails CLOSED on either being unknown, and on
 * a mismatch — so a subagent's prompt read against the parent's conversation is not a turn
 * boundary here, no matter that it is filed as USER_INPUT/USER_EXPLICIT.
 *
 * Known limit, by design (web-jam-tools#841 non-goals): a subagent reading its OWN transcript
 * against its OWN conversationId cannot be told apart from a person by this function, because
 * the surface publishes the parent↔child edge (`Recipient`) only once the subagent finishes.
 * Refusing a subagent's first action needs state carried across invocations, which belongs to
 * the mechanisms built on top of this reader, not to the reader.
 */
export function isOwnSessionUserTurnBoundary(
  entry: TranscriptEntry | null | undefined,
  sessionConversationId: string | null | undefined,
): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (!isAntigravityEntry(entry)) return isUserTurnBoundary(entry);

  const entryId = entryConversationId(entry);
  const sessionId = typeof sessionConversationId === "string" ? sessionConversationId : "";
  if (!entryId || !sessionId || entryId !== sessionId) return false;

  return entry.type === ANTIGRAVITY_PROMPT_ENTRY_TYPE;
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
 * Claude Code shape: if message.content is a string, returns it directly; if it is an array
 * of content blocks, filters for blocks with type == "text" and joins their text values with
 * newlines.
 *
 * Antigravity shape: the text is a plain top-level `content` string, so it is returned as-is.
 * An Antigravity entry with no text of its own (a tool_calls-only entry) still yields "".
 */
export function extractEntryText(entry: TranscriptEntry | null | undefined): string {
  if (!entry || !entry.message) {
    if (isAntigravityEntry(entry) && typeof entry?.content === "string") {
      return entry.content;
    }
    return "";
  }
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
 *
 * Claude Code entries name the model on the message object.
 *
 * Antigravity entries name no model anywhere — verified across the store, every entry is
 * `{type, source, step_index, status, created_at}` plus content/tool_calls and nothing else.
 * The surface reports the model at the payload level (`modelName`), which loadTranscript()
 * attaches to each entry as provenance, and that is the only value returned here. With no
 * provenance the model is UNDETERMINED and this returns "" — the same fail-closed result as
 * before this adapter existed. It is deliberately never inferred from entry prose (an entry's
 * text can mention a model name, and model-written text is not evidence of anything).
 */
export function extractEntryModel(entry: TranscriptEntry | null | undefined): string {
  if (!entry || typeof entry !== "object") return "";
  if (entry.message && typeof entry.message === "object") {
    const model = entry.message.model;
    return typeof model === "string" ? model : "";
  }
  if (isAntigravityEntry(entry) && typeof entry.modelName === "string") {
    return entry.modelName;
  }
  return "";
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
 * Reads a transcript file and attaches Antigravity session provenance to its entries.
 *
 * The conversationId comes from the hook payload when there is one, and otherwise from the
 * `brain/<conversationId>/` path segment — both are written by the surface. Claude Code
 * transcripts pass through unchanged, since neither value applies to them.
 */
async function readTranscriptFile(
  path: string,
  context?: AntigravitySessionContext | null,
): Promise<TranscriptEntry[]> {
  const content = await Deno.readTextFile(path);
  const entries = parseTranscriptJsonl(content);
  return tagAntigravityEntries(entries, {
    conversationId: context?.conversationId || conversationIdFromTranscriptPath(path),
    modelName: context?.modelName ?? "",
  });
}

/**
 * Reads transcript entries from a file path, raw JSONL string, or JSON payload.
 *
 * Recognises both surfaces' payloads: Claude Code's `transcript_path`, and Antigravity's
 * `transcriptPath` + `conversationId` + `modelName`, whose values are carried onto every
 * entry as provenance (see tagAntigravityEntries).
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
          return await readTranscriptFile(payload.transcript_path);
        } catch {
          return [];
        }
      }
      const agyContext = parseAntigravityPayload(payload);
      if (agyContext && agyContext.transcriptPath) {
        try {
          return await readTranscriptFile(agyContext.transcriptPath, agyContext);
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
    return await readTranscriptFile(trimmed);
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
