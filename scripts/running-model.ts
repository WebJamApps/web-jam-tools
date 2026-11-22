import { join } from "@std/path";
import {
  codexRunningModel,
  readAuthorRoster,
  type RunningModelOptions,
} from "../src/shared/codex_running_model.ts";
import {
  extractEntryModel,
  parseTranscriptJsonl,
  selectSessionModel,
} from "../hooks/lib/select_transcript_entry.ts";

function uniqueRosterModel(model: string, matches: string[]): string {
  if (matches.length === 0) throw new Error(`Model ${model} has no author roster entry`);
  if (matches.length !== 1) throw new Error(`Two author roster entries stand for ${model}`);
  return matches[0];
}

function matchesClaudeModel(model: string, entry: string): boolean {
  if (!entry.startsWith("Claude ")) return false;
  const slug = entry.toLowerCase().replaceAll(" ", "-").replaceAll(".", "-");
  if (model === slug) return true;
  if (!model.startsWith(`${slug}-`)) return false;
  const suffix = model.slice(slug.length + 1);
  // Opus is deliberately unversioned in the roster; versioned entries may carry a date.
  return /\d/.test(entry) ? /^\d{8}$/.test(suffix) : /^\d+(?:-\d+)*$/.test(suffix);
}

export async function claudeSessionRecord(
  sessionId: string,
  userHome: string | undefined,
): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(sessionId)) {
    throw new Error("CLAUDE_CODE_SESSION_ID is not a safe session id");
  }
  if (!userHome) throw new Error("Cannot locate Claude Code sessions: HOME is unset");
  const projects = join(userHome, ".claude", "projects");
  const files: string[] = [];
  for await (const entry of Deno.readDir(projects)) {
    if (!entry.isDirectory) continue;
    const candidate = join(projects, entry.name, `${sessionId}.jsonl`);
    try {
      if ((await Deno.stat(candidate)).isFile) files.push(candidate);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  if (files.length !== 1) {
    throw new Error(
      `Expected one Claude Code record for ${sessionId} under ${projects}; found ${files.length}`,
    );
  }
  return files[0];
}

/** Resolve a main or helper Claude record through the same sole author roster. */
export async function claudeRecordedAuthor(
  path: string,
  options: RunningModelOptions = {},
  helper = false,
): Promise<string> {
  const entries = parseTranscriptJsonl(await Deno.readTextFile(path));
  const latest = entries.findLast((entry) =>
    (entry.type === "assistant" || entry.message?.role === "assistant") &&
    (helper || entry.isSidechain !== true) && entry.isApiErrorMessage !== true &&
    extractEntryModel(entry).length > 0
  );
  const model = selectSessionModel(latest ? [{ ...latest, isSidechain: false }] : []);
  if (!model) {
    throw new Error(`The newest Claude Code assistant entry has no recorded model: ${path}`);
  }
  const roster = await (options.readRoster ?? readAuthorRoster)();
  return uniqueRosterModel(model, roster.filter((entry) => matchesClaudeModel(model, entry)));
}

const AGY_ROSTER_ALIASES: Record<string, readonly string[]> = {
  "Gemini Hydrogen": ["Gemini Hydrogen", "gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
  "Gemini Argon": ["Gemini Argon", "gemini-4-argon-high", "Gemini 4 Argon (High)"],
  "Gemini Neon": ["Gemini Neon", "gemini-4-neon-high", "Gemini 4 Neon (High)"],
  "Claude Sonnet 5.5": ["Claude Sonnet 5.5", "claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
  "Claude Opus": ["Claude Opus", "claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
};

function matchesAgyModel(model: string, entry: string): boolean {
  return AGY_ROSTER_ALIASES[entry]?.includes(model) ?? false;
}

function safeEnv(env: (name: string) => string | undefined, name: string): string | undefined {
  try {
    return env(name);
  } catch {
    return undefined;
  }
}

/** Parse the shared log, passing over rows that name no conversation without reading the rest. */
function agyRecords(text: string, path: string): Record<string, unknown>[] {
  const lines = text.split("\n").filter((line) => line.trim());
  if (!lines.length) throw new Error(`The agy hook record is empty: ${path}`);
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Cannot read the agy model record ${path}: ${error}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`The agy hook record is not an object in ${path}`);
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.conversationId !== "string" || !record.conversationId.trim()) {
      continue;
    }
    records.push(record);
  }
  return records;
}

function agyRecordedAuthor(
  records: Record<string, unknown>[],
  context: NonNullable<RunningModelOptions["invocationContext"]>,
  roster: string[],
  path: string,
): string {
  const { conversationId, modelName, transcriptPath } = context;
  if (typeof conversationId !== "string" || !conversationId.trim()) {
    throw new Error("Missing calling conversation identity");
  }
  if (typeof modelName !== "string" || !modelName.trim()) {
    throw new Error("Invocation context has missing model");
  }
  const conversation = records.filter((record) => record.conversationId === conversationId);
  if (!conversation.length) {
    throw new Error(`No agy hook record matches conversation ${conversationId}`);
  }
  if (
    conversation.some((record) => typeof record.modelName !== "string" || !record.modelName.trim())
  ) {
    throw new Error(`The agy hook record has no recorded model in ${path}`);
  }
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) {
    throw new Error("Invocation context has missing transcriptPath");
  }
  uniqueRosterModel(modelName, roster.filter((entry) => matchesAgyModel(modelName, entry)));
  // A row missing the second identity key cannot be safely attributed to either collision.
  if (
    conversation.some((record) =>
      typeof record.transcriptPath !== "string" || !record.transcriptPath.trim()
    )
  ) {
    throw new Error("The agy hook record has no recorded transcriptPath");
  }
  const latest = conversation.findLast((record) => record.transcriptPath === transcriptPath);
  if (!latest) {
    throw new Error("Contradictory context: no hook record matches the calling transcriptPath");
  }
  const recordedModel = latest.modelName as string;
  const author = uniqueRosterModel(
    recordedModel,
    roster.filter((entry) => matchesAgyModel(recordedModel, entry)),
  );
  if (latest.modelName !== modelName) {
    throw new Error("Contradictory context: modelName does not match the recorded model");
  }
  return author;
}

