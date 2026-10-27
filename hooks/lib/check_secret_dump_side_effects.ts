/**
 * Process, container and shell-variable dumps for block-secret-dumps.sh.
 * Requirements: hooks-design-2026-09-15.md, "Commands that print secrets as a side effect".
 * Only executable command positions are checked; shared tokenization is unchanged.
 */
import {
  ASSIGN_RE,
  dropProse,
  MAX_WRAPPER_RECURSION_DEPTH,
  resolveThroughWrappers,
  splitOnOperators,
  splitShellTokens,
  stripHeredocs,
} from "./normalize_command.ts";

const UNREADABLE_WORDS = /\b(ps|pgrep|pstree|top|htop|docker|systemctl|declare|typeset)\b|\/proc\//;
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|AUTH/i;
const PROC_DUMP = /^(?:\d*<)?\/proc\/[^\/]+(?:\/task\/[^\/]+)?\/(?:cmdline|environ)$/;
const PS_COLUMNS = new Set([
  "pid",
  "ppid",
  "etime",
  "etimes",
  "stat",
  "state",
  "comm",
  "user",
  "%cpu",
  "%mem",
  "rss",
  "vsz",
  "tty",
  "start",
  "time",
]);
const DOCKER_GLOBAL_VALUE_FLAGS = new Set([
  "-H",
  "--host",
  "-c",
  "--context",
  "-l",
  "--log-level",
  "--config",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);
const RESERVED_PREFIXES = new Set([
  "!",
  "then",
  "elif",
  "else",
  "do",
  "time",
  "builtin",
  "exec",
  "noglob",
]);

function unreadable(raw: string): string | undefined {
  return UNREADABLE_WORDS.test(raw)
    ? "The command could not be read; process or environment dump words are present. Restate the same action in a readable form and report this gap."
    : undefined;
}

/** Permit explicit safe columns, with selectors that do not add output fields. */
function safePs(args: string[]): boolean {
  let hasFormat = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let format: string | undefined;
    if (arg === "-o" || arg === "o") format = args[++i] ?? "";
    else if (arg.startsWith("-o")) format = arg.slice(2);
    else if (arg.startsWith("o")) format = arg.slice(1);
    else if (["-p", "p", "--pid", "--ppid", "-q", "--quick-pid", "-u", "-U", "-t"].includes(arg)) {
      if (!args[++i]) return false;
    } else if (
      !/^-(?:p|q|u|U|t).+/.test(arg) && !["-e", "-A", "-a", "-d", "a", "x", "ax"].includes(arg)
    ) {
      return false;
    }
    if (format !== undefined) {
      const columns = format.split(/[\s,]+/);
      if (columns.some((column) => !PS_COLUMNS.has(column))) return false;
      hasFormat = true;
    }
  }
  return hasFormat;
}

function hasOption(args: string[], short: string, long?: string): boolean {
  const end = args.indexOf("--");
  return args.slice(0, end < 0 ? args.length : end).some((arg) =>
    arg === long || (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes(short))
  );
}

function extractBackticks(text: string): string[] {
  const extracted: string[] = [];
  let inSquote = false;
  let inDquote = false;
  let escaped = false;
  let inBacktick = false;
  let current = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      if (inBacktick) current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inBacktick) current += ch;
      escaped = true;
      continue;
    }
    if (inSquote) {
      if (ch === "'") inSquote = false;
      continue;
    }
    if (inBacktick) {
      if (ch === "`") {
        inBacktick = false;
        extracted.push(current);
        current = "";
      } else {
        current += ch;
      }
      continue;
    }
    if (!inDquote && ch === "#") {
      const previous = i - 1;
      let slashes = 0;
      let pos = previous;
      while (pos >= 0 && text[pos] === "\\") {
        slashes++;
        pos--;
      }
      const escapedPrev = slashes % 2 === 1;
      if (previous < 0 || (/[\s;&|()<>]/.test(text[previous]) && !escapedPrev)) {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
    }
    if (ch === "'") {
      if (!inDquote) inSquote = true;
      continue;
    }
    if (ch === '"') {
      inDquote = !inDquote;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      continue;
    }
  }
  if (inBacktick) throw new Error("unterminated command");
  return extracted;
}

