/**
 * Opus delegation gate decisions (web-jam-tools#965).
 *
 * Requirements: ~/Dropbox/web-jam-llms/Token_Savings/opus-delegation-gate-design-2026-08-18.md,
 * Appendix C, decisions D-6 (subagent edits in auto mode), D-7 (a `/work-issue` run on an
 * Opus-labeled issue approves the Opus session's own edits), and D-8 (a message asking Opus to do
 * the work approves like "opus edit ok" does).
 *
 * hooks/opus-delegation-gate.sh makes the cheap exits itself (a subagent call outside auto mode, no
 * target path, a path outside any git working tree) and pipes every remaining PreToolUse payload to
 * this module, which prints one JSON decision.
 *
 * Main-thread call — allowed when:
 *   - the session model is not Opus, or
 *   - Josh's latest HUMAN prompt contains "opus edit ok" or asks Opus to do the work, or
 *   - the most recent slash command in the transcript is a `/work-issue` Josh typed, naming an issue
 *     whose model label is Opus (D-7). Any other label, no issue named, or a failed label lookup gives
 *     no approval — the skill then has to delegate to the labeled tier.
 *
 * Subagent call in auto mode (D-6) — allowed when the subagent's own model is not Opus, or when it is
 * Opus and the human prompt that spawned it contains "opus edit ok", asks for an Opus subagent, or
 * asks Opus to do the work. An undeterminable model or spawning prompt is refused.
 *
 * Only prompts a person actually sent count (isHumanPrompt), on every path: a task notification or
 * an isMeta injection can neither grant approval nor displace Josh's last real prompt.
 *
 * Session layout, read from a live Claude Code 2.1.267 session:
 *   <project>/<session_id>.jsonl                                  main transcript
 *   <project>/<session_id>/subagents/agent-<agent_id>.jsonl       subagent transcript (isSidechain)
 *   <project>/<session_id>/subagents/agent-<agent_id>.meta.json   {model, spawnDepth, parentAgentId, toolUseId}
 *
 * A depth-1 subagent's `toolUseId` names an Agent tool_use in the main transcript. A nested
 * subagent's names one in its parent's transcript, so the spawning prompt is always looked up
 * through the depth-1 ancestor — which is also why an approval covers that agent's descendants.
 */

import {
  extractEntryModel,
  extractEntryText,
  getOpusGateInfo,
  isHumanPrompt,
  isUserTurnBoundary,
  parseTranscriptJsonl,
  type TranscriptEntry,
} from "./select_transcript_entry.ts";
import { slashCommandFromInvocationWrapper } from "./check_token_write_authorization.ts";
import { bashWriteTargets } from "./bash_write_targets.ts";

export const ESCAPE_PHRASE = "opus edit ok";

/** A parent chain longer than this is treated as broken rather than walked forever. */
export const MAX_SPAWN_DEPTH = 32;

/** Owner assumed for a `Repo#N` reference with no owner, matching `/work-issue Repo#123`. */
export const DEFAULT_OWNER = "WebJamApps";

/**
 * Labels that put an issue in the Opus lane. "Fable" is the retired name for the same lane (global
 * rules: "Any existing `Fable` label now means Opus").
 */
export const OPUS_LANE_LABELS = ["opus", "fable"];

/** How long a looked-up label set is reused before `gh` is asked again. */
export const LABEL_CACHE_TTL_MS = 10 * 60 * 1000;

/** Reads a file as text, returning null when it is missing or unreadable. */
export type ReadText = (path: string) => string | null;

export interface IssueRef {
  /** `Owner/Name` */
  repo: string;
  number: number;
}

/** Returns an issue's label names, or null when they could not be looked up. */
export type LabelLookup = (ref: IssueRef) => string[] | null;