/** Resolve the current surface's recorded model, never falling back from an identified session. */
export async function resolveRunningModel(options: RunningModelOptions = {}): Promise<string> {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const codexId = safeEnv(env, "CODEX_THREAD_ID");
  const claudeId = safeEnv(env, "CLAUDE_CODE_SESSION_ID");
  const agyId = safeEnv(env, "AGY_CONVERSATION_ID") || options.invocationContext?.conversationId;

  if (codexId && claudeId) throw new Error("Two tools claim the session: Codex and Claude Code");
  if (codexId && agyId) throw new Error("Two tools claim the session: Codex and agy");
  if (claudeId && agyId) throw new Error("Two tools claim the session: Claude Code and agy");

  if (codexId) {
    const signature = await codexRunningModel({ ...options, env });
    return signature.slice("Codex — ".length);
  }
  const roster = await (options.readRoster ?? readAuthorRoster)();
  if (claudeId) {
    const path = await claudeSessionRecord(claudeId, env("HOME"));
    return await claudeRecordedAuthor(path, {
      ...options,
      readRoster: () => Promise.resolve(roster),
    });
  }

  const recordPath = env("AGY_HOOK_RECORD_PATH") || "/tmp/agy-hook-invocations.jsonl";
  let recordText: string;
  try {
    recordText = await Deno.readTextFile(recordPath);
  } catch (error) {
    throw new Error(`Cannot read the agy model record ${recordPath}: ${error}`);
  }

  const records = agyRecords(recordText, recordPath);

  if (options.invocationContext === null) {
    throw new Error("Missing trusted invocation context");
  }

  const contextConversationId = options.invocationContext !== undefined
    ? options.invocationContext.conversationId
    : safeEnv(env, "AGY_CONVERSATION_ID");
  const contextModelName = options.invocationContext !== undefined
    ? options.invocationContext.modelName
    : safeEnv(env, "AGY_MODEL_NAME");
  const contextTranscriptPath = options.invocationContext !== undefined
    ? options.invocationContext.transcriptPath
    : safeEnv(env, "AGY_TRANSCRIPT_PATH");

  if (contextConversationId === undefined) {
    throw new Error("Missing trusted invocation context");
  }
  return agyRecordedAuthor(
    records,
    {
      conversationId: contextConversationId,
      modelName: contextModelName,
      transcriptPath: contextTranscriptPath,
    },
    roster,
    recordPath,
  );
}

export async function runRunningModel(
  options: RunningModelOptions = {},
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): Promise<number> {
  try {
    stdout(await resolveRunningModel(options));
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    stderr(`Cannot tell the running model: ${reason}`);
    return 1;
  }
}

if (import.meta.main) Deno.exit(await runRunningModel());
