/**
 * Delegation gate decisions (web-jam-tools#965, web-jam-tools#1781).
 *
 * Requirements: ~/Dropbox/web-jam-llms/AI_Misbehaves/delegation-gate-design.md (revision 1.3.0),
 * "Opus coding and Josh’s choice of Fable" and "The delegation gate's Bash writes"; typed fix-pr
 * authorization is also specified in ~/Dropbox/web-jam-llms/Token_Savings/fix-pr-design-2026-10-10.md.
 *
 * hooks/opus-delegation-gate.sh makes the cheap exits itself (a subagent call outside auto mode, no
 * target path, a path outside any git working tree) and pipes every remaining PreToolUse payload to
 * this module, which prints one JSON decision.
 *
 * The gate reads the recorded model before looking for any grant:
 *
 * Main-thread call —
 *   - Opus, or any model other than Fable: allowed directly, with no edit grant.
 *   - Fable: allowed only on Josh's own choice of Fable for the task —
 *       - a human prompt containing "fable edit ok" or asking Fable to do the work, anywhere earlier
 *         in the SESSION, not since withdrawn with "fable edit off", or
 *       - the most recent slash command is a `/work-issue` Josh typed naming an issue he labeled
 *         Fable, or whose own instructions choose Fable for it. An Opus or Sol label, no issue
 *         named, or a failed lookup gives no approval, or
 *       - the newest skill Josh typed is `/fix-pr` naming a pull request. Later plain messages keep
 *         this approval; another typed skill ends it.
 *     A typed task grant covers only edits in the repository of the issue or pull request it
 *     names, judged by where each write really lands (through symlinks), and a "fable edit off"
 *     Josh sends after it ends it until he chooses Fable again. A Fable choice typed inside a skill
 *     call never grants the whole session.
 *     An Opus label or an Opus edit grant ("opus edit ok") never authorizes a Fable edit.
 *
 * Subagent call in auto mode — allowed when the subagent's own model is not Fable (an Opus coding
 * helper edits directly). A Fable subagent is allowed only when the human prompt that spawned it
 * contains "fable edit ok", asks for a Fable subagent, or asks Fable to do the work, until Josh says
 * "fable edit off" after it; during a fix-pr call, only that call's explicit Fable helper request
 * approves it, for edits in that pull request's repository and until Josh says "fable edit off".
 * An undeterminable model or
 * spawning prompt allows with a note. Whether a helper may be launched at all — the two-slot cap and
 * the refusal of an agent-selected or inherited Fable launch — belongs to the subagent cap,
 * hooks/lib/check_agent_concurrency.ts (web-jam-tools#708).
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
import { analyzeBashWrites } from "./bash_write_targets.ts";
import { parseApplyPatchFilePaths } from "./parse_apply_patch.ts";
import { checkAndConsumeWorkflowSwitch, type SwitchCheckResult } from "./workflow_switch.ts";

/** Grants a Fable session edits for the rest of the session: Josh's choice of Fable. */
export const FABLE_EDIT_PHRASE = "fable edit ok";

/** Withdraws a session-scoped approval granted by {@link FABLE_EDIT_PHRASE}. */
export const FABLE_REVOKE_PHRASE = "fable edit off";

/** A parent chain longer than this is treated as broken rather than walked forever. */
export const MAX_SPAWN_DEPTH = 32;

/** Owner assumed for a `Repo#N` reference with no owner, matching `/work-issue Repo#123`. */
export const DEFAULT_OWNER = "WebJamApps";

/**
 * The label Josh adds himself when he chooses Fable for an issue (tier-order design, "Fable is kept
 * for work Josh names"). `Opus` and `Sol` name the top coding lane and never authorize Fable.
 */
export const FABLE_TASK_LABEL = "fable";

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

/**
 * Splits a command into its top-level argv tokens, or returns null when the command is anything
 * other than ONE simple invocation: a pipeline, a list (`&&`, `||`, `;`), a redirect, a background
 * job, a command substitution, or a trailing comment all return null. Quoted text is returned with
 * its quotes removed and is never scanned for operators, which is the whole point — an operator
 * inside a quoted script argument is data, and one outside it is a second command.
 */
