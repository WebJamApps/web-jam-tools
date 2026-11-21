/**
 * Subagent concurrency cap and model-launch guard (web-jam-tools#708 "Subagent cap: admit Opus
 * coding helpers within the two-slot queue").
 *
 * Requirements: ~/Dropbox/web-jam-llms/AI_Misbehaves/delegation-gate-design.md (revision 1.3.0),
 * "Subagents and the work queue", the helper-launch rows of "Opus coding and Josh’s choice of
 * Fable", and "Both surfaces". Claude Code only: the cap counts Anthropic-billed subagents, and a
 * helper agy or Codex starts is not one.
 *
 * One module, three modes. Each is run by a thin hook script that goes through run_hook.sh, the
 * workflow-guard runner, so an unusable checker allows with a note:
 *
 *   check  PreToolUse on `Agent`           hooks/cap-concurrent-subagents.sh
 *   start  SubagentStart                   hooks/track-subagent-start.sh
 *   stop   SubagentStop                    hooks/track-subagent-stop.sh
 *
 * Launch rules (`check`):
 *   - An explicit `fable` launch is refused and never queued.
 *   - A launch that names no model — a fork, or any launch that inherits — from a Fable session
 *     (or from a Fable subagent) is refused and never queued: it would run the helper on Fable.
 *   - Every other launch — explicit or inherited Opus included, and a Sonnet or Haiku helper a
 *     Fable session starts — takes one of two slots. With two slots taken the launch is refused and
 *     appended to the session's durable queue; with one free it is admitted.
 *   - Workflow-guard default: an unreadable session id, running list or model allows the launch
 *     with a note, and an unexpired workflow switch naming this guard (or "all") releases it.
 *
 * A slot is reserved the moment a launch is admitted, not when SubagentStart fires. Several launches
 * in one message pass PreToolUse before any of them has started, so counting only started
 * subagents would let a third through. SubagentStart turns the oldest matching reservation into a
 * running entry; a reservation no SubagentStart ever claims (the launch failed) expires after
 * {@link RESERVATION_TTL_MS}. A running entry whose subagent transcript has been silent for
 * {@link SILENT_TRANSCRIPT_MS} without a SubagentStop is dropped, so a crashed helper never blocks
 * later launches. SubagentStop removes the entry.
 *
 * State is per session, under `~/.claude/state/subagent-cap/` (override: SUBAGENT_CAP_STATE_DIR):
 *   <session_id>.running.json   {"version":1,"entries":[RunningEntry, ...]}
 *   <session_id>.queue.jsonl    one JSON object per line; this module writes `kind: "launch"` lines.
 *                               The mid-turn message queue (web-jam-tools#1065) writes its own
 *                               `kind` into the same file.
 *   <session_id>.lock/          a directory made with mkdir while one hook rewrites the files
 */

import { isSafeSessionId } from "./check_issue_approval_token.ts";
import {
  type ReadText,
  readTextOrNull,
  resolveSessionFiles,
  resolveSubagentModel,
} from "./opus_gate.ts";
import { parseTranscriptJsonl, selectSessionModel } from "./select_transcript_entry.ts";
import { checkAndConsumeWorkflowSwitch } from "./workflow_switch.ts";

/** At most this many Anthropic-billed subagents run at once. */
export const MAX_RUNNING_SUBAGENTS = 2;

/** A running entry whose transcript has been silent this long without a Stop event is dropped. */
export const SILENT_TRANSCRIPT_MS = 30 * 60 * 1000;

/** A slot reserved at admission that no SubagentStart claims is released after this long. */
export const RESERVATION_TTL_MS = 2 * 60 * 1000;

/** Guard names the workflow off-switch matches (the hook script names, without `.sh`). */
export const CAP_GUARD = "cap-concurrent-subagents";
export const START_GUARD = "track-subagent-start";
export const STOP_GUARD = "track-subagent-stop";

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;

export interface RunningEntry {
  /** Null while the slot is only reserved. */
  agent_id: string | null;
  agent_type: string;
  state: "reserved" | "running";
  reserved_at: string;
  started_at?: string;
  /** The subagent's own transcript, whose last write shows it is still alive. */
  transcript_path?: string;
}

export interface RunningList {
  version: 1;
  entries: RunningEntry[];
}

