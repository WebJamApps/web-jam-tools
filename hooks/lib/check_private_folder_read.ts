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
  MAX_WRAPPER_ITERATIONS,
  type Quote,
  readInterpreterHeredocs,
  readInterpreterScript,
  resolveThroughWrappers,
  resolveWrapperLayer,
  scanHeredocLine,
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
const MAX_SCRIPT_DEPTH = 6;
const MAX_SHELL_DEPTH = 12;
const CMD_VALUE = "__WJT_CMD_VAL__";
const COULD_NOT_READ_REFUSAL = "cannot resolve command paths or inspect script — refusing";
const SHELL_KEYWORDS = new Set(["while", "until", "if", "elif", "then", "do", "else"]);

interface DepthState {
  scriptDepth: number;
  shellDepth: number;
}

function protectSingleQuotedMetachars(text: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === '"' && ch === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      // In double quotes, bash preserves '\' unless escaping '"', '\', '$', '`', or newline.
      out += `\\${'"\\$`\n'.includes(next) ? "" : "\\"}${next}`;
      i++;
      continue;
    }
    if (quote !== "'" && ch === "\\" && i + 1 < text.length) {
      out += text.slice(i, i + 2);
      i++;
      continue;
    }
    if (!quote) {
      if (ch === "'" || ch === '"') quote = ch;
      out += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = "";
      out += ch;
      continue;
    }
    if (ch === "'") {
      quote = "";
      out += ch;
    } else if (ch === "$") out += "__WJT_SQ_DOLLAR__";
    else if (ch === "`") out += "__WJT_SQ_BACKTICK__";
    else if (ch === "*") out += "__WJT_SQ_STAR__";
    else if (ch === "?") out += "__WJT_SQ_QMARK__";
    else if (ch === "[") out += "__WJT_SQ_LBRACK__";
    else if (ch === "]") out += "__WJT_SQ_RBRACK__";
    else out += ch;
  }
  return out;
}

function unprotectSingleQuotedMetachars(text: string): string {
  return text
    .replaceAll("__WJT_SQ_DOLLAR__", "$")
    .replaceAll("__WJT_SQ_BACKTICK__", "`")
    .replaceAll("__WJT_SQ_STAR__", "*")
    .replaceAll("__WJT_SQ_QMARK__", "?")
    .replaceAll("__WJT_SQ_LBRACK__", "[")
    .replaceAll("__WJT_SQ_RBRACK__", "]");
}

interface InspectionContext {
  cwd: string;
  home: string;
  folders: string[];
  variables: Map<string, string>;
  scripts: Set<string>;
  scriptText?: boolean;
  allowProcReadlink?: boolean;
}

class UnresolvedPathError extends Error {
  constructor(message: string) {
    super(message);
  }
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

function lookupPathVariable(name: string, context: InspectionContext): string | undefined {
  if (name === "HOME") return context.home;
  if (context.variables.has(name)) return context.variables.get(name);
  return Deno.env.get(name) || undefined;
}

function globToPatternSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") out += "[\\s\\S]*";
    else if (ch === "?") out += "[\\s\\S]";
    else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close > i + 1) {
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        out += `[${cls}]`;
        i = close;
        continue;
      }
      out += "\\[";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

function stripAffixGlob(
  val: string,
  op: "%" | "%%" | "#" | "##",
  pat: string,
): string {
  const regex = new RegExp(`^${globToPatternSource(pat)}$`);
  if (op === "%") {
    for (let i = val.length; i >= 0; i--) {
      if (regex.test(val.slice(i))) return val.slice(0, i);
    }
    return val;
  }
  if (op === "%%") {
    for (let i = 0; i <= val.length; i++) {
      if (regex.test(val.slice(i))) return val.slice(0, i);
    }
    return val;
  }
  if (op === "#") {
    for (let i = 0; i <= val.length; i++) {
      if (regex.test(val.slice(0, i))) return val.slice(i);
    }
    return val;
  }
  for (let i = val.length; i >= 0; i--) {
    if (regex.test(val.slice(0, i))) return val.slice(i);
  }
  return val;
}

function sliceBashSubstring(val: string, offsetRaw: string, lenRaw?: string): string | null {
  const offTrim = offsetRaw.trim();
  const offset = Number(offTrim);
  if (!offTrim || !Number.isInteger(offset)) return null;
  const start = offset < 0 ? Math.max(val.length + offset, 0) : offset;
  if (lenRaw === undefined) return val.slice(start);
  const lenTrim = lenRaw.trim();
  const len = Number(lenTrim);
  if (!lenTrim || !Number.isInteger(len)) return null;
  if (len >= 0) return val.slice(start, start + len);
  const end = Math.max(val.length + len, 0);
  return start <= end ? val.slice(start, end) : "";
}