export function singleSimpleCommandTokens(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      current += command.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let quoted = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\") {
          quoted += command[j + 1] ?? "";
          j += 2;
          continue;
        }
        // An expansion inside double quotes can run anything, so the shape is not readable.
        if (command[j] === "`") return null;
        if (command[j] === "$" && command[j + 1] === "(") return null;
        quoted += command[j];
        j += 1;
      }
      if (j >= command.length) return null;
      current += quoted;
      started = true;
      i = j + 1;
      continue;
    }

    if (ch === "\\") {
      current += command[i + 1] ?? "";
      started = true;
      i += 2;
      continue;
    }

    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      i += 1;
      continue;
    }

    // Any unquoted shell metacharacter means this is not a single simple command.
    if ("&|;<>()`\n".includes(ch)) return null;
    if (ch === "#" && !started) return null;
    if (ch === "$" && command[i + 1] === "(") return null;

    current += ch;
    started = true;
    i += 1;
  }

  if (started) tokens.push(current);
  return tokens.length > 0 ? tokens : null;
}

/** The write and subprocess APIs that make an interpreter's inline script an actual write. */
const WRITE_APIS: Record<"deno" | "node" | "python", RegExp> = {
  deno:
    /\bDeno\.(?:writeTextFile|writeTextFileSync|writeFile|writeFileSync|create|createSync|copyFile|copyFileSync|rename|renameSync|truncate|truncateSync|open|openSync|mkdir|mkdirSync|remove|removeSync|symlink|symlinkSync|Command|run)\b/,
  node:
    /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|cpSync|mkdirSync|rmSync|unlinkSync|execSync|spawnSync|exec|spawn|child_process)\b/,
  python:
    /(?:\bopen\s*\([^)]*['"][wax+][^'"]*['"]|\bwrite_(?:text|bytes)\s*\(|\bshutil\.|\bos\.(?:rename|replace|remove|unlink|mkdir|makedirs|system|popen)\b|\bsubprocess\b)/,
};

/** The inline script argument of a read-only interpreter invocation, with which runtime ran it. */
function inlineScriptOf(
  tokens: string[],
): { runtime: "deno" | "node" | "python"; script: string } | null {
  const [argv0, ...rest] = tokens;
  const program = argv0.slice(argv0.lastIndexOf("/") + 1);

  // `deno eval [flags] <script>`
  if (program === "deno" && rest[0] === "eval") {
    const script = rest.slice(1).find((t) => !t.startsWith("-"));
    return script === undefined ? null : { runtime: "deno", script };
  }

  // `node -e|-p|--eval|--print <script>`
  if (program === "node" || program === "nodejs") {
    const flagAt = rest.findIndex((t) => ["-e", "-p", "--eval", "--print"].includes(t));
    if (flagAt === -1) return null;
    const script = rest[flagAt + 1];
    return script === undefined ? null : { runtime: "node", script };
  }

  // `python[3][.x] -c <script>`
  if (/^python[0-9.]*$/.test(program)) {
    const flagAt = rest.indexOf("-c");
    if (flagAt === -1) return null;
    const script = rest[flagAt + 1];
    return script === undefined ? null : { runtime: "python", script };
  }

  return null;
}

/**
 * True when the command is SOLELY a read-only script evaluation whose quoted text merely contains
 * a write — the 2026-09-17 finding, where a `deno eval` printing a Python heredoc was read as a
 * write to the repository.
 *
 * Both halves are load-bearing, and checking either one alone is the defect this replaces. The
 * command must be one simple invocation, so a real write chained onto a harmless evaluation
 * (`deno eval 'console.log(1)' && echo x > src/a.ts`, or the same write with a trailing
 * `# deno eval` comment) is NOT read-only and stays gated. And the write APIs are matched against
 * the script argument only, under the runtime that actually runs it, so a Python write API inside
 * a string a `deno eval` merely prints does not make that eval a write.
 */
