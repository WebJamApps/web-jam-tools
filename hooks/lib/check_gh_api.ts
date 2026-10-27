/**
 * gh-api-guard decisions (R-6 consent rules), using the shared shell parser before the legacy fallback.
 * - Deny (exit 2) if method is DELETE (-X DELETE / --method DELETE), except for the narrow
 *   reversible carve-out of removing an issue dependency (allowedDependencyRemoval).
 * - Force prompt (JSON ask) if method is POST/PUT/PATCH or field flags are passed.
 */
import {
  ASSIGN_RE,
  MAX_WRAPPER_RECURSION_DEPTH,
  resolveThroughWrappers,
  splitOnOperators,
  splitShellTokens,
} from "./normalize_command.ts";

export type GhApiDecision = "allow" | "ask" | "deny";

const DELETE_TEXT = /(-x|--method)\s+delete|(-xdelete|--method=delete)/;
const WRITE_TEXT =
  /(-x|--method)\s+(post|put|patch)|(-xpost|-xput|-xpatch|--method=post|--method=put|--method=patch)|(^|\s)-f([\s=$]|$)|--field|--raw-field|--input/;
const BLOCKED_BY_REMOVAL =
  /^gh api (--method\s+delete|--method=delete|-x\s+delete|-xdelete) repos\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/issues\/[0-9]+\/dependencies\/blocked_by\/[0-9]+$/;
const SHELLS = new Set(["bash", "sh", "zsh", "ksh", "dash", "ash"]);
const CONTROL_WORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!"]);

function normalizedText(command: string): string {
  return command.toLowerCase().replace(/["']/g, "");
}

/**
 * Narrow carve-out: allow ONLY removing an issue dependency —
 *   gh api --method DELETE repos/<owner>/<repo>/issues/<N>/dependencies/blocked_by/<ID>
 * (or the -X DELETE spelling) — because it is reversible: the dependency
 * can be re-added with the corresponding POST to .../dependencies/blocked_by.
 * Everything else that is a DELETE stays denied.
 *
 * Safety posture (this must never become a general DELETE bypass):
 *  1. The path is matched anchored to the full (whitespace-squeezed)
 *     command, not merely as a substring — "blocked_by" appearing
 *     anywhere else (a comment, a different path) does not match.
 *  2. Any shell metacharacter that could chain or embed another command
 *     (`;`, `&&`, `||`, `|`, backtick, `$(`, or an embedded newline)
 *     disqualifies the command from the carve-out outright, so a DELETE
 *     hidden in a compound/chained command is always denied.
 *  3. Extra trailing arguments, a different owner/repo/issue/dependency
 *     id shape, or a different endpoint all fail the anchored match and
 *     fall through to the standard deny below.
 */
function allowedDependencyRemoval(command: string): boolean {
  const text = normalizedText(command);
  if (/[\n;|&`]|\$\(/.test(text)) return false;
  return BLOCKED_BY_REMOVAL.test(text.replace(/\s+/g, " ").trim());
}

// The shared tokenizer does not evaluate substitutions. Use the conservative
// text fallback when executable expansion prevents a positional decision.
function hasExecutableExpansion(segment: string): boolean {
  let quote = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote !== "'" && (ch === "`" || (ch === "$" && segment[i + 1] === "("))) {
      return true;
    }
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') quote = ch;
  }
  return false;
}

function apiCalls(command: string, depth = 0): string[][] {
  if (depth > MAX_WRAPPER_RECURSION_DEPTH) throw new Error("Wrapper recursion limit");
  const { segments, unterminated } = splitOnOperators(command);
  if (unterminated) throw new Error("Unterminated shell syntax");
  const calls: string[][] = [];
  for (const segment of segments) {
    if (hasExecutableExpansion(segment)) throw new Error("Executable expansion");
    const tokens = splitShellTokens(segment);
    while (CONTROL_WORDS.has(tokens[0])) tokens.shift();
    const resolved = resolveThroughWrappers(tokens);
    if (resolved.kind === "cap-exceeded") throw new Error("Wrapper iteration limit");
    if (resolved.kind === "nested") {
      calls.push(...apiCalls(resolved.command, depth + 1));
      continue;
    }
    const argv = resolved.argv;
    let i = 0;
    while (ASSIGN_RE.test(argv[i] ?? "")) i++;
    const program = argv[i]?.split("/").pop();
    if (program === "gh") {
      if (argv[i + 1] === "api") calls.push(argv.slice(i + 2));
    } else if (
      SHELLS.has(program ?? "") ||
      (tokens.length > 0 && argv.length === 0) ||
      // Known text emitters consume arguments as data. Other programs carrying
      // a recognizable command may be unsupported wrappers: keep the fallback.
      (!["echo", "printf"].includes(program ?? "") &&
        argv.some((word, j) =>
          (word === "gh" && argv[j + 1] === "api") || /gh +api( |$)/.test(word)
        ))
    ) {
      throw new Error("Unresolved wrapper");
    }
  }
  return calls;
}

function callDecision(args: string[]): GhApiDecision {
  let write = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].toLowerCase();
    if (["-f", "--field", "--raw-field", "--input"].includes(arg)) {
      write = true;
      i++; // The next token is data, even if it resembles a method flag.
      continue;
    }
    if (/^(-f|--field=|--raw-field=|--input=)/.test(arg)) {
      write = true;
      continue;
    }
    if (
      ["-H", "--header", "--hostname", "--jq", "-q", "--template", "-t", "--cache"].includes(
        args[i],
      )
    ) {
      i++;
      continue;
    }
    let method = "";
    if (arg === "-x" || arg === "--method") method = args[++i]?.toLowerCase() ?? "";
    else if (arg.startsWith("--method=")) method = arg.slice(9);
    else if (arg.startsWith("-x")) method = arg.slice(2);
    if (method === "delete") return "deny";
    if (["post", "put", "patch"].includes(method)) write = true;
  }
  return write ? "ask" : "allow";
}

function textFallback(command: string): GhApiDecision {
  if (!/gh +api( |$)/.test(command)) return "allow";
  const text = normalizedText(command);
  if (DELETE_TEXT.test(text)) return "deny";
  return WRITE_TEXT.test(text) ? "ask" : "allow";
}

export function checkGhApi(command: string): GhApiDecision {
  let decisions: GhApiDecision[];
  try {
    decisions = apiCalls(command).map(callDecision);
  } catch {
    decisions = [textFallback(command)];
  }
  if (decisions.includes("deny")) return allowedDependencyRemoval(command) ? "allow" : "deny";
  return decisions.includes("ask") ? "ask" : "allow";
}

if (import.meta.main) {
  const payload = JSON.parse(await new Response(Deno.stdin.readable).text());
  const command: unknown = payload?.tool_input?.command ?? payload?.toolCall?.args?.CommandLine;
  if (command !== undefined && typeof command !== "string") throw new Error("Invalid command");
  const decision = checkGhApi(command ?? "");
  if (decision === "deny") {
    console.error("BLOCKED (gh api guard): gh api DELETE is denied (irreversible state change).");
    console.error(
      "This is Josh's decision to make — propose the command and let Josh run it manually.",
    );
    Deno.exit(2);
  }
  // Codex's own prompt rule handles write consent (web-jam-tools#1140).
  if (decision === "ask" && Deno.env.get("WJT_SURFACE") !== "codex") {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "gh api state-changing command requires user confirmation",
      },
    }));
  }
}
