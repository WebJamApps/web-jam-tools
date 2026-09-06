/**
 * agy-hook-shim — the translation shim (web-jam-tools#432).
 *
 * Antigravity (agy/Flash) speaks a different PreToolUse/PostToolUse hook
 * protocol than Claude Code, and neither Claude veto mechanism (`exit 2`,
 * `hookSpecificOutput.permissionDecision`) is honoured there — so every hook
 * registered directly into `~/.gemini/config/hooks.json` fires but is a
 * no-op (measured 2026-08-07, see the issue for the full write-up). Rather
 * than teach all twelve existing hooks to speak both protocols, this single
 * shim sits in front of an UNMODIFIED hook and does the translation:
 *
 *   1. normalize agy's camelCase payload into the Claude shape the hook
 *      already parses (`toolCall.name` -> `tool_name`, `toolCall.args` ->
 *      `tool_input`, `transcriptPath` -> `transcript_path`, and known agy
 *      tool/arg names -> their Claude equivalents),
 *   2. enforce the `matcher` itself (agy ignores that field entirely), and
 *      skip running the underlying hook at all when it doesn't match,
 *   3. run the existing hook, unmodified, feeding it the normalized JSON,
 *   4. convert its verdict (`exit 2`, or
 *      `hookSpecificOutput.permissionDecision`) into agy's own
 *      `{"decision":"deny","reason":"..."}` veto form (confirmed working
 *      2026-08-07 — see finding 6 in the issue).
 *
 * HONESTY NOTE on field-name mapping: only `run_command` (agy's shell tool,
 * args `CommandLine`/`Cwd`) is independently verified against a live agy
 * probe (finding 3). agy is closed-source, so no other tool's arg names are
 * verifiable from source. hooks/lib/detect_human_only_credentials.ts already
 * carries best-effort fallback field names for an edit-like tool
 * (`TargetFile`, `CodeContent`, `ReplacementContent`, `ReplacementChunks`)
 * from earlier work (web-jam-tools#344) — this shim's `buildToolInput`
 * mirrors those same names so a hook reading either the Claude name or the
 * best-effort agy name finds the value either way. Anything not in that
 * short, documented set is passed through verbatim (identity), never
 * invented.
 */

import {
  isPlaceholderValue,
  looksSynthetic,
  SPECIFIC_PATTERNS,
} from "./detect_credential_literal.ts";

export interface AgyToolCall {
  name?: string;
  args?: Record<string, unknown>;
}

export interface AgyPayload {
  toolCall?: AgyToolCall;
  transcriptPath?: string;
  conversationId?: string;
  stepIdx?: number;
  artifactDirectoryPath?: string;
  workspacePaths?: string[];
  modelName?: string;
  error?: unknown;
}

export const DEFAULT_RECORD_PATH = "/tmp/agy-hook-invocations.jsonl";
export const MAX_RECORD_BYTES = 5 * 1024 * 1024; // 5 MB file size limit
export const RETAINED_RECORD_BYTES = 2 * 1024 * 1024; // Retain 2 MB on rotation

export function getRecordPath(): string | undefined {
  try {
    const custom = Deno.env.get("AGY_HOOK_RECORD_PATH");
    if (custom !== undefined) {
      const lower = custom.trim().toLowerCase();
      if (
        lower === "off" || lower === "false" || lower === "0" || lower === "none" || lower === ""
      ) {
        return undefined;
      }
      return custom;
    }
    return DEFAULT_RECORD_PATH;
  } catch {
    return DEFAULT_RECORD_PATH;
  }
}

export interface RecordedInvocation {
  timestamp: string;
  event: "PreToolUse" | "PostToolUse";
  matcher: string;
  targetHookPath: string;
  toolCall?: AgyToolCall;
  transcriptPath?: string;
  conversationId?: string;
  stepIdx?: number;
  artifactDirectoryPath?: string;
  workspacePaths?: string[];
  modelName?: string;
  error?: unknown;
  rawInput?: string;
  [key: string]: unknown;
}

/**
 * Redacts credential-shaped literals from recorded lines to prevent persisting plaintext secrets (web-jam-tools#821 review suggestion).
 */
export function redactSensitiveText(text: string): string {
  let redacted = text;
  for (const [, pattern] of SPECIFIC_PATTERNS) {
    const globalPattern = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g",
    );
    redacted = redacted.replace(globalPattern, (match) => {
      if (isPlaceholderValue(match) || looksSynthetic(match)) return match;
      return "[REDACTED_CREDENTIAL]";
    });
  }
  return redacted;
}

/**
 * Appends a recorded invocation entry to the target JSONL file on disk (web-jam-tools#816).
 * Automatically redacts credential literals, bounds file size to MAX_RECORD_BYTES with rotation,
 * applies user-only (0o600) file permissions, and fails safely on any I/O error so hook execution is never interrupted.
 */