export function isReadOnlyQuotedWrite(command: string): boolean {
  const tokens = singleSimpleCommandTokens(command);
  if (!tokens) return false;

  const inline = inlineScriptOf(tokens);
  if (!inline) return false;

  return !WRITE_APIS[inline.runtime].test(inline.script);
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

  const writes = analyzeBashWrites(command, { cwd, home });
  const targets = [...writes.targets, ...writes.unknownFiles];
  if (targets.length === 0) {
    if (writes.unknownDirectory) {
      return {
        determinable: false,
        note: "The working directory of a Bash write could not be determined.",
      };
    }
    return { determinable: true, targets: [] };
  }
  return {
    determinable: true,
    target: targets[0],
    targets,
    note: writes.unknownFiles.length
      ? "A write whose file cannot be named: run the same command again with its file paths written out."
      : undefined,
  };
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

  if (toolName === "apply_patch") {
    const patchText = typeof toolInput.command === "string" ? toolInput.command : "";
    const paths = parseApplyPatchFilePaths(patchText);
    if (paths.length === 0) {
      return {
        determinable: false,
        note:
          "apply_patch contains no parseable file paths (malformed or unrecognized patch text).",
      };
    }
    return {
      determinable: true,
      target: paths[0],
      targets: paths,
    };
  }

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

/** True for a Fable model id, e.g. `claude-fable-5-2`. */
export function isFableModel(model: string): boolean {
  return /fable/i.test(model);
}

/** The top-tier model a spoken instruction names. */
export type InstructedModel = "opus" | "fable";

/** Where a clause may end, for finding the start of the clause a match sits in. */
const CLAUSE_BREAKS = [".", "!", "?", ",", ";", ":", "\n"];

/** The index where the clause holding `at` begins. */
function clauseStartBefore(text: string, at: number): number {
  return Math.max(...CLAUSE_BREAKS.map((c) => text.lastIndexOf(c, at - 1))) + 1;
}

/**
 * True when the instruction running on from `end` is a question: the punctuation closing its
 * sentence includes "?". A multi-step request is one instruction, so "use Fable and fix it?" is a
 * question; a "?" in a later sentence ("have Fable fix it. is that clear?") does not count. A "." or
 * "?" inside a link is not followed by a space and does not end the sentence.
 */
function sentenceIsQuestion(text: string, end: number): boolean {
  const close = text.slice(end).match(/[.!?]+(?=\s|$)|\n/);
  return !!close && close[0].includes("?");
}

/** A verb that makes a clause an instruction of its own. */
const INSTRUCTION_VERB =
  /\b(?:use|using|have|let|make|get|ask|send|dispatch|give|hand|assign|route|spawn|start|launch|run|create)\b/i;

/**
 * True when a negation governs the instruction verb at `verbStart`: one earlier in the verb's own
 * clause ("I don't want you to stop and then use Fable"), or in an earlier clause of the same
 * sentence that gives no instruction of its own ("do not, under any circumstances, use Fable"). A
 * negated instruction of its own before it ("don't use Sonnet, use Fable") governs only its own verb.
 */
function negationGoverns(text: string, verbStart: number): boolean {
  let start = clauseStartBefore(text, verbStart);
  if (NEGATION.test(text.slice(start, verbStart))) return true;
  while (start > 0 && !".!?\n".includes(text[start - 1])) {
    const end = start - 1;
    start = clauseStartBefore(text, end);
    const clause = text.slice(start, end);
    if (INSTRUCTION_VERB.test(clause)) return false;
    if (NEGATION.test(clause)) return true;
  }
  return false;
}

/** A clause opening that asks, complains or describes rather than instructs. */
const NOT_AN_INSTRUCTION =
  /^(?:why|who|what|when|where|which|how|did|does|should|shall|could|would|can|will|is|are|was|were|has|had|i|you|we|they|it|this|that|there|the|fable|(?:do|have)\s+(?:you|we|i|they|it))\b/i;

/** Affirmations and connectives that may lead an instruction: "yes, please spawn ...". */
const LEADING_AFFIRMATIONS = /^(?:(?:yes|yeah|yep|ok|okay|sure|please|and|then|now|so)\b[\s,]*)+/i;

/** A verb that puts a Fable subagent to work earlier in its clause. */
const SUBAGENT_VERB =
  /\b(?:use|using|with|via|spawn|start|launch|run|create|dispatch|send|give|hand|assign|route|get|have|let|make|ask)\b/i;

/**
 * True when the text asks for a Fable subagent: "dispatch to a Fable subagent", "spawn a Fable
 * subagent", "fix them now using a Fable subagent". The mention's clause must put the subagent to
 * work (a verb such as use, spawn or dispatch before it), carry no negation governing it, not open as
 * a question, complaint or statement ("why did you spawn a Fable subagent", "the Fable subagent broke
 * it"), and its sentence must not end in "?". Anything else fails closed.
 */
export function asksForFableSubagent(text: string): boolean {
  const mention = /\bfable\s+sub-?agents?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = mention.exec(text))) {
    const before = text.slice(clauseStartBefore(text, match.index), match.index);
    const opening = before.trim().replace(LEADING_AFFIRMATIONS, "");
    if (
      SUBAGENT_VERB.test(before) && !negationGoverns(text, match.index) &&
      !NOT_AN_INSTRUCTION.test(opening) &&
      !sentenceIsQuestion(text, match.index + match[0].length)
    ) return true;
  }
  return false;
}

