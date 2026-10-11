/**
 * check_agy_skill_run.ts — logic for hooks/agy-skill-run-hook.sh (web-jam-tools#1319).
 *
 * Implements the agy PreToolUse hook logic:
 * 1. Checks if the tool call is `run_command`. If not, allows without rewrite.
 * 2. Checks if the command contains the installed script path (`.claude/hooks/agy-skill-run.sh`).
 *    If so, denies the command (whether a skill run is open or not).
 * 3. Determines whether a skill run is open from the conversation record (`transcriptPath`),
 *    following helper agent links up to 3 steps up if needed.
 * 4. If a skill run is open, rewrites the command to invoke the installed script with the
 *    original command single-quoted (with internal single quotes escaped as `'\''`).
 * 5. Fails open (allows without rewrite) if the record cannot be read, parsed, or decided.
 */

import { basename, dirname, join } from "node:path";

export const INSTALLED_SCRIPT_PATH = "/home/joshua/.claude/hooks/agy-skill-run.sh";
export const SCRIPT_DENY_TARGET = ".claude/hooks/agy-skill-run.sh";

export function getDefaultPluginSkillsDir(): string {
  return (
    Deno.env.get("AGY_PLUGIN_SKILLS_DIR") ??
      `${Deno.env.get("HOME") ?? "/home/joshua"}/.gemini/config/plugins/webjam-tasks/skills`
  );
}

export function getDefaultUserSkillsDir(): string {
  return (
    Deno.env.get("AGY_USER_SKILLS_DIR") ??
      `${Deno.env.get("HOME") ?? "/home/joshua"}/.gemini/skills`
  );
}

export const DEFAULT_PLUGIN_SKILLS_DIR = getDefaultPluginSkillsDir();
export const DEFAULT_USER_SKILLS_DIR = getDefaultUserSkillsDir();

/**
 * Rewrites a shell command to be executed via the installed agy-skill-run script.
 * Escapes internal single quotes as `'\''`.
 */
export function rewriteCommand(command: string): string {
  const escaped = command.replaceAll("'", "'\\''");
  return `${INSTALLED_SCRIPT_PATH} '${escaped}'`;
}

/**
 * Checks whether the command text contains the script's installed path.
 */
export function containsInstalledScriptPath(command: string): boolean {
  return command.includes(SCRIPT_DENY_TARGET);
}

/**
 * Scans directories for installed skills that contain a SKILL.md file.
 */
export function getInstalledSkills(
  pluginDir = getDefaultPluginSkillsDir(),
  userDir = getDefaultUserSkillsDir(),
): { pluginSkills: Set<string>; userSkills: Set<string> } {
  const pluginSkills = new Set<string>();
  const userSkills = new Set<string>();

  const scanDir = (dir: string, targetSet: Set<string>) => {
    try {
      for (const entry of Deno.readDirSync(dir)) {
        if (entry.isDirectory || entry.isSymlink) {
          const skillMdPath = join(dir, entry.name, "SKILL.md");
          try {
            const stat = Deno.statSync(skillMdPath);
            if (stat.isFile) {
              targetSet.add(entry.name);
            }
          } catch {
            // SKILL.md missing or unreadable
          }
        }
      }
    } catch {
      // directory missing or unreadable
    }
  };

  scanDir(pluginDir, pluginSkills);
  scanDir(userDir, userSkills);

  return { pluginSkills, userSkills };
}

export interface MessageEvaluation {
  isSlashCommand: boolean;
  isInstalledSkill: boolean;
}

/**
 * Evaluates a single message typed by the user.
 * - Opens with `/` and not containing `/` in command token -> slash command.
 * - If slash command names an installed skill -> isInstalledSkill: true.
 * - Plain message or path starting with `/` -> not a slash command.
 */
export function evaluateMessage(
  text: string,
  pluginSkills: Set<string>,
  userSkills: Set<string>,
): MessageEvaluation {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) {
    return { isSlashCommand: false, isInstalledSkill: false };
  }

  const match = trimmed.match(/^\/([^\s]+)/);
  if (!match) {
    return { isSlashCommand: false, isInstalledSkill: false };
  }

  const token = match[1];

  // A message that begins with a file path (e.g. /home/joshua/Pictures/shot.png) is NOT a slash command.
  if (token.includes("/")) {
    return { isSlashCommand: false, isInstalledSkill: false };
  }

  if (token.includes(":")) {
    const parts = token.split(":");
    if (parts.length !== 2) {
      return { isSlashCommand: true, isInstalledSkill: false };
    }
    const [pluginPrefix, skillName] = parts;
    if (pluginPrefix !== "webjam-tasks") {
      return { isSlashCommand: true, isInstalledSkill: false };
    }
    return {
      isSlashCommand: true,
      isInstalledSkill: pluginSkills.has(skillName),
    };
  }

  return {
    isSlashCommand: true,
    isInstalledSkill: pluginSkills.has(token) || userSkills.has(token),
  };
}