function findClosingBrace(text: string, openBraceIdx: number): number {
  let depth = 1;
  for (let i = openBraceIdx + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

function resolveBracedExpression(
  inner: string,
  context: InspectionContext,
  seen: Set<string>,
  strict: boolean,
): string | null {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) {
    if (seen.has(inner)) throw new Error("cyclic path variable");
    const replacement = lookupPathVariable(inner, context);
    if (replacement === undefined) {
      if (strict) throw new UnresolvedPathError("unresolved path variable");
      return null;
    }
    return expandVariablesText(replacement, context, new Set(seen).add(inner), strict);
  }

  const defMatch = /^([A-Za-z_][A-Za-z0-9_]*)(:-|-)(.*)$/s.exec(inner);
  if (defMatch) {
    const [, name, op, defVal] = defMatch;
    if (seen.has(name)) throw new Error("cyclic path variable");
    const raw = lookupPathVariable(name, context);
    const nextSeen = new Set(seen).add(name);
    if (raw === undefined) {
      return expandVariablesText(defVal, context, nextSeen, strict);
    }
    const resolved = expandVariablesText(raw, context, nextSeen, strict);
    if (op === ":-" && resolved === "") {
      return expandVariablesText(defVal, context, nextSeen, strict);
    }
    return resolved;
  }

  const affixMatch = /^([A-Za-z_][A-Za-z0-9_]*)(%%|%|##|#)(.*)$/s.exec(inner);
  if (affixMatch) {
    const [, name, op, rawPat] = affixMatch;
    if (seen.has(name)) throw new Error("cyclic path variable");
    const raw = lookupPathVariable(name, context);
    if (raw === undefined) {
      if (strict) throw new UnresolvedPathError("unresolved path variable");
      return null;
    }
    const nextSeen = new Set(seen).add(name);
    const resolvedVal = expandVariablesText(raw, context, nextSeen, strict);
    const resolvedPat = expandVariablesText(rawPat, context, nextSeen, strict);
    if (resolvedVal === null || resolvedPat === null) return null;
    return stripAffixGlob(resolvedVal, op as "%" | "%%" | "#" | "##", resolvedPat);
  }

  const sliceMatch = /^([A-Za-z_][A-Za-z0-9_]*):(?![-+?=])([^:]*)(?::(.*))?$/s.exec(inner);
  if (sliceMatch) {
    const [, name, offRaw, lenRaw] = sliceMatch;
    if (seen.has(name)) throw new Error("cyclic path variable");
    const raw = lookupPathVariable(name, context);
    if (raw === undefined) {
      if (strict) throw new UnresolvedPathError("unresolved path variable");
      return null;
    }
    const resolvedVal = expandVariablesText(raw, context, new Set(seen).add(name), strict);
    if (resolvedVal === null) return null;
    const sliced = sliceBashSubstring(resolvedVal, offRaw, lenRaw);
    if (sliced === null) {
      if (strict) throw new UnresolvedPathError("unresolved path variable");
      return null;
    }
    return sliced;
  }

  if (strict) throw new UnresolvedPathError("unresolved path variable");
  return null;
}

function expandVariablesText(
  text: string,
  context: InspectionContext,
  seen: Set<string>,
  strict: boolean,
): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$") {
      out += text[i];
      continue;
    }
    if (text[i + 1] === "{") {
      const close = findClosingBrace(text, i + 1);
      if (close < 0) {
        if (strict) throw new UnresolvedPathError("unresolved path variable");
        out += text.slice(i);
        break;
      }
      const inner = text.slice(i + 2, close);
      const replaced = resolveBracedExpression(inner, context, seen, strict);
      if (replaced === null) {
        out += text.slice(i, close + 1);
      } else {
        out += replaced;
      }
      i = close;
      continue;
    }
    const bareMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
    if (bareMatch) {
      const name = bareMatch[0];
      if (seen.has(name)) throw new Error("cyclic path variable");
      const replacement = lookupPathVariable(name, context);
      if (replacement === undefined) {
        if (strict) throw new UnresolvedPathError("unresolved path variable");
        out += `$${name}`;
      } else {
        out += expandVariablesText(replacement, context, new Set(seen).add(name), strict);
      }
      i += name.length;
      continue;
    }
    out += text[i];
  }
  return out;
}

/** Resolve variables and tilde without prepending cwd yet, preserving CMD_VALUE semantics. */
function expandRawPath(value: string, context: InspectionContext): string {
  const tildeReplaced = value.replace(/^~(?=\/|$)/, context.home);
  const expanded = expandVariablesText(tildeReplaced, context, new Set(), true);
  if (expanded.includes("$") || expanded.includes("`")) {
    throw new UnresolvedPathError("unresolved path");
  }
  return expanded;
}

type ProcKind = "metadata" | "bare-cwd" | "bare-exe" | "traversal";

function classifyProcPath(procPath: string): ProcKind {
  const parts: string[] = [];
  for (const part of procPath.slice("/proc".length).split("/")) {
    if (!part || part === ".") continue;
    const curBody = parts[1] === "task" && parts.length >= 4 ? parts.slice(3) : parts.slice(1);
    if (
      curBody.length >= 1 &&
      ["cwd", "root", "exe", "fd", "fdinfo", "map_files"].includes(curBody[0])
    ) {
      return "traversal";
    }
    if (part === "..") {
      if (parts.length === 0) return "traversal";
      parts.pop();
      continue;
    }
    parts.push(part);
    const body = parts[1] === "task" && parts.length >= 4 ? parts.slice(3) : parts.slice(1);
    if (body.length === 0) continue;
    if (["root", "fd", "fdinfo", "map_files"].includes(body[0])) {
      return "traversal";
    }
    if (body.length > 1 && (body[0] === "cwd" || body[0] === "exe")) {
      return "traversal";
    }
  }
  if (parts.length === 0) return "traversal";
  const body = parts[1] === "task" && parts.length >= 4 ? parts.slice(3) : parts.slice(1);
  if (body.length === 1 && body[0] === "cwd") return "bare-cwd";
  if (body.length === 1 && body[0] === "exe") return "bare-exe";
  return "metadata";
}

function hasProcTraversalInText(rawPath: string): boolean {
  const normalized = rawPath.replaceAll("//", "/");
  if (normalized === "/proc" || normalized === "/proc/") return true;
  if (!normalized.startsWith("/proc/")) return false;
  return classifyProcPath(normalized) === "traversal";
}