/**
 * Where an instruction may start: the text, a line, or a clause (after punctuation, "please", "and" or
 * "then"). A bare affirmation (yes/yeah/yep/ok/okay/sure) may sit between the start of the text, line
 * or clause and the verb: "yes dispatch the fix to Fable" was refused before, because only "yes," with
 * a comma opened a clause. The affirmation must itself open the text, line or clause, so "you said yes
 * send it to Fable" still refuses.
 */
const CLAUSE_OPENER = String
  .raw`(?:(?:^\s*|[.!?,;:]\s*)(?:(?:yes|yeah|yep|ok|okay|sure)\s+)?|\b(?:please|and|then)\s+)`;

/** "use/have/let/make/get/ask (a|an|the)? <model>" opening a clause. */
function useHaveLetMakeGetAsk(model: InstructedModel): RegExp {
  return new RegExp(
    String.raw`${CLAUSE_OPENER}(?:use|have|let|make|get|ask)\s+(?:(?:a|an|the)\s+)?${model}\b`,
    "gim",
  );
}

/**
 * True when a use/have/let/make/get/ask instruction names the model, no negation governs its verb
 * ("do not, under any circumstances, use Fable"), and it is not a question ("use Fable?").
 */
function putsModelToWork(text: string, model: InstructedModel): boolean {
  const pattern = useHaveLetMakeGetAsk(model);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const verbStart = match.index + match[0].search(/\b(?:use|have|let|make|get|ask)\b/i);
    if (
      !negationGoverns(text, verbStart) &&
      !sentenceIsQuestion(text, match.index + match[0].length)
    ) return true;
  }
  return false;
}

/** "send/dispatch/give/hand/assign/route <object>? to (the|a|an)? <model>"; group 1 is the object. */
function routesTo(model: InstructedModel): RegExp {
  return new RegExp(
    String
      .raw`${CLAUSE_OPENER}(?:send|dispatch|give|hand|assign|route)\s+(?:([^.!?,;:\n]*?)\s+)?to\s+(?:(?:the|a|an)\s+)?${model}\b`,
    "gim",
  );
}

const NEGATION =
  /\b(?:not|no|never|stop|nothing|none|cannot|\w+n['’]t|dont|didnt|doesnt|wont|cant|shouldnt|wouldnt)\b/i;

/**
 * True when a routing verb opening a clause sends work to the model, with no negation governing the
 * verb or in the object ("don't take this and send it to Fable", "send nothing to Fable"), and the
 * instruction not a question: its sentence must not close with "?" ("send it to Fable?", "send it to
 * Fable and rebase?"). A "?" in a later sentence does not count.
 */
function routesWorkTo(text: string, model: InstructedModel): boolean {
  const pattern = routesTo(model);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const verbStart = match.index + match[0].search(/(?:send|dispatch|give|hand|assign|route)\b/i);
    const negated = negationGoverns(text, verbStart) || NEGATION.test(match[1] ?? "");

    if (!negated && !sentenceIsQuestion(text, match.index + match[0].length)) return true;
  }
  return false;
}

/**
 * True when the text instructs the named model to do the work (D-8): "please use FABLE to fix this",
 * "have Fable fix it", "dispatch this to Fable", "send the fix to FABLE". Only an instruction counts:
 * the verb (use/have/let/make/get/ask before the model, or send/dispatch/give/hand/assign/route
 * before "to <model>") must open the text, a line or a clause. A complaint or question ("why did you
 * send this to Fable", "should we send this to Fable", "you shouldn't send it to Fable"), a statement
 * about the model ("Fable should only be used for design") or a bare mention ("the problem with
 * Fable") does not match, so anything that is not plainly a request fails closed — including an
 * instruction reported second-hand ("I asked you earlier to dispatch to Fable"), which has the same
 * shape as a complaint.
 */
export function asksModelToDoTheWork(text: string, model: InstructedModel): boolean {
  return putsModelToWork(text, model) || routesWorkTo(text, model);
}

/** Josh's instruction choosing Fable for the work. */
export function asksFableToDoTheWork(text: string): boolean {
  return asksModelToDoTheWork(text, "fable");
}

/** The grant phrase, or an instruction choosing Fable for the work. */
function choosesFable(text: string): boolean {
  return text.toLowerCase().includes(FABLE_EDIT_PHRASE) || asksFableToDoTheWork(text);
}

/** A spawning prompt that chooses a Fable subagent: the grant phrase, or asking for Fable. */
export function approvesFableSubagent(text: string): boolean {
  return text.toLowerCase().includes(FABLE_EDIT_PHRASE) || asksForFableSubagent(text) ||
    asksFableToDoTheWork(text);
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
  if (typeof meta?.model === "string" && /opus|fable|sonnet|haiku|claude/i.test(meta.model)) {
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
function findSpawningContext(
  files: SessionFiles,
  agentId: string,
  read: ReadText,
): { entries: TranscriptEntry[]; preceding: TranscriptEntry[]; prompt: TranscriptEntry } | null {
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
    if (isHumanPrompt(entries[i])) {
      return { entries, preceding: entries.slice(0, spawnIndex), prompt: entries[i] };
    }
  }
  return null;
}

export function findSpawningHumanPrompt(
  files: SessionFiles,
  agentId: string,
  read: ReadText,
): TranscriptEntry | null {
  return findSpawningContext(files, agentId, read)?.prompt ?? null;
}

/** The slash command a user-turn text invokes — Claude Code's wrapper form or a bare leading `/` — or null. */
export function slashCommandOf(text: string): string | null {
  const trimmed = text.trim();
  const wrapped = slashCommandFromInvocationWrapper(trimmed);
  if (wrapped) return wrapped;
  const bare = trimmed.match(/^[/$](?:[a-zA-Z0-9_-]+:)?([a-zA-Z0-9_-]+)(?=\s|$)/);
  return bare ? bare[1].toLowerCase() : null;
}

/** Arguments from an invocation wrapper or a leading typed skill call. */
function skillArgs(text: string): string {
  const wrapped = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (wrapped) return wrapped[1].trim();
  const bare = text.trim().match(/^[/$](?:[a-zA-Z0-9_-]+:)?[a-zA-Z0-9_-]+(?:\s+([\s\S]*))?$/);
  return bare?.[1]?.trim() ?? "";
}

export function workIssueArgs(text: string): string {
  return slashCommandOf(text) === "work-issue" ? skillArgs(text) : "";
}

interface TypedSkillCall {
  entry: TranscriptEntry;
  command: string;
  args: string;
}

/** Agent/tool text cannot grant approval or replace the most recent skill Josh typed. */
function newestTypedSkillCall(entries: readonly TranscriptEntry[]): TypedSkillCall | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isHumanPrompt(entries[i])) continue;
    const text = extractEntryText(entries[i]);
    const command = slashCommandOf(text);
    if (command) return { entry: entries[i], command, args: skillArgs(text) };
  }
  return null;
}