export function readTextOrNull(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

export interface GatePayload {
  agent_id?: unknown;
  permission_mode?: unknown;
  transcript_path?: unknown;
  tool_name?: unknown;
  tool_input?: {
    command?: unknown;
    file_path?: unknown;
    notebook_path?: unknown;
    path?: unknown;
    [key: string]: unknown;
  };
  cwd?: unknown;
}

export interface GateDecision {
  decision: "allow" | "deny";
  /** Which path decided: the main thread's own edit, or a subagent's. */
  kind: "main" | "subagent";
  /** Why a call was refused or noted on allow. Empty when allowed or when the reason is the standard one. */
  why: string;
}

function allow(kind: GateDecision["kind"], why = ""): GateDecision {
  return { decision: "allow", kind, why };
}

function deny(kind: GateDecision["kind"], why: string): GateDecision {
  return { decision: "deny", kind, why };
}

export interface WriteTargetCheck {
  determinable: boolean;
  target?: string;
  targets?: string[];
  note?: string;
}

/** True when a command is a read-only script evaluation whose quoted text merely contains a write. */
export function isReadOnlyQuotedWrite(command: string): boolean {
  // 1. deno eval
  if (/\bdeno\s+eval\b/.test(command)) {
    const hasDenoWriteApi =
      /\bDeno\.(?:writeTextFile|writeTextFileSync|writeFile|writeFileSync|create|createSync|copyFile|copyFileSync|rename|renameSync|truncate|truncateSync|open|openSync)\b/
        .test(command);
    if (!hasDenoWriteApi) return true;
  }

  // 2. node -e / -p
  if (/\bnode(?:js)?\s+(?:-e|-p|--eval|--print)\b/.test(command)) {
    const hasNodeWriteApi =
      /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|cpSync)\b/
        .test(command);
    if (!hasNodeWriteApi) return true;
  }

  // 3. python -c that only logs/prints or does not invoke real write APIs
  if (/\bpython[0-9.]*\s+-c\b/.test(command)) {
    const hasPythonWriteApi =
      /(?:\bopen\s*\([^)]*['"][wax+][^'"]*['"]|\bwrite_(?:text|bytes)\s*\(|\bshutil\.|\bos\.(?:rename|replace)\b)/
        .test(command);
    if (!hasPythonWriteApi) return true;
  }

  return false;
}

/**
 * Checks whether a Bash command's write target is determinable or whether it falls into an
 * undeterminable case (unreadable destination, unreadable shape, or read-only command whose
 * quoted text merely contains a write).
 */
export function checkBashCommandTarget(
  command: string,
  cwd: string,
  home: string,
): WriteTargetCheck {
  if (!command.trim()) {
    return {
      determinable: false,
      note: "A Bash command could not be read, so write target is undeterminable.",
    };
  }

  // Check for read-only interpreter commands whose quoted text merely contains a write pattern
  if (isReadOnlyQuotedWrite(command)) {
    return {
      determinable: false,
      note: "A read-only command whose quoted text merely contains a write.",
    };
  }

  const targets = bashWriteTargets(command, { cwd, home });
  if (targets.length === 0) {
    return { determinable: true, targets: [] };
  }

  // If targets only contains cwd or directory targets, the destination cannot be read.
  // (bash_write_targets.ts line 373: "or working directories, for unknown destinations")
  if (targets.every((t) => t === cwd || t === "." || t.endsWith("/"))) {
    return {
      determinable: false,
      note: "A Bash write whose destination cannot be read.",
    };
  }

  if (targets.some((t) => t === cwd || t === ".")) {
    return {
      determinable: false,
      note: "A Bash write whose destination cannot be read.",
    };
  }

  return { determinable: true, target: targets[0], targets };
}

/** Resolves whether the tool call's write target is determinable. */
export function checkWriteTarget(payload: GatePayload): WriteTargetCheck {
  // Backwards compatibility with unit tests calling decide with only transcript_path
  if (payload.tool_name === undefined && payload.tool_input === undefined) {
    return { determinable: true };
  }

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const toolInput = payload.tool_input && typeof payload.tool_input === "object"
    ? payload.tool_input as Record<string, unknown>
    : {};

  if (toolName === "Bash" || ("command" in toolInput && typeof toolInput.command === "string")) {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    const cwd = typeof payload.cwd === "string" && payload.cwd
      ? payload.cwd
      : (typeof Deno !== "undefined" && typeof Deno.cwd === "function" ? Deno.cwd() : "/");
    let home = "";
    try {
      home = (typeof Deno !== "undefined" && typeof Deno.env?.get === "function" &&
        Deno.env.get("HOME")) || "";
    } catch {
      // No env permission: keep empty string.
    }

    return checkBashCommandTarget(command, cwd, home);
  }

  // Edit / Write / NotebookEdit
  const filePath = typeof toolInput.file_path === "string"
    ? toolInput.file_path
    : typeof toolInput.notebook_path === "string"
    ? toolInput.notebook_path
    : typeof toolInput.path === "string"
    ? toolInput.path
    : "";

  if (filePath.trim().length > 0) {
    return { determinable: true, target: filePath };
  }

  return {
    determinable: false,
    note: "The target file path could not be determined from the tool input.",
  };
}

export function isOpusModel(model: string): boolean {
  return /opus/i.test(model);
}

/** True when the text asks for an Opus subagent, e.g. "dispatch to an Opus subagent". */
export function asksForOpusSubagent(text: string): boolean {
  return /\bopus\s+sub-?agents?\b/i.test(text);
}

/**
 * Where an instruction may start: the text, a line, or a clause (after punctuation, "please", "and" or
 * "then"). A bare affirmation (yes/yeah/yep/ok/okay/sure) may sit between the start of the text, line
 * or clause and the verb: "yes dispatch the fix to Opus" was refused before, because only "yes," with a
 * comma opened a clause. The affirmation must itself open the text, line or clause, so "you said yes
 * send it to Opus" still refuses.
 */
const CLAUSE_OPENER = String
  .raw`(?:(?:^\s*|[.!?,;:]\s*)(?:(?:yes|yeah|yep|ok|okay|sure)\s+)?|\b(?:please|and|then)\s+)`;

const USE_HAVE_LET_MAKE_GET_ASK_OPUS = new RegExp(
  String.raw`${CLAUSE_OPENER}(?:use|have|let|make|get|ask)\s+(?:(?:a|an|the)\s+)?opus\b`,
  "im",
);

/** "send/dispatch/give/hand/assign/route <object>? to (the|a|an)? opus"; group 1 is the object. */
const ROUTES_TO_OPUS = new RegExp(
  String
    .raw`${CLAUSE_OPENER}(?:send|dispatch|give|hand|assign|route)\s+(?:([^.!?,;:\n]*?)\s+)?to\s+(?:(?:the|a|an)\s+)?opus\b`,
  "gim",
);

const NEGATION =
  /\b(?:not|no|never|stop|nothing|none|cannot|\w+n['’]t|dont|didnt|doesnt|wont|cant|shouldnt|wouldnt)\b/i;

/**
 * True when a routing verb opening a clause sends work to Opus, with no negation earlier in that
 * clause or in the object ("don't take this and send it to Opus", "send nothing to Opus"), and the
 * clause not a question: "?" must not be the first clause-ending punctuation after the match
 * ("send it to Opus?"). A "?" in a later clause does not count.
 */
function routesWorkToOpus(text: string): boolean {
  ROUTES_TO_OPUS.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ROUTES_TO_OPUS.exec(text))) {
    const verbStart = match.index + match[0].search(/(?:send|dispatch|give|hand|assign|route)\b/i);
    const clauseStart = Math.max(
      ...[".", "!", "?", ",", ";", ":", "\n"].map((c) => text.lastIndexOf(c, verbStart - 1)),
    ) + 1;
    const negated = NEGATION.test(text.slice(clauseStart, verbStart)) ||
      NEGATION.test(match[1] ?? "");

    const nextBreak = text.slice(match.index + match[0].length).match(/[.!?]+|\b(?:and|then)\b/i);
    const isQuestion = !!nextBreak && nextBreak[0].includes("?");

    if (!negated && !isQuestion) return true;
  }
  return false;
}

/**
 * True when the text instructs Opus to do the work (D-8): "please use OPUS to fix this", "have Opus
 * fix it", "dispatch this to Opus", "send the fix to OPUS". Only an instruction counts: the verb
 * (use/have/let/make/get/ask before "opus", or send/dispatch/give/hand/assign/route before "to opus")
 * must open the text, a line or a clause. A complaint or question ("why did you send this to Opus",
 * "should we send this to Opus", "you shouldn't send it to Opus"), a statement about Opus ("Opus
 * should only be used for design") or a bare mention ("the problem with Opus") does not match, so
 * anything that is not plainly a request fails closed — including an instruction reported
 * second-hand ("I asked you earlier to dispatch to Opus"), which has the same shape as a complaint.
 */
export function asksOpusToDoTheWork(text: string): boolean {
  return USE_HAVE_LET_MAKE_GET_ASK_OPUS.test(text) || routesWorkToOpus(text);
}

export function approvesOpusSubagent(text: string): boolean {
  return text.toLowerCase().includes(ESCAPE_PHRASE) || asksForOpusSubagent(text) ||
    asksOpusToDoTheWork(text);
}

export interface SessionFiles {
  mainTranscriptPath: string;
  subagentsDir: string;
}

/**
 * Resolves a session's files from either transcript_path shape: the main transcript (what Claude
 * Code 2.1.267 sends on every PreToolUse call, subagent calls included) or a subagent's own
 * `subagents/agent-<id>.jsonl`. Both resolve to the same files. Returns null for any other path.
 */
export function resolveSessionFiles(transcriptPath: string): SessionFiles | null {
  if (!transcriptPath.endsWith(".jsonl")) return null;
  const parts = transcriptPath.split("/");
  if (parts.length >= 3 && parts[parts.length - 2] === "subagents") {
    const sessionDir = parts.slice(0, -2).join("/");
    if (!sessionDir) return null;
    return { mainTranscriptPath: `${sessionDir}.jsonl`, subagentsDir: `${sessionDir}/subagents` };
  }
  const sessionDir = transcriptPath.slice(0, -".jsonl".length);
  return { mainTranscriptPath: transcriptPath, subagentsDir: `${sessionDir}/subagents` };
}

interface SubagentMeta {
  model?: unknown;
  parentAgentId?: unknown;
  toolUseId?: unknown;
}

function bareAgentId(agentId: string): string {
  return agentId.startsWith("agent-") ? agentId.slice("agent-".length) : agentId;
}

function readSubagentMeta(
  files: SessionFiles,
  agentId: string,
  read: ReadText,
): SubagentMeta | null {
  const raw = read(`${files.subagentsDir}/agent-${bareAgentId(agentId)}.meta.json`);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as SubagentMeta : null;
  } catch {
    return null;
  }
}

