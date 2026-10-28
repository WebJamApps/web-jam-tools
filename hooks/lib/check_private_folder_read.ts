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
  MAX_WRAPPER_RECURSION_DEPTH,
  resolveThroughWrappers,
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
}

/** Resolve existing ancestors too, so a new file cannot conceal a symlink traversal. */
function expandedPath(value: string, context: InspectionContext): string {
  const expanded = value.replace(/^~(?=\/|$)/, context.home).replace(
    /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
    (_, name: string) => {
      const replacement = name === "HOME" ? context.home : context.variables.get(name);
      if (replacement === undefined) throw new Error("unresolved path variable");
      return replacement;
    },
  );
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
    try {
      current = Deno.realPathSync(candidate);
    } catch (err) {
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
  }
  return current;
}

function privatePath(value: string, context: InspectionContext, allowRoot = false): string | null {
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
  const operands = argv.slice(1).filter((arg) => !arg.startsWith("-"));
  const implicit = (["rg", "grep"].includes(name) && operands.length <= 1) ||
    (["find", "du", "ls"].includes(name) && operands.length === 0);
  return (implicit && homes.includes(resolvedPath(".", context))) || operands.some((arg) => {
    if (!/^(?:~|\$|\/|\.)/.test(arg)) return false;
    return homes.includes(resolvedPath(arg, context));
  });
}

function inspectScript(
  source: string,
  context: InspectionContext,
  depth: number,
  shell = false,
): string | null {
  if (depth > MAX_WRAPPER_RECURSION_DEPTH) throw new Error("script nesting limit");
  const text = source.replace(/^\s*(?:#|\/\/).*$/gm, "");
  const named = checkCommandForPrivateFolder(text, context.folders);
  if (named) return named;
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

function inspectShell(
  command: string,
  context: InspectionContext,
  depth: number,
): string | null {
  if (depth > MAX_WRAPPER_RECURSION_DEPTH) throw new Error("script/wrapper nesting limit");
  const text = stripHeredocs(command).replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, name) => `$${name}`,
  );
  if (splitOnOperators(text).unterminated) throw new Error("unparseable shell command");
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
  const parsed = splitOnOperators(shellLines.join("\n"));
  const cwdDenied = privatePath(context.cwd, context, true);
  if (cwdDenied) return cwdDenied;
  for (const segment of parsed.segments) {
    const parentContext = context;
    context = { ...parentContext, variables: new Map(parentContext.variables) };
    const named = checkCommandForPrivateFolder(segment, context.folders);
    if (named) return named;
    const tokens = splitShellTokens(segment);
    let assignments = 0;
    while (assignments < tokens.length && ASSIGN_RE.test(tokens[assignments])) {
      const token = tokens[assignments++];
      const equals = token.indexOf("=");
      context.variables.set(token.slice(0, equals), token.slice(equals + 1));
    }
    // Prefix assignments populate the child's environment after shell argument
    // expansion. They cannot establish a variable used in this command's argv.
    if (assignments < tokens.length) context.variables = new Map(parentContext.variables);
    for (const token of tokens) {
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
    const name = path.basename(argv[0] ?? "");
    if (name === "dropbox") return "Dropbox desktop command";
    if (sweepCommand(argv, context)) return "whole-home sweep";
    if (INTERPRETERS.has(name)) {
      const shell = name === "bash" || name === "sh";
      const inline = argv.findIndex((arg) =>
        ["-c", "-e", "-p", "--eval", "--print"].includes(arg) ||
        (shell && /^-[a-z]*c[a-z]*$/.test(arg)) || (name === "deno" && arg === "eval")
      );
      if (inline >= 0 && argv[inline + 1]) {
        const denied = inspectScript(argv[inline + 1], { ...context }, depth + 1, shell);
        if (denied) return denied;
        context = parentContext;
        continue;
      }
    }
    if (name === "cd") {
      parentContext.cwd = resolvedPath(argv[1] ?? context.home, context);
      context = parentContext;
      continue;
    }
    // Commands without operands still operate on their cwd (e.g. ls from Dropbox).
    if (
      ["ls", "rg", "find", "du", "cat", "head", "tail", "grep", "sed", "cp", "rsync", "tar"]
        .includes(name)
    ) {
      for (const arg of argv.slice(1).filter((word) => !word.startsWith("-"))) {
        const denied = privatePath(arg, context);
        if (denied) return denied;
      }
      if (argv.length === 1) {
        const denied = privatePath(context.cwd, context);
        if (denied) return denied;
      }
    }
    const file = scriptArgument(argv);
    if (file !== undefined) {
      if (path.basename(file) === "dropbox") return "Dropbox desktop command";
      const privateScript = privatePath(file, context);
      if (privateScript) return privateScript;
      const filename = resolvedPath(file, context);
      if (context.scripts.has(filename)) throw new Error("recursive script reference");
      const stat = Deno.statSync(filename);
      if (!stat.isFile || stat.size > MAX_SCRIPT_BYTES) throw new Error("unreadable script file");
      const scripts = new Set(context.scripts).add(filename);
      const denied = inspectScript(
        Deno.readTextFileSync(filename),
        { ...context, scripts },
        depth + 1,
        name === "bash" || name === "sh",
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
  } catch {
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