/**
 * Recognise the fix-pr target forms, without mistaking an issue URL or prose for a PR. `repo` is the
 * `owner/name` (lower case) a link or `Repo#N` names; null for a bare number, whose repository is the
 * one Josh typed the call in.
 */
function activeFixPrCall(entries: readonly TranscriptEntry[]):
  | (TypedSkillCall & {
    instructions: string;
    repo: string | null;
  })
  | null {
  const call = newestTypedSkillCall(entries);
  if (call?.command !== "fix-pr") return null;
  const target = call.args.match(/^\S+/)?.[0] ?? "";
  const ref = target.match(
    /^(?:https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/|(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+)#|#?)([1-9]\d*)$/,
  );
  if (!ref || !Number.isSafeInteger(Number(ref[5]))) return null;
  const repo = ref[1]
    ? `${ref[1]}/${ref[2]}`
    : ref[4]
    ? `${ref[3] ?? DEFAULT_OWNER}/${ref[4]}`
    : null;
  return {
    ...call,
    instructions: call.args.slice(target.length).trim(),
    repo: repo?.toLowerCase() ?? null,
  };
}

function asksForFixPrFableHelper(instructions: string): boolean {
  return /\bfable\s+(?:helpers?|sub-?agents?)\b/i.test(instructions) &&
    asksFableToDoTheWork(instructions);
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
 * D-7, as revision 1.3.0 narrows it: true when the most recent slash command in the transcript is a
 * `/work-issue` Josh typed that names an issue he labeled Fable, or whose own instructions choose
 * Fable for that issue ("/work-issue web-jam-tools#5 use Fable"). An `Opus` or `Sol` label names the
 * top coding lane and never authorizes Fable.
 *
 * Josh's later plain messages do not end the approval; any other slash command does — the same
 * scope-ending rule hooks/lib/check_token_write_authorization.ts applies to the issue-approval token.
 * Local-command echoes (e.g. `/model`, which carry no origin) still count as that other command, so
 * the scope only ever ends early, never extends. A `/work-issue` naming no issue, an issue without the
 * Fable label, or a failed lookup gives no approval.
 */
export function workIssueApprovalActive(
  entries: readonly TranscriptEntry[],
  lookupLabels: LabelLookup,
): boolean {
  return workIssueGrant(entries, lookupLabels) !== null;
}

/** The Fable-labeled issue behind an active {@link workIssueApprovalActive} approval, or null. */
function workIssueGrant(
  entries: readonly TranscriptEntry[],
  lookupLabels: LabelLookup,
): IssueRef | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isUserTurnBoundary(entry) || entry.isMeta === true) continue;
    const text = extractEntryText(entry);
    const command = slashCommandOf(text);
    if (command === null) continue;
    if (command !== "work-issue" || !isHumanPrompt(entry)) return null;
    const args = workIssueArgs(text);
    const ref = parseIssueRef(args);
    if (!ref) return null;
    // A Fable choice typed with the call is Josh's choice for this issue, bound to its repository.
    if (choosesFable(withoutIssueRefs(args))) return ref;
    const labels = lookupLabels(ref);
    return labels !== null && labels.some((label) => label.toLowerCase() === FABLE_TASK_LABEL)
      ? ref
      : null;
  }
  return null;
}