/**
 * The subagent's real model: `model` from its meta file when that names a model family, otherwise
 * the last assistant `message.model` in its own transcript. Returns "" when neither says.
 */
export function resolveSubagentModel(files: SessionFiles, agentId: string, read: ReadText): string {
  const meta = readSubagentMeta(files, agentId, read);
  if (typeof meta?.model === "string" && /opus|sonnet|haiku|claude/i.test(meta.model)) {
    return meta.model;
  }
  const raw = read(`${files.subagentsDir}/agent-${bareAgentId(agentId)}.jsonl`);
  if (raw === null) return "";
  const entries = parseTranscriptJsonl(raw);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const isAssistant = entry.type === "assistant" || entry.message?.role === "assistant";
    if (!isAssistant || entry.isApiErrorMessage === true) continue;
    const model = extractEntryModel(entry);
    if (model) return model;
  }
  return "";
}

function toolUseIds(entry: TranscriptEntry): string[] {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "tool_use" && typeof block.id === "string")
    .map((block) => block.id as string);
}

/**
 * The human prompt that spawned a subagent: walk `parentAgentId` up to the depth-1 ancestor, find
 * that ancestor's `toolUseId` in the main transcript, and take the nearest human prompt before it.
 * Returns null when the chain is broken, the tool_use is missing, or no human prompt precedes it.
 */