export interface TranscriptReadResult {
  canRead: boolean;
  validJson: boolean;
  rawText: string;
  userMessages: string[];
  entries: Record<string, unknown>[];
}

/**
 * Reads a transcript file and extracts messages typed by Josh and structured entries.
 * Returns canRead: false on missing/unreadable file, validJson: false on syntax error.
 */
export function readTranscript(transcriptPath: string): TranscriptReadResult {
  let rawText: string;
  try {
    rawText = Deno.readTextFileSync(transcriptPath);
  } catch {
    return { canRead: false, validJson: false, rawText: "", userMessages: [], entries: [] };
  }

  const lines = rawText.split("\n");
  const userMessages: string[] = [];
  const entries: Record<string, unknown>[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
      entries.push(parsed);
    } catch {
      return { canRead: true, validJson: false, rawText, userMessages: [], entries: [] };
    }

    if (
      parsed.type === "USER_INPUT" ||
      parsed.source === "USER_EXPLICIT" ||
      parsed.role === "user" ||
      parsed.type === "user"
    ) {
      let content = "";
      if (typeof parsed.content === "string") {
        content = parsed.content;
      } else if (typeof parsed.text === "string") {
        content = parsed.text;
      } else if (typeof parsed.message === "string") {
        content = parsed.message;
      } else if (Array.isArray(parsed.content)) {
        for (const part of parsed.content) {
          if (typeof part === "string") {
            content += part;
          } else if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof (part as { text: unknown }).text === "string"
          ) {
            content += (part as { text: string }).text;
          }
        }
      }

      const reqMatch = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
      if (reqMatch) {
        userMessages.push(reqMatch[1]);
      } else {
        userMessages.push(content);
      }
    }
  }

  return { canRead: true, validJson: true, rawText, userMessages, entries };
}

/**
 * Processes user messages sequentially to determine if a skill run is open at the end.
 */
export function evaluateUserMessages(
  userMessages: string[],
  pluginSkills: Set<string>,
  userSkills: Set<string>,
): boolean {
  let skillRunOpen = false;

  for (const msg of userMessages) {
    const evalResult = evaluateMessage(msg, pluginSkills, userSkills);
    if (evalResult.isSlashCommand) {
      skillRunOpen = evalResult.isInstalledSkill;
    }
    // Plain messages leave the state unchanged.
  }

  return skillRunOpen;
}

/**
 * Returns the messages directory for a transcript path.
 */
export function getMessagesDir(transcriptPath: string): string {
  const dir = dirname(transcriptPath);
  if (basename(dir) === "logs") {
    return join(dirname(dir), "messages");
  }
  return join(dir, "messages");
}

export function getConversationIdFromTranscriptPath(transcriptPath: string): string | undefined {
  const parts = transcriptPath.split("/");
  const brainIdx = parts.lastIndexOf("brain");
  if (brainIdx !== -1 && brainIdx + 1 < parts.length) {
    return parts[brainIdx + 1];
  }
  const sysIdx = parts.lastIndexOf(".system_generated");
  if (sysIdx > 0) {
    return parts[sysIdx - 1];
  }
  return undefined;
}

/**
 * Validates whether a parsed message JSON is an authentic helper-creation message
 * directed to the specified conversationId.
 */
export function isHelperCreationMessage(
  parsed: unknown,
  conversationId?: string,
): { valid: boolean; parentId?: string } {
  if (!parsed || typeof parsed !== "object") {
    return { valid: false };
  }
  const obj = parsed as {
    recipient?: unknown;
    sender?: unknown;
    sourceMetadata?: {
      tool?: {
        conversationId?: unknown;
        toolCall?: { name?: unknown };
      };
    };
  };

  // Recipient must be a non-empty string. Missing or non-string recipients are refused.
  if (typeof obj.recipient !== "string" || !obj.recipient) {
    return { valid: false };
  }

  // Must be targeted to this conversation if conversationId is specified
  if (conversationId && obj.recipient !== conversationId) {
    return { valid: false };
  }

  // Must be an invoke_subagent creation message
  const toolName = obj.sourceMetadata?.tool?.toolCall?.name;
  if (toolName !== "invoke_subagent") {
    return { valid: false };
  }

  const toolConvId = obj.sourceMetadata?.tool?.conversationId;
  const sender = obj.sender;

  let resolvedParentId: string | undefined;
  if (typeof toolConvId === "string" && toolConvId) {
    resolvedParentId = toolConvId;
  }

  if (typeof sender === "string" && sender && sender !== "system") {
    const senderId = sender.split("/")[0];
    if (resolvedParentId && senderId !== resolvedParentId) {
      // Sender and tool.conversationId contradict each other
      return { valid: false };
    }
    if (!resolvedParentId) {
      resolvedParentId = senderId;
    }
  }

  if (!resolvedParentId || (conversationId && resolvedParentId === conversationId)) {
    return { valid: false };
  }

  return { valid: true, parentId: resolvedParentId };
}

