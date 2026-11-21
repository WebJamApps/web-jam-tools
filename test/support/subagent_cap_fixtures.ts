// Shared fixtures for the subagent cap hooks (web-jam-tools#708): a sandbox with its own state
// directory, a fake clock and a private workflow switch, plus the transcripts and payloads the
// PreToolUse, SubagentStart and SubagentStop hooks read. Nothing here touches ~/.claude.

import {
  type CapDeps,
  readRunning,
  type RunningEntry,
} from "../../hooks/lib/check_agent_concurrency.ts";

export const SESSION_ID = "session-708";

export interface Sandbox {
  dir: string;
  stateDir: string;
  projectDir: string;
  switchPath: string;
  clock: { now: number };
  /** Last-write times the pruning step sees, by path. A path not listed has none. */
  mtimes: Map<string, number>;
  deps: CapDeps;
  /** Env a hook script needs to stay inside the sandbox. */
  env: Record<string, string>;
}

/**
 * Runs `fn` with the workflow switch pointed at a file inside the sandbox, so a switch live on the
 * laptop can never release a guard under test.
 */
export async function withSandbox(fn: (box: Sandbox) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "subagent-cap-" });
  const stateDir = `${dir}/state`;
  const projectDir = `${dir}/project`;
  const switchPath = `${dir}/workflow-switch.json`;
  await Deno.mkdir(projectDir, { recursive: true });
  // Starts at the real time, because the hook scripts a test runs keep time with the real clock.
  const clock = { now: Date.now() };
  const mtimes = new Map<string, number>();
  const env = {
    SUBAGENT_CAP_STATE_DIR: stateDir,
    WORKFLOW_SWITCH_PATH: switchPath,
    WORKFLOW_SWITCH_LOG_PATH: `${dir}/workflow-switch.log`,
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  const box: Sandbox = {
    dir,
    stateDir,
    projectDir,
    switchPath,
    clock,
    mtimes,
    env,
    deps: {
      stateDir,
      now: () => clock.now,
      readText: (path) => {
        try {
          return Deno.readTextFileSync(path);
        } catch {
          return null;
        }
      },
      readState: (path) => {
        try {
          return Deno.readTextFileSync(path);
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) return null;
          throw err;
        }
      },
      mtimeMs: (path) => mtimes.get(path) ?? null,
    },
  };
  try {
    await fn(box);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await Deno.remove(dir, { recursive: true });
  }
}

/** Writes the main transcript whose newest assistant entry names `model`; returns its path. */
export async function writeMainTranscript(
  box: Sandbox,
  model: string,
  sessionId = SESSION_ID,
): Promise<string> {
  const path = `${box.projectDir}/${sessionId}.jsonl`;
  const lines = [
    { type: "user", message: { role: "user", content: "go" } },
    { type: "assistant", message: { role: "assistant", model, content: [] } },
  ];
  await Deno.writeTextFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

/** Writes a subagent's meta file, which names the model it runs on. */
export async function writeSubagentMeta(
  box: Sandbox,
  agentId: string,
  model: string,
  sessionId = SESSION_ID,
): Promise<void> {
  const dir = `${box.projectDir}/${sessionId}/subagents`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/agent-${agentId}.meta.json`, JSON.stringify({ model }));
}

export interface LaunchOptions {
  model?: string;
  subagent_type?: string;
  description?: string;
  prompt?: string;
  agent_id?: string;
  transcript_path?: string;
  session_id?: string;
}

/** A PreToolUse payload for the `Agent` tool. */
export function launchPayload(opts: LaunchOptions = {}): Record<string, unknown> {
  const input: Record<string, unknown> = {
    description: opts.description ?? "build the thing",
    prompt: opts.prompt ?? "do the work",
  };
  if (opts.subagent_type !== undefined) input.subagent_type = opts.subagent_type;
  if (opts.model !== undefined) input.model = opts.model;
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    session_id: opts.session_id ?? SESSION_ID,
    transcript_path: opts.transcript_path,
    agent_id: opts.agent_id,
    tool_input: input,
  };
}

/** A SubagentStart or SubagentStop payload. */
export function lifecyclePayload(
  event: "SubagentStart" | "SubagentStop",
  agentId: string,
  opts: { agent_type?: string; transcript_path?: string; session_id?: string } = {},
): Record<string, unknown> {
  return {
    hook_event_name: event,
    session_id: opts.session_id ?? SESSION_ID,
    transcript_path: opts.transcript_path,
    agent_id: agentId,
    agent_type: opts.agent_type ?? "general-purpose",
  };
}

/** The session's running entries as `agent_id:state` strings, for compact assertions. */
export function runningSummary(box: Sandbox, sessionId = SESSION_ID): string[] {
  const entries: RunningEntry[] | null = readRunning(sessionId, box.deps);
  return (entries ?? []).map((e) => `${e.agent_id ?? "-"}:${e.state}`);
}

/** The queue file's `launch` lines, parsed. */
export async function queuedLaunches(
  box: Sandbox,
  sessionId = SESSION_ID,
): Promise<Array<Record<string, string>>> {
  let text = "";
  try {
    text = await Deno.readTextFile(`${box.stateDir}/${sessionId}.queue.jsonl`);
  } catch {
    return [];
  }
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((i) =>
    i.kind === "launch"
  );
}

export interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a hook script with a JSON payload on stdin, inside the sandbox. */
export async function runHookScript(
  box: Sandbox,
  script: string,
  stdin: string,
  extraEnv: Record<string, string> = {},
): Promise<ScriptResult> {
  const denoDir = Deno.execPath().slice(0, Deno.execPath().lastIndexOf("/"));
  const child = new Deno.Command("bash", {
    args: [new URL(`../../hooks/${script}`, import.meta.url).pathname],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), ...box.env, PATH: `${denoDir}:/usr/bin:/bin`, ...extraEnv },
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdin));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

/** Writes a workflow switch naming `guard` that stays unexpired through the sandbox clock. */
export async function writeSwitch(box: Sandbox, guard: string): Promise<void> {
  await Deno.writeTextFile(
    box.switchPath,
    JSON.stringify({
      guard,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    }),
  );
}