export function findSpawningHumanPrompt(
  files: SessionFiles,
  agentId: string,
  read: ReadText,
): TranscriptEntry | null {
  let meta = readSubagentMeta(files, agentId, read);
  for (let hops = 0; typeof meta?.parentAgentId === "string" && meta.parentAgentId !== ""; hops++) {
    if (hops >= MAX_SPAWN_DEPTH) return null;
    meta = readSubagentMeta(files, meta.parentAgentId, read);
  }
  const toolUseId = meta?.toolUseId;
  if (typeof toolUseId !== "string" || toolUseId === "") return null;

  const raw = read(files.mainTranscriptPath);
  if (raw === null) return null;
  const entries = parseTranscriptJsonl(raw);
  const spawnIndex = entries.findIndex((entry) =>
    entry.isSidechain !== true && toolUseIds(entry).includes(toolUseId)
  );
  for (let i = spawnIndex - 1; i >= 0; i--) {
    if (isHumanPrompt(entries[i])) return entries[i];
  }
  return null;
}

/** The slash command a user-turn text invokes — Claude Code's wrapper form or a bare leading `/` — or null. */
export function slashCommandOf(text: string): string | null {
  const trimmed = text.trim();
  const wrapped = slashCommandFromInvocationWrapper(trimmed);
  if (wrapped) return wrapped;
  const bare = trimmed.match(/^\/([a-zA-Z0-9_-]+)/);
  return bare ? bare[1].toLowerCase() : null;
}