export interface CapDeps {
  /** Directory holding the per-session state files. Empty when HOME cannot be found. */
  stateDir: string;
  now: () => number;
  /** Reads a transcript: the text, or null when it cannot be read. */
  readText: ReadText;
  /** Reads a state file: the text, null when it does not exist; throws when it cannot be read. */
  readState: (path: string) => string | null;
  /** A file's last-write time in milliseconds, or null when it cannot be read. */
  mtimeMs: (path: string) => number | null;
}

export function defaultStateDir(): string {
  const override = Deno.env.get("SUBAGENT_CAP_STATE_DIR");
  if (override) return override;
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  return home ? `${home}/.claude/state/subagent-cap` : "";
}

export function defaultDeps(): CapDeps {
  return {
    stateDir: defaultStateDir(),
    now: () => Date.now(),
    readText: readTextOrNull,
    readState: (path) => {
      try {
        return Deno.readTextFileSync(path);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return null;
        throw err;
      }
    },
    mtimeMs: (path) => {
      try {
        return Deno.statSync(path).mtime?.getTime() ?? null;
      } catch {
        return null;
      }
    },
  };
}

export interface SessionPaths {
  list: string;
  queue: string;
  lock: string;
}

export function sessionPaths(stateDir: string, sessionId: string): SessionPaths {
  return {
    list: `${stateDir}/${sessionId}.running.json`,
    queue: `${stateDir}/${sessionId}.queue.jsonl`,
    lock: `${stateDir}/${sessionId}.lock`,
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bareAgentId(agentId: string): string {
  return agentId.startsWith("agent-") ? agentId.slice("agent-".length) : agentId;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Locked<T> = { ok: true; value: T } | { ok: false; why: string };

/**
 * Runs `fn` while holding the session's lock directory. Returns why when the lock cannot be taken
 * in {@link LOCK_WAIT_MS} or `fn` throws, so the caller can apply the workflow-guard default.
 * A lock older than {@link LOCK_STALE_MS} belongs to a hook that died and is removed.
 */
async function withLock<T>(paths: SessionPaths, stateDir: string, fn: () => T): Promise<Locked<T>> {
  try {
    Deno.mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    return { ok: false, why: `the state directory could not be created (${errorText(err)})` };
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      Deno.mkdirSync(paths.lock);
      break;
    } catch (err) {
      if (!(err instanceof Deno.errors.AlreadyExists)) {
        return { ok: false, why: `the lock could not be taken (${errorText(err)})` };
      }
      let age: number | null = null;
      try {
        const mtime = Deno.statSync(paths.lock).mtime;
        age = mtime ? Date.now() - mtime.getTime() : null;
      } catch {
        age = null;
      }
      if (age !== null && age > LOCK_STALE_MS) {
        try {
          Deno.removeSync(paths.lock);
        } catch {
          // another hook removed it first; the next mkdir decides
        }
        continue;
      }
      if (Date.now() > deadline) {
        return { ok: false, why: "another hook held the lock for too long" };
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, why: errorText(err) };
  } finally {
    try {
      Deno.removeSync(paths.lock);
    } catch {
      // already gone
    }
  }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${Deno.pid}.tmp`;
  Deno.writeTextFileSync(tmp, text);
  Deno.renameSync(tmp, path);
}

/** A missing file is an empty list; a file that is not a well-formed list throws. */
function loadList(path: string, deps: CapDeps): RunningList {
  const raw = deps.readState(path);
  if (raw === null || raw.trim() === "") return { version: 1, entries: [] };
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error(`${path} is not a running-subagent list`);
  }
  const entries: RunningEntry[] = [];
  for (const entry of parsed.entries) {
    if (
      entry && typeof entry === "object" && typeof entry.agent_type === "string" &&
      (entry.state === "reserved" || entry.state === "running") &&
      typeof entry.reserved_at === "string"
    ) {
      entries.push(entry as RunningEntry);
    }
  }
  return { version: 1, entries };
}

function saveList(path: string, entries: RunningEntry[]): void {
  writeAtomic(path, JSON.stringify({ version: 1, entries }, null, 2) + "\n");
}

/** Drops reservations nobody claimed and running entries whose transcript has gone silent. */
export function pruneEntries(entries: readonly RunningEntry[], deps: CapDeps): RunningEntry[] {
  const now = deps.now();
  return entries.filter((entry) => {
    if (entry.state === "reserved") {
      return now - Date.parse(entry.reserved_at) <= RESERVATION_TTL_MS;
    }
    const started = Date.parse(entry.started_at ?? entry.reserved_at);
    const written = entry.transcript_path ? deps.mtimeMs(entry.transcript_path) : null;
    const lastActive = Math.max(Number.isNaN(started) ? 0 : started, written ?? 0);
    return now - lastActive <= SILENT_TRANSCRIPT_MS;
  });
}

export type ModelFamily = "opus" | "fable" | "sonnet" | "haiku" | "other";

/** "" when no model is named (omitted, blank or "inherit"): the helper inherits its launcher's. */
export function modelFamily(text: string): ModelFamily | "" {
  const name = text.trim().toLowerCase();
  if (name === "" || name === "inherit") return "";
  if (name.includes("fable")) return "fable";
  if (name.includes("opus")) return "opus";
  if (name.includes("sonnet")) return "sonnet";
  if (name.includes("haiku")) return "haiku";
  return "other";
}

export interface AgentLaunchPayload {
  session_id?: unknown;
  transcript_path?: unknown;
  agent_id?: unknown;
  tool_name?: unknown;
  tool_input?: {
    description?: unknown;
    prompt?: unknown;
    subagent_type?: unknown;
    model?: unknown;
    [key: string]: unknown;
  };
}

/** The model of whoever launches: the main session, or the subagent named by `agent_id`. */
function launcherModel(payload: AgentLaunchPayload, deps: CapDeps): string {
  const transcript = str(payload.transcript_path);
  const files = transcript ? resolveSessionFiles(transcript) : null;
  if (!files) return "";
  const agentId = str(payload.agent_id);
  if (agentId) return resolveSubagentModel(files, agentId, deps.readText);
  const raw = deps.readText(files.mainTranscriptPath);
  return raw === null ? "" : selectSessionModel(parseTranscriptJsonl(raw));
}

export type LaunchDecision =
  | { decision: "allow"; note?: string }
  | { decision: "deny"; reason: string };

const allow = (note?: string): LaunchDecision => ({ decision: "allow", note });
const deny = (reason: string): LaunchDecision => ({ decision: "deny", reason });

const FABLE_KEPT = "Fable is kept for work Josh names, so an agent may not start a helper on it.";

function launchKey(input: NonNullable<AgentLaunchPayload["tool_input"]>): string {
  return JSON.stringify([
    str(input.description),
    str(input.subagent_type),
    str(input.model),
    str(input.prompt),
  ]);
}

/** Appends the launch to the session queue unless that same launch is already queued. */
function queueLaunch(
  queuePath: string,
  input: NonNullable<AgentLaunchPayload["tool_input"]>,
  deps: CapDeps,
) {
  const key = launchKey(input);
  const existing = deps.readState(queuePath) ?? "";
  for (const line of existing.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item?.kind === "launch" && item.key === key) return;
    } catch {
      // another writer's malformed line is none of this launch's business
    }
  }
  const item = {
    kind: "launch",
    key,
    queued_at: new Date(deps.now()).toISOString(),
    description: str(input.description),
    subagent_type: str(input.subagent_type),
    model: str(input.model),
    prompt: str(input.prompt),
  };
  writeAtomic(queuePath, existing + JSON.stringify(item) + "\n");
}

/** A launch that was queued and is now admitted leaves the queue, so the queue drains. */
function dequeueLaunch(queuePath: string, key: string, deps: CapDeps) {
  const existing = deps.readState(queuePath);
  if (existing === null) return;
  const kept = existing.split("\n").filter((line) => {
    if (!line.trim()) return false;
    try {
      const item = JSON.parse(line);
      return !(item?.kind === "launch" && item.key === key);
    } catch {
      return true;
    }
  });
  if (kept.length !== existing.split("\n").filter((line) => line.trim()).length) {
    writeAtomic(queuePath, kept.length ? kept.join("\n") + "\n" : "");
  }
}

type CapOutcome = { full: RunningEntry[] } | { admitted: true };

/** Decides a PreToolUse call on the `Agent` tool. */
export async function decideLaunch(
  payload: AgentLaunchPayload,
  deps: CapDeps = defaultDeps(),
): Promise<LaunchDecision> {
  const toolName = str(payload.tool_name);
  if (toolName && toolName !== "Agent") return allow();
  const input = payload.tool_input ?? {};

  const requested = modelFamily(str(input.model));
  if (requested === "fable") {
    return deny(
      `Subagent launch refused: it names the Fable model. ${FABLE_KEPT} ` +
        'Name "sonnet" or "haiku" for the helper, or "opus" for a coding helper.',
    );
  }
  if (requested === "") {
    const model = launcherModel(payload, deps);
    if (!model) {
      return allow(
        "Subagent cap: the model that would run this helper could not be determined from the " +
          "transcript, so the launch was allowed without a Fable check or a slot count.",
      );
    }
    if (modelFamily(model) === "fable") {
      return deny(
        "Subagent launch refused: this launch names no model, so the helper would inherit Fable " +
          `from ${str(payload.agent_id) ? "the subagent starting it" : "this session"}. ` +
          `${FABLE_KEPT} Name the helper's model: "sonnet" or "haiku", or "opus" for a coding helper.`,
      );
    }
  }

  const sessionId = str(payload.session_id);
  if (!isSafeSessionId(sessionId) || !deps.stateDir) {
    return allow(
      "Subagent cap: the session id or the state directory could not be determined, so the " +
        "launch was allowed without a slot count.",
    );
  }
  const paths = sessionPaths(deps.stateDir, sessionId);
  const key = launchKey(input);
  const locked = await withLock<CapOutcome>(paths, deps.stateDir, () => {
    const entries = pruneEntries(loadList(paths.list, deps).entries, deps);
    if (entries.length >= MAX_RUNNING_SUBAGENTS) {
      queueLaunch(paths.queue, input, deps);
      saveList(paths.list, entries);
      return { full: entries };
    }
    entries.push({
      agent_id: null,
      agent_type: str(input.subagent_type) || "general-purpose",
      state: "reserved",
      reserved_at: new Date(deps.now()).toISOString(),
    });
    saveList(paths.list, entries);
    dequeueLaunch(paths.queue, key, deps);
    return { admitted: true };
  });
  if (!locked.ok) {
    return allow(
      `Subagent cap: the running-subagent list could not be used (${locked.why}), so the launch ` +
        "was allowed without a slot count.",
    );
  }
  if ("admitted" in locked.value) return allow();

  const running = locked.value.full.map((e) => e.agent_type).join(", ");
  const label = str(input.description) || str(input.subagent_type) || "this launch";
  return deny(
    `Subagent cap: ${MAX_RUNNING_SUBAGENTS} subagents are already running (${running}), and at ` +
      `most ${MAX_RUNNING_SUBAGENTS} Anthropic-billed subagents run at a time. "${label}" was ` +
      `saved to this session's queue (${paths.queue}) and has not started. Carry on with other ` +
      "work; when a running subagent finishes, its completion is reported to you, and you then " +
      "launch the queued task.",
  );
}

