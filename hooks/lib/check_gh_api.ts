/**
 * gh-api-guard decisions (R-6 consent rules), using the shared shell parser before the legacy fallback.
 * - Deny (exit 2) if method is DELETE (-X DELETE / --method DELETE).
 * - Deny (exit 2) any write to an issue's dependency path, on every tool, naming
 *   `deno task block-issue` for an add and `deno task unblock-issue` for a removal
 *   ("Raw writes to an issue's dependency path" in github-write-guards-design.md).
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
/** The link command a refused dependency-path write is pointed at. */
export type LinkCommand = "block-issue" | "unblock-issue";
export interface GhApiVerdict {
  decision: GhApiDecision;
  link?: LinkCommand;
}

const DELETE_TEXT = /(-x|--method)\s+delete|(-xdelete|--method=delete)/;
const WRITE_TEXT =
  /(-x|--method)\s+(post|put|patch)|(-xpost|-xput|-xpatch|--method=post|--method=put|--method=patch)|(^|\s)-f([\s=$]|$)|--field|--raw-field|--input/;
// An issue's dependency path, as an endpoint argument or anywhere in unparsed text.
const DEPENDENCY_PATH =
  /(^|\/|\s)repos\/[^/\s]+\/[^/\s]+\/issues\/[^/\s]+\/dependencies(\/|\?|\s|$)/;
const SHELLS = new Set(["bash", "sh", "zsh", "ksh", "dash", "ash"]);
const CONTROL_WORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!"]);