/** The arguments of a `/work-issue` invocation: the `<command-args>` element, or the text after a bare `/work-issue`. */
export function workIssueArgs(text: string): string {
  const wrapped = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (wrapped) return wrapped[1].trim();
  const bare = text.trim().match(/^\/work-issue\b([\s\S]*)$/i);
  return bare ? bare[1].trim() : "";
}

/**
 * The first issue named in `/work-issue` arguments: a GitHub issue URL, `Owner/Repo#N`, or `Repo#N`
 * (owner WebJamApps). Returns null when none is named.
 */
export function parseIssueRef(args: string): IssueRef | null {
  const url = args.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/);
  if (url) return { repo: `${url[1]}/${url[2]}`, number: Number(url[3]) };
  const ref = args.match(/(?:^|\s)(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+)#(\d+)\b/);
  if (ref) return { repo: `${ref[1] ?? DEFAULT_OWNER}/${ref[2]}`, number: Number(ref[3]) };
  return null;
}

/** Parses `gh issue view --json labels` output into label names, or null when it is not that shape. */
export function parseLabelsJson(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.labels)) return null;
    return parsed.labels
      .map((label: { name?: unknown }) => label?.name)
      .filter((name: unknown): name is string => typeof name === "string");
  } catch {
    return null;
  }
}

/** Asks `gh` for an issue's labels, giving up after 10 seconds. Null on any failure. */
export function runGhLabels(ref: IssueRef): string[] | null {
  try {
    const output = new Deno.Command("timeout", {
      args: [
        "10",
        "gh",
        "issue",
        "view",
        String(ref.number),
        "--repo",
        ref.repo,
        "--json",
        "labels",
      ],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!output.success) return null;
    return parseLabelsJson(new TextDecoder().decode(output.stdout));
  } catch {
    return null;
  }
}

export interface LabelLookupDeps {
  cacheDir: string;
  now: () => number;
  run: LabelLookup;
  read: ReadText;
  write: (path: string, text: string) => void;
}

/**
 * A label lookup that reuses a result for LABEL_CACHE_TTL_MS, so a `/work-issue` build does not pay
 * a `gh` round trip on every edit. Failed lookups are never cached.
 */
export function createLabelLookup(deps: LabelLookupDeps): LabelLookup {
  return (ref) => {
    const path = `${deps.cacheDir}/${ref.repo.replace("/", "__")}__${ref.number}.json`;
    const cached = deps.read(path);
    if (cached !== null) {
      try {
        const entry = JSON.parse(cached);
        if (
          typeof entry?.fetchedAt === "number" &&
          deps.now() - entry.fetchedAt < LABEL_CACHE_TTL_MS &&
          Array.isArray(entry.labels)
        ) {
          return entry.labels.filter((name: unknown): name is string => typeof name === "string");
        }
      } catch {
        // Unreadable cache entry: look the labels up again.
      }
    }
    const labels = deps.run(ref);
    if (labels !== null) {
      try {
        deps.write(path, JSON.stringify({ fetchedAt: deps.now(), labels }));
      } catch {
        // The cache is best-effort.
      }
    }
    return labels;
  };
}

/** The live lookup: `gh`, cached under $OPUS_GATE_CACHE_DIR (default /tmp/opus-gate-labels). */
export function defaultLabelLookup(): LabelLookup {
  let cacheDir = "/tmp/opus-gate-labels";
  try {
    cacheDir = Deno.env.get("OPUS_GATE_CACHE_DIR") || cacheDir;
  } catch {
    // No env permission: keep the default.
  }
  return createLabelLookup({
    cacheDir,
    now: Date.now,
    run: runGhLabels,
    read: readTextOrNull,
    write: (path, text) => {
      Deno.mkdirSync(cacheDir, { recursive: true });
      Deno.writeTextFileSync(path, text);
    },
  });
}

/**
 * D-7: true when the most recent slash command in the transcript is a `/work-issue` Josh typed that
 * names an issue labeled for the Opus lane.
 *
 * Josh's later plain messages do not end the approval; any other slash command does — the same
 * scope-ending rule hooks/lib/check_token_write_authorization.ts applies to the issue-approval token.
 * Local-command echoes (e.g. `/model`, which carry no origin) still count as that other command, so
 * the scope only ever ends early, never extends. A `/work-issue` naming no issue, an issue with any
 * other label, or a failed lookup gives no approval.
 */
export function workIssueApprovalActive(
  entries: readonly TranscriptEntry[],
  lookupLabels: LabelLookup,
): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isUserTurnBoundary(entry) || entry.isMeta === true) continue;
    const text = extractEntryText(entry);
    const command = slashCommandOf(text);
    if (command === null) continue;
    if (command !== "work-issue" || !isHumanPrompt(entry)) return false;
    const ref = parseIssueRef(workIssueArgs(text));
    if (!ref) return false;
    const labels = lookupLabels(ref);
    return labels !== null &&
      labels.some((label) => OPUS_LANE_LABELS.includes(label.toLowerCase()));
  }
  return false;
}

