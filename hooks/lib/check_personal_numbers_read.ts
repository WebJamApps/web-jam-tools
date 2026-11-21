/**
 * The read guard of the personal information guards (web-jam-tools#1860).
 *
 * Before an agent reads a file, this reads that file on the laptop and runs
 * the checker (detect_personal_numbers.ts) on it, refusing the call when the
 * checker finds anything. The refusal names the kind of number and the file,
 * never the number.
 *
 * Design: ~/Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.md,
 * "What an agent reads".
 *
 * Which calls: Claude Code's `Read`, agy's `view_file` and `read_file`, and a shell command
 * whose words, through the shared command reader (normalize_command.ts), run
 * one of READER_COMMANDS on a file or a folder.
 *
 * Three outcomes:
 *   - Refuse (exit 2): a file the call names holds a protected number.
 *   - Allow (exit 0): no file the call names holds one, or every such file is
 *     inside a git working tree of a ~/WebJamApps repository (insideWebJamAppsRepo),
 *     is this guard's own design document (isExemptDesignDoc), is over 5 MB, an
 *     image, audio or video, or otherwise not text or PDF. A shell word holding an
 *     unresolved variable, or a relative path after a `cd` the shared reader cannot
 *     follow, is passed over; every literal path in the same command is still checked.
 *   - Refuse, failing closed (exit 2): the guard cannot open a file the call
 *     names, cannot read the call itself, or a folder sweep passes
 *     MAX_SWEEP_FILES files or SWEEP_TIME_LIMIT_MS.
 *
 * Used on Claude Code (PreToolUse `Bash|Read`), agy (through agy-hook-shim.sh,
 * on `run_command` and `view_file|read_file`) and Codex (PreToolUse `Bash`, WJT_SURFACE=codex).
 */

import * as path from "jsr:@std/path@^1.0.0";
import {
  ASSIGN_RE,
  commandPartsInFolders,
  resolveCommandPath,
  resolveThroughWrappers,
  splitShellTokens,
} from "./normalize_command.ts";
import { describeKinds, detectPersonalNumbers } from "./detect_personal_numbers.ts";

export const READER_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "grep",
  "rg",
  "sed",
  "awk",
  "cut",
  "sort",
  "uniq",
  "wc",
  "strings",
  "jq",
  "column",
  "pdftotext",
  "rledger",
]);

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** A folder sweep stops here and refuses rather than run past the hook's timeout. */
export const MAX_SWEEP_FILES = 20_000;
export const SWEEP_TIME_LIMIT_MS = 8_000;
const MAX_NESTED_DEPTH = 6;

const NOT_TEXT_EXTENSIONS = new Set([
  // images
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
  "ico",
  "svg",
  "raw",
  "cr2",
  "nef",
  "dng",
  "psd",
  // audio
  "wav",
  "mp3",
  "flac",
  "aac",
  "m4a",
  "ogg",
  "opus",
  "aif",
  "aiff",
  "wma",
  "mid",
  "midi",
  // video
  "mp4",
  "mov",
  "m4v",
  "mkv",
  "avi",
  "webm",
  "wmv",
  "mpg",
  "mpeg",
  "3gp",
]);

export type Verdict =
  | { kind: "allow" }
  | { kind: "found"; file: string; what: string }
  | { kind: "unreadable"; file: string; detail: string };

export const ALLOW: Verdict = { kind: "allow" };

export function refusalFor(verdict: Verdict): string | null {
  if (verdict.kind === "found") {
    return `This file holds what looks like ${verdict.what}: ${verdict.file}. Personal numbers never reach an AI. Move the file into ~/Dropbox/financial-private/ and, for a bank or card download, run the cleaning command on it.`;
  }
  if (verdict.kind === "unreadable") {
    return `The personal-numbers read guard could not read ${verdict.file} (${verdict.detail}), so it cannot tell whether that file holds a personal number. It refuses rather than let one reach an AI.`;
  }
  return null;
}

function homeDir(): string {
  return Deno.env.get("HOME") || "/home/joshua";
}

function errorDetail(err: unknown): string {
  if (err instanceof Deno.errors.PermissionDenied) return "permission denied";
  return err instanceof Error ? err.message : String(err);
}

/**
 * A file or folder inside a git working tree of a ~/WebJamApps repository,
 * judged on its real location so a link inside a repository never exempts what
 * it points at. That is a working tree under ~/WebJamApps itself, or a git
 * worktree elsewhere (such as /tmp/agy-worktrees/...) whose `.git` file carries
 * a `gitdir:` resolving inside ~/WebJamApps/<repo>/.git/worktrees/. Any other
 * path, under /tmp or not, is never trusted.
 */