/**
 * Looks for the parent conversation in the messages directory.
 * Requires a verified helper-creation message (invoke_subagent) addressed to this helper.
 * If multiple conflicting parent IDs are found (competing senders), refuses by returning null.
 */
export function findParentConversation(
  transcriptPath: string,
  conversationId?: string,
): { parentId: string } | null {
  if (!conversationId) {
    return null;
  }
  const messagesDir = getMessagesDir(transcriptPath);
  try {
    const parentIds = new Set<string>();

    for (const entry of Deno.readDirSync(messagesDir)) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        const msgPath = join(messagesDir, entry.name);
        try {
          const content = Deno.readTextFileSync(msgPath);
          const parsed = JSON.parse(content);
          const check = isHelperCreationMessage(parsed, conversationId);
          if (check.valid && check.parentId) {
            parentIds.add(check.parentId);
          }
        } catch {
          // ignore unparseable message file
        }
      }
    }

    if (parentIds.size === 0) {
      return null;
    }

    // Competing senders claiming different parent IDs -> ambiguous / refuse
    if (parentIds.size > 1) {
      return null;
    }

    const [parentId] = parentIds;
    return { parentId };
  } catch {
    // messagesDir does not exist or is unreadable
    return null;
  }
}

/**
 * Resolves the parent conversation transcript path from the current transcript path and parentId.
 */
export function resolveTranscriptPath(currentTranscriptPath: string, parentId: string): string {
  const parts = currentTranscriptPath.split("/");
  const brainIdx = parts.lastIndexOf("brain");
  if (brainIdx !== -1 && brainIdx + 1 < parts.length) {
    const newParts = [...parts];
    newParts[brainIdx + 1] = parentId;
    return newParts.join("/");
  }

  if (currentTranscriptPath.includes(".system_generated")) {
    const beforeSys = currentTranscriptPath.substring(
      0,
      currentTranscriptPath.indexOf("/.system_generated"),
    );
    const baseDir = dirname(beforeSys);
    return join(baseDir, parentId, ".system_generated", "logs", "transcript.jsonl");
  }

  const baseDir = dirname(dirname(currentTranscriptPath));
  return join(baseDir, parentId, basename(currentTranscriptPath));
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractJsonBlocks(str: string): unknown[] {
  const results: unknown[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (str[i] === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          try {
            results.push(JSON.parse(str.slice(start, i + 1)));
          } catch {
            // ignore non-json block
          }
          start = -1;
        }
      }
    }
  }
  return results;
}

/**
 * Validates whether a parent transcript entry is an authentic helper-creation result
 * confirming the launch of childId, rather than an incidental prose mention or unrelated JSON/status response.
 */
export function isHelperCreationResult(
  entry: Record<string, unknown>,
  childId: string,
): boolean {
  if (!entry || typeof entry !== "object" || !childId) {
    return false;
  }
  // Must be an authentic tool result entry (never user input or assistant planner response)
  if (entry.type !== "GENERIC" && entry.type !== "TOOL_RESPONSE") {
    return false;
  }
  if (
    entry.source === "USER_EXPLICIT" ||
    entry.role === "user" ||
    entry.role === "assistant"
  ) {
    return false;
  }

  const content = typeof entry.content === "string" ? entry.content : "";
  if (!content.includes(childId)) {
    return false;
  }

  // Must match the recognized subagent creation header format (e.g. "Created the following subagents:" or "Created subagents:")
  const subagentHeaderRegex = /created\s+(the\s+following\s+)?subagents?:?/i;
  if (!subagentHeaderRegex.test(content)) {
    return false;
  }

  // Fast pre-check for conversationId declaration
  const conversationIdRegex = new RegExp(
    `["']?conversationId["']?\\s*:\\s*["']${escapeRegex(childId)}["']`,
  );
  if (!conversationIdRegex.test(content)) {
    return false;
  }

  // Must parse a JSON object that declares conversationId matching childId
  const blocks = extractJsonBlocks(content);
  for (const block of blocks) {
    if (block && typeof block === "object") {
      const record = block as Record<string, unknown>;
      if (record.conversationId === childId) {
        return true;
      }
    }
  }

  return false;
}