/** Resolve existing ancestors too, so a new file cannot conceal a symlink traversal. */
function expandedPath(value: string, context: InspectionContext): string {
  const expanded = expandRawPath(value, context);
  // Keep '..' until realPath has followed symlinks: normalizing it first can
  // hide an escape through an allowed-folder symlink followed by '/..'.
  return path.isAbsolute(expanded) ? expanded : `${context.cwd}${path.SEPARATOR}${expanded}`;
}

function resolvedPath(value: string, context: InspectionContext): string {
  const expanded = expandedPath(value, context);
  const root = path.parse(expanded).root;
  if (!root) throw new Error("unresolved path root");
  let current = root;
  const rawParts = expanded.slice(root.length).split(path.SEPARATOR);
  // Find the index of the last meaningful component so bare /proc/<id>/cwd or exe
  // is known to have no trailing subpath.
  let lastPartIdx = -1;
  for (let i = rawParts.length - 1; i >= 0; i--) {
    if (rawParts[i] && rawParts[i] !== ".") {
      lastPartIdx = i;
      break;
    }
  }
  const evaluateProcCandidate = (procTarget: string, isFinal: boolean): string | null => {
    const kind = classifyProcPath(procTarget);
    if (kind === "metadata") return procTarget;
    if (
      (kind === "bare-cwd" || kind === "bare-exe") &&
      isFinal &&
      (context.allowProcReadlink || context.scriptText)
    ) {
      return procTarget;
    }
    throw new Error("cannot resolve a /proc path");
  };

  // Deno normalizes '..' in a realPath argument before reaching the OS. Resolve
  // one component at a time so a symlink is followed before its subsequent '..'.
  for (let idx = 0; idx < rawParts.length; idx++) {
    const part = rawParts[idx];
    if (!part || part === ".") continue;
    if (part === "..") {
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, part);
    if (candidate === "/proc" || candidate.startsWith("/proc/")) {
      const restParts = rawParts.slice(idx + 1).filter((p) => p && p !== ".");
      const fullProcPath = candidate === "/proc"
        ? (restParts.length > 0 ? `/proc/${restParts.join("/")}` : "/proc")
        : (restParts.length > 0 ? `${candidate}/${restParts.join("/")}` : candidate);
      return evaluateProcCandidate(fullProcPath, true)!;
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
      const restParts = rawParts.slice(idx + 1).filter((p) => p && p !== ".");
      const fullProcPath = restParts.length > 0 ? `${current}/${restParts.join("/")}` : current;
      return evaluateProcCandidate(fullProcPath, idx === lastPartIdx)!;
    }
  }
  return current;
}

function isRelativeInside(base: string, target: string): string | null {
  const relative = path.relative(base, target);
  if (
    relative === ".." || relative.startsWith(`..${path.SEPARATOR}`) || path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative;
}

function hasSafeLiteralPrefixBeforeUnresolved(value: string, context: InspectionContext): boolean {
  const tildeReplaced = value.replace(/^~(?=\/|$)/, context.home);
  const partial = expandVariablesText(tildeReplaced, context, new Set(), false);
  const dollarIdx = partial.indexOf("$");
  const tickIdx = partial.indexOf("`");
  const idx = dollarIdx >= 0 && tickIdx >= 0
    ? Math.min(dollarIdx, tickIdx)
    : Math.max(dollarIdx, tickIdx);
  if (idx <= 0) return false;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(partial)) return false;

  const literalPrefix = partial.slice(0, idx);
  const lastSlash = literalPrefix.lastIndexOf("/");
  if (lastSlash < 0) return false;
  const dirPrefix = literalPrefix.slice(0, lastSlash + 1);
  if (dirPrefix.includes(CMD_VALUE)) return false;

  let expandedDir: string;
  let resolvedDir: string;
  try {
    expandedDir = expandedPath(dirPrefix, context);
    resolvedDir = resolvedPath(dirPrefix, context);
  } catch {
    return false;
  }

  const roots = [path.join(context.home, "Dropbox"), "/home/joshua/Dropbox"].flatMap((root) => [
    root,
    resolvedPath(root, context),
  ]);
  const homes = [context.home, "/home/joshua"].flatMap((home) => [
    home,
    resolvedPath(home, context),
  ]);

  for (const target of [expandedDir, resolvedDir]) {
    if (target === "/" || homes.includes(target)) return false;
    for (const root of roots) {
      if (isRelativeInside(root, target) !== null) return false;
    }
  }
  return true;
}