function checkArgv(argv: string[], depth: number): string | undefined {
  const resolved = resolveThroughWrappers(argv);
  if (resolved.kind === "cap-exceeded") throw new Error("wrapper cap");
  if (resolved.kind === "nested") {
    if (depth >= MAX_WRAPPER_RECURSION_DEPTH) throw new Error("nesting cap");
    return checkCommand(resolved.command, depth + 1);
  }
  let i = 0;
  while (i < resolved.argv.length) {
    if (ASSIGN_RE.test(resolved.argv[i])) {
      i++;
      continue;
    }
    const word = resolved.argv[i]?.split("/").pop();
    if (word && RESERVED_PREFIXES.has(word)) {
      i++;
      while (i < resolved.argv.length && resolved.argv[i].startsWith("-")) {
        const flag = resolved.argv[i++];
        if (flag === "--") break;
        if (
          (word === "exec" && flag === "-a") ||
          (word === "time" && ["-f", "--format", "-o", "--output"].includes(flag))
        ) {
          i++;
        }
      }
      continue;
    }
    break;
  }
  const name = resolved.argv[i]?.split("/").pop();
  const args = resolved.argv.slice(i + 1);

  if (name === "ps" && !safePs(args)) {
    return "This ps form can print process arguments or environments.";
  }
  if (name === "pgrep" && hasOption(args, "a", "--list-full")) {
    return "pgrep with full command lines can print credentials.";
  }
  if (name === "pstree" && hasOption(args, "a", "--arguments")) {
    return "pstree with arguments can print credentials.";
  }
  if ((name === "top" || name === "htop") && hasOption(args, "c")) {
    return "Full command lines in a process monitor can print credentials.";
  }
  if (name === "docker") {
    let subIdx = 0;
    while (subIdx < args.length && args[subIdx].startsWith("-")) {
      const opt = args[subIdx];
      if (opt === "--") {
        subIdx++;
        break;
      }
      if (DOCKER_GLOBAL_VALUE_FLAGS.has(opt)) {
        subIdx += 2;
      } else if (opt.includes("=")) {
        subIdx++;
      } else {
        subIdx++;
      }
    }
    const subArgs = args.slice(subIdx);
    const sub = subArgs[0];
    const subNext = subArgs[1];
    const isInspect = sub === "inspect" || (sub === "container" && subNext === "inspect");
    const isTop = sub === "top" || (sub === "container" && subNext === "top");
    const isNoTrunc =
      (sub === "ps" || (sub === "container" && (subNext === "ls" || subNext === "ps"))) &&
      subArgs.includes("--no-trunc");
    if (isInspect || isTop || isNoTrunc) {
      return "Container settings or untruncated process commands can print credentials.";
    }
  }
  if (name === "systemctl" && args[0] === "status") {
    return "systemctl status prints process command lines.";
  }
  if (name === "set" && args.length === 0) {
    return "set without arguments prints every shell variable.";
  }
  if (name === "export" || name === "declare" || name === "typeset") {
    const operands = args.filter((arg) => !arg.startsWith("-") && !arg.startsWith("+"));
    if (
      operands.length === 0 || (name === "export" && hasOption(args, "p")) ||
      (hasOption(args, "p") && operands.some((arg) => CREDENTIAL_NAME.test(arg.split("=")[0])))
    ) {
      return "Printing shell variables can expose credentials.";
    }
  }
  return undefined;
}

function checkCommand(command: string, depth = 0): string | undefined {
  const cleaned = stripHeredocs(command);
  for (const sub of extractBackticks(cleaned)) {
    if (depth >= MAX_WRAPPER_RECURSION_DEPTH) throw new Error("nesting cap");
    const result = checkCommand(sub, depth + 1);
    if (result) return result;
  }
  const parsed = splitOnOperators(command);
  if (parsed.unterminated) throw new Error("unterminated command");
  for (const segment of parsed.segments) {
    // Use the existing prose filter for path references. Keep the original quoting
    // for positional checks and nested shell payloads below.
    if (splitShellTokens(dropProse(segment)).some((arg) => PROC_DUMP.test(arg))) {
      return "Reading /proc command lines or environments can print credentials.";
    }
    const result = checkArgv(splitShellTokens(segment), depth);
    if (result) return result;
  }
  return undefined;
}

export function checkSecretDumpSideEffects(payload: string): string | undefined {
  try {
    const input = JSON.parse(payload);
    if (typeof input?.tool_input?.command !== "string") return unreadable(payload);
    try {
      return checkCommand(input.tool_input.command);
    } catch {
      return unreadable(input.tool_input.command);
    }
  } catch {
    return unreadable(payload);
  }
}

if (import.meta.main) {
  const result = checkSecretDumpSideEffects(await new Response(Deno.stdin.readable).text());
  if (result) console.log(result);
}