function normalizedText(command: string): string {
  return command.toLowerCase().replace(/["']/g, "");
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

// The shared splitter cuts an unquoted word at a brace. gh's own endpoint placeholders,
// `repos/{owner}/{repo}/...`, are rewritten to plain words first so the endpoint reaches
// the guard whole. Any other unquoted brace inside a word (brace expansion such as
// `issues/{1,2}`, or `xargs -I{}`) is swapped for a marker so the splitter keeps the word
// whole; only a `gh api` call carrying a marker is judged by the text fallback, on its own
// text. Quoted text, such as a JSON example, is data and is never touched.
const GH_PLACEHOLDER = /\{(owner|repo|branch)\}/g;
const OPEN_MARK = "\u0001";
const CLOSE_MARK = "\u0002";

function markBracesInWords(command: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'") {
      out += ch + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "$" && command[i + 1] === "{") {
      const close = command.indexOf("}", i);
      const end = close < 0 ? command.length : close + 1;
      out += command.slice(i, end);
      i = end - 1;
      continue;
    } else if (ch === "{" && i + 1 < command.length && !/\s/.test(command[i + 1])) {
      out += OPEN_MARK;
      continue;
    } else if (ch === "}" && i > 0 && !/[\s;]/.test(command[i - 1])) {
      out += CLOSE_MARK;
      continue;
    }
    out += ch;
  }
  return out;
}

function unmark(text: string): string {
  return text.replaceAll(OPEN_MARK, "{").replaceAll(CLOSE_MARK, "}");
}

function apiCalls(rawCommand: string, depth = 0): GhApiVerdict[] {
  if (depth > MAX_WRAPPER_RECURSION_DEPTH) throw new Error("Wrapper recursion limit");
  const command = markBracesInWords(rawCommand.replace(GH_PLACEHOLDER, "_$1_"));
  const { segments, unterminated } = splitOnOperators(command);
  if (unterminated) throw new Error("Unterminated shell syntax");
  const calls: GhApiVerdict[] = [];
  for (const segment of segments) {
    if (hasExecutableExpansion(segment)) throw new Error("Executable expansion");
    const tokens = splitShellTokens(segment);
    while (CONTROL_WORDS.has(tokens[0])) tokens.shift();
    const resolved = resolveThroughWrappers(tokens);
    if (resolved.kind === "cap-exceeded") throw new Error("Wrapper iteration limit");
    if (resolved.kind === "nested") {
      calls.push(...apiCalls(unmark(resolved.command), depth + 1));
      continue;
    }
    const argv = resolved.argv;
    let i = 0;
    while (ASSIGN_RE.test(argv[i] ?? "")) i++;
    const program = argv[i]?.split("/").pop();
    if (program === "gh") {
      if (argv[i + 1] !== "api") continue;
      // A brace-expanded word can become several endpoints: this call alone takes the text check.
      const marked = segment.includes(OPEN_MARK) || segment.includes(CLOSE_MARK);
      calls.push(marked ? textFallback(unmark(segment)) : callDecision(argv.slice(i + 2)));
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

const VALUE_OPTIONS = [
  "-H",
  "--header",
  "--hostname",
  "--jq",
  "-q",
  "--template",
  "-t",
  "--cache",
  "-p",
  "--preview",
];

function callDecision(args: string[]): GhApiVerdict {
  let write = false;
  let fields = false;
  let method = "";
  let endpoint = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].toLowerCase();
    if (["-f", "--field", "--raw-field", "--input"].includes(arg)) {
      write = fields = true;
      i++; // The next token is data, even if it resembles a method flag.
      continue;
    }
    if (/^(-f|--field=|--raw-field=|--input=)/.test(arg)) {
      write = fields = true;
      continue;
    }
    if (VALUE_OPTIONS.includes(args[i])) {
      i++;
      continue;
    }
    let value = "";
    if (arg === "-x" || arg === "--method") value = args[++i]?.toLowerCase() ?? "";
    else if (arg.startsWith("--method=")) value = arg.slice(9);
    else if (arg.startsWith("-x")) value = arg.slice(2);
    else if (!arg.startsWith("-") && !endpoint) endpoint = args[i];
    if (value) method = value;
    if (["post", "put", "patch"].includes(value)) write = true;
  }
  // gh sends a request carrying parameters as POST unless a method is named.
  const effective = method || (fields ? "post" : "get");
  const path = endpoint.replace(/^https?:\/\/[^/]+/i, "");
  if (DEPENDENCY_PATH.test(path) && effective !== "get") {
    return { decision: "deny", link: effective === "delete" ? "unblock-issue" : "block-issue" };
  }
  if (method === "delete") return { decision: "deny" };
  return { decision: write ? "ask" : "allow" };
}

function textFallback(command: string): GhApiVerdict {
  if (!/gh +api( |$)/.test(command)) return { decision: "allow" };
  const text = normalizedText(command);
  const deleting = DELETE_TEXT.test(text);
  const writing = WRITE_TEXT.test(text);
  if (DEPENDENCY_PATH.test(text) && (deleting || writing)) {
    return { decision: "deny", link: deleting ? "unblock-issue" : "block-issue" };
  }
  if (deleting) return { decision: "deny" };
  return { decision: writing ? "ask" : "allow" };
}

/** The decision, and for a dependency-path write the link command to name. */
export function ghApiVerdict(command: string): GhApiVerdict {
  let verdicts: GhApiVerdict[];
  try {
    verdicts = apiCalls(command);
  } catch {
    verdicts = [textFallback(command)];
  }
  const denied = verdicts.filter((verdict) => verdict.decision === "deny");
  if (denied.length > 0) return denied.find((verdict) => verdict.link) ?? denied[0];
  return { decision: verdicts.some((verdict) => verdict.decision === "ask") ? "ask" : "allow" };
}

export function checkGhApi(command: string): GhApiDecision {
  return ghApiVerdict(command).decision;
}

const LINK_USAGE: Record<LinkCommand, string> = {
  "block-issue":
    "add a blocked-by link with: deno task block-issue --repo <owner/repo> --issue <n> --blocker <m>",
  "unblock-issue":
    "remove a blocked-by link with: deno task unblock-issue --repo <owner/repo> --issue <n> --blocker <m>",
};

if (import.meta.main) {
  const payload = JSON.parse(await new Response(Deno.stdin.readable).text());
  const command: unknown = payload?.tool_input?.command ?? payload?.toolCall?.args?.CommandLine;
  if (command !== undefined && typeof command !== "string") throw new Error("Invalid command");
  const { decision, link } = ghApiVerdict(command ?? "");
  if (link) {
    console.error(
      "BLOCKED (gh api guard): a raw gh api write to an issue's dependency path is refused.",
    );
    console.error(`Instead, ${LINK_USAGE[link]}`);
    console.error("It prints the command that undoes the change.");
    Deno.exit(2);
  }
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