export type SkillRunCheckResult =
  | { outcome: "open" }
  | { outcome: "not_open" }
  | { outcome: "cannot_tell" };

/**
 * Decides whether a skill run is open, following helper agent links up to 3 steps up.
 */
export function isSkillRunOpen(
  transcriptPath: string | undefined,
  conversationId: string | undefined,
  pluginSkills: Set<string>,
  userSkills: Set<string>,
): SkillRunCheckResult {
  if (!transcriptPath || typeof transcriptPath !== "string") {
    return { outcome: "cannot_tell" };
  }

  let currentTranscript = transcriptPath;
  let currentId = conversationId ?? getConversationIdFromTranscriptPath(transcriptPath) ?? "";
  let stepsUp = 0;
  const MAX_STEPS_UP = 3;

  while (stepsUp <= MAX_STEPS_UP) {
    const transcriptData = readTranscript(currentTranscript);
    if (!transcriptData.canRead || !transcriptData.validJson) {
      return { outcome: "cannot_tell" };
    }

    if (transcriptData.userMessages.length > 0) {
      const isOpen = evaluateUserMessages(transcriptData.userMessages, pluginSkills, userSkills);
      return { outcome: isOpen ? "open" : "not_open" };
    }

    // Current transcript holds nothing Josh typed.
    if (stepsUp >= MAX_STEPS_UP) {
      // Reached 3 steps up and still no user messages -> requires a 4th step, so not open.
      return { outcome: "not_open" };
    }

    const parentInfo = findParentConversation(currentTranscript, currentId);
    if (!parentInfo) {
      // Holds nothing Josh typed and has no verified helper creation message.
      return { outcome: "not_open" };
    }

    const parentTranscriptPath = resolveTranscriptPath(currentTranscript, parentInfo.parentId);
    const parentTranscriptData = readTranscript(parentTranscriptPath);
    if (!parentTranscriptData.canRead || !parentTranscriptData.validJson) {
      return { outcome: "cannot_tell" };
    }

    // That conversation's record must list the child helper in an authentic creation result.
    const hasCreationResult = parentTranscriptData.entries.some((entry) =>
      isHelperCreationResult(entry, currentId)
    );
    if (!hasCreationResult) {
      return { outcome: "not_open" };
    }

    currentId = parentInfo.parentId;
    currentTranscript = parentTranscriptPath;
    stepsUp++;
  }

  return { outcome: "not_open" };
}

export interface HookResult {
  decision: "allow" | "deny";
  reason?: string;
  overwrite?: {
    CommandLine: string;
  };
}

/**
 * Top-level PreToolUse handler.
 */
export function handlePreToolUse(
  payload: unknown,
  pluginSkills?: Set<string>,
  userSkills?: Set<string>,
): HookResult {
  try {
    const p = payload as {
      toolCall?: { name?: unknown; args?: { CommandLine?: unknown } };
      transcriptPath?: unknown;
      conversationId?: unknown;
    } | null;

    const toolName = p?.toolCall?.name;
    if (toolName !== "run_command") {
      return { decision: "allow" };
    }

    const command = p?.toolCall?.args?.CommandLine;
    if (typeof command !== "string") {
      return { decision: "allow" };
    }

    if (containsInstalledScriptPath(command)) {
      return {
        decision: "deny",
        reason: "Terminal commands containing the installed skill-run script path are denied.",
      };
    }

    if (!pluginSkills || !userSkills) {
      const installed = getInstalledSkills();
      pluginSkills = pluginSkills ?? installed.pluginSkills;
      userSkills = userSkills ?? installed.userSkills;
    }

    const transcriptPath = typeof p?.transcriptPath === "string" ? p.transcriptPath : undefined;
    const conversationId = typeof p?.conversationId === "string" ? p.conversationId : undefined;
    const checkResult = isSkillRunOpen(transcriptPath, conversationId, pluginSkills, userSkills);

    if (checkResult.outcome === "open") {
      return {
        decision: "allow",
        overwrite: {
          CommandLine: rewriteCommand(command),
        },
      };
    }

    return { decision: "allow" };
  } catch {
    return { decision: "allow" };
  }
}

if (import.meta.main) {
  let raw = "";
  try {
    const decoder = new TextDecoder();
    const buf = new Uint8Array(65536);
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      raw += decoder.decode(buf.subarray(0, n), { stream: true });
    }
    raw += decoder.decode();
  } catch {
    console.log(JSON.stringify({ decision: "allow" }));
    Deno.exit(0);
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({ decision: "allow" }));
    Deno.exit(0);
  }

  const result = handlePreToolUse(payload);
  console.log(JSON.stringify(result));
  Deno.exit(0);
}