export async function recordInvocation(
  entry: Record<string, unknown>,
  recordPath?: string,
): Promise<void> {
  const targetPath = recordPath ?? getRecordPath();
  if (!targetPath) return;

  try {
    const rawLine = JSON.stringify(entry) + "\n";
    const line = redactSensitiveText(rawLine);

    try {
      const stat = await Deno.stat(targetPath);
      if (stat.size > MAX_RECORD_BYTES) {
        const text = await Deno.readTextFile(targetPath);
        const sliced = text.slice(Math.max(0, text.length - RETAINED_RECORD_BYTES));
        const firstNewline = sliced.indexOf("\n");
        const retained = firstNewline !== -1 ? sliced.slice(firstNewline + 1) : sliced;
        await Deno.writeTextFile(targetPath, retained, { mode: 0o600 });
      }
    } catch {
      // File may not exist yet; proceed to write
    }

    await Deno.writeTextFile(targetPath, line, { append: true, create: true, mode: 0o600 });
  } catch {
    // Fail-safe: recording must never crash or change allow/deny verdicts.
  }
}

// VERIFIED (web-jam-tools#432 finding 3, measured 2026-08-07): agy's shell
// tool is `run_command`; Claude Code's equivalent tool name is `Bash`.
const TOOL_NAME_MAP: Record<string, string> = {
  run_command: "Bash",
};

export function mapAgyToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}

/**
 * Claude's PreToolUse `matcher` is a regex tested against the tool name
 * (a bare name, an `A|B` alternation, or a real regex like
 * `mcp__.*__issue_write` are all valid matcher strings already in use in
 * this repo). Anchored full-match, same semantics either engine would apply
 * to a matcher this specific.
 */
export function matcherMatches(matcher: string, toolName: string): boolean {
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    // An unparseable matcher must never silently match everything.
    return false;
  }
}

export function buildToolInput(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (out.command === undefined && args.CommandLine !== undefined) {
    out.command = args.CommandLine;
  }
  if (out.cwd === undefined && args.Cwd !== undefined) {
    out.cwd = args.Cwd;
  }
  if (out.file_path === undefined && args.TargetFile !== undefined) {
    out.file_path = args.TargetFile;
  }
  if (out.content === undefined) {
    if (args.CodeContent !== undefined) {
      out.content = args.CodeContent;
    } else if (args.ReplacementContent !== undefined) {
      out.content = args.ReplacementContent;
    }
  }
  return out;
}

/**
 * Best-effort recovery of a PostToolUse step's tool OUTPUT from agy's
 * transcript file (agy's own PostToolUse payload carries no output field at
 * all — finding 8). The transcript's exact schema is UNVERIFIED (agy is
 * closed-source); this tries a line-delimited-JSON scan for an entry
 * correlated by `stepIdx` first, and falls back to the whole file's text so
 * a detector never goes blind just because the structured guess was wrong
 * — over-inclusion only risks an extra false positive on unrelated older
 * transcript content, never a missed real leak.
 */
export function recoverPostToolOutput(
  transcriptText: string,
  stepIdx: number | undefined,
): string {
  const lines = transcriptText.split("\n").filter((l) => l.trim().length > 0);
  const candidates: string[] = [];
  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      stepIdx !== undefined && obj && typeof obj === "object" &&
      (obj as Record<string, unknown>).stepIdx === stepIdx
    ) {
      const rec = obj as Record<string, unknown>;
      const out = rec.output ?? rec.result ?? rec.toolResult ?? rec.stdout ?? rec.content;
      if (typeof out === "string") {
        candidates.push(out);
      } else if (out !== undefined) {
        candidates.push(JSON.stringify(out));
      }
    }
  }
  if (candidates.length > 0) return candidates.join("\n");
  return transcriptText;
}

export interface NormalizedPayload {
  tool_name: string;
  tool_input: Record<string, unknown>;
  transcript_path?: string;
  tool_response?: { stdout: string };
  // Extra, non-Claude fields preserved verbatim so agy-native hooks (e.g.
  // hooks/agy-model-guard.sh) can use them. Existing Claude-shape hooks
  // simply never look for these keys, so their behaviour is unaffected.
  modelName?: string;
  stepIdx?: number;
  conversationId?: string;
  artifactDirectoryPath?: string;
  workspacePaths?: string[];
}

export function normalize(
  payload: AgyPayload,
  event: "PreToolUse" | "PostToolUse",
  transcriptText?: string,
): { toolName: string; normalized: NormalizedPayload } {
  const rawName = payload.toolCall?.name ?? "";
  const toolName = mapAgyToolName(rawName);
  const args = payload.toolCall?.args ?? {};
  const normalized: NormalizedPayload = {
    tool_name: toolName,
    tool_input: buildToolInput(args),
    transcript_path: payload.transcriptPath,
    modelName: payload.modelName,
    stepIdx: payload.stepIdx,
    conversationId: payload.conversationId,
    artifactDirectoryPath: payload.artifactDirectoryPath,
    workspacePaths: payload.workspacePaths,
  };
  if (event === "PostToolUse") {
    normalized.tool_response = {
      stdout: recoverPostToolOutput(transcriptText ?? "", payload.stepIdx),
    };
  }
  return { toolName, normalized };
}

