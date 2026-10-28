/**
 * Production-media guard for ~/Dropbox/joshandmariamusic (web-jam-tools#1580).
 *
 * Refuses an agent changing an existing audio, video or image file, or removing
 * or moving a lead-sheet document, in ~/Dropbox/joshandmariamusic across
 * Claude Code, agy and Codex.
 *
 * Reads paths with the private-folder guard's module (check_private_folder_read.ts).
 * Safety guard: when it cannot tell, it refuses (exit 2).
 */

import * as path from "node:path";
import { buildFolderPattern } from "./check_private_folder_read.ts";
import {
  ASSIGN_RE,
  findHeredocMarker,
  MAX_WRAPPER_RECURSION_DEPTH,
  resolveThroughWrappers,
  splitOnOperators,
  splitShellTokens,
} from "./normalize_command.ts";
import { redirectTargets, withoutRedirections } from "./bash_write_targets.ts";

export const MEDIA_EXTENSIONS = [
  "mp3",
  "wav",
  "m4a",
  "mp4",
  "mov",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
] as const;

export const DOCUMENT_EXTENSIONS = ["pdf", "docx", "doc"] as const;

const MEDIA_EXT_RE = /\.(?:mp3|wav|m4a|mp4|mov|jpe?g|png|webp|gif)$/i;
const DOCUMENT_EXT_RE = /\.(?:pdf|docx?)$/i;

export const JOSHANDMARIAMUSIC_FOLDER_RE = buildFolderPattern("joshandmariamusic");

const READ_COMMANDS = new Set([
  "ls",
  "stat",
  "file",
  "du",
  "cd",
  "ffprobe",
  "mediainfo",
  "sha256sum",
  "md5sum",
]);

const DESTRUCTIVE_OR_MOVE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "mv",
  "trash-put",
  "trash",
]);

const FIND_DANGEROUS_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok"]);

const FIND_VALUE_FLAGS = new Set([
  "-name",
  "-iname",
  "-lname",
  "-ilname",
  "-path",
  "-ipath",
  "-wholename",
  "-iwholename",
  "-regex",
  "-iregex",
  "-type",
  "-xtype",
  "-maxdepth",
  "-mindepth",
  "-perm",
  "-user",
  "-group",
  "-uid",
  "-gid",
  "-size",
  "-mtime",
  "-atime",
  "-ctime",
  "-mmin",
  "-amin",
  "-cmin",
  "-used",
  "-links",
  "-inum",
  "-printf",
  "-fprintf",
  "-fprint",
  "-fprint0",
  "-fls",
]);

const CP_VALUE_FLAGS = new Set(["-t", "--target-directory", "-S", "--suffix"]);

const RSYNC_VALUE_FLAGS = new Set([
  "-e",
  "--rsh",
  "--exclude",
  "--include",
  "--exclude-from",
  "--include-from",
  "--files-from",
  "--log-file",
  "--temp-dir",
  "--backup-dir",
  "--suffix",
  "--compare-dest",
  "--copy-dest",
  "--link-dest",
  "--port",
  "--chmod",
  "--chown",
]);

const PYTHON_VALUE_FLAGS = new Set(["-W", "-X", "--check-hash-based-pycs"]);
const NODE_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--input-type",
  "--conditions",
  "-C",
]);
const DENO_RUN_VALUE_FLAGS = new Set([
  "--config",
  "-c",
  "--import-map",
  "--lock",
  "--ext",
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--location",
  "--seed",
  "--v8-flags",
  "--cert",
  "--unsafely-ignore-certificate-errors",
]);

const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "ksh", "dash"]);
const FILE_WRITE_TOOLS = new Set([
  "Edit",
  "Write",
  "NotebookEdit",
  "replace_file_content",
  "multi_replace_file_content",
  "write_to_file",
]);

export type CheckDecision =
  | { allowed: true }
  | { allowed: false; check: 1 | 2 | 3 | 4 | 5 | 6; reason: string };

export function isMediaFileName(name: string): boolean {
  return MEDIA_EXT_RE.test(name);
}

export function isDocumentFileName(name: string): boolean {
  return DOCUMENT_EXT_RE.test(name);
}

export function hasWildcard(raw: string): boolean {
  return /[*?[\]]/.test(raw);
}

export function getTargetRoot(home: string): string {
  return path.resolve(home, "Dropbox/joshandmariamusic");
}

export function isUnderTargetRoot(resolved: string, targetRoot: string): boolean {
  return resolved === targetRoot || resolved.startsWith(targetRoot + "/");
}