export interface SubagentEventPayload {
  session_id?: unknown;
  transcript_path?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  agent_transcript_path?: unknown;
}

export type TrackResult = { ok: true } | { ok: false; why: string };

function agentTranscriptPath(payload: SubagentEventPayload, agentId: string): string | undefined {
  const given = str(payload.agent_transcript_path);
  if (given) return given;
  const transcript = str(payload.transcript_path);
  const files = transcript ? resolveSessionFiles(transcript) : null;
  return files ? `${files.subagentsDir}/agent-${bareAgentId(agentId)}.jsonl` : undefined;
}

function trackTarget(
  payload: SubagentEventPayload,
  deps: CapDeps,
): { paths: SessionPaths; agentId: string } | { why: string } {
  const sessionId = str(payload.session_id);
  const agentId = str(payload.agent_id);
  if (!isSafeSessionId(sessionId) || !agentId || !deps.stateDir) {
    return { why: "the session id, the agent id or the state directory could not be determined" };
  }
  return { paths: sessionPaths(deps.stateDir, sessionId), agentId };
}

/** SubagentStart: a reserved slot becomes a running entry, or a new running entry is added. */
export async function recordSubagentStart(
  payload: SubagentEventPayload,
  deps: CapDeps = defaultDeps(),
): Promise<TrackResult> {
  const target = trackTarget(payload, deps);
  if ("why" in target) return { ok: false, why: target.why };
  const { paths, agentId } = target;
  const agentType = str(payload.agent_type) || "general-purpose";
  const startedAt = new Date(deps.now()).toISOString();
  const locked = await withLock(paths, deps.stateDir, () => {
    const entries = pruneEntries(loadList(paths.list, deps).entries, deps)
      .filter((e) => e.agent_id === null || bareAgentId(e.agent_id) !== bareAgentId(agentId));
    const reserved = entries.filter((e) => e.state === "reserved");
    const slot = reserved.find((e) => e.agent_type === agentType) ?? reserved[0];
    const running: RunningEntry = {
      agent_id: agentId,
      agent_type: agentType,
      state: "running",
      reserved_at: slot?.reserved_at ?? startedAt,
      started_at: startedAt,
      transcript_path: agentTranscriptPath(payload, agentId),
    };
    if (slot) entries[entries.indexOf(slot)] = running;
    else entries.push(running);
    saveList(paths.list, entries);
  });
  return locked.ok ? { ok: true } : { ok: false, why: locked.why };
}