export function insideWebJamAppsRepo(realPath: string, home = homeDir()): boolean {
  const root = path.join(home, "WebJamApps");
  if (realPath.startsWith(root + "/")) {
    let dir = realPath;
    while (dir.startsWith(root + "/")) {
      try {
        Deno.lstatSync(path.join(dir, ".git"));
        return true;
      } catch {
        // not a working tree root at this level
      }
      dir = path.dirname(dir);
    }
    return false;
  }
  // Outside ~/WebJamApps: the nearest `.git` decides, and only a worktree's
  // `.git` file pointing into a ~/WebJamApps repository exempts.
  let dir = realPath;
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let info: Deno.FileInfo | null = null;
    try {
      info = Deno.lstatSync(dotGit);
    } catch {
      // no `.git` at this level
    }
    if (info) return info.isFile && worktreeOfWebJamAppsRepo(dotGit, dir, root);
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Whether a worktree's `.git` file names a gitdir inside ~/WebJamApps/<repo>/.git/worktrees/. */
function worktreeOfWebJamAppsRepo(dotGit: string, worktree: string, root: string): boolean {
  let text: string;
  try {
    text = Deno.readTextFileSync(dotGit);
  } catch {
    return false;
  }
  const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text);
  if (!match) return false;
  let gitdir: string;
  try {
    gitdir = Deno.realPathSync(path.resolve(worktree, match[1]));
  } catch {
    return false; // a gitdir that does not exist is no worktree
  }
  const realRoot = (() => {
    try {
      return Deno.realPathSync(root);
    } catch {
      return root;
    }
  })();
  if (!gitdir.startsWith(realRoot + "/")) return false;
  const [repo, dotGitDir, worktrees, name] = gitdir.slice(realRoot.length + 1).split("/");
  return Boolean(repo) && dotGitDir === ".git" && worktrees === "worktrees" && Boolean(name);
}

/** The design document's two files, whose literal-case tables carry made-up numbers on purpose. */
const EXEMPT_DESIGN_DOCS = [
  "Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.md",
  "Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.html",
];

/** Whether `realFile` is exactly one of the design document's canonical resolved paths. */
export function isExemptDesignDoc(realFile: string, home = homeDir()): boolean {
  return EXEMPT_DESIGN_DOCS.some((rel) => {
    const named = path.join(home, rel);
    if (realFile === named) return true;
    try {
      return realFile === Deno.realPathSync(named);
    } catch {
      return false;
    }
  });
}

interface Sweep {
  files: number;
  deadline: number;
}

function pdfText(file: string): { ok: true; text: string } | { ok: false; detail: string } {
  try {
    const out = new Deno.Command("pdftotext", {
      args: ["-q", file, "-"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (out.code !== 0) return { ok: false, detail: `pdftotext exited ${out.code}` };
    return { ok: true, text: new TextDecoder().decode(out.stdout) };
  } catch (err) {
    return { ok: false, detail: `pdftotext could not run: ${errorDetail(err)}` };
  }
}

/** Check one regular file the call names. `realFile` is its resolved location. */
function checkFile(file: string, realFile: string, size: number): Verdict {
  if (insideWebJamAppsRepo(realFile) || isExemptDesignDoc(realFile)) return ALLOW;
  if (size > MAX_FILE_BYTES) return ALLOW;
  const ext = path.extname(realFile).slice(1).toLowerCase();
  if (NOT_TEXT_EXTENSIONS.has(ext)) return ALLOW;
  let bytes: Uint8Array;
  try {
    bytes = Deno.readFileSync(file);
  } catch (err) {
    return { kind: "unreadable", file, detail: errorDetail(err) };
  }
  let text: string;
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") {
    const pdf = pdfText(file);
    if (!pdf.ok) return { kind: "unreadable", file, detail: pdf.detail };
    text = pdf.text;
  } else if (bytes.subarray(0, 8192).includes(0)) {
    return ALLOW; // not text: a binary file is not read
  } else {
    text = new TextDecoder().decode(bytes);
  }
  const findings = detectPersonalNumbers(text);
  return findings.length ? { kind: "found", file, what: describeKinds(findings) } : ALLOW;
}

/**
 * Check a path the call names: a regular file, or every regular file under a
 * folder. A path that does not exist names nothing and is allowed (the call
 * itself will fail); one the guard cannot look at refuses.
 */
export function checkPath(target: string, sweep: Sweep = newSweep()): Verdict {
  let info: Deno.FileInfo;
  try {
    info = Deno.statSync(target);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound || err instanceof Deno.errors.NotADirectory) {
      return ALLOW;
    }
    return { kind: "unreadable", file: target, detail: errorDetail(err) };
  }
  let real: string;
  try {
    real = Deno.realPathSync(target);
  } catch (err) {
    return { kind: "unreadable", file: target, detail: errorDetail(err) };
  }
  if (info.isFile) return checkFile(target, real, info.size);
  if (!info.isDirectory) return ALLOW; // a socket, device or pipe is not a regular file
  if (insideWebJamAppsRepo(real)) return ALLOW;
  return checkFolder(target, sweep);
}

export function newSweep(): Sweep {
  return { files: 0, deadline: Date.now() + SWEEP_TIME_LIMIT_MS };
}

function checkFolder(folder: string, sweep: Sweep): Verdict {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(folder)];
  } catch (err) {
    return { kind: "unreadable", file: folder, detail: errorDetail(err) };
  }
  for (const entry of entries) {
    const child = path.join(folder, entry.name);
    if (++sweep.files > MAX_SWEEP_FILES || Date.now() > sweep.deadline) {
      return {
        kind: "unreadable",
        file: folder,
        detail: `more files under it than the guard can check in time`,
      };
    }
    let verdict: Verdict;
    if (entry.isSymlink) {
      // A linked file is checked where it points; a linked folder is not followed.
      let info: Deno.FileInfo;
      try {
        info = Deno.statSync(child);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) continue; // a dangling link names nothing
        return { kind: "unreadable", file: child, detail: errorDetail(err) };
      }
      if (!info.isFile) continue;
      verdict = checkPath(child, sweep);
    } else if (entry.isDirectory) {
      let realChild: string;
      try {
        realChild = Deno.realPathSync(child);
      } catch (err) {
        return { kind: "unreadable", file: child, detail: errorDetail(err) };
      }
      if (insideWebJamAppsRepo(realChild)) continue;
      verdict = checkFolder(child, sweep);
    } else if (entry.isFile) {
      verdict = checkPath(child, sweep);
    } else continue;
    if (verdict.kind !== "allow") return verdict;
  }
  return ALLOW;
}