export function decideMainThreadEdit(
  transcriptPath: string,
  read: ReadText,
  lookupLabels: LabelLookup,
): GateDecision {
  const raw = transcriptPath ? read(transcriptPath) : null;
  if (raw === null) {
    return allow(
      "main",
      "The session transcript could not be read, so the session model is unknown.",
    );
  }
  const entries = parseTranscriptJsonl(raw);
  const info = getOpusGateInfo(entries);
  if (!info.model) {
    return allow("main", "The session model could not be determined from the transcript.");
  }
  if (!isOpusModel(info.model)) return allow("main");
  if (
    info.hasEscape || asksOpusToDoTheWork(info.lastUserText) ||
    workIssueApprovalActive(entries, lookupLabels)
  ) {
    return allow("main");
  }
  return deny("main", "");
}

export function decideSubagentEdit(
  agentId: string,
  transcriptPath: string,
  read: ReadText,
): GateDecision {
  const files = resolveSessionFiles(transcriptPath);
  if (!files) {
    return allow("subagent", "The session's files could not be located from transcript_path.");
  }
  const model = resolveSubagentModel(files, agentId, read);
  if (!model) {
    return allow(
      "subagent",
      "The subagent's model could not be determined: no meta file or transcript names it.",
    );
  }
  if (!isOpusModel(model)) return allow("subagent");
  const prompt = findSpawningHumanPrompt(files, agentId, read);
  if (!prompt) {
    return allow(
      "subagent",
      "The message Josh typed that spawned this Opus subagent could not be found.",
    );
  }
  if (approvesOpusSubagent(extractEntryText(prompt))) return allow("subagent");
  return deny(
    "subagent",
    'This is an Opus subagent, and the message that spawned it neither contains "opus edit ok", ' +
      "asks for an Opus subagent, nor asks Opus to do the work.",
  );
}

export function decide(
  payload: GatePayload,
  read: ReadText = readTextOrNull,
  lookupLabels: LabelLookup = defaultLabelLookup(),
): GateDecision {
  try {
    const targetCheck = checkWriteTarget(payload);
    const agentId = typeof payload.agent_id === "string" ? payload.agent_id : "";
    if (!targetCheck.determinable) {
      return allow(
        agentId ? "subagent" : "main",
        targetCheck.note ?? "Write target could not be determined.",
      );
    }

    const transcriptPath = typeof payload.transcript_path === "string"
      ? payload.transcript_path
      : "";
    if (agentId && payload.permission_mode === "auto") {
      return decideSubagentEdit(agentId, transcriptPath, read);
    }
    // A subagent call outside auto mode keeps its exemption. The shell hook exits before calling this
    // module in that case; the branch keeps decide() total.
    if (agentId) return allow("subagent");
    return decideMainThreadEdit(transcriptPath, read, lookupLabels);
  } catch (err) {
    return allow(
      "main",
      `The gate's checker threw an error (${err instanceof Error ? err.message : String(err)}), so proceeding by workflow default.`,
    );
  }
}

if (import.meta.main) {
  let result = allow(
    "main",
    "The hook payload could not be read, so proceeding by workflow default.",
  );
  try {
    const raw = await new Response(Deno.stdin.readable).text();
    const payload = JSON.parse(raw);
    if (payload && typeof payload === "object") result = decide(payload as GatePayload);
  } catch (err) {
    result = allow(
      "main",
      `The gate's checker threw an error (${err instanceof Error ? err.message : String(err)}), so proceeding by workflow default.`,
    );
  }
  console.log(JSON.stringify(result));
}