function privatePath(value: string, context: InspectionContext, allowRoot = false): string | null {
  // Unknown values inside script text are not paths we can establish. Explicit
  // Dropbox prefixes and /proc traversal subpaths stay refused before skipping.
  let rawExpanded: string;
  try {
    rawExpanded = expandRawPath(value, context);
  } catch (err) {
    if (context.scriptText) {
      if (hasProcTraversalInText(value)) {
        throw new Error("cannot resolve a /proc path");
      }
      return null;
    }
    if (
      err instanceof UnresolvedPathError && hasSafeLiteralPrefixBeforeUnresolved(value, context)
    ) {
      return null;
    }
    throw err;
  }
  const hasCmdValue = rawExpanded.includes(CMD_VALUE);
  const roots = [path.join(context.home, "Dropbox"), "/home/joshua/Dropbox"].flatMap((root) => [
    root,
    resolvedPath(root, context),
  ]);
  const homes = [context.home, "/home/joshua"].flatMap((home) => [
    home,
    resolvedPath(home, context),
  ]);
  // A bare/relative command-produced value (e.g. `cat "$x"`) that was not prefixed by
  // home or Dropbox is skipped unless cwd itself sits at Dropbox root.
  if (
    hasCmdValue && !path.isAbsolute(rawExpanded) && !rawExpanded.startsWith("..") &&
    !/^Dropbox(?:\/|$)/.test(rawExpanded)
  ) {
    const cwdInDropboxRoot = roots.some((root) => isRelativeInside(root, context.cwd) === "");
    if (!cwdInDropboxRoot) return null;
  }
  const targets = [expandedPath(value, context), resolvedPath(value, context)];
  for (const target of targets) {
    for (const root of roots) {
      const relative = isRelativeInside(root, target);
      if (relative === null) continue;
      if (!relative) {
        if (!allowRoot) return "Dropbox root";
        continue;
      }
      const folder = relative.split(path.SEPARATOR)[0];
      if (folder.includes(CMD_VALUE)) {
        throw new Error("cannot resolve Dropbox folder from command output");
      }
      if (!ALLOWED_FOLDERS.has(folder)) return folder;
    }
    if (hasCmdValue) {
      for (const home of homes) {
        const relative = isRelativeInside(home, target);
        if (relative && relative.split(path.SEPARATOR)[0].includes(CMD_VALUE)) {
          throw new Error("cannot resolve home subfolder from command output");
        }
      }
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
  depths: DepthState,
  shell = false,
): string | null {
  if (depths.scriptDepth > MAX_SCRIPT_DEPTH) throw new Error("script nesting limit");
  if (depths.shellDepth > MAX_SHELL_DEPTH) throw new Error("script/wrapper nesting limit");
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
      { scriptDepth: depths.scriptDepth, shellDepth: depths.shellDepth + 1 },
    );
    if (denied) return denied;
  }
  return shell ? inspectShell(text, context, depths) : null;
}

function scriptArgument(argv: string[]): string[] {
  const invocation = readInterpreterScript(argv);
  if (invocation) {
    return [
      ...invocation.preloads,
      ...(invocation.script?.kind === "file" ? [invocation.script.path] : []),
    ];
  }
  const name = path.basename(argv[0] ?? "");
  if (name !== "bash" && name !== "sh") return [];
  for (let index = 1; index < argv.length; index++) {
    const word = argv[index];
    if (["-c", "-s", "-", "/dev/stdin"].includes(word)) return [];
    if (word === "--") return argv[index + 1] ? [argv[index + 1]] : [];
    if (!word.startsWith("-")) return [word];
  }
  return [];
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
  depths: DepthState,
  shell: boolean,
  ownPath: boolean,
): string | null {
  if (context.scripts.has(filename)) throw new Error("recursive script reference");
  const nextScriptDepth = depths.scriptDepth + 1;
  if (nextScriptDepth > MAX_SCRIPT_DEPTH) throw new Error("script nesting limit");
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
    { scriptDepth: nextScriptDepth, shellDepth: depths.shellDepth },
    shell,
  );
}

function globSegmentToRegExp(segment: string): RegExp {
  let pattern = "^";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "*") pattern += ".*";
    else if (ch === "?") pattern += ".";
    else if (ch === "[") {
      const close = segment.indexOf("]", i + 1);
      if (close > i + 1) {
        let cls = segment.slice(i + 1, close);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        pattern += `[${cls}]`;
        i = close;
        continue;
      }
      pattern += "\\[";
    } else {
      pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(pattern + "$");
}

function isDirEntry(dir: string, entry: Deno.DirEntry): boolean {
  if (entry.isDirectory) return true;
  if (!entry.isSymlink) return false;
  try {
    return Deno.statSync(path.join(dir, entry.name)).isDirectory;
  } catch {
    return false;
  }
}

function expandWildcardWord(rawWord: string, context: InspectionContext): string[] {
  const expanded = expandRawPath(rawWord, context);
  if (expanded.includes(CMD_VALUE) || !/[*?[]/.test(expanded)) return [expanded];
  // Check wildcard paths directly under Dropbox before reading any directory on disk.
  if (privatePath(expanded, context) !== null) return [expanded];

  const isAbs = path.isAbsolute(expanded);
  const trailingSlash = expanded.endsWith("/");
  const trimmed = expanded.replace(/\/+$/, "");
  const segments = (isAbs ? trimmed.slice(1) : trimmed).split("/").filter(Boolean);
  let prefixes = [isAbs ? "/" : ""];

  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    const isLast = idx === segments.length - 1;
    const next: string[] = [];
    if (!/[*?[]/.test(seg)) {
      for (const prefix of prefixes) {
        next.push(prefix === "/" ? `/${seg}` : prefix ? `${prefix}/${seg}` : seg);
      }
      prefixes = next;
      continue;
    }
    const regex = globSegmentToRegExp(seg);
    const includeHidden = seg.startsWith(".");
    for (const prefix of prefixes) {
      const fsDir = prefix
        ? (isAbs ? prefix : path.join(context.cwd, prefix))
        : (isAbs ? "/" : context.cwd);
      let entries: Deno.DirEntry[];
      try {
        entries = [...Deno.readDirSync(fsDir)];
      } catch {
        throw new Error("cannot read wildcard loop directory");
      }
      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith(".")) continue;
        if (!regex.test(entry.name)) continue;
        if ((!isLast || trailingSlash) && !isDirEntry(fsDir, entry)) continue;
        next.push(
          prefix === "/" ? `/${entry.name}` : prefix ? `${prefix}/${entry.name}` : entry.name,
        );
      }
    }
    prefixes = next;
  }

  if (prefixes.length === 0) return [rawWord];
  return prefixes.map((p) => (trailingSlash && !p.endsWith("/") ? `${p}/` : p)).sort();
}

interface BalancedLoopMatch {
  index: number;
  length: number;
  varName: string;
  wordList: string;
  body: string;
}

