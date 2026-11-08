/**
 * Shared private-folder read guard (web-jam-tools#1141).
 *
 * Enforces the Dropbox command shapes in the hooks design (web-jam-tools#1579).
 * Reads the private list from settings; resolves literal paths and inspected scripts
 * without executing them. Deliberately encoded/constructed paths are outside this guard.
 *
 * One list, read once from settings.json — never duplicated into the repo.
 *
 * Three outcomes:
 *   - Allow: none of the protected command shapes is present (exit 0).
 *   - Deny: a private path, home sweep or desktop-app invocation is present (exit 2).
 *   - Refuse: settings, paths or script contents cannot be established (exit 2).
 *
 * Used across Claude Code, agy (via hooks/agy-hook-shim.sh), and Codex (WJT_SURFACE=codex).
 */

import * as path from "jsr:@std/path@^1.0.0";
import {
  ASSIGN_RE,
  findHeredocMarker,
  MAX_WRAPPER_ITERATIONS,
  MAX_WRAPPER_RECURSION_DEPTH,
  resolveThroughWrappers,
  resolveWrapperLayer,
  splitOnOperators,
  splitShellTokens,
  stripHeredocs,
} from "./normalize_command.ts";

export interface FolderListResult {
  ok: boolean;
  folders: string[];
  error?: string;
}

export function getPrivateDropboxFolders(settingsPath?: string): FolderListResult {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/home/joshua";
  const targetPath = settingsPath ||
    Deno.env.get("CLAUDE_SETTINGS_PATH") ||
    path.join(home, ".claude/settings.json");

  let content: string;
  try {
    content = Deno.readTextFileSync(targetPath);
  } catch (err) {
    return {
      ok: false,
      folders: [],
      error: `cannot read settings file at '${targetPath}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      folders: [],
      error: `cannot parse JSON in settings file at '${targetPath}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      folders: [],
      error: `settings file at '${targetPath}' is not an object`,
    };
  }

  const permissions = (parsed as Record<string, unknown>).permissions;
  if (typeof permissions !== "object" || permissions === null) {
    return {
      ok: false,
      folders: [],
      error: `settings file at '${targetPath}' missing permissions object`,
    };
  }

  const deny = (permissions as Record<string, unknown>).deny;
  if (!Array.isArray(deny)) {
    return {
      ok: false,
      folders: [],
      error: `settings file at '${targetPath}' permissions.deny is not an array`,
    };
  }

  const folders: string[] = [];
  for (const rule of deny) {
    if (typeof rule === "string") {
      const match = rule.match(/^Read\(.*?[/\\]Dropbox[/\\]([^/\\]+)[/\\]\*\*\)$/);
      if (match && !folders.includes(match[1])) {
        folders.push(match[1]);
      }
    }
  }

  if (folders.length === 0) {
    return {
      ok: false,
      folders: [],
      error: `no private Dropbox folders found in permissions.deny in '${targetPath}'`,
    };
  }

  return {
    ok: true,
    folders,
  };
}

export function folderToRegexPattern(folder: string): string {
  let pattern = "";
  for (let i = 0; i < folder.length; i++) {
    const ch = folder[i];
    if (ch === " ") {
      pattern += "(?:\\\\?\\s|['\"]\\s*['\"])";
    } else if (ch === "(") {
      pattern += "(?:\\\\?\\()";
    } else if (ch === ")") {
      pattern += "(?:\\\\?\\))";
    } else if (/[a-zA-Z0-9_-]/.test(ch)) {
      pattern += ch;
    } else {
      pattern += "\\" + ch;
    }
  }
  return pattern;
}

export function buildFolderPattern(folder: string): RegExp {
  const folderPattern = folderToRegexPattern(folder);
  // Match Dropbox followed by the folder name
  // Preceded by: start of string, or common delimiters/path separators
  // Then optional path before Dropbox (e.g. /home/joshua/, ~/, $HOME/, ${HOME}/, etc.)
  // Then Dropbox/
  // Then optional quote around folder name
  // Then folderPattern
  // Then optional quote
  // Then lookahead: end of string, or path separator (/ or \), or quotes, or whitespace, or shell delimiters
  const prefix =
    "(?:^|[\\s\"'`=:(</\\\\])(?:[~a-zA-Z0-9_./$}{@\\-]*[\\\\/])?[Dd]ropbox[\\\\/]+['\"]?";
  const suffix = "['\"]?(?=$|[\\\\/'\"`\\s;&|),>\\]])";
  return new RegExp(prefix + folderPattern + suffix);
}

export function checkCommandForPrivateFolder(command: string, folders: string[]): string | null {
  for (const f of folders) {
    const regex = buildFolderPattern(f);
    if (regex.test(command)) {
      return f;
    }
  }
  return null;
}