/** Skill arguments with each issue reference replaced by a line break, so what follows opens a line. */
function withoutIssueRefs(args: string): string {
  return args
    .replace(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+/g, "\n")
    .replace(/(?:^|\s)(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+#\d+\b/g, "\n");
}

/**
 * Whether Josh's choice of Fable for edits is active, scoped to the SESSION rather than to the one
 * turn he typed it in: once he has said so, that answer holds until he withdraws it with
 * "fable edit off", so a correction or a "try again" does not silently withdraw it.
 *
 * Walks human turns newest-first and returns on the first decisive one, so a later revocation beats
 * an earlier approval. Only prompts Josh actually sent count (`isHumanPrompt`, not `isMeta`), so a
 * task notification or an injected reminder can neither grant approval nor cancel it. An Opus grant
 * ("opus edit ok", or asking Opus to do the work) is not a choice of Fable and counts for nothing.
 * Only a separate message grants the session: a Fable choice typed inside a skill call belongs to
 * that task ({@link workIssueGrant}), though a "fable edit off" typed there still withdraws.
 */
export function fableEditApprovalActive(entries: readonly TranscriptEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isUserTurnBoundary(entry) || entry.isMeta === true) continue;
    if (!isHumanPrompt(entry)) continue;
    const text = extractEntryText(entry).toLowerCase();
    const command = slashCommandOf(text);
    // A fix-pr helper request is scoped to that call, never a permanent session grant.
    if (command === "fix-pr") continue;
    if (text.includes(FABLE_REVOKE_PHRASE)) return false;
    if (command !== null) continue;
    if (choosesFable(text)) return true;
  }
  return false;
}

/**
 * The transcript after Josh's newest "fable edit off": a typed task grant counts only when he typed
 * it after withdrawing, so the withdrawal ends the task's choice of Fable until he chooses it again.
 * A `/fix-pr` line is skipped, as in {@link fableEditApprovalActive}.
 */
function sinceFableWithdrawal(entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isHumanPrompt(entries[i])) continue;
    const text = extractEntryText(entries[i]).toLowerCase();
    if (slashCommandOf(text) === "fix-pr") continue;
    if (text.includes(FABLE_REVOKE_PHRASE)) return entries.slice(i + 1);
  }
  return entries;
}

/**
 * Where a path sits: outside any git working tree (`inTree` false), or inside one whose GitHub
 * origin is `repo` (`owner/name`, lower case; null when the origin cannot be read).
 */
export interface PathRepo {
  inTree: boolean;
  repo: string | null;
}

/** Finds the repository an absolute path belongs to. */
export type RepoLookup = (path: string) => PathRepo;