function findFirstBalancedForLoop(text: string): BalancedLoopMatch | null {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && startsShellComment(text, i)) {
      const end = text.indexOf("\n", i);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (i > 0 && !/[\s;|&({]/.test(text[i - 1])) continue;
    const header = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+/.exec(text.slice(i));
    if (!header) continue;

    const listStart = i + header[0].length;
    let headerQuote = "";
    let j = listStart;
    let listEnd = -1;
    let bodyStart = -1;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === "\\" && headerQuote !== "'") {
        j++;
        continue;
      }
      if (headerQuote) {
        if (c === headerQuote) headerQuote = "";
        continue;
      }
      if (c === "'" || c === '"') {
        headerQuote = c;
        continue;
      }
      if (c === "#" && startsShellComment(text, j)) break;
      if (c === ";" || c === "\n") {
        const afterSep = /^([ \t]*)do(?=$|[\s;|&)#])/.exec(text.slice(j + 1));
        if (afterSep) {
          listEnd = j;
          bodyStart = j + 1 + afterSep[0].length;
          break;
        }
        if (c === "\n") continue;
        break;
      }
    }
    if (listEnd < 0 || bodyStart < 0) continue;

    let loopDepth = 1;
    let bodyQuote = "";
    let k = bodyStart;
    for (; k < text.length; k++) {
      const c = text[k];
      if (c === "\\" && bodyQuote !== "'") {
        k++;
        continue;
      }
      if (bodyQuote) {
        if (c === bodyQuote) bodyQuote = "";
        continue;
      }
      if (c === "'" || c === '"') {
        bodyQuote = c;
        continue;
      }
      if (c === "#" && startsShellComment(text, k)) {
        const end = text.indexOf("\n", k);
        if (end < 0) break;
        k = end;
        continue;
      }
      if (c === ";" || c === "\n" || c === "&") {
        const kwMatch = /^[ \t]*(do|done)(?=$|[\s;|&)#])/.exec(text.slice(k + 1));
        if (kwMatch) {
          if (kwMatch[1] === "do") {
            loopDepth++;
            k += kwMatch[0].length;
            continue;
          }
          loopDepth--;
          const doneEnd = k + 1 + kwMatch[0].length;
          if (loopDepth === 0) {
            return {
              index: i,
              length: doneEnd - i,
              varName: header[1],
              wordList: text.slice(listStart, listEnd),
              body: text.slice(bodyStart, k),
            };
          }
          k = doneEnd - 1;
        }
      }
    }
  }
  return null;
}

function inspectLiteralLoop(
  text: string,
  context: InspectionContext,
  depths: DepthState,
): { found: boolean; denied: string | null } {
  const loop = findFirstBalancedForLoop(text);
  if (!loop) return { found: false, denied: null };
  const prefix = inspectShell(text.slice(0, loop.index), context, depths);
  if (prefix) return { found: true, denied: prefix };

  const wordSubs = shellSubstitutions(loop.wordList);
  for (const subCmd of wordSubs.commands) {
    const denied = inspectShell(subCmd, { ...context }, {
      scriptDepth: depths.scriptDepth,
      shellDepth: depths.shellDepth + 1,
    });
    if (denied) return { found: true, denied };
  }
  const normalizedList = protectSingleQuotedMetachars(wordSubs.text)
    .replaceAll(/\$\?__WJT_SUBSTITUTION_\d+__/g, CMD_VALUE)
    .replaceAll(/__WJT_SUBSTITUTION_\d+__/g, "");

  const words: string[] = [];
  for (const token of splitShellTokens(normalizedList)) {
    let candidate = token;
    if (token.includes("$")) {
      try {
        candidate = expandRawPath(token, context);
      } catch (err) {
        if (!context.scriptText) throw err;
        // Visible Dropbox prefixes in the raw loop header stay enforced by checkCommandForPrivateFolder/privatePath.
        if (token.includes("Dropbox")) {
          const denied = privatePath(token, context);
          if (denied) return { found: true, denied };
        }
        candidate = CMD_VALUE;
      }
    }
    const splitWords = !token.startsWith('"') && !token.startsWith("'") && /\s/.test(candidate)
      ? candidate.trim().split(/\s+/).filter(Boolean)
      : [candidate];
    for (const word of splitWords) {
      if (/[*?[]/.test(word)) {
        if (context.scriptText && privatePath(word, context) === null) {
          words.push(CMD_VALUE);
        } else {
          words.push(...expandWildcardWord(word, context));
        }
      } else {
        words.push(unprotectSingleQuotedMetachars(word));
      }
    }
  }

  for (const word of words) {
    const variables = new Map(context.variables).set(loop.varName, word);
    const denied = inspectShell(loop.body, { ...context, variables }, {
      scriptDepth: depths.scriptDepth,
      shellDepth: depths.shellDepth + 1,
    });
    if (denied) return { found: true, denied };
  }
  return {
    found: true,
    denied: inspectShell(text.slice(loop.index + loop.length), context, depths),
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
    else if (ch === "#" && startsShellComment(text, i)) {
      const end = text.indexOf("\n", i);
      if (end < 0) return { text: result + text.slice(i + 1), commands };
      result += text.slice(i + 1, end);
      i = end - 1;
    }
  }
  return { text: result, commands };
}

function startsShellComment(text: string, index: number): boolean {
  if (index === 0) return true;
  if (!/[\s;&|()]/.test(text[index - 1])) return false;
  let escapes = 0;
  for (let i = index - 2; i >= 0 && text[i] === "\\"; i--) escapes++;
  return escapes % 2 === 0;
}

/** Find the reserved closing word, keeping quoted text and bracket patterns intact. */
function closingConditional(text: string, start: number): number {
  let quote = "";
  let bracketStart = -1;
  for (let i = start + 2; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    // An unquoted reserved word ends the test even when a pattern contains a
    // literal unmatched '['. Bracket expressions cannot span unquoted words.
    if (
      text.startsWith("]]", i) && /\s/.test(text[i - 1]) &&
      (i + 2 === text.length || /[\s;&|()<>]/.test(text[i + 2]))
    ) return i;
    if (bracketStart >= 0) {
      // POSIX classes, collating symbols and equivalence classes have their own
      // closing pair inside the enclosing bracket expression.
      if (ch === "[" && /[:.=]/.test(text[i + 1] ?? "")) {
        const end = text.indexOf(text[i + 1] + "]", i + 2);
        if (end < 0) throw new Error("unterminated bracket expression");
        i = end + 1;
      } else if (
        ch === "]" && i !== bracketStart + 1 &&
        !(i === bracketStart + 2 && /[!^]/.test(text[bracketStart + 1]))
      ) bracketStart = -1;
      continue;
    }
    if (ch === "[") bracketStart = i;
  }
  throw new Error("unterminated conditional test");
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
      if (quote === '"' && text.startsWith("$((", i)) {
        const end = closingParenthesis(text, i + 1);
        const raw = text.slice(i, end + 1);
        patterns.push(raw);
        result += "0" +
          [...raw.matchAll(/__WJT_SUBSTITUTION_\d+__/g)].map((match) => match[0]).join("");
        i = end;
        continue;
      }
      result += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === "#" && startsShellComment(text, i)) {
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
      const end = closingConditional(text, i);
      result += keepPattern(text.slice(i, end + 2));
      i = end + 1;
      continue;
    }
    if (text.startsWith("$((", i) || text.startsWith("((", i)) {
      const start = ch === "$" ? i + 1 : i;
      const end = closingParenthesis(text, start);
      const raw = text.slice(i, end + 1);
      if (ch === "$") {
        patterns.push(raw);
        result += "0" +
          [...raw.matchAll(/__WJT_SUBSTITUTION_\d+__/g)].map((match) => match[0]).join("");
      } else {
        result += keepPattern(raw, " ");
      }
      i = end;
      continue;
    }
    if (ch === "(" && /(?:^|[\s;|&])(?:[A-Za-z_][A-Za-z0-9_]*)\+?=$/.test(result)) {
      const end = closingParenthesis(text, i);
      const inner = text.slice(i + 1, end);
      let flat = "";
      let arrQuote = "";
      for (let j = 0; j < inner.length; j++) {
        const c = inner[j];
        if (c === "\\" && arrQuote !== "'") {
          flat += inner.slice(j, j + 2);
          j++;
          continue;
        }
        if (arrQuote) {
          flat += c;
          if (c === arrQuote) arrQuote = "";
          continue;
        }
        if (c === "'" || c === '"') {
          arrQuote = c;
          flat += c;
          continue;
        }
        if (c === "#" && startsShellComment(inner, j)) {
          const nl = inner.indexOf("\n", j);
          if (nl < 0) break;
          flat += " ";
          j = nl;
          continue;
        }
        flat += c === "\n" ? " " : c;
      }
      result += `__WJT_ARRAY__ ${flat} `;
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

function parseReadVars(argv: string[]): string[] | null {
  if (argv[0] !== "read") return null;
  const vars: string[] = [];
  let options = true;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && arg.startsWith("-") && arg.length > 1) {
      if (arg === "-a" && i + 1 < argv.length) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(argv[++i])) vars.push(argv[i]);
      } else if (/^-[rse]*[nNtpdui]$/.test(arg)) {
        i++;
      }
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) vars.push(arg);
  }
  return vars.length > 0 ? vars : ["REPLY"];
}