const GLOB_CHARS = /[*?[]/;

/** Expand a literal shell word holding `*`, `?` or `[` against the file system. */
function expandGlob(word: string): string[] {
  const absolute = word.startsWith("/");
  const segments = word.split("/").filter((s, i) => s !== "" || i === 0);
  let bases = [absolute ? "/" : ""];
  for (const segment of segments) {
    if (segment === "") continue;
    if (!GLOB_CHARS.test(segment)) {
      bases = bases.map((b) => (b ? path.join(b, segment) : segment));
      continue;
    }
    const re = path.globToRegExp(segment, { extended: false, globstar: false });
    const next: string[] = [];
    for (const base of bases) {
      try {
        for (const entry of Deno.readDirSync(base || ".")) {
          if (entry.name.startsWith(".") && !segment.startsWith(".")) continue;
          if (re.test(entry.name)) next.push(base ? path.join(base, entry.name) : entry.name);
        }
      } catch {
        // an unreadable or missing folder matches nothing, as in the shell
      }
    }
    bases = next;
  }
  return bases.filter(Boolean);
}

/** The words of one simple command, with redirection operators kept apart. */
function operandWords(argv: string[]): { operands: string[]; recursive: boolean } {
  const name = path.basename(argv[0]);
  const operands: string[] = [];
  let recursive = name === "rg";
  let endOfOptions = false;
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i];
    // Output redirections name a file written, not read; an input one names a file read.
    if (/^\d*(?:>>?|&>>?|>&|<>)$/.test(word)) {
      i++;
      continue;
    }
    if (/^\d*(?:>>?|&>>?|>&)/.test(word)) continue;
    if (/^\d*<$/.test(word)) {
      if (i + 1 < argv.length) operands.push(argv[++i]);
      continue;
    }
    if (/^\d*<[^<]/.test(word)) {
      operands.push(word.replace(/^\d*</, ""));
      continue;
    }
    if (/^\d*<</.test(word)) continue;
    if (!endOfOptions && word === "--") {
      endOfOptions = true;
      continue;
    }
    if (word === "-") continue; // standard input
    if (!endOfOptions && word.startsWith("-")) {
      if (
        name === "grep" && (/^-[^-]*[rR]/.test(word) || /^--(?:dereference-)?recursive$/.test(word))
      ) {
        recursive = true;
      }
      // The value of an `--opt=value` form can name a file (`--file=patterns`).
      const eq = word.indexOf("=");
      if (word.startsWith("--") && eq !== -1) operands.push(word.slice(eq + 1));
      continue;
    }
    // Option values and patterns land here too; a word that names no existing
    // file is passed over when it is checked, so they cost nothing.
    operands.push(word);
  }
  return { operands, recursive };
}

