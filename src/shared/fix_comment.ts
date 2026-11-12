import { join } from "@std/path";
import type { CodexSkillCall } from "../../hooks/lib/codex_session_reader.ts";
import { parseTranscriptJsonl } from "../../hooks/lib/select_transcript_entry.ts";
import {
  claudeRecordedAuthor,
  claudeSessionRecord,
  resolveRunningModel,
} from "../../scripts/running-model.ts";
import { REVIEW_SUMMARY_HEADER, runFormGuards } from "../../scripts/gh-write/guard.ts";
import {
  codexRunningModel,
  findSessionFiles,
  readCodexSession,
  type RunningModelOptions,
} from "./codex_running_model.ts";

function startedSinceCall(timestamp: unknown, call: CodexSkillCall | null, path: string): boolean {
  const started = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  const invoked = call?.timestamp ? Date.parse(call.timestamp) : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(invoked)) {
    throw new Error(`Cannot date helper ${path} against the typed fix-pr call`);
  }
  return started >= invoked;
}

/** Discover only this Claude session's helper records, comparing their start to the typed call. */
async function claudeHelpers(path: string, call: CodexSkillCall | null): Promise<string[]> {
  const directory = join(path.slice(0, -".jsonl".length), "subagents");
  const helpers: string[] = [];
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
      files.push(join(directory, entry.name));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  for (const file of files) {
    const records = parseTranscriptJsonl(await Deno.readTextFile(file));
    if (startedSinceCall(records[0]?.timestamp, call, file)) helpers.push(file);
  }
  return helpers;
}

/** Codex records each child's exact parent thread and start time in session_meta. */
async function codexHelpers(
  path: string,
  threadId: string,
  call: CodexSkillCall | null,
  options: RunningModelOptions,
): Promise<string[]> {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const directory = join(env("CODEX_HOME") ?? join(env("HOME")!, ".codex"), "sessions");
  const helpers: string[] = [];
  for (const file of await findSessionFiles(directory, ".jsonl")) {
    if (file === path) continue;
    const text = await Deno.readTextFile(file);
    let first;
    try {
      first = JSON.parse(text.split("\n")[0]);
    } catch {
      continue; // An unrelated damaged session is not this session's child.
    }
    const meta = first?.type === "session_meta" ? first.payload : null;
    const nestedParent = meta?.source?.subagent?.thread_spawn?.parent_thread_id;
    if (meta?.parent_thread_id !== threadId && nestedParent !== threadId) continue;
    if (
      (meta.parent_thread_id && meta.parent_thread_id !== threadId) ||
      (nestedParent && nestedParent !== threadId)
    ) throw new Error(`Conflicting helper parent records in ${file}`);
    if (startedSinceCall(first.timestamp ?? meta.timestamp, call, file)) {
      if (typeof meta.id !== "string") throw new Error(`No helper session id in ${file}`);
      helpers.push(meta.id);
    }
  }
  return helpers;
}

/** A helper may sign only as itself or as the recorded parent; no-helper runs replace typed names. */
export async function fixCommentAuthor(
  typed: string,
  call: CodexSkillCall | null,
  options: RunningModelOptions = {},
): Promise<string> {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const codexId = env("CODEX_THREAD_ID");
  const claudeId = env("CLAUDE_CODE_SESSION_ID");
  if (codexId && env("FORCED_PR_AUTHOR")) {
    throw new Error("Refusing to sign: CODEX_THREAD_ID and FORCED_PR_AUTHOR are both set");
  }
  const model = await resolveRunningModel(options);
  const surface = codexId ? "Codex" : claudeId ? "Claude Code" : "agy";
  const parent = `${surface} — ${model}`;
  if (surface === "agy") return parent;

  let authors: (() => Promise<string>)[];
  if (codexId) {
    const session = await readCodexSession(options);
    const ids = await codexHelpers(session.path, session.threadId, call, options);
    authors = ids.map((id) => () =>
      codexRunningModel({ ...options, env: (name) => name === "CODEX_THREAD_ID" ? id : env(name) })
    );
  } else {
    const path = await claudeSessionRecord(claudeId!, env("HOME"));
    const files = await claudeHelpers(path, call);
    authors = files.map((file) => async () =>
      `Claude Code — ${await claudeRecordedAuthor(file, options, true)}`
    );
  }
  if (!authors.length || typed === parent) return parent;
  for (const readAuthor of authors) {
    if (typed === await readAuthor()) return typed;
  }
  throw new Error(
    "The Fixed-by signature names neither the session model nor a helper started since the fix-pr call",
  );
}

/** Check the whole comment before any push, then sign its sole final line from the tool's record. */
export async function signedFixComment(
  body: string,
  call: CodexSkillCall | null,
  options: RunningModelOptions = {},
): Promise<string> {
  const lines = body.trim().split(/\r?\n/);
  const last = lines.at(-1)?.trim() ?? "";
  const signature = last.match(/^🤖 Fixed by (\S.*?) — (\S.*?)$/u);
  if (!signature || lines.filter((line) => /^\s*🤖 Fixed by\b/u.test(line)).length !== 1) {
    throw new Error(
      "--fix-comment requires exactly one final signature: 🤖 Fixed by <tool> — <model>",
    );
  }
  if (!lines.slice(0, -1).join("\n").trim()) {
    throw new Error(
      "--fix-comment must describe the fix; an empty or signature-only file is refused",
    );
  }
  const form = runFormGuards(body, { requireReviewerLine: body.includes(REVIEW_SUMMARY_HEADER) });
  if (!form.ok) throw new Error(form.error);
  const author = await fixCommentAuthor(`${signature[1]} — ${signature[2]}`, call, options);
  return `${lines.slice(0, -1).join("\n")}\n🤖 Fixed by ${author}\n`;
}