/** `owner/name` in lower case from a GitHub remote URL, or null for any other URL. */
export function parseGitHubRepo(url: string): string | null {
  const match = url.trim().match(
    /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
  );
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function gitOutput(dir: string, args: string[]): string | null {
  try {
    const output = new Deno.Command("timeout", {
      args: ["10", "git", "-C", dir, ...args],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    return output.success ? new TextDecoder().decode(output.stdout).trim() : null;
  } catch {
    return null;
  }
}

/**
 * The path a write to `path` actually lands on. Each existing component is resolved through its
 * symlinks in turn, so a link is followed before a later "..", the same way
 * hooks/lib/check_private_folder_read.ts resolves a destination; a missing remainder is kept as
 * written. Null when the destination cannot be verified: a relative path, a dangling symlink (the
 * write would create whatever it points at), or a component that cannot be read.
 */
export function writeDestination(path: string): string | null {
  if (!path.startsWith("/")) return null;
  let current = "/";
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = current.slice(0, current.lastIndexOf("/")) || "/";
      continue;
    }
    const candidate = current === "/" ? `/${part}` : `${current}/${part}`;
    try {
      current = Deno.realPathSync(candidate);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) return null;
      try {
        Deno.lstatSync(candidate);
        return null;
      } catch (statErr) {
        if (!(statErr instanceof Deno.errors.NotFound)) return null;
      }
      current = candidate;
    }
  }
  return current;
}

/**
 * The live lookup: asks git about the nearest existing directory of the write's real destination
 * ({@link writeDestination}), so a symlink is judged by where it points and a file about to be
 * created by the folder it will land in. A destination that cannot be verified is reported as a
 * working tree with no known origin, which no task grant covers.
 */