function inspectShell(
  command: string,
  context: InspectionContext,
  depths: DepthState,
): string | null {
  if (depths.shellDepth > MAX_SHELL_DEPTH) throw new Error("script/wrapper nesting limit");
  if (namedSocket(command)) return "Dropbox desktop socket";
  const cleaned = command.replace(/\\\r?\n/g, "");
  const stripped = stripHeredocs(cleaned);
  // Data bodies have already been stripped. Separate executable heredocs BEFORE
  // inspectLiteralLoop so heredoc contents never match outer shell loop patterns,
  // and pass quote state across lines so '<<EOF' inside multi-line quotes never opens one.
  const lines = stripped.split("\n");
  const shellLines: string[] = [];
  const heredocInspections: Array<{ body: string; shell: boolean }> = [];
  let quote: Quote = null;
  for (let index = 0; index < lines.length; index++) {
    shellLines.push(lines[index]);
    const scanned = scanHeredocLine(lines[index], quote);
    quote = scanned.quote;
    const marker = scanned.marker;
    if (!marker) continue;
    const header = lines[index];
    const shell = !/(?:^|[\s/])(python3?|node|deno)(?=\s|$)/.test(header);
    const body: string[] = [];
    while (++index < lines.length) {
      const line = marker[1] ? lines[index].replace(/^\t+/, "") : lines[index];
      if (line.replace(/\r$/, "") === marker[0]) break;
      body.push(line);
    }
    if (index >= lines.length) throw new Error("unterminated heredoc");
    shellLines.push(lines[index]);
    const consumesHeredoc = shell || readInterpreterHeredocs(header).length > 0;
    if (consumesHeredoc) {
      heredocInspections.push({ body: body.join("\n"), shell });
    }
  }
  for (const heredoc of heredocInspections) {
    const denied = inspectScript(
      heredoc.body,
      { ...context },
      { scriptDepth: depths.scriptDepth, shellDepth: depths.shellDepth + 1 },
      heredoc.shell,
    );
    if (denied) return denied;
  }

  const text = withoutWebAddresses(shellLines.join("\n")).replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}(?![A-Za-z0-9_])/g,
    (_, name) => `$${name}`,
  );
  const loop = inspectLiteralLoop(text, context, depths);
  if (loop.found) return loop.denied;
  const substitutions = shellSubstitutions(text);
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
  const replaceSubstitutions = (token: string) =>
    token.replaceAll(/\$\?__WJT_SUBSTITUTION_\d+__/g, CMD_VALUE).replaceAll(
      /__WJT_SUBSTITUTION_\d+__/g,
      "",
    );
  for (const segment of parsed.segments) {
    const parentContext = context;
    context = { ...parentContext, variables: new Map(parentContext.variables) };
    const named = checkCommandForPrivateFolder(segment, context.folders);
    if (named) return named;
    const rawTokens = splitShellTokens(protectSingleQuotedMetachars(segment));
    const tokens = rawTokens.map(replaceSubstitutions)
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
      const denied = inspectShell(substitutions.commands[index], { ...context }, {
        scriptDepth: depths.scriptDepth,
        shellDepth: depths.shellDepth + 1,
      });
      if (denied) return denied;
    }
    for (const token of rawTokens) {
      const redirect = /^__WJT_REDIRECT_(\d+)__$/.exec(token);
      if (!redirect) continue;
      const target = replaceSubstitutions(
        protectSingleQuotedMetachars(syntax.redirects[Number(redirect[1])]),
      );
      const denied = privatePath(target, context);
      if (denied) return denied;
    }
    let cmdStart = assignments;
    while (cmdStart < tokens.length && SHELL_KEYWORDS.has(tokens[cmdStart])) cmdStart++;
    const cmdName = path.basename(tokens[cmdStart] ?? "");
    const resolvedTokenCmd = resolveThroughWrappers(tokens.slice(cmdStart));
    const effectiveCmdName = resolvedTokenCmd.kind === "argv" && resolvedTokenCmd.argv[0]
      ? path.basename(resolvedTokenCmd.argv[0])
      : cmdName;
    const patternCommand = ["grep", "sed"].includes(cmdName);
    const tokenContext = effectiveCmdName === "readlink"
      ? { ...context, allowProcReadlink: true }
      : context;
    for (
      const token of patternCommand ? pathOperands(tokens.slice(cmdStart), context) : tokens
    ) {
      for (const candidate of literalPaths(token)) {
        const denied = privatePath(candidate, tokenContext);
        if (denied) return denied;
      }
    }
    const isArrayAssignment = (() => {
      let idx = 0;
      if (["local", "declare", "typeset", "readonly", "export"].includes(tokens[idx] ?? "")) {
        idx++;
        while (idx < tokens.length && tokens[idx].startsWith("-")) idx++;
      }
      return /^([A-Za-z_][A-Za-z0-9_]*)\+?=__WJT_ARRAY__$/.test(tokens[idx] ?? "");
    })();
    if (assignments === tokens.length || isArrayAssignment) {
      parentContext.variables = context.variables;
      context = parentContext;
      continue;
    }
    const invocation = tokens.slice();
    while (
      invocation.length &&
      (ASSIGN_RE.test(invocation[0]) || invocation[0] === "exec" ||
        SHELL_KEYWORDS.has(invocation[0]))
    ) {
      invocation.shift();
    }
    if (!context.scriptText) checkUnresolvedShellCommand(invocation);
    const resolved = resolveThroughWrappers(invocation);
    if (resolved.kind === "cap-exceeded") throw new Error("wrapper nesting limit");
    if (resolved.kind === "nested") {
      const denied = inspectShell(
        unprotectSingleQuotedMetachars(resolved.command),
        { ...context },
        { scriptDepth: depths.scriptDepth, shellDepth: depths.shellDepth + 1 },
      );
      if (denied) return denied;
      context = parentContext;
      continue;
    }
    const argv = resolved.argv.slice();
    while (
      argv.length &&
      (ASSIGN_RE.test(argv[0]) || argv[0] === "exec" || SHELL_KEYWORDS.has(argv[0]))
    ) argv.shift();
    const readVars = parseReadVars(argv);
    if (readVars !== null) {
      for (const variable of readVars) parentContext.variables.set(variable, CMD_VALUE);
      context = parentContext;
      continue;
    }
    const name = argv[0] === "." ? "." : path.basename(argv[0] ?? "");
    if (name === "dropbox") return "Dropbox desktop command";
    if (sweepCommand(argv, context)) return "whole-home sweep";
    if (name === "bash" || name === "sh") {
      const inline = argv.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
      if (inline >= 0 && argv[inline + 1]) {
        const denied = inspectShell(
          unprotectSingleQuotedMetachars(argv[inline + 1]),
          { ...context },
          { scriptDepth: depths.scriptDepth, shellDepth: depths.shellDepth + 1 },
        );
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
      const cdDenied = privatePath(destination, context, true);
      if (cdDenied) return cdDenied;
      try {
        const rawDest = expandRawPath(destination, context);
        parentContext.cwd =
          rawDest.includes(CMD_VALUE) && !path.isAbsolute(rawDest) && !rawDest.startsWith("..")
            ? `/${CMD_VALUE}`
            : resolvedPath(destination, context);
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
    const files = ownPath ? [argv[0]] : scriptArgument(argv);
    for (const file of files) {
      if (path.basename(file) === "dropbox") return "Dropbox desktop command";
      const privateScript = privatePath(file, context);
      if (privateScript) return privateScript;
      let filename: string;
      try {
        if (expandRawPath(file, context).includes(CMD_VALUE)) continue;
        filename = resolvedPath(file, context);
      } catch (error) {
        if (context.scriptText) continue;
        throw error;
      }
      const denied = inspectFile(
        filename,
        context,
        depths,
        ownPath || name === "bash" || name === "sh",
        ownPath,
      );
      if (denied) return denied;
    }
    const scriptCall = readInterpreterScript(argv.map(unprotectSingleQuotedMetachars));
    if (scriptCall?.script?.kind === "inline") {
      const denied = inspectScript(scriptCall.script.code, { ...context }, {
        scriptDepth: depths.scriptDepth,
        shellDepth: depths.shellDepth + 1,
      });
      if (denied) return denied;
    }
    context = parentContext;
  }
  return null;
}

/** Every argument, at any depth, whose whole string value is a path (dropbox-guards-design.md). */
export function collectWholeStringPaths(val: unknown, out: string[]): void {
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

/**
 * Every whole-string path in an untranslated agy call's arguments. The shim supports two forms of
 * a structured `Arguments` value (`buildToolInput` in agy_hook_shim.ts): an object, which the
 * collector already descends into, and JSON text, which is decoded here so its paths are inspected
 * too. The arguments themselves are never changed. Throws when `Arguments` is text that does not
 * decode to a JSON object, so each guard refuses what it cannot read.
 */
export function collectUntranslatedArgumentPaths(toolInput: Record<string, unknown>): string[] {
  const paths: string[] = [];
  collectWholeStringPaths(toolInput, paths);
  const structured = toolInput.Arguments;
  if (typeof structured === "string") {
    let decoded: unknown;
    try {
      decoded = JSON.parse(structured);
    } catch {
      throw new Error("the structured Arguments value is not valid JSON");
    }
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("the structured Arguments value does not decode to a JSON object");
    }
    collectWholeStringPaths(decoded, paths);
  }
  return paths;
}

/**
 * An agy tool the shim does not translate reaches this guard as `AgyUntranslated` with its
 * arguments unchanged (dropbox-guards-design.md, "agy tools the shim does not translate").
 * Returns what it protects, or `null` to allow. Each whole-string path argument is resolved as a
 * shell path is; a path under `~/Dropbox` outside the allowed folders, bare `~/Dropbox`, or the
 * home folder itself refuses, and arguments or a path that cannot be read refuse.
 */
export function checkUntranslatedAgyCall(
  toolInput: unknown,
  cwd: string,
  home: string,
): string | null {
  if (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return `${COULD_NOT_READ_REFUSAL} (untranslated agy tool call arguments cannot be read)`;
  }
  let paths: string[];
  try {
    paths = collectUntranslatedArgumentPaths(toolInput as Record<string, unknown>);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `${COULD_NOT_READ_REFUSAL} (${msg})`;
  }
  const context: InspectionContext = {
    cwd,
    home,
    folders: [],
    variables: new Map(),
    scripts: new Set(),
  };
  const homes = new Set<string>();
  for (const candidate of [home, "/home/joshua"]) {
    homes.add(path.resolve(candidate));
    try {
      homes.add(Deno.realPathSync(candidate));
    } catch {
      // A home folder that does not exist on this machine has no real path to add.
    }
  }
  for (const value of paths) {
    try {
      const folder = privatePath(value, context);
      if (folder) return folder;
      for (const target of [expandedPath(value, context), resolvedPath(value, context)]) {
        if (homes.has(path.resolve(target))) return "the home folder";
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `${COULD_NOT_READ_REFUSAL} (${msg})`;
    }
  }
  return null;
}

function writeCouldNotReadRefusal(detail: string): never {
  console.error(
    `BLOCKED (private-folder read guard): could not read the command (${detail}); nothing protected was found.`,
  );
  console.error(
    "You may restate the same action in a form this guard can read. The restated command must be checked by this same guard.",
  );
  console.error("Do not change what the command does. Report this gap at the end of the turn.");
  Deno.exit(2);
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
      { scriptDepth: 0, shellDepth: 0 },
    );
  } catch (error) {
    if (error instanceof UnreadableScript) return error.message;
    const msg = error instanceof Error ? error.message : String(error);
    return `${COULD_NOT_READ_REFUSAL} (${msg})`;
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
  let untranslated: Record<string, unknown> | undefined;

  if (!command && Deno.args.length > 0) {
    command = Deno.args.join(" ");
  }

  const rawInput = await readStdin();
  if (rawInput.trim()) {
    try {
      const data = JSON.parse(rawInput);
      if (typeof data === "object" && data !== null && data.tool_name === "AgyUntranslated") {
        untranslated = data;
      } else if (typeof data === "object" && data !== null) {
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

  if (untranslated) {
    const callCwd = typeof untranslated.cwd === "string" && path.isAbsolute(untranslated.cwd)
      ? untranslated.cwd
      : Deno.cwd();
    const found = checkUntranslatedAgyCall(
      untranslated.tool_input,
      callCwd,
      Deno.env.get("HOME") || "/home/joshua",
    );
    if (found) refuseMatch(found);
    Deno.exit(0);
  }

  // If tool name is explicitly provided and is not Bash, allow (exit 0)
  if (toolName && toolName !== "Bash" && toolName !== "bash") {
    Deno.exit(0);
  }

  if (invalidInput) {
    writeCouldNotReadRefusal("cannot establish command or working directory");
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
  if (matchedFolder) refuseMatch(matchedFolder);

  Deno.exit(0);
}

function refuseMatch(matchedFolder: string): never {
  if (matchedFolder.startsWith("Cannot read the script ")) {
    console.error(`BLOCKED (private-folder read guard): ${matchedFolder}`);
    Deno.exit(2);
  }
  if (matchedFolder.startsWith(COULD_NOT_READ_REFUSAL)) {
    writeCouldNotReadRefusal(matchedFolder);
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

if (import.meta.main) {
  await main();
}