/** Every literal path a reader command names, resolved against the folder it runs in. */
function readerTargets(argv: string[], cwd: string | null): string[] {
  const { operands, recursive } = operandWords(argv);
  const home = homeDir();
  const targets: string[] = [];
  for (const word of operands) {
    if (!word) continue;
    const words = GLOB_CHARS.test(word) ? expandGlobFrom(word, cwd, home) : [word];
    for (const w of words) {
      const resolved = resolveCommandPath(w, cwd, home);
      if (resolved !== null) targets.push(resolved);
    }
  }
  // `grep -r` and `rg` with no path that exists search the folder they run in.
  if (recursive && cwd !== null && !targets.some((t) => exists(t))) targets.push(cwd);
  return targets;
}

function expandGlobFrom(word: string, cwd: string | null, home: string): string[] {
  const literal = word.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (/[$`]/.test(literal)) return [word];
  const absolute = literal.startsWith("/")
    ? literal
    : cwd === null
    ? null
    : path.join(cwd, literal);
  if (absolute === null) return [word];
  const matches = expandGlob(absolute);
  return matches.length ? matches : [word];
}

function exists(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch (err) {
    return !(err instanceof Deno.errors.NotFound || err instanceof Deno.errors.NotADirectory);
  }
}

/** The verdict on a shell command: the first file any reader command in it names that refuses. */
export function checkShellCommand(command: string, cwd: string | null, depth = 0): Verdict {
  if (depth > MAX_NESTED_DEPTH) {
    return { kind: "unreadable", file: "the command", detail: "too many nested shells to follow" };
  }
  const sweep = newSweep();
  for (const part of commandPartsInFolders(command, cwd, homeDir())) {
    if (part.script) continue; // a program that opens a file itself is out of scope
    const tokens = splitShellTokens(part.text);
    if (!tokens.length) continue;
    const resolution = resolveThroughWrappers(tokens);
    if (resolution.kind === "cap-exceeded") {
      return {
        kind: "unreadable",
        file: "the command",
        detail: "too many command wrappers to follow",
      };
    }
    if (resolution.kind === "nested") {
      const verdict = checkShellCommand(resolution.command, part.cwd, depth + 1);
      if (verdict.kind !== "allow") return verdict;
      continue;
    }
    const argv = resolution.argv.slice(resolution.argv.findIndex((w) => !ASSIGN_RE.test(w)));
    if (argv.length && ASSIGN_RE.test(argv[0])) continue; // assignments only
    if (!argv.length || !READER_COMMANDS.has(path.basename(argv[0]))) continue;
    for (const target of readerTargets(argv, part.cwd)) {
      const verdict = checkPath(target, sweep);
      if (verdict.kind !== "allow") return verdict;
    }
  }
  return ALLOW;
}

/** The verdict on one hook payload, as Claude Code, agy (through the shim) or Codex sends it. */
export function checkPayload(raw: string, fallbackCwd = Deno.cwd()): Verdict {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", file: "the tool call", detail: "its payload is not JSON" };
  }
  if (typeof data !== "object" || data === null) {
    return { kind: "unreadable", file: "the tool call", detail: "its payload is not an object" };
  }
  const payload = data as Record<string, unknown>;
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const inputRaw = payload.tool_input ?? {};
  const input = typeof inputRaw === "object" && inputRaw !== null
    ? inputRaw as Record<string, unknown>
    : {};

  if (toolName === "Read" || toolName === "view_file" || toolName === "read_file") {
    const file = input.file_path ?? input.AbsolutePath ?? input.Path;
    if (typeof file !== "string" || !path.isAbsolute(file)) {
      return {
        kind: "unreadable",
        file: "the file the call names",
        detail: "its path is missing or not absolute",
      };
    }
    return checkPath(file);
  }
  if (toolName === "Bash" || toolName === "bash") {
    const command = input.command;
    if (typeof command !== "string") {
      return {
        kind: "unreadable",
        file: "the command",
        detail: "the payload holds no command text",
      };
    }
    const requested = input.cwd ?? input.workdir ?? payload.cwd;
    if (requested !== undefined && (typeof requested !== "string" || !path.isAbsolute(requested))) {
      return {
        kind: "unreadable",
        file: "the command",
        detail: "its working folder is not an absolute path",
      };
    }
    return checkShellCommand(command, typeof requested === "string" ? requested : fallbackCwd);
  }
  return ALLOW;
}

async function readStdin(): Promise<string> {
  return await new Response(Deno.stdin.readable).text();
}

export async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    console.error(
      refusalFor({ kind: "unreadable", file: "the tool call", detail: errorDetail(err) }),
    );
    Deno.exit(2);
  }
  let verdict: Verdict;
  try {
    verdict = checkPayload(raw);
  } catch (err) {
    verdict = {
      kind: "unreadable",
      file: "the tool call",
      detail: `the guard failed: ${errorDetail(err)}`,
    };
  }
  const refusal = refusalFor(verdict);
  if (refusal) {
    console.error(refusal);
    Deno.exit(2);
  }
  Deno.exit(0);
}

if (import.meta.main) {
  await main();
}