/** SubagentStop: the finished subagent's entry leaves the list. */
export async function recordSubagentStop(
  payload: SubagentEventPayload,
  deps: CapDeps = defaultDeps(),
): Promise<TrackResult> {
  const target = trackTarget(payload, deps);
  if ("why" in target) return { ok: false, why: target.why };
  const { paths, agentId } = target;
  const locked = await withLock(paths, deps.stateDir, () => {
    const entries = pruneEntries(loadList(paths.list, deps).entries, deps)
      .filter((e) => e.agent_id === null || bareAgentId(e.agent_id) !== bareAgentId(agentId));
    saveList(paths.list, entries);
  });
  return locked.ok ? { ok: true } : { ok: false, why: locked.why };
}

/** The session's current running list after pruning, for tests and diagnostics. Null when unreadable. */
export function readRunning(
  sessionId: string,
  deps: CapDeps = defaultDeps(),
): RunningEntry[] | null {
  if (!isSafeSessionId(sessionId) || !deps.stateDir) return null;
  try {
    return pruneEntries(loadList(sessionPaths(deps.stateDir, sessionId).list, deps).entries, deps);
  } catch {
    return null;
  }
}

/** The JSON a PreToolUse hook prints for a decision, or "" when nothing needs saying. */
export function renderLaunchOutput(decision: LaunchDecision): string {
  if (decision.decision === "deny") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    });
  }
  if (!decision.note) return "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: decision.note },
  });
}