const ALLOWED_FOLDERS = new Set(["joshandmariamusic", "web-jam-llms", "mark_henrickson"]);
const INTERPRETERS = new Set(["python", "python3", "node", "deno", "bash", "sh"]);
const MAX_SCRIPT_BYTES = 1_000_000;

interface InspectionContext {
  cwd: string;
  home: string;
  folders: string[];
  variables: Map<string, string>;
  scripts: Set<string>;
  scriptText?: boolean;
}

export function unreadableScriptMessage(filename: string): string {
  return `Cannot read the script ${filename} yet, so it cannot be checked. Write the script in an earlier command, then run it.`;
}

class UnreadableScript extends Error {
  constructor(filename: string) {
    super(unreadableScriptMessage(filename));
  }
}

function withoutWebAddresses(text: string): string {
  // Command substitutions, backtick substitutions, and unspaced shell operators
  // (; | &) execute locally even when embedded in or directly adjacent to a URL.
  // Leave them visible to the command/path checks.
  return text.replace(/https?:\/\/(?:(?!\$\()[^\s"'`<>;&|])+/g, "").replaceAll("file://", "");
}

function namedSocket(text: string): boolean {
  return /\.dropbox\/(?:command_socket|iface_socket)(?=$|[\s"'`),;\/])/m.test(text);
}

/** Resolve existing ancestors too, so a new file cannot conceal a symlink traversal. */
function expandedPath(value: string, context: InspectionContext): string {
  const resolveVariables = (text: string, seen = new Set<string>()): string =>
    text.replace(
      /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
      (_, name: string) => {
        if (seen.has(name)) throw new Error("cyclic path variable");
        const replacement = name === "HOME"
          ? context.home
          : context.variables.has(name)
          ? context.variables.get(name)
          : Deno.env.get(name) || undefined;
        if (replacement === undefined) throw new Error("unresolved path variable");
        return resolveVariables(replacement, new Set(seen).add(name));
      },
    );
  const expanded = resolveVariables(value.replace(/^~(?=\/|$)/, context.home));
  if (expanded.includes("$") || expanded.includes("`")) throw new Error("unresolved path");
  // Keep '..' until realPath has followed symlinks: normalizing it first can
  // hide an escape through an allowed-folder symlink followed by '/..'.
  return path.isAbsolute(expanded) ? expanded : `${context.cwd}${path.SEPARATOR}${expanded}`;
}

function resolvedPath(value: string, context: InspectionContext): string {
  const expanded = expandedPath(value, context);
  const root = path.parse(expanded).root;
  if (!root) throw new Error("unresolved path root");
  let current = root;
  // Deno normalizes '..' in a realPath argument before reaching the OS. Resolve
  // one component at a time so a symlink is followed before its subsequent '..'.
  for (const part of expanded.slice(root.length).split(path.SEPARATOR)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, part);
    if (candidate === "/proc" || candidate.startsWith("/proc/")) {
      throw new Error("cannot resolve a /proc path");
    }
    try {
      current = Deno.realPathSync(candidate);
    } catch (err) {
      if (candidate === "/dev" || candidate.startsWith("/dev/")) {
        current = candidate;
        continue;
      }
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      try {
        // An existing dangling symlink is indeterminate, not a new output path.
        Deno.lstatSync(candidate);
        throw new Error("unresolved symbolic link");
      } catch (statError) {
        if (!(statError instanceof Deno.errors.NotFound)) throw statError;
      }
      current = candidate;
    }
    if (current === "/proc" || current.startsWith("/proc/")) {
      throw new Error("cannot resolve a /proc path");
    }
  }
  return current;
}

function privatePath(value: string, context: InspectionContext, allowRoot = false): string | null {
  // Unknown values inside script text are not paths we can establish. Explicit
  // Dropbox prefixes are checked separately before any such value is skipped.
  if (context.scriptText) {
    try {
      expandedPath(value, context);
    } catch {
      return null;
    }
  }
  const targets = [expandedPath(value, context), resolvedPath(value, context)];
  const roots = [path.join(context.home, "Dropbox"), "/home/joshua/Dropbox"].flatMap((root) => [
    root,
    resolvedPath(root, context),
  ]);
  for (const target of targets) {
    for (const root of roots) {
      const relative = path.relative(root, target);
      if (
        relative === ".." || relative.startsWith(`..${path.SEPARATOR}`) || path.isAbsolute(relative)
      ) {
        continue;
      }
      if (!relative) {
        if (!allowRoot) return "Dropbox root";
        continue;
      }
      const folder = relative.split(path.SEPARATOR)[0];
      if (!ALLOWED_FOLDERS.has(folder)) return folder;
    }
  }
  return null;
}

function literalPaths(text: string): string[] {
  const candidates: string[] = [];
  // Whole quoted shell arguments retain spaces after tokenization.
  if (/^(?:\/|~\/|\$[A-Za-z_][A-Za-z0-9_]*\/|\.\.?\/)/.test(text) && !/["'`()\n]/.test(text)) {
    candidates.push(text);
  } else {
    for (
      const match of text.matchAll(
        /(?:^|[\s=:(\[,"'])(\/[^\s"'`()\[\]{},;<>]*|~\/[^\s"'`()\[\]{},;<>]*|\$[A-Za-z_][A-Za-z0-9_]*\/[^\s"'`()\[\]{},;<>]*|\.\.?\/[^\s"'`()\[\]{},;<>]*)/g,
      )
    ) candidates.push(match[1]);
  }
  return candidates;
}

function sweepCommand(argv: string[], context: InspectionContext): boolean {
  const name = path.basename(argv[0] ?? "");
  const recursive = argv.slice(1).some((arg) =>
    arg === "--recursive" || (/^-[^-]/.test(arg) && /[rR]/.test(arg))
  );
  if (
    !["rg", "find", "tar", "rsync", "du"].includes(name) &&
    !(["grep", "cp", "ls"].includes(name) && recursive)
  ) return false;
  const homes = [context.home, "/home/joshua"].map((home) => resolvedPath(home, context));
  const operands = pathOperands(argv, context);
  const implicit = (name === "rg" && operands.length <= 1) ||
    (name === "grep" && operands.length === 0) ||
    (["find", "du", "ls"].includes(name) && operands.length === 0);
  return (implicit && homes.includes(resolvedPath(".", context))) || operands.some((arg) => {
    if (!/^(?:~|\$|\/|\.)/.test(arg)) return false;
    try {
      return homes.includes(resolvedPath(arg, context));
    } catch (error) {
      if (context.scriptText) return false;
      throw error;
    }
  });
}

function inspectScript(
  source: string,
  context: InspectionContext,
  depth: number,
  shell = false,
): string | null {
  if (depth > MAX_WRAPPER_RECURSION_DEPTH) throw new Error("script nesting limit");
  context = { ...context, scriptText: true };
  const text = withoutWebAddresses(source.replace(/^\s*(?:#|\/\/).*$/gm, ""));
  if (namedSocket(text)) return "Dropbox desktop socket";
  const named = checkCommandForPrivateFolder(text, context.folders);
  if (named) return named;
  // A visible Dropbox prefix remains protected even when the rest is dynamic.
  for (const match of text.matchAll(/Dropbox\/([^\s/"'`;)]+)/g)) {
    if (!ALLOWED_FOLDERS.has(match[1])) return match[1];
  }
  for (const candidate of literalPaths(text)) {
    const denied = privatePath(candidate, context);
    if (denied) return denied;
  }
  // Literal interpreter process APIs. Strings are inspected, never evaluated.
  for (
    const call of text.matchAll(
      /(?:subprocess\.(?:run|call|Popen|check_output|check_call)|(?:Deno\.)?Command|(?:child_process\.)?(?:exec|execFile|spawn)(?:Sync)?|os\.system)\s*\(\s*(?:\[([^\]]*)\]|(["'])(.*?)\2)/gs,
    )
  ) {
    const words = call[1] === undefined
      ? [call[3]]
      : [...call[1].matchAll(/(["'])(.*?)\1/gs)].map((word) => word[2]);
    const denied = inspectShell(
      call[1] === undefined
        ? call[3]
        : words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" "),
      context,
      depth + 1,
    );
    if (denied) return denied;
  }
  return shell ? inspectShell(text, context, depth + 1) : null;
}

function scriptArgument(argv: string[]): string | undefined {
  const name = path.basename(argv[0] ?? "");
  if (!INTERPRETERS.has(name)) return undefined;
  let index = name === "deno" ? 2 : 1;
  if (name === "deno" && argv[1] !== "run") return undefined;
  for (; index < argv.length; index++) {
    const word = argv[index];
    if (["-c", "-e", "--eval", "-m", "-p", "--print"].includes(word)) return undefined;
    if (["-s", "-", "/dev/stdin"].includes(word)) return undefined;
    if (word === "--") return argv[index + 1];
    if (["--config", "--import-map", "--loader", "--require", "-r"].includes(word)) {
      index++;
      continue;
    }
    if (!word.startsWith("-")) return word;
  }
  return undefined;
}

const UNRESOLVED_SHELL_COMMANDS = new Set([
  "builtin",
  "eval",
  "source",
  ".",
  "pushd",
  "popd",
]);

function checkUnresolvedShellCommand(tokens: string[]): void {
  let current = tokens;
  let iterations = 0;
  while (current.length && iterations < MAX_WRAPPER_ITERATIONS) {
    let i = 0;
    while (i < current.length && (ASSIGN_RE.test(current[i]) || current[i] === "exec")) i++;
    if (i >= current.length) return;
    const token = current[i];
    const name = token === "." ? "." : path.basename(token);
    if (UNRESOLVED_SHELL_COMMANDS.has(name)) {
      if (name === "pushd" || name === "popd") {
        throw new Error("cannot resolve shell directory stack");
      }
      throw new Error(`cannot resolve ${name} execution`);
    }
    const layer = resolveWrapperLayer(current.slice(i));
    if (!layer || layer.kind === "nested") return;
    current = layer.argv;
    iterations++;
  }
}

/** grep patterns are data; sed patterns may name files or unresolved values. */
function pathOperands(argv: string[], context: InspectionContext): string[] {
  const name = path.basename(argv[0] ?? "");
  if (name !== "grep" && name !== "sed") return argv.slice(1).filter((arg) => !arg.startsWith("-"));
  const operands: string[] = [];
  let patternSeen = false;
  let options = true;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    // Only flags without arguments may precede e/f in a short-option cluster.
    // In particular, sed's -i suffix is not another sequence of options.
    const shortOption = options
      ? (name === "grep"
        ? /^-[EFGPivwxobncHhLlrRqsaIUuZzTyV]*([ef])(.*)$/
        : /^-[nEzrusb]*([ef])(.*)$/)
        .exec(arg)
      : null;
    if (options && (arg === "--file" || arg.startsWith("--file=") || shortOption?.[1] === "f")) {
      operands.push(
        arg.startsWith("--file=") ? arg.slice(7) : shortOption?.[2] || argv[++i] || "",
      );
      patternSeen = true;
      continue;
    }
    let pattern: string | undefined;
    if (shortOption?.[1] === "e") pattern = shortOption[2] || argv[++i] || "";
    else if (options && ["--regexp", "--expression"].includes(arg)) pattern = argv[++i] ?? "";
    else if (options && arg.startsWith("-")) continue;
    else if (!patternSeen) pattern = arg;
    else {
      operands.push(arg);
      continue;
    }
    patternSeen = true;
    if (name === "sed" && !context.scriptText && /`|\$\(|\$\d|\$\{[^}]*[:/]/.test(pattern)) {
      throw new Error("unresolved sed pattern");
    }
    if (name === "sed" && /\$(?:[A-Za-z_{(0-9])|`/.test(pattern)) {
      // Only an unresolved variable is unsafe; an end-of-line regex anchor is literal.
      try {
        pattern = pattern.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name: string) => {
          const value = name === "HOME"
            ? context.home
            : context.variables.get(name) ?? Deno.env.get(name);
          if (!value) throw new Error("unresolved sed pattern variable");
          return value;
        });
      } catch (error) {
        if (!context.scriptText) throw error;
      }
    }
    // Patterns can still name a Dropbox path (including sed's r/w commands).
    // Regex addresses beginning with '/' are not file operands.
    operands.push(
      ...literalPaths(pattern).filter((value) => !value.includes("$") && !/^\/\^/.test(value)),
    );
    if (name === "sed") {
      for (const file of pattern.matchAll(/(?:^|[;\n0-9/])\s*[rw]\s+([^\s;]+)/g)) {
        operands.push(file[1]);
      }
    }
  }
  return operands;
}

function inspectFile(
  filename: string,
  context: InspectionContext,
  depth: number,
  shell: boolean,
  ownPath: boolean,
): string | null {
  if (context.scripts.has(filename)) throw new Error("recursive script reference");
  let source: string;
  try {
    const file = Deno.openSync(filename, { read: true });
    try {
      const prefix = new Uint8Array(4096);
      const size = file.readSync(prefix) ?? 0;
      const magic = new DataView(prefix.buffer).getUint32(0, false);
      const compiled = size >= 4 && (
        magic === 0x7f454c46 || (prefix[0] === 0x4d && prefix[1] === 0x5a) ||
        [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe].includes(magic)
      );
      if (ownPath && compiled) return null;
      const stat = file.statSync();
      if (!stat.isFile || stat.size > MAX_SCRIPT_BYTES) throw new Error("unreadable script file");
    } finally {
      file.close();
    }
    source = Deno.readTextFileSync(filename);
  } catch {
    throw new UnreadableScript(filename);
  }
  return inspectScript(
    source,
    { ...context, scripts: new Set(context.scripts).add(filename) },
    depth + 1,
    shell,
  );
}

function inspectLiteralLoop(
  text: string,
  context: InspectionContext,
  depth: number,
): { found: boolean; denied: string | null } {
  const loop =
    /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]+)[;\n]\s*do\b([\s\S]*?)[;\n]\s*done\b/.exec(
      text,
    );
  if (!loop) return { found: false, denied: null };
  const prefix = inspectShell(text.slice(0, loop.index), context, depth);
  if (prefix) return { found: true, denied: prefix };
  if (/[$`*?[\]]/.test(loop[2])) {
    if (!context.scriptText) throw new Error("cannot resolve loop words");
    const denied = inspectShell(loop[3], context, depth + 1);
    if (denied) return { found: true, denied };
  } else {
    for (const word of splitShellTokens(loop[2])) {
      const variables = new Map(context.variables).set(loop[1], word);
      const denied = inspectShell(loop[3], { ...context, variables }, depth + 1);
      if (denied) return { found: true, denied };
    }
  }
  return {
    found: true,
    denied: inspectShell(text.slice(loop.index + loop[0].length), context, depth),
  };
}

/** Find a balanced shell group without evaluating its contents. */
function closingParenthesis(text: string, start: number): number {
  let nesting = 0;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && quote !== "'") {
      i++;
    } else if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
    } else if (ch === "(") {
      nesting++;
    } else if (ch === ")" && --nesting === 0) {
      return i;
    }
  }
  throw new Error("unterminated shell group");
}

/** Substitutions execute even in patterns, arithmetic and double-quoted words. */
function shellSubstitutions(text: string): { text: string; commands: string[] } {
  let result = "";
  let quote = "";
  const commands: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && quote !== "'") {
      result += text.slice(i, i + 2);
      i++;
      continue;
    }
    const processSubstitution = !quote && (ch === "<" || ch === ">") && text[i + 1] === "(";
    if (
      processSubstitution ||
      (quote !== "'" && text.startsWith("$(", i) && !text.startsWith("$((", i))
    ) {
      const end = closingParenthesis(text, i + 1);
      commands.push(text.slice(i + 2, end));
      // The marker keeps the expansion in its original command position. $? is
      // deliberately unresolved by the path reader; no constructed value is guessed.
      result += (processSubstitution ? "/dev/fd/" : "$?") +
        `__WJT_SUBSTITUTION_${commands.length - 1}__`;
      i = end;
      continue;
    }
    if (quote !== "'" && ch === "`") {
      let end = i + 1;
      for (; end < text.length; end++) {
        if (text[end] === "\\") end++;
        else if (text[end] === "`") break;
      }
      if (end === text.length) throw new Error("unterminated backtick");
      commands.push(text.slice(i + 1, end));
      result += `$?__WJT_SUBSTITUTION_${commands.length - 1}__`;
      i = end;
      continue;
    }
    result += ch;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "#" && (i === 0 || /[\s;&|()]/.test(text[i - 1]))) {
      const end = text.indexOf("\n", i);
      if (end < 0) return { text: result + text.slice(i + 1), commands };
      result += text.slice(i + 1, end);
      i = end - 1;
    }
  }
  return { text: result, commands };
}

/** Keep non-command syntax out of the shared position-based command splitter. */
function shellSyntax(text: string): { text: string; patterns: string[]; redirects: string[] } {
  let result = "";
  let quote = "";
  const patterns: string[] = [];
  const redirects: string[] = [];
  const cases: Array<"pattern" | "body"> = [];
  const keepPattern = (pattern: string, replacement = " ") => {
    patterns.push(pattern);
    return replacement + " " + [...pattern.matchAll(/__WJT_SUBSTITUTION_\d+__/g)]
      .map((match) => match[0]).join(" ") +
      " ";
  };
  const wordAt = (i: number, word: string) =>
    text.startsWith(word, i) && (i === 0 || /[\s;()]/.test(text[i - 1])) &&
    (i + word.length === text.length || /[\s;()]/.test(text[i + word.length]));
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!quote && cases.at(-1) === "pattern" && !/\s/.test(ch) && !wordAt(i, "esac")) {
      const start = i;
      if (ch === "(") i++; // optional opening parenthesis of a case arm
      let nesting = 0;
      let patternQuote = "";
      for (; i < text.length; i++) {
        const c = text[i];
        if (c === "\\" && patternQuote !== "'") i++;
        else if (patternQuote) {
          if (c === patternQuote) patternQuote = "";
        } else if (c === "'" || c === '"') patternQuote = c;
        else if (c === "(") nesting++;
        else if (c === ")") {
          if (nesting === 0) break;
          nesting--;
        }
      }
      if (i === text.length) throw new Error("unterminated case pattern");
      result += keepPattern(text.slice(start, i));
      cases[cases.length - 1] = "body";
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      result += text.slice(i, i + 2);
      i++;
      continue;
    }
    if (quote) {
      result += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|()]/.test(text[i - 1]))) {
      const end = text.indexOf("\n", i);
      if (end < 0) break;
      i = end - 1;
      continue;
    }
    if (wordAt(i, "esac") && cases.length) {
      cases.pop();
      result += " ";
      i += 3;
      continue;
    }
    if (wordAt(i, "case")) {
      const header = /^case\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)\s+in\b/.exec(text.slice(i));
      if (header) {
        result += keepPattern(header[0]);
        cases.push("pattern");
        i += header[0].length - 1;
        continue;
      }
    }
    if (cases.at(-1) === "body" && (text.startsWith(";;", i) || text.startsWith(";&", i))) {
      cases[cases.length - 1] = "pattern";
      i += text.startsWith(";;&", i) ? 2 : 1;
      result += "; ";
      continue;
    }
    if (text.startsWith("[[", i) && (i === 0 || /[\s;&|()]/.test(text[i - 1]))) {
      const end = text.indexOf("]]", i + 2);
      if (end < 0) throw new Error("unterminated conditional test");
      result += keepPattern(text.slice(i, end + 2));
      i = end + 1;
      continue;
    }
    if (text.startsWith("$((", i) || text.startsWith("((", i)) {
      const start = ch === "$" ? i + 1 : i;
      const end = closingParenthesis(text, start);
      result += keepPattern(text.slice(i, end + 1), ch === "$" ? "0" : " ");
      i = end;
      continue;
    }
    const redirect = /^(?:&>>?|<<<|<<-?|<>|>>|[<>]&|>\||[<>])/.exec(text.slice(i));
    if (redirect && text[i + redirect[0].length] !== "(") {
      // A numeric descriptor belongs to the operator, never to the command argv.
      result = result.replace(/(?:^|(?<=\s))\d+$/, "");
      i += redirect[0].length;
      while (i < text.length && /[ \t]/.test(text[i])) i++;
      const start = i;
      let targetQuote = "";
      for (; i < text.length; i++) {
        const c = text[i];
        if (c === "\\" && targetQuote !== "'") i++;
        else if (targetQuote) {
          if (c === targetQuote) targetQuote = "";
        } else if (c === "'" || c === '"') targetQuote = c;
        else if (/[\s;&|()<>]/.test(c)) break;
      }
      if (targetQuote || start === i) throw new Error("unreadable redirection target");
      const target = splitShellTokens(text.slice(start, i))[0];
      // Here-strings are data; >&file still opens a path, whereas >&1 copies a descriptor.
      if (redirect[0] === "<<<") result += keepPattern(text.slice(start, i));
      else if (
        !redirect[0].startsWith("<<") &&
        !(redirect[0].endsWith("&") && /^(?:\d+-?|-)$/.test(target))
      ) {
        redirects.push(target);
        result += ` __WJT_REDIRECT_${redirects.length - 1}__ `;
      }
      result += " ";
      i--;
      continue;
    }
    result += ch;
  }
  return { text: result, patterns, redirects };
}

function inspectShell(
  command: string,
  context: InspectionContext,
  depth: number,
): string | null {
  if (depth > MAX_WRAPPER_RECURSION_DEPTH) throw new Error("script/wrapper nesting limit");
  if (namedSocket(command)) return "Dropbox desktop socket";
  const text = withoutWebAddresses(stripHeredocs(command.replace(/\\\r?\n/g, ""))).replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, name) => `$${name}`,
  );
  const loop = inspectLiteralLoop(text, context, depth);
  if (loop.found) return loop.denied;
  // Data bodies have already been stripped. Retained bodies execute as scripts.
  const lines = text.split("\n");
  const shellLines: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    shellLines.push(lines[index]);
    const marker = findHeredocMarker(lines[index]);
    if (!marker) continue;
    const shell = !/(?:^|[\s/])(python3?|node|deno)(?=\s|$)/.test(lines[index]);
    const body: string[] = [];
    while (++index < lines.length) {
      const line = marker[1] ? lines[index].replace(/^\t+/, "") : lines[index];
      if (line.replace(/\r$/, "") === marker[0]) break;
      body.push(line);
    }
    if (index >= lines.length) throw new Error("unterminated heredoc");
    shellLines.push(lines[index]);
    const denied = inspectScript(body.join("\n"), { ...context }, depth + 1, shell);
    if (denied) return denied;
  }
  const substitutions = shellSubstitutions(shellLines.join("\n"));
  const syntax = shellSyntax(substitutions.text);
  for (const pattern of syntax.patterns) {
    const named = checkCommandForPrivateFolder(pattern, context.folders);
    if (named) return named;
    for (const match of pattern.matchAll(/Dropbox\/([^\s/"'`;)]+)/g)) {
      if (!ALLOWED_FOLDERS.has(match[1])) return match[1];
    }
    if (/Dropbox\/(?=$|[\s"'])/.test(pattern)) return "Dropbox root";
  }
  const parsed = splitOnOperators(syntax.text);
  if (parsed.unterminated) throw new Error("unparseable shell command");
  const cwdDenied = privatePath(context.cwd, context, true);
  if (cwdDenied) return cwdDenied;
  for (const segment of parsed.segments) {
    const parentContext = context;
    context = { ...parentContext, variables: new Map(parentContext.variables) };
    const named = checkCommandForPrivateFolder(segment, context.folders);
    if (named) return named;
    const rawTokens = splitShellTokens(segment);
    const tokens = rawTokens.map((token) => token.replaceAll(/__WJT_SUBSTITUTION_\d+__/g, ""))
      .filter((token) => token && !/^__WJT_REDIRECT_\d+__$/.test(token));
    let assignments = 0;
    while (assignments < tokens.length && ASSIGN_RE.test(tokens[assignments])) {
      const token = tokens[assignments++];
      const equals = token.indexOf("=");
      context.variables.set(token.slice(0, equals), token.slice(equals + 1));
    }
    // Prefix assignments populate the child's environment after shell argument
    // expansion. They cannot establish a variable used in this command's argv.
    if (assignments < tokens.length) context.variables = new Map(parentContext.variables);
    const redirected = rawTokens.flatMap((token) => {
      const match = /^__WJT_REDIRECT_(\d+)__$/.exec(token);
      return match ? [syntax.redirects[Number(match[1])]] : [];
    });
    const expansions = [
      ...(segment + " " + redirected.join(" ")).matchAll(/__WJT_SUBSTITUTION_(\d+)__/g),
    ];
    for (const index of new Set(expansions.map((match) => Number(match[1])))) {
      const denied = inspectShell(substitutions.commands[index], { ...context }, depth + 1);
      if (denied) return denied;
    }
    for (const token of rawTokens) {
      const redirect = /^__WJT_REDIRECT_(\d+)__$/.exec(token);
      if (!redirect) continue;
      const target = syntax.redirects[Number(redirect[1])].replaceAll(
        /__WJT_SUBSTITUTION_\d+__/g,
        "",
      );
      const denied = privatePath(target, context);
      if (denied) return denied;
    }
    const patternCommand = ["grep", "sed"].includes(path.basename(tokens[assignments] ?? ""));
    for (
      const token of patternCommand ? pathOperands(tokens.slice(assignments), context) : tokens
    ) {
      for (const candidate of literalPaths(token)) {
        const denied = privatePath(candidate, context);
        if (denied) return denied;
      }
    }
    if (assignments === tokens.length) {
      parentContext.variables = context.variables;
      context = parentContext;
      continue;
    }
    const invocation = tokens.slice();
    while (invocation.length && (ASSIGN_RE.test(invocation[0]) || invocation[0] === "exec")) {
      invocation.shift();
    }
    if (!context.scriptText) checkUnresolvedShellCommand(invocation);
    const resolved = resolveThroughWrappers(invocation);
    if (resolved.kind === "cap-exceeded") throw new Error("wrapper nesting limit");
    if (resolved.kind === "nested") {
      const denied = inspectShell(resolved.command, { ...context }, depth + 1);
      if (denied) return denied;
      context = parentContext;
      continue;
    }
    const argv = resolved.argv.slice();
    while (argv.length && (ASSIGN_RE.test(argv[0]) || argv[0] === "exec")) argv.shift();
    const name = argv[0] === "." ? "." : path.basename(argv[0] ?? "");
    if (name === "dropbox") return "Dropbox desktop command";
    if (sweepCommand(argv, context)) return "whole-home sweep";
    if (INTERPRETERS.has(name)) {
      const shell = name === "bash" || name === "sh";
      const inline = argv.findIndex((arg) =>
        ["-c", "-e", "-p", "--eval", "--print"].includes(arg) ||
        (shell && /^-[a-z]*c[a-z]*$/.test(arg)) || (name === "deno" && arg === "eval")
      );
      if (inline >= 0 && argv[inline + 1]) {
        const denied = shell
          ? inspectShell(argv[inline + 1], { ...context }, depth + 1)
          : inspectScript(argv[inline + 1], { ...context }, depth + 1);
        if (denied) return denied;
        context = parentContext;
        continue;
      }
    }
    if (!context.scriptText && (name === "pushd" || name === "popd")) {
      throw new Error("cannot resolve shell directory stack");
    }
    if (
      !context.scriptText &&
      (name === "builtin" || name === "eval" || name === "source" || name === ".")
    ) {
      throw new Error(`cannot resolve ${name} execution`);
    }
    if (name === "cd") {
      const destinations = argv.slice(1);
      if (destinations[0] === "--") destinations.shift();
      const destination = destinations[0] ?? context.home;
      if (context.scriptText) {
        try {
          expandedPath(destination, context);
        } catch {
          continue;
        }
      }
      if (
        destinations.length > 1 || destination.startsWith("-") ||
        /^~(?!\/|$)/.test(destination) || /[*?[\]{}]/.test(expandedPath(destination, context))
      ) {
        throw new Error("cannot resolve cd target");
      }
      try {
        parentContext.cwd = resolvedPath(destination, context);
      } catch (error) {
        if (context.scriptText) continue;
        throw error;
      }
      context = parentContext;
      continue;
    }
    // Commands without operands still operate on their cwd (e.g. ls from Dropbox).
    if (
      ["ls", "rg", "find", "du", "cat", "head", "tail", "grep", "sed", "cp", "rsync", "tar"]
        .includes(name)
    ) {
      for (const arg of pathOperands(argv, context)) {
        const denied = privatePath(arg, context);
        if (denied) return denied;
      }
      if (argv.length === 1) {
        const denied = privatePath(context.cwd, context);
        if (denied) return denied;
      }
    }
    const ownPath = !INTERPRETERS.has(name) && (argv[0] ?? "").includes("/") &&
      (!context.scriptText || !/[()"'`;&|]/.test(argv[0]));
    const file = scriptArgument(argv) ?? (ownPath ? argv[0] : undefined);
    if (file !== undefined) {
      if (path.basename(file) === "dropbox") return "Dropbox desktop command";
      const privateScript = privatePath(file, context);
      if (privateScript) return privateScript;
      let filename: string;
      try {
        filename = resolvedPath(file, context);
      } catch (error) {
        if (context.scriptText) continue;
        throw error;
      }
      const denied = inspectFile(
        filename,
        context,
        depth,
        ownPath || name === "bash" || name === "sh",
        ownPath,
      );
      if (denied) return denied;
    }
    context = parentContext;
  }
  return null;
}

export function checkPrivateFolderCommand(
  command: string,
  folders: string[],
  cwd = Deno.cwd(),
  home = Deno.env.get("HOME") || "/home/joshua",
): string | null {
  try {
    return inspectShell(
      command,
      { cwd, home, folders, variables: new Map(), scripts: new Set() },
      0,
    );
  } catch (error) {
    if (error instanceof UnreadableScript) return error.message;
    return "cannot resolve command paths or inspect script — refusing";
  }
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = Deno.stdin.readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } catch {
    // Stdin closed or empty
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const full = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    full.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(full);
}

export async function main(): Promise<void> {
  let command = Deno.env.get("CMD_FOR_PY") || "";
  let toolName = "";
  let cwd = Deno.cwd();
  let invalidInput = false;

  if (!command && Deno.args.length > 0) {
    command = Deno.args.join(" ");
  }

  const rawInput = await readStdin();
  if (rawInput.trim()) {
    try {
      const data = JSON.parse(rawInput);
      if (typeof data === "object" && data !== null) {
        if (typeof data.tool_name === "string") {
          toolName = data.tool_name;
        }
        const toolInputRaw = data.tool_input ?? data.input ?? data.arguments ?? {};
        const toolInput = typeof toolInputRaw === "object" && toolInputRaw !== null
          ? (toolInputRaw as Record<string, unknown>)
          : {};
        const rawCommand = toolInput.command ?? data.command ?? "";
        if (typeof rawCommand !== "string") invalidInput = true;
        const cmdFromTool = typeof rawCommand === "string" ? rawCommand.trim() : "";
        if (cmdFromTool) {
          command = cmdFromTool;
        }
        const requestedCwd = toolInput.cwd ?? toolInput.workdir ?? data.cwd;
        if (requestedCwd !== undefined) {
          if (typeof requestedCwd !== "string" || !path.isAbsolute(requestedCwd)) {
            invalidInput = true;
          } else cwd = requestedCwd;
        }
      }
    } catch {
      invalidInput = /^[{[]/.test(rawInput.trim());
      if (!command) {
        command = rawInput.trim();
      }
    }
  }

  // If tool name is explicitly provided and is not Bash, allow (exit 0)
  if (toolName && toolName !== "Bash" && toolName !== "bash") {
    Deno.exit(0);
  }

  if (invalidInput) {
    console.error(
      "BLOCKED (private-folder read guard): cannot establish command or working directory.",
    );
    Deno.exit(2);
  }

  // If no command text was passed, allow (exit 0)
  if (!command || !command.trim()) {
    Deno.exit(0);
  }

  // Load private folders list from settings.json
  const folderResult = getPrivateDropboxFolders();
  if (!folderResult.ok) {
    console.error(
      `BLOCKED (private-folder read guard): failed to establish private Dropbox folder list: ${folderResult.error}`,
    );
    console.error(
      "~/.claude/settings.json must exist, be valid JSON, and define permissions.deny with Read(//home/joshua/Dropbox/<folder>/**) rules.",
    );
    console.error("(rule: web-jam-tools#1141 — shared private-folder read guard)");
    Deno.exit(2);
  }

  const matchedFolder = checkPrivateFolderCommand(command, folderResult.folders, cwd);
  if (matchedFolder) {
    if (matchedFolder.startsWith("Cannot read the script ")) {
      console.error(`BLOCKED (private-folder read guard): ${matchedFolder}`);
      Deno.exit(2);
    }
    console.error(
      `BLOCKED (private-folder read guard): protected Dropbox location or operation '${matchedFolder}'.`,
    );
    console.error(
      "Private Dropbox folders are protected from shell inspection across Claude Code, agy, and Codex.",
    );
    console.error("(rule: web-jam-tools#1141 — shared private-folder read guard)");
    Deno.exit(2);
  }

  Deno.exit(0);
}

if (import.meta.main) {
  await main();
}
