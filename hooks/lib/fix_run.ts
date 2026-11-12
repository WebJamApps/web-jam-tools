import {
  type CodexSkillCall,
  codexSkillCall,
  readCodexTypedSession,
} from "./codex_session_reader.ts";
import {
  slashCommandFromInvocationWrapper,
  stripUserRequestWrapper,
} from "./check_token_write_authorization.ts";
import {
  extractEntryText,
  isAntigravityEntry,
  isHumanPrompt,
  isOwnSessionUserTurnBoundary,
} from "./select_transcript_entry.ts";
import {
  resolveAntigravityWriteContext,
  resolveClaudeCodeWriteContext,
  type ResolvedWriteContext,
} from "../../scripts/write_issue_approval_token.ts";

export type SessionEnv = (name: string) => string | undefined;

/** Read only human calls in this conversation; plain replies preserve the newest skill. */
export function latestTypedSkillCall(context: ResolvedWriteContext): CodexSkillCall | null {
  if (context.isSubagentInvocation || !context.ownConversationId) return null;
  for (let i = context.entries.length - 1; i >= 0; i--) {
    const entry = context.entries[i];
    const human = isAntigravityEntry(entry)
      ? isOwnSessionUserTurnBoundary(entry, context.ownConversationId)
      : isHumanPrompt(entry);
    if (!human || entry.isMeta === true) continue;
    const content = isAntigravityEntry(entry) ? entry.content : entry.message?.content;
    if (
      typeof content !== "string" &&
      (!Array.isArray(content) || content.some((block) =>
        !block || typeof block !== "object" ||
        (block.type !== "image" && (block.type !== "text" || typeof block.text !== "string"))
      ))
    ) return null;
    const text = stripUserRequestWrapper(extractEntryText(entry));
    const wrapped = slashCommandFromInvocationWrapper(text);
    const dated = (call: CodexSkillCall): CodexSkillCall =>
      typeof entry.timestamp === "string" ? { ...call, timestamp: entry.timestamp } : call;
    if (wrapped) {
      const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
      return dated({ name: wrapped, arguments: args?.[1].trim() ?? "", text });
    }
    const call = codexSkillCall(text);
    if (call) return dated(call);
  }
  return null;
}

/** Use each tool's existing discovery, refusing damaged records and agent-started sessions. */
export async function readTypedSkillCall(
  env: SessionEnv = (name) => Deno.env.get(name),
): Promise<CodexSkillCall | null> {
  try {
    if (env("WJT_UNATTENDED") === "1") return null;
    const codexId = env("CODEX_THREAD_ID");
    const claudeId = env("CLAUDE_CODE_SESSION_ID");
    if (codexId && claudeId) return null;
    if (codexId) return (await readCodexTypedSession({ env })).latestSkillCall;
    const surface = env("WJT_SURFACE");
    if (surface === "codex" || (surface === "claude" && !claudeId)) return null;
    const context = claudeId
      ? await resolveClaudeCodeWriteContext(claudeId, true)
      : await resolveAntigravityWriteContext(true);
    return context ? latestTypedSkillCall(context) : null;
  } catch {
    return null;
  }
}

export interface PullRequestRef {
  repo: string;
  number: number;
}

/** The first argument names the PR; the rest of the call may ask for checks or a helper. */
export function parseFixPrReference(args: string, checkoutRepo: string): PullRequestRef | null {
  const first = args.trim().split(/\s+/)[0];
  const url = first.match(
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/i,
  );
  const named = first.match(/^(?:([\w.-]+)\/)?([\w.-]+)#([1-9]\d*)$/);
  const bare = first.match(/^([1-9]\d*)$/);
  const repo = url?.[1] ?? (named ? `${named[1] ?? "WebJamApps"}/${named[2]}` : checkoutRepo);
  const number = Number(url?.[2] ?? named?.[3] ?? bare?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? { repo, number } : null;
}

/** GitHub HTTPS and SSH remotes, with no credentials or alternative host accepted. */
export function githubRepository(remote: string): string | null {
  const match = remote.trim().match(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i,
  );
  return match?.[1] ?? null;
}

export interface PullRequestState {
  number: number;
  state: string;
  headRefName: string;
  headRepository: { nameWithOwner: string } | null;
  isCrossRepository: boolean;
}

export type FixRun =
  | { kind: "none" }
  | { kind: "refused"; reason: string }
  | { kind: "active"; pullRequest: PullRequestRef };

/** Bind the latest typed call to this open PR's repository and exact head branch. */
export function checkFixRun(
  call: CodexSkillCall | null,
  checkoutRepo: string,
  branch: string,
  pr: PullRequestState | null,
): FixRun {
  if (call?.name.split(":").at(-1) !== "fix-pr") return { kind: "none" };
  const ref = parseFixPrReference(call.arguments, checkoutRepo);
  if (!ref) return { kind: "refused", reason: "the typed fix-pr call names no pull request" };
  if (ref.repo.toLowerCase() !== checkoutRepo.toLowerCase()) {
    return { kind: "refused", reason: "the typed fix-pr call names another repository" };
  }
  if (!pr) return { kind: "none" };
  if (
    pr.number !== ref.number || pr.state !== "OPEN" || pr.headRefName !== branch ||
    pr.isCrossRepository !== false ||
    pr.headRepository?.nameWithOwner?.toLowerCase() !== checkoutRepo.toLowerCase()
  ) {
    return { kind: "refused", reason: "the typed fix-pr call does not name this open PR branch" };
  }
  return { kind: "active", pullRequest: ref };
}
