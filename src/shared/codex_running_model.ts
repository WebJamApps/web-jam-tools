import { join } from "@std/path";

export interface RunningModelOptions {
  env?: (name: string) => string | undefined;
  readRoster?: () => Promise<string[]>;
}

/** Read the sole author roster through its side-effect-free shell probe. */
export async function readAuthorRoster(): Promise<string[]> {
  const script = new URL("../../scripts/create-draft-pr.sh", import.meta.url).pathname;
  const result = await new Deno.Command("bash", {
    args: [script, "--list-roster"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.code !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr) || `exit ${result.code}`);
  }
  return new TextDecoder().decode(result.stdout).split(/\r?\n/).filter((line) => line.length > 0);
}

async function findSessionFiles(directory: string, suffix: string): Promise<string[]> {
  const matches: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      matches.push(...await findSessionFiles(path, suffix));
    } else if (entry.isFile && entry.name.endsWith(suffix)) {
      matches.push(path);
    }
  }
  return matches;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lastTurnModel(text: string, path: string): string {
  let lastTurn: Record<string, unknown> | undefined;
  for (const line of text.split("\n")) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // The running session may have appended only part of its last line.
      continue;
    }
    if (isRecord(record) && record.type === "turn_context") lastTurn = record;
  }
  if (!lastTurn) throw new Error(`No turn_context could be read from ${path}`);
  const model = isRecord(lastTurn.payload) ? lastTurn.payload.model : undefined;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error(`The newest turn_context has no model in ${path}`);
  }
  return model;
}

/** Resolve this session's signature, refusing any ambiguous or unreadable input. */
export async function codexRunningModel(options: RunningModelOptions = {}): Promise<string> {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const id = env("CODEX_THREAD_ID");
  if (!id) throw new Error("Not a Codex session: CODEX_THREAD_ID is unset or empty");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new Error(`CODEX_THREAD_ID is not a session id: ${id}`);
  }
  let codexHome = env("CODEX_HOME");
  if (!codexHome) {
    const userHome = env("HOME");
    if (!userHome) throw new Error("Cannot locate Codex sessions: CODEX_HOME and HOME are unset");
    codexHome = join(userHome, ".codex");
  }
  const directory = join(codexHome, "sessions");
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
  const model = lastTurnModel(text, path);
  let roster: string[];
  try {
    roster = await (options.readRoster ?? readAuthorRoster)();
  } catch (error) {
    throw new Error(`The author roster could not be read: ${error}`);
  }
  const entries = roster.filter((entry) => entry.toLowerCase().replaceAll(" ", "-") === model);
  if (entries.length === 0) throw new Error(`Model ${model} has no author roster entry`);
  if (entries.length > 1) throw new Error(`Two author roster entries stand for ${model}`);
  return `Codex — ${entries[0]}`;
}