export type AgyDecision = "allow" | "deny" | "ask";

export interface AgyVerdict {
  decision: AgyDecision;
  reason?: string;
}

/**
 * Converts an underlying Claude-shape hook's exit code + stdout/stderr into
 * agy's own veto contract (finding 6): `{"decision":"deny","reason":"..."}`
 * hard-blocks; `{"decision":"allow"}` (or nothing) lets the call proceed.
 * agy's decision enum also includes `ask` and two grant-scoped variants
 * (`force_ask`, `deny_unless_prior_grant`) that no hook in this repo emits
 * today, so only `allow`/`deny`/`ask` are produced here.
 */
export function translateVerdict(exitCode: number, stdout: string, stderr: string): AgyVerdict {
  if (exitCode === 0) {
    const trimmed = stdout.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        const hso = parsed?.hookSpecificOutput;
        if (hso && typeof hso.permissionDecision === "string") {
          const d = hso.permissionDecision as string;
          if (d === "allow" || d === "deny" || d === "ask") {
            const reason = typeof hso.permissionDecisionReason === "string"
              ? hso.permissionDecisionReason
              : undefined;
            return reason !== undefined ? { decision: d, reason } : { decision: d };
          }
        }
      } catch {
        // Not JSON (e.g. a reminder hook's plain stdout) — not a veto.
      }
    }
    return { decision: "allow" };
  }
  if (exitCode === 2) {
    return { decision: "deny", reason: stderr.trim() || "blocked by hook (exit 2)" };
  }
  // Any other nonzero exit is unexpected for a well-behaved PreToolUse hook.
  // Fail CLOSED: a crashed/unparseable guard must never silently allow.
  return { decision: "deny", reason: stderr.trim() || `hook exited ${exitCode} unexpectedly` };
}

async function readAllStdin(): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const buf = new Uint8Array(65536);
  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    text += decoder.decode(buf.subarray(0, n), { stream: true });
  }
  text += decoder.decode();
  return text;
}

export async function runShim(
  event: "PreToolUse" | "PostToolUse",
  matcher: string,
  targetHookPath: string,
  rawInput: string,
  recordPath?: string,
): Promise<AgyVerdict> {
  let payload: AgyPayload = {};
  let parsedRaw: unknown = undefined;
  try {
    parsedRaw = JSON.parse(rawInput);
    if (parsedRaw && typeof parsedRaw === "object" && !Array.isArray(parsedRaw)) {
      payload = parsedRaw as AgyPayload;
    }
  } catch {
    // Unparseable payload: nothing to match or normalize. Allow — matches
    // the fail-open convention of the other cost/reminder guards when their
    // input can't be evaluated at all (see hooks/block-agy-non-flash-model.sh).
  }

  // web-jam-tools#816: Record all invocation fields sent by the surface before evaluating matchers
  const recordEntry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    event,
    matcher,
    targetHookPath,
    rawInput,
    ...(parsedRaw && typeof parsedRaw === "object" && !Array.isArray(parsedRaw)
      ? (parsedRaw as Record<string, unknown>)
      : { raw: parsedRaw }),
  };

  await recordInvocation(recordEntry, recordPath);

  if (!parsedRaw || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) {
    return { decision: "allow" };
  }

  const rawName = payload.toolCall?.name ?? "";
  const toolName = mapAgyToolName(rawName);
  if (!matcherMatches(matcher, toolName)) {
    return { decision: "allow" };
  }

  let transcriptText = "";
  if (event === "PostToolUse" && payload.transcriptPath) {
    try {
      transcriptText = await Deno.readTextFile(payload.transcriptPath);
    } catch {
      transcriptText = "";
    }
  }

  const { normalized } = normalize(payload, event, transcriptText);

  const cmd = new Deno.Command("bash", {
    args: [targetHookPath],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(normalized)));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return translateVerdict(
    code,
    new TextDecoder().decode(stdout),
    new TextDecoder().decode(stderr),
  );
}

if (import.meta.main) {
  const [event, matcherB64, targetHookPath] = Deno.args;
  if (event !== "PreToolUse" && event !== "PostToolUse") {
    console.error(`agy-hook-shim: unknown event "${event}" (expected PreToolUse or PostToolUse)`);
    Deno.exit(1);
  }
  if (!matcherB64 || !targetHookPath) {
    console.error(
      "usage: agy_hook_shim.ts <PreToolUse|PostToolUse> <base64-matcher> <target-hook-path>",
    );
    Deno.exit(1);
  }
  let matcher: string;
  try {
    matcher = atob(matcherB64);
  } catch {
    console.error("agy-hook-shim: matcher argument is not valid base64");
    Deno.exit(1);
  }
  const rawInput = await readAllStdin();
  const verdict = await runShim(event, matcher, targetHookPath, rawInput);
  console.log(JSON.stringify(verdict));
}