function systemMessage(text: string): string {
  return JSON.stringify({ systemMessage: text });
}

async function readPayload(): Promise<unknown> {
  const raw = await new Response(Deno.stdin.readable).text();
  return raw.trim() ? JSON.parse(raw) : {};
}

/** Runs one mode against stdin and returns the text the hook prints. Exported for tests. */
export async function runMode(
  mode: string,
  payload: unknown,
  deps: CapDeps = defaultDeps(),
): Promise<string> {
  const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (mode === "check") {
    const released = checkAndConsumeWorkflowSwitch(CAP_GUARD);
    if (released.released) return renderLaunchOutput(allow(`Subagent cap: ${released.reason}`));
    return renderLaunchOutput(await decideLaunch(body as AgentLaunchPayload, deps));
  }
  if (mode === "start" || mode === "stop") {
    const guard = mode === "start" ? START_GUARD : STOP_GUARD;
    const released = checkAndConsumeWorkflowSwitch(guard);
    if (released.released) {
      return systemMessage(`${guard}: ${released.reason} Nothing was recorded.`);
    }
    const result = mode === "start"
      ? await recordSubagentStart(body, deps)
      : await recordSubagentStop(body, deps);
    if (result.ok) return "";
    return systemMessage(
      `${guard}: the running-subagent list could not be updated (${result.why}), so the cap may ` +
        "count this helper wrongly until its entry expires.",
    );
  }
  throw new Error(`unknown mode "${mode}"; expected check, start or stop`);
}

if (import.meta.main) {
  try {
    const out = await runMode(Deno.args[0] ?? "", await readPayload());
    if (out) console.log(out);
  } catch (err) {
    console.error(`check_agent_concurrency: ${errorText(err)}`);
    Deno.exit(1);
  }
}