function expandVariables(
  raw: string,
  home: string,
  vars: Map<string, string>,
): string {
  let s = raw.trim();
  if (s === "~" || s.startsWith("~/")) {
    s = s === "~" ? home : `${home}/${s.slice(2)}`;
  }
  s = s.replace(/\$\{HOME\}|\$HOME(?=\/|$)/g, home);
  if (s === "/home/joshua" || s.startsWith("/home/joshua/")) {
    s = s === "/home/joshua" ? home : `${home}${s.slice("/home/joshua".length)}`;
  }
  for (const [k, v] of vars.entries()) {
    s = s.replaceAll(`\${${k}}`, v).replaceAll(`$${k}`, v);
  }
  return s;
}

export function resolveTargetPath(
  raw: string,
  cwd: string,
  home: string,
  vars: Map<string, string> = new Map(),
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Remote destination specs such as gdrive:JoshMariaMusic/ are not local filesystem paths.
  if (/^[a-zA-Z0-9_.-]+:(?!\/)/.test(trimmed)) return null;

  const expanded = expandVariables(trimmed, home, vars);
  if (!expanded || /[$`]/.test(expanded)) return null;

  const joined = expanded.startsWith("/") ? expanded : `${cwd.replace(/\/+$/, "")}/${expanded}`;
  return path.resolve(joined);
}

export function fileExistsUnderTarget(resolved: string, targetRoot: string): boolean {
  try {
    const st = Deno.statSync(resolved);
    if (st.isFile) return true;
  } catch {
    // Fall through to case-insensitive check in parent directory
  }
  if (!resolved.startsWith(targetRoot + "/")) return false;
  const dir = path.dirname(resolved);
  const baseLower = path.basename(resolved).toLowerCase();
  try {
    for (const entry of Deno.readDirSync(dir)) {
      if (entry.isFile && entry.name.toLowerCase() === baseLower) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function isDirectoryOnDisk(resolved: string): boolean {
  try {
    return Deno.statSync(resolved).isDirectory;
  } catch {
    return false;
  }
}

export function directoryHoldsMediaOrDocument(dirPath: string): boolean {
  try {
    for (const entry of Deno.readDirSync(dirPath)) {
      if (entry.isFile && (isMediaFileName(entry.name) || isDocumentFileName(entry.name))) {
        return true;
      }
      if (entry.isDirectory) {
        if (directoryHoldsMediaOrDocument(path.join(dirPath, entry.name))) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

function matchWildcardSegment(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const s = name.toLowerCase();
  let pi = 0;
  let si = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (si < s.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
      pi++;
      si++;
    } else if (pi < p.length && p[pi] === "*") {
      starIdx = pi;
      matchIdx = si;
      pi++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx++;
      si = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < p.length && p[pi] === "*") {
    pi++;
  }
  return pi === p.length;
}

function matchGlobSegments(dirPath: string, segments: string[]): boolean {
  if (segments.length === 0) {
    return directoryHoldsMediaOrDocument(dirPath);
  }
  const [head, ...tail] = segments;
  if (head === "**") {
    if (matchGlobSegments(dirPath, tail)) return true;
    try {
      for (const entry of Deno.readDirSync(dirPath)) {
        if (entry.isDirectory && matchGlobSegments(path.join(dirPath, entry.name), segments)) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }
  try {
    for (const entry of Deno.readDirSync(dirPath)) {
      if (!matchWildcardSegment(head, entry.name)) continue;
      const full = path.join(dirPath, entry.name);
      if (tail.length === 0) {
        if (entry.isFile && (isMediaFileName(entry.name) || isDocumentFileName(entry.name))) {
          return true;
        }
        if (entry.isDirectory && directoryHoldsMediaOrDocument(full)) {
          return true;
        }
      } else if (entry.isDirectory) {
        if (matchGlobSegments(full, tail)) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function wildcardHoldsMediaOrDocument(globPath: string, targetRoot: string): boolean {
  if (!isUnderTargetRoot(globPath, targetRoot)) return false;
  const rel = globPath.slice(targetRoot.length).replace(/^\/+/, "");
  const parts = rel ? rel.split("/") : [];
  let baseDir = targetRoot;
  let idx = 0;
  while (idx < parts.length && !hasWildcard(parts[idx])) {
    baseDir = path.join(baseDir, parts[idx]);
    idx++;
  }
  if (!isDirectoryOnDisk(baseDir)) return false;
  return matchGlobSegments(baseDir, parts.slice(idx));
}

function isDestructiveOrMoveCommand(cmdName: string, args: string[]): boolean {
  if (DESTRUCTIVE_OR_MOVE_COMMANDS.has(cmdName)) return true;
  if (cmdName === "gio") {
    const sub = args.find((a) => !a.startsWith("-"));
    return sub === "trash" || sub === "remove";
  }
  if (cmdName === "find") {
    return args.some((a) => FIND_DANGEROUS_FLAGS.has(a));
  }
  if (cmdName === "rsync") {
    return args.some((a) =>
      a === "--delete" || a.startsWith("--delete-") || a === "--remove-source-files"
    );
  }
  if (cmdName === "rclone") {
    const sub = args.find((a) => !a.startsWith("-"));
    return sub === "delete" || sub === "deletefile" || sub === "purge" || sub === "move" ||
      sub === "sync" || sub === "rmdir" || sub === "rmdirs";
  }
  return false;
}

function getPositionalArgIndices(
  args: string[],
  valueFlags: Set<string>,
): number[] {
  const indices: number[] = [];
  let endOfOpts = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!endOfOpts && a === "--") {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && a.startsWith("-") && a !== "-") {
      if (valueFlags.has(a)) i++;
      continue;
    }
    indices.push(i);
  }
  return indices;
}

function isAllowedCopySource(cmdName: string, args: string[], argIndex: number): boolean {
  if (
    args.some((a) => a === "--delete" || a.startsWith("--delete-") || a === "--remove-source-files")
  ) {
    return false;
  }

  if (cmdName === "cp") {
    if (args.some((a) => a === "-t" || a.startsWith("--target-directory"))) {
      return false;
    }
    const pos = getPositionalArgIndices(args, CP_VALUE_FLAGS);
    return pos.length >= 2 && pos.includes(argIndex) && argIndex !== pos[pos.length - 1];
  }

  if (cmdName === "rsync") {
    const pos = getPositionalArgIndices(args, RSYNC_VALUE_FLAGS);
    return pos.length >= 2 && pos.includes(argIndex) && argIndex !== pos[pos.length - 1];
  }

  if (cmdName === "rclone") {
    const pos = getPositionalArgIndices(args, new Set());
    if (pos.length < 3) return false;
    const subIndex = pos[0];
    if (args[subIndex] !== "copy") return false;
    const copyPos = pos.slice(1);
    return copyPos.length >= 2 && copyPos.includes(argIndex) &&
      argIndex !== copyPos[copyPos.length - 1];
  }

  return false;
}

function extractHeredocs(command: string): { body: string; line: string }[] {
  const lines = command.split("\n");
  const out: { body: string; line: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = findHeredocMarker(line);
    if (!marker) continue;
    const [word, stripTabs] = marker;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const probe = stripTabs ? lines[j].replace(/^\t+/, "") : lines[j];
      if (probe.replace(/\r$/, "") === word) break;
      body.push(lines[j]);
    }
    out.push({ body: body.join("\n"), line });
    i = j;
  }
  return out;
}

function extractQuotedLiterals(scriptText: string): string[] {
  const literals: string[] = [];
  const re = /(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scriptText)) !== null) {
    if (m[2]) literals.push(m[2]);
  }
  return literals;
}

const SCRIPT_DESTRUCTIVE_RE =
  /\b(?:os\.(?:remove|unlink|rmdir|removedirs|rename|replace)|shutil\.(?:rmtree|move)|Deno\.(?:remove|removeSync|rename|renameSync)|fs\.(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync)|(?:\w+\.)?(?:unlink|rmdir|rename|replace)\s*\(|rm|rmdir|unlink|shred|mv|trash-put|gio\s+(?:trash|remove))\b/;

function checkScriptContents(
  scriptText: string,
  interpreter: string,
  cwd: string,
  home: string,
  targetRoot: string,
  depth: number,
): CheckDecision {
  if (depth > MAX_WRAPPER_RECURSION_DEPTH) {
    return {
      allowed: false,
      check: 6,
      reason: "script nesting depth exceeded maximum limit",
    };
  }

  const cwdInTarget = isUnderTargetRoot(cwd, targetRoot);
  const mentionsTarget = JOSHANDMARIAMUSIC_FOLDER_RE.test(scriptText) ||
    /joshandmariamusic/i.test(scriptText);

  if (!cwdInTarget && !mentionsTarget) {
    return { allowed: true };
  }

  if (SHELL_INTERPRETERS.has(interpreter)) {
    const shellCheck = checkShellCommand(scriptText, cwd, home, depth + 1);
    if (!shellCheck.allowed) {
      return {
        allowed: false,
        check: 4,
        reason: `script contents triggered check ${shellCheck.check}: ${shellCheck.reason}`,
      };
    }
  }

  const hasDestructiveCall = SCRIPT_DESTRUCTIVE_RE.test(scriptText);
  const literals = extractQuotedLiterals(scriptText);

  for (const lit of literals) {
    if (/^(?:Read|Edit|Write|NotebookEdit|Bash)\(/.test(lit)) continue;
    const resolved = resolveTargetPath(lit, cwd, home);
    if (!resolved || !isUnderTargetRoot(resolved, targetRoot)) continue;

    const base = path.basename(resolved);
    const glob = hasWildcard(lit);

    if (isMediaFileName(base) && (glob || fileExistsUnderTarget(resolved, targetRoot))) {
      return {
        allowed: false,
        check: 4,
        reason: `script references existing production media file '${lit}'`,
      };
    }

    if (hasDestructiveCall) {
      if (isDocumentFileName(base) && (glob || fileExistsUnderTarget(resolved, targetRoot))) {
        return {
          allowed: false,
          check: 4,
          reason: `script removes or moves existing document '${lit}'`,
        };
      }
      if (
        (!glob && isDirectoryOnDisk(resolved) && directoryHoldsMediaOrDocument(resolved)) ||
        (glob && wildcardHoldsMediaOrDocument(resolved, targetRoot))
      ) {
        return {
          allowed: false,
          check: 4,
          reason: `script removes or moves directory/wildcard '${lit}' holding media or documents`,
        };
      }
    }
  }

  return { allowed: true };
}

function findScriptArgument(
  cmdName: string,
  args: string[],
): { kind: "file"; path: string } | { kind: "inline"; code: string } | null {
  if (cmdName === "python3" || cmdName === "python" || /^python\d+(?:\.\d+)*$/.test(cmdName)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-c") {
        return { kind: "inline", code: args[i + 1] ?? "" };
      }
      if (a === "-m") return null;
      if (a === "--") {
        return args[i + 1] ? { kind: "file", path: args[i + 1] } : null;
      }
      if (a.startsWith("-") && a !== "-") {
        if (PYTHON_VALUE_FLAGS.has(a)) i++;
        continue;
      }
      if (a !== "-") return { kind: "file", path: a };
    }
    return null;
  }

  if (cmdName === "node" || cmdName === "nodejs") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-e" || a === "--eval" || a === "-p" || a === "--print") {
        return { kind: "inline", code: args[i + 1] ?? "" };
      }
      if (a === "--") {
        return args[i + 1] ? { kind: "file", path: args[i + 1] } : null;
      }
      if (a.startsWith("-") && a !== "-") {
        if (NODE_VALUE_FLAGS.has(a)) i++;
        continue;
      }
      if (a !== "-") return { kind: "file", path: a };
    }
    return null;
  }

  if (cmdName === "deno") {
    if (args[0] === "eval") {
      const codeArgs = args.slice(1).filter((a) => !a.startsWith("-"));
      return { kind: "inline", code: codeArgs.join(" ") };
    }
    if (args[0] !== "run") return null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === "--") {
        return args[i + 1] ? { kind: "file", path: args[i + 1] } : null;
      }
      if (a.startsWith("-") && a !== "-") {
        if (DENO_RUN_VALUE_FLAGS.has(a)) i++;
        continue;
      }
      if (a !== "-") return { kind: "file", path: a };
    }
    return null;
  }

  if (SHELL_INTERPRETERS.has(cmdName)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-c") {
        return { kind: "inline", code: args[i + 1] ?? "" };
      }
      if (a === "--") {
        return args[i + 1] ? { kind: "file", path: args[i + 1] } : null;
      }
      if ((a === "-o" || a === "+o") && i + 1 < args.length) {
        i++;
        continue;
      }
      if (a.startsWith("-") || a.startsWith("+")) continue;
      return { kind: "file", path: a };
    }
    return null;
  }

  return null;
}

function hasTrailingUnescapedBackslash(text: string): boolean {
  let slashes = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === "\\"; i--) {
    slashes++;
  }
  return slashes % 2 === 1;
}

export function checkShellCommand(
  command: string,
  cwd: string,
  home: string,
  depth = 0,
): CheckDecision {
  if (depth > MAX_WRAPPER_RECURSION_DEPTH) {
    return {
      allowed: false,
      check: 6,
      reason: "command nesting depth exceeded maximum limit",
    };
  }

  if (!command || !command.trim()) {
    return {
      allowed: false,
      check: 6,
      reason: "empty or unparseable shell command",
    };
  }

  if (hasTrailingUnescapedBackslash(command.trimEnd())) {
    return {
      allowed: false,
      check: 6,
      reason: "command has trailing unescaped backslash",
    };
  }

  let splitResult: { segments: string[]; unterminated: boolean };
  try {
    splitResult = splitOnOperators(command);
  } catch (err) {
    return {
      allowed: false,
      check: 6,
      reason: `command could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (splitResult.unterminated) {
    return {
      allowed: false,
      check: 6,
      reason: "command contains an unterminated quote or heredoc",
    };
  }

  const targetRoot = getTargetRoot(home);

  // Check 4: inspect heredoc bodies
  for (const h of extractHeredocs(command)) {
    const words = splitShellTokens(h.line.replace(/[|;&()]/g, " ")).map((w) =>
      w.split("/").pop() ?? w
    );
    const interp = words.find((w) => SHELL_INTERPRETERS.has(w)) ?? "python3";
    const heredocDecision = checkScriptContents(
      h.body,
      interp,
      cwd,
      home,
      targetRoot,
      depth + 1,
    );
    if (!heredocDecision.allowed) return heredocDecision;
  }

  let currentCwd = cwd;
  const vars = new Map<string, string>();

  for (const segment of splitResult.segments) {
    // Check redirections on this segment (Check 1)
    for (const redirWord of redirectTargets(segment)) {
      const resolved = resolveTargetPath(redirWord, currentCwd, home, vars);
      if (resolved && isUnderTargetRoot(resolved, targetRoot)) {
        const base = path.basename(resolved);
        const glob = hasWildcard(redirWord);
        if (isMediaFileName(base) && (glob || fileExistsUnderTarget(resolved, targetRoot))) {
          return {
            allowed: false,
            check: 1,
            reason: `redirection targets existing production media file '${redirWord}'`,
          };
        }
      }
    }

    const tokens = withoutRedirections(splitShellTokens(segment));
    if (tokens.length === 0) continue;

    // Collect leading variable assignments
    let assignIdx = 0;
    while (assignIdx < tokens.length && ASSIGN_RE.test(tokens[assignIdx])) {
      const tok = tokens[assignIdx];
      const eq = tok.indexOf("=");
      const varName = tok.slice(0, eq);
      const varVal = expandVariables(tok.slice(eq + 1), home, vars);
      vars.set(varName, varVal);
      assignIdx++;
    }
    if (assignIdx >= tokens.length) continue;

    const resolution = resolveThroughWrappers(tokens.slice(assignIdx));
    if (resolution.kind === "cap-exceeded") {
      return {
        allowed: false,
        check: 6,
        reason: "wrapper recursion cap exceeded",
      };
    }
    if (resolution.kind === "nested") {
      const nestedDecision = checkShellCommand(resolution.command, currentCwd, home, depth + 1);
      if (!nestedDecision.allowed) return nestedDecision;
      continue;
    }

    const argv = resolution.argv;
    let cmdIdx = 0;
    while (cmdIdx < argv.length && ASSIGN_RE.test(argv[cmdIdx])) {
      const tok = argv[cmdIdx];
      const eq = tok.indexOf("=");
      vars.set(tok.slice(0, eq), expandVariables(tok.slice(eq + 1), home, vars));
      cmdIdx++;
    }
    if (cmdIdx >= argv.length) continue;

    const cmdToken = argv[cmdIdx];
    const cmdName = cmdToken.split("/").pop() ?? cmdToken;
    const args = argv.slice(cmdIdx + 1);

    // Follow `cd`
    if (cmdName === "cd") {
      const dirArg = args.find((a) => !a.startsWith("-")) ?? home;
      if (dirArg !== "-") {
        const resolvedCd = resolveTargetPath(dirArg, currentCwd, home, vars);
        if (resolvedCd) {
          currentCwd = resolvedCd;
        }
      }
      continue;
    }

    // Check 4: script file or inline code given to python3, python, deno run, node, bash or sh
    const scriptTarget = findScriptArgument(cmdName, args);
    if (scriptTarget) {
      if (scriptTarget.kind === "inline") {
        const inlineDecision = checkScriptContents(
          scriptTarget.code,
          cmdName,
          currentCwd,
          home,
          targetRoot,
          depth + 1,
        );
        if (!inlineDecision.allowed) return inlineDecision;
      } else {
        const resolvedScript = resolveTargetPath(scriptTarget.path, currentCwd, home, vars);
        if (!resolvedScript) {
          return {
            allowed: false,
            check: 6,
            reason: `cannot resolve script path '${scriptTarget.path}'`,
          };
        }
        let scriptText: string;
        try {
          scriptText = Deno.readTextFileSync(resolvedScript);
        } catch (err) {
          return {
            allowed: false,
            check: 4,
            reason: `cannot read script file '${resolvedScript}': ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
        const fileDecision = checkScriptContents(
          scriptText,
          cmdName,
          currentCwd,
          home,
          targetRoot,
          depth + 1,
        );
        if (!fileDecision.allowed) return fileDecision;
      }
    }

    const destructiveOrMove = isDestructiveOrMoveCommand(cmdName, args);

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") continue;

      // Skip predicate value arguments of `find` (e.g. `-name "*.tmp"`) so starting-point
      // directories determine Check 2 rather than filter predicates.
      if (cmdName === "find" && FIND_VALUE_FLAGS.has(arg)) {
        i++;
        continue;
      }

      let rawPath = arg;
      if (arg.startsWith("-")) {
        if (!arg.includes("=")) continue;
        rawPath = arg.slice(arg.indexOf("=") + 1);
      } else if (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(arg)) {
        rawPath = arg.slice(arg.indexOf("=") + 1);
      }

      const resolved = resolveTargetPath(rawPath, currentCwd, home, vars);
      if (!resolved || !isUnderTargetRoot(resolved, targetRoot)) continue;

      const base = path.basename(resolved);
      const glob = hasWildcard(rawPath);

      // Check 1: existing media file under ~/Dropbox/joshandmariamusic, or wildcard ending in media file name
      if (isMediaFileName(base) && (glob || fileExistsUnderTarget(resolved, targetRoot))) {
        const isReadCmd = READ_COMMANDS.has(cmdName);
        const isSafeFind = cmdName === "find" && !args.some((a) => FIND_DANGEROUS_FLAGS.has(a));
        const isCopySrc = isAllowedCopySource(cmdName, args, i);
        if (!isReadCmd && !isSafeFind && !isCopySrc) {
          return {
            allowed: false,
            check: 1,
            reason: `command '${cmdName}' names production media '${rawPath}'`,
          };
        }
      }

      if (destructiveOrMove) {
        // Check 3: existing document or wildcard ending in document name
        if (isDocumentFileName(base) && (glob || fileExistsUnderTarget(resolved, targetRoot))) {
          return {
            allowed: false,
            check: 3,
            reason: `command '${cmdName}' removes, moves or replaces document '${rawPath}'`,
          };
        }

        // Check 2: directory or wildcard holding a media file or document at any depth
        if (
          (!glob && isDirectoryOnDisk(resolved) && directoryHoldsMediaOrDocument(resolved)) ||
          (glob && wildcardHoldsMediaOrDocument(resolved, targetRoot))
        ) {
          return {
            allowed: false,
            check: 2,
            reason:
              `command '${cmdName}' targets directory or wildcard '${rawPath}' holding production media or documents`,
          };
        }
      }
    }
  }

  return { allowed: true };
}

interface PatchOperation {
  kind: "add" | "update" | "delete";
  filePath: string;
  moveTo?: string;
}

export function parseApplyPatchOperations(patchText: string): PatchOperation[] | null {
  if (!patchText || typeof patchText !== "string" || !patchText.trim()) {
    return null;
  }

  const lines = patchText.split(/\r?\n/);
  const ops: PatchOperation[] = [];
  let currentOp: PatchOperation | null = null;

  for (const line of lines) {
    if (!line.startsWith("***")) continue;
    const trimmed = line.trim();
    if (
      trimmed === "*** Begin Patch" ||
      trimmed === "*** End Patch" ||
      trimmed === "*** End of File"
    ) {
      continue;
    }

    const headerMatch = trimmed.match(
      /^\*\*\*\s*(Add File|Update File|Delete File|Move to):\s*(.*)$/,
    );
    if (!headerMatch) {
      return null;
    }
    const action = headerMatch[1];
    const target = headerMatch[2].trim().replace(/^["']|["']$/g, "").trim();
    if (!target) {
      return null;
    }

    if (action === "Move to") {
      if (!currentOp || currentOp.kind !== "update") {
        return null;
      }
      currentOp.moveTo = target;
    } else {
      const kind = action === "Add File" ? "add" : action === "Update File" ? "update" : "delete";
      currentOp = { kind, filePath: target };
      ops.push(currentOp);
    }
  }

  return ops.length > 0 ? ops : null;
}

export function checkApplyPatch(
  patchText: string,
  cwd: string,
  home: string,
): CheckDecision {
  const ops = parseApplyPatchOperations(patchText);
  if (!ops) {
    return {
      allowed: false,
      check: 6,
      reason: "apply_patch contains no parseable file headers",
    };
  }

  const targetRoot = getTargetRoot(home);

  for (const op of ops) {
    const resolved = resolveTargetPath(op.filePath, cwd, home);
    if (!resolved) {
      return {
        allowed: false,
        check: 6,
        reason: `apply_patch path '${op.filePath}' cannot be resolved`,
      };
    }

    if (isUnderTargetRoot(resolved, targetRoot)) {
      const base = path.basename(resolved);
      if (isMediaFileName(base) && fileExistsUnderTarget(resolved, targetRoot)) {
        return {
          allowed: false,
          check: 5,
          reason: `apply_patch ${op.kind}s existing production media file '${op.filePath}'`,
        };
      }
      if (
        (op.kind === "delete" || (op.kind === "update" && op.moveTo !== undefined)) &&
        isDocumentFileName(base) &&
        fileExistsUnderTarget(resolved, targetRoot)
      ) {
        return {
          allowed: false,
          check: 5,
          reason: `apply_patch ${
            op.kind === "delete" ? "deletes" : "moves"
          } existing document '${op.filePath}'`,
        };
      }
    }

    if (op.moveTo !== undefined) {
      const moveResolved = resolveTargetPath(op.moveTo, cwd, home);
      if (!moveResolved) {
        return {
          allowed: false,
          check: 6,
          reason: `apply_patch move destination '${op.moveTo}' cannot be resolved`,
        };
      }
      if (isUnderTargetRoot(moveResolved, targetRoot)) {
        const moveBase = path.basename(moveResolved);
        if (isMediaFileName(moveBase) && fileExistsUnderTarget(moveResolved, targetRoot)) {
          return {
            allowed: false,
            check: 5,
            reason: `apply_patch moves onto existing production media file '${op.moveTo}'`,
          };
        }
        if (isDocumentFileName(moveBase) && fileExistsUnderTarget(moveResolved, targetRoot)) {
          return {
            allowed: false,
            check: 5,
            reason: `apply_patch moves onto existing document '${op.moveTo}'`,
          };
        }
      }
    }
  }

  return { allowed: true };
}

export function checkFileToolWrite(
  toolInput: Record<string, unknown>,
  cwd: string,
  home: string,
): CheckDecision {
  const rawPath = String(
    toolInput.file_path ??
      toolInput.notebook_path ??
      toolInput.path ??
      toolInput.TargetFile ??
      toolInput.target_file ??
      "",
  ).trim();

  if (!rawPath) {
    return {
      allowed: false,
      check: 6,
      reason: "file tool call has no parseable target path",
    };
  }

  const resolved = resolveTargetPath(rawPath, cwd, home);
  if (!resolved) {
    return {
      allowed: false,
      check: 6,
      reason: `file tool path '${rawPath}' cannot be resolved`,
    };
  }

  const targetRoot = getTargetRoot(home);
  if (isUnderTargetRoot(resolved, targetRoot)) {
    const base = path.basename(resolved);
    if (isMediaFileName(base) && fileExistsUnderTarget(resolved, targetRoot)) {
      return {
        allowed: false,
        check: 5,
        reason: `file tool write targets existing production media file '${rawPath}'`,
      };
    }
  }

  return { allowed: true };
}

function collectWholeStringPaths(val: unknown, out: string[]): void {
  if (typeof val === "string") {
    if (
      !/[\r\n]/.test(val) &&
      (val.startsWith("/") ||
        val.startsWith("~/") ||
        val === "~" ||
        val.startsWith("$HOME/") ||
        val === "$HOME" ||
        val.startsWith("${HOME}/") ||
        val === "${HOME}")
    ) {
      out.push(val);
    }
    return;
  }
  if (Array.isArray(val)) {
    for (const item of val) collectWholeStringPaths(item, out);
    return;
  }
  if (val !== null && typeof val === "object") {
    for (const v of Object.values(val as Record<string, unknown>)) {
      collectWholeStringPaths(v, out);
    }
  }
}

export function checkAgyUntranslated(
  toolInput: unknown,
  cwd: string,
  home: string,
): CheckDecision {
  if (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return {
      allowed: false,
      check: 6,
      reason: "untranslated agy tool call arguments cannot be read",
    };
  }

  const paths: string[] = [];
  collectWholeStringPaths(toolInput, paths);
  const targetRoot = getTargetRoot(home);

  for (const rawPath of paths) {
    const resolved = resolveTargetPath(rawPath, cwd, home);
    if (!resolved || !isUnderTargetRoot(resolved, targetRoot)) continue;
    const base = path.basename(resolved);
    const glob = hasWildcard(rawPath);
    if (isMediaFileName(base) && (glob || fileExistsUnderTarget(resolved, targetRoot))) {
      return {
        allowed: false,
        check: 5,
        reason: `untranslated agy tool names existing production media file '${rawPath}'`,
      };
    }
  }

  return { allowed: true };
}

export function evaluatePayload(
  rawInput: string,
  defaultCwd?: string,
  homeOverride?: string,
): CheckDecision {
  const home = homeOverride || Deno.env.get("HOME") || Deno.env.get("USERPROFILE") ||
    "/home/joshua";
  const fallbackCwd = defaultCwd || Deno.cwd();

  if (!rawInput || !rawInput.trim()) {
    return {
      allowed: false,
      check: 6,
      reason: "hook payload is empty",
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(rawInput);
  } catch {
    return {
      allowed: false,
      check: 6,
      reason: "hook payload is not valid JSON",
    };
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {
      allowed: false,
      check: 6,
      reason: "hook payload is not a JSON object",
    };
  }

  const record = data as Record<string, unknown>;
  const toolCall = typeof record.toolCall === "object" && record.toolCall !== null &&
      !Array.isArray(record.toolCall)
    ? (record.toolCall as Record<string, unknown>)
    : undefined;

  const toolName = String(
    record.tool_name ?? record.name ?? toolCall?.name ?? "",
  ).trim();

  if (!toolName) {
    return {
      allowed: false,
      check: 6,
      reason: "tool_name is missing from hook payload",
    };
  }

  const toolInputRaw = record.tool_input ?? toolCall?.args ?? record.input ?? record.arguments;
  const toolInput = typeof toolInputRaw === "object" && toolInputRaw !== null &&
      !Array.isArray(toolInputRaw)
    ? (toolInputRaw as Record<string, unknown>)
    : null;

  const payloadCwd = typeof record.cwd === "string" && record.cwd.trim()
    ? record.cwd.trim()
    : typeof toolInput?.cwd === "string" && toolInput.cwd.trim()
    ? toolInput.cwd.trim()
    : typeof toolInput?.Cwd === "string" && toolInput.Cwd.trim()
    ? toolInput.Cwd.trim()
    : fallbackCwd;

  const resolvedCwd = resolveTargetPath(payloadCwd, fallbackCwd, home) ?? fallbackCwd;

  if (toolName === "Bash" || toolName === "bash" || toolName === "run_command") {
    if (!toolInput) {
      return {
        allowed: false,
        check: 6,
        reason: "Bash tool_input is missing or invalid",
      };
    }
    const command = String(
      toolInput.command ?? toolInput.CommandLine ?? record.command ?? "",
    );
    return checkShellCommand(command, resolvedCwd, home);
  }

  if (toolName === "apply_patch") {
    if (!toolInput) {
      return {
        allowed: false,
        check: 6,
        reason: "apply_patch tool_input is missing or invalid",
      };
    }
    const patchText = String(toolInput.command ?? toolInput.patch ?? "");
    return checkApplyPatch(patchText, resolvedCwd, home);
  }

  if (FILE_WRITE_TOOLS.has(toolName)) {
    if (!toolInput) {
      return {
        allowed: false,
        check: 6,
        reason: `${toolName} tool_input is missing or invalid`,
      };
    }
    return checkFileToolWrite(toolInput, resolvedCwd, home);
  }

  if (toolName === "Read") {
    return { allowed: true };
  }

  return checkAgyUntranslated(toolInputRaw, resolvedCwd, home);
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
  const rawInput = await readStdin();
  const decision = evaluatePayload(rawInput);
  if (!decision.allowed) {
    console.error(
      `BLOCKED (production-media guard — check ${decision.check}): ${decision.reason}.`,
    );
    console.error(
      "Existing audio, video, and image files in ~/Dropbox/joshandmariamusic may not be changed, moved, or deleted, and lead-sheet documents there may not be removed or moved.",
    );
    console.error("(rule: web-jam-tools#1580 — production-media guard)");
    Deno.exit(2);
  }
  Deno.exit(0);
}

if (import.meta.main) {
  await main();
}