export function gitRepoOfPath(path: string): PathRepo {
  const destination = writeDestination(path);
  if (destination === null) return { inTree: true, repo: null };
  let dir = destination;
  for (;;) {
    try {
      if (Deno.statSync(dir).isDirectory) break;
    } catch {
      // Missing: try its parent.
    }
    const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
    if (parent === dir) break;
    dir = parent;
  }
  if (gitOutput(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return { inTree: false, repo: null };
  }
  const url = gitOutput(dir, ["remote", "get-url", "origin"]);
  return { inTree: true, repo: url === null ? null : parseGitHubRepo(url) };
}

/**
 * True when every written path inside a git working tree belongs to `repo`. A path outside any
 * working tree (a comment file under /tmp) is not a repository edit; a working tree whose origin
 * cannot be read is not known to be `repo`, so it fails closed.
 */
function writesStayIn(repo: string, targets: readonly string[], repoOf: RepoLookup): boolean {
  return targets.every((target) => {
    const where = repoOf(target);
    return !where.inTree || where.repo === repo;
  });
}

/**
 * The repositories of the task grants Josh typed and has not since withdrawn: the Fable-labeled
 * issue a `/work-issue` names, and the pull request an active `/fix-pr` names. A bare-number
 * `/fix-pr` names the repository of the folder Josh typed it in; when that cannot be read, the call
 * grants nothing.
 */
function taskGrantRepos(
  entries: readonly TranscriptEntry[],
  lookupLabels: LabelLookup,
  repoOf: RepoLookup,
): string[] {
  const live = sinceFableWithdrawal(entries);
  const repos: string[] = [];
  const issue = workIssueGrant(live, lookupLabels);
  if (issue) repos.push(issue.repo.toLowerCase());
  const fixPr = activeFixPrCall(live);
  const fixPrRepo = fixPr ? fixPrCallRepo(fixPr, repoOf) : null;
  if (fixPrRepo) repos.push(fixPrRepo);
  return repos;
}

/** The repository a `/fix-pr` call names, or, for a bare number, the one Josh typed it in. */
function fixPrCallRepo(
  call: { entry: TranscriptEntry; repo: string | null },
  repoOf: RepoLookup,
): string | null {
  const cwd = call.entry.cwd;
  return call.repo ?? (typeof cwd === "string" && cwd ? repoOf(cwd).repo : null);
}

/**
 * `targets` are the absolute paths the call writes, and `repoOf` finds each one's repository: a
 * typed task grant covers only edits in the repository of the issue or pull request Josh named.
 */
export function decideMainThreadEdit(
  transcriptPath: string,
  read: ReadText,
  lookupLabels: LabelLookup,
  targets: readonly string[] = [],
  repoOf: RepoLookup = gitRepoOfPath,
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
  // Revision 1.3.0: Opus, and every model other than Fable, edits directly with no grant.
  if (!isFableModel(info.model)) return allow("main");
  if (fableEditApprovalActive(entries)) return allow("main");
  const repos = taskGrantRepos(entries, lookupLabels, repoOf);
  if (repos.some((repo) => writesStayIn(repo, targets, repoOf))) return allow("main");
  return deny(
    "main",
    repos.length === 0
      ? ""
      : `The task Josh chose Fable for is in ${
        repos.join(" and ")
      }; this edit writes outside that repository.`,
  );
}

/**
 * `targets` and `repoOf` bind a typed `/fix-pr` call's Fable helper to that pull request's
 * repository, as for the main thread.
 */
export function decideSubagentEdit(
  agentId: string,
  transcriptPath: string,
  read: ReadText,
  targets: readonly string[] = [],
  repoOf: RepoLookup = gitRepoOfPath,
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
  // An Opus coding helper, like any helper not on Fable, edits directly; launch limits belong to the
  // subagent cap (web-jam-tools#708).
  if (!isFableModel(model)) return allow("subagent");
  const context = findSpawningContext(files, agentId, read);
  if (!context) {
    return allow(
      "subagent",
      "The message Josh typed that spawned this Fable subagent could not be found.",
    );
  }
  const spawningCall = newestTypedSkillCall(context.preceding);
  if (spawningCall?.command === "fix-pr") {
    const activeCall = activeFixPrCall(sinceFableWithdrawal(context.entries));
    if (
      activeCall?.entry !== spawningCall.entry ||
      !asksForFixPrFableHelper(activeCall.instructions)
    ) {
      return deny(
        "subagent",
        "The active typed fix-pr call does not ask for this Fable helper, or Josh has since said fable edit off.",
      );
    }
    const repo = fixPrCallRepo(activeCall, repoOf);
    if (repo && writesStayIn(repo, targets, repoOf)) return allow("subagent");
    return deny(
      "subagent",
      `This Fable helper works on a pull request in ${
        repo ?? "a repository that could not be read"
      }; this edit writes outside it.`,
    );
  }
  if (!approvesFableSubagent(extractEntryText(context.prompt))) {
    return deny(
      "subagent",
      'This is a Fable subagent, and the message that spawned it neither contains "fable edit ok", ' +
        "asks for a Fable subagent, nor asks Fable to do the work.",
    );
  }
  // A withdrawal Josh sends after the spawning message ends this helper's choice of Fable too.
  if (!sinceFableWithdrawal(context.entries).includes(context.prompt)) {
    return deny(
      "subagent",
      "Josh said fable edit off after the message that spawned this Fable subagent.",
    );
  }
  return allow("subagent");
}

export function decide(
  payload: GatePayload,
  read: ReadText = readTextOrNull,
  lookupLabels: LabelLookup = defaultLabelLookup(),
  switchChecker: (guardName: string) => SwitchCheckResult = (guard) =>
    checkAndConsumeWorkflowSwitch(guard),
  repoOf: RepoLookup = gitRepoOfPath,
): GateDecision {
  try {
    const targetCheck = checkWriteTarget(payload);
    const agentId = typeof payload.agent_id === "string" ? payload.agent_id : "";
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
    if (!targetCheck.determinable) {
      if (toolName === "apply_patch") {
        const switchResult = switchChecker("opus-delegation-gate");
        if (switchResult.released) {
          return allow(agentId ? "subagent" : "main", switchResult.reason);
        }
        return deny(
          agentId ? "subagent" : "main",
          targetCheck.note ??
            "apply_patch contains no parseable file paths (malformed or unrecognized patch text).",
        );
      }
      return allow(
        agentId ? "subagent" : "main",
        targetCheck.note ?? "Write target could not be determined.",
      );
    }

    const transcriptPath = typeof payload.transcript_path === "string"
      ? payload.transcript_path
      : "";
    const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
    const targets = (targetCheck.targets ?? (targetCheck.target ? [targetCheck.target] : []))
      .map((target) => target.startsWith("/") || !cwd ? target : `${cwd}/${target}`);
    let decision: GateDecision;
    if (agentId && payload.permission_mode === "auto") {
      decision = decideSubagentEdit(agentId, transcriptPath, read, targets, repoOf);
    } else if (agentId) {
      // A subagent call outside auto mode keeps its exemption. The shell hook exits before calling this
      // module in that case; the branch keeps decide() total.
      return allow("subagent");
    } else {
      decision = decideMainThreadEdit(transcriptPath, read, lookupLabels, targets, repoOf);
    }

    if (decision.decision === "deny") {
      const switchResult = switchChecker("opus-delegation-gate");
      if (switchResult.released) {
        return allow(decision.kind, switchResult.reason);
      }
      if (targetCheck.note) return deny(decision.kind, targetCheck.note);
    }
    return decision;
  } catch (err) {
    return allow(
      "main",
      `The gate's checker threw an error (${
        err instanceof Error ? err.message : String(err)
      }), so proceeding by workflow default.`,
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
      `The gate's checker threw an error (${
        err instanceof Error ? err.message : String(err)
      }), so proceeding by workflow default.`,
    );
  }
  console.log(JSON.stringify(result));
}
