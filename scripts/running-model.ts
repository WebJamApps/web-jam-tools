import { join } from "@std/path";
import {
  codexRunningModel,
  readAuthorRoster,
  type RunningModelOptions,
} from "../src/shared/codex_running_model.ts";
import { parseTranscriptJsonl, selectSessionModel } from "../hooks/lib/select_transcript_entry.ts";

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

async function claudeSessionModel(
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
    throw new Error(`Expected one Claude Code record for ${sessionId}; found ${files.length}`);
  }
  const entries = parseTranscriptJsonl(await Deno.readTextFile(files[0]));
  const latest = entries.findLast((entry) =>
    (entry.type === "assistant" || entry.message?.role === "assistant") &&
    entry.isSidechain !== true && entry.isApiErrorMessage !== true
  );
  // Pass only the newest genuine assistant entry so missing metadata cannot use an older model.
  const model = selectSessionModel(latest ? [latest] : []);
  if (!model) throw new Error("The newest Claude Code assistant entry has no recorded model");
  return model;
}

async function agySessionModel(recordPath: string): Promise<string> {
  const lines = (await Deno.readTextFile(recordPath)).split("\n");
  const last = lines.findLast((line) => line.trim().length > 0);
  if (!last) throw new Error("The agy hook record is empty");
  const record: unknown = JSON.parse(last);
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("The newest agy hook record is not an object");
  }
  const fields = record as Record<string, unknown>;
  if (typeof fields.conversationId !== "string" || !fields.conversationId.trim()) {
    throw new Error("The newest agy hook record names no running conversation");
  }
  if (typeof fields.modelName !== "string" || !fields.modelName.trim()) {
    throw new Error("The newest agy hook record has no recorded model");
  }
  return fields.modelName;
}

/** Resolve the current surface's recorded model, never falling back from an identified session. */
export async function resolveRunningModel(options: RunningModelOptions = {}): Promise<string> {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const codexId = env("CODEX_THREAD_ID");
  const claudeId = env("CLAUDE_CODE_SESSION_ID");
  if (codexId && claudeId) throw new Error("Two tools claim the session: Codex and Claude Code");
  if (codexId) {
    const signature = await codexRunningModel({ ...options, env });
    return signature.slice("Codex — ".length);
  }
  const roster = await (options.readRoster ?? readAuthorRoster)();
  if (claudeId) {
    const model = await claudeSessionModel(claudeId, env("HOME"));
    return uniqueRosterModel(model, roster.filter((entry) => matchesClaudeModel(model, entry)));
  }
  const model = await agySessionModel(
    env("AGY_HOOK_RECORD_PATH") || "/tmp/agy-hook-invocations.jsonl",
  );
  const flash = model === "Gemini Flash" ||
    /^gemini-\d+(?:\.\d+)*-flash-(?:high|tiered)$/.test(model) ||
    /^Gemini \d+(?:\.\d+)* Flash(?: \(High\))?$/.test(model);
  return uniqueRosterModel(model, roster.filter((entry) => flash && entry === "Gemini Flash"));
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
