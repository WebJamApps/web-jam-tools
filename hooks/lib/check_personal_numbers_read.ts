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
 *     names, cannot read the call itself, a folder sweep passes MAX_SWEEP_FILES
 *     files, or the call's checks, PDF conversion included, pass SWEEP_TIME_LIMIT_MS.
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

/** A path's canonical location, or the path itself when it cannot be resolved. */
function realOr(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    return p;
  }
}

/**
 * Whether `gitDir` is a repository's own metadata folder: a real folder, not a
 * link, holding a well-formed HEAD and the `objects` and `refs` folders git
 * keeps there. An empty folder or a file merely named `.git` is not one.
 */
function isRepositoryGitDir(gitDir: string): boolean {
  try {
    if (!Deno.lstatSync(gitDir).isDirectory) return false;
    if (
      !/^(?:ref: refs\/\S+|[0-9a-f]{40}|[0-9a-f]{64})\s*$/.test(
        Deno.readTextFileSync(path.join(gitDir, "HEAD")),
      )
    ) return false;
    return Deno.lstatSync(path.join(gitDir, "objects")).isDirectory &&
      Deno.lstatSync(path.join(gitDir, "refs")).isDirectory;
  } catch {
    return false;
  }
}

/**
 * Whether `dotGit`, a regular file, makes its folder a linked worktree of a
 * ~/WebJamApps repository, as `git worktree add` sets one up. Its `gitdir:`
 * must resolve to ~/WebJamApps/<repo>/.git/worktrees/<name> of a real
 * repository, that folder must hold the worktree's HEAD, and its `gitdir`
 * file must point back at this very `.git` file, so a `.git` file copied or
 * written by hand into another folder never makes that folder a worktree.
 */
function isWebJamAppsWorktree(dotGit: string, realRoot: string): boolean {
  try {
    if (!Deno.lstatSync(dotGit).isFile) return false;
    const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(Deno.readTextFileSync(dotGit));
    if (!match) return false;
    const gitdir = Deno.realPathSync(path.resolve(path.dirname(dotGit), match[1]));
    if (!gitdir.startsWith(realRoot + "/")) return false;
    const parts = gitdir.slice(realRoot.length + 1).split("/");
    if (parts.length !== 4 || parts[1] !== ".git" || parts[2] !== "worktrees") return false;
    if (!isRepositoryGitDir(path.join(realRoot, parts[0], ".git"))) return false;
    if (!Deno.lstatSync(path.join(gitdir, "HEAD")).isFile) return false;
    const back = Deno.readTextFileSync(path.join(gitdir, "gitdir")).trim();
    return Deno.realPathSync(path.resolve(gitdir, back)) === Deno.realPathSync(dotGit);
  } catch {
    return false;
  }
}

/**
 * A file or folder inside a git working tree of a ~/WebJamApps repository,
 * judged on its real location so a link inside a repository never exempts what
 * it points at. That is a folder under ~/WebJamApps whose `.git` is a real
 * repository's metadata folder, or a linked worktree anywhere (such as
 * /tmp/agy-worktrees/...) whose `.git` file git set up for a ~/WebJamApps
 * repository (isWebJamAppsWorktree). Any other path, under /tmp or not, is
 * never trusted, and a clone outside ~/WebJamApps is not exempt.
 */
export function insideWebJamAppsRepo(realPath: string, home = homeDir()): boolean {
  const realRoot = realOr(path.join(home, "WebJamApps"));
  let dir = realPath;
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let info: Deno.FileInfo | null = null;
    try {
      info = Deno.lstatSync(dotGit);
    } catch {
      // no `.git` at this level
    }
    if (info?.isDirectory && dir.startsWith(realRoot + "/") && isRepositoryGitDir(dotGit)) {
      return true;
    }
    if (info?.isFile && isWebJamAppsWorktree(dotGit, realRoot)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
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

/**
 * One call's budget: every file and folder the call names shares it, so the
 * whole check ends inside run_hook.sh's 15-second timeout. `visited` maps the
 * real path of every folder already walked to whether that walk followed links,
 * so a link back up the tree ends the walk instead of looping. A walk that
 * follows links checks everything one that does not checks, and more, so a
 * folder walked without following links is walked again by a reader that
 * follows them. `now` is the clock, replaceable in tests.
 */
export interface Sweep {
  files: number;
  deadline: number;
  visited: Map<string, boolean>;
  now: () => number;
}

export function newSweep(limitMs = SWEEP_TIME_LIMIT_MS, now: () => number = Date.now): Sweep {
  return { files: 0, deadline: now() + limitMs, visited: new Map(), now };
}

const OUT_OF_TIME = "the guard could not finish checking it in time";
const TOO_MANY = "more files under it than the guard can check in time";

function outOfTime(sweep: Sweep): boolean {
  return sweep.now() > sweep.deadline;
}

/** pdftotext's text, run under `timeout` so a slow PDF cannot outlast the call's budget. */
function pdfText(
  file: string,
  sweep: Sweep,
): { ok: true; text: string } | { ok: false; detail: string } {
  const remainingMs = sweep.deadline - sweep.now();
  if (remainingMs <= 0) return { ok: false, detail: OUT_OF_TIME };
  try {
    const out = new Deno.Command("timeout", {
      args: ["-k", "1", `${(remainingMs / 1000).toFixed(3)}s`, "pdftotext", "-q", file, "-"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (out.code === 124 || out.code === 137) return { ok: false, detail: OUT_OF_TIME };
    if (out.code !== 0) return { ok: false, detail: `pdftotext exited ${out.code}` };
    return { ok: true, text: new TextDecoder().decode(out.stdout) };
  } catch (err) {
    return { ok: false, detail: `pdftotext could not run: ${errorDetail(err)}` };
  }
}

/** Check one regular file the call names. `realFile` is its resolved location. */
function checkFile(file: string, realFile: string, size: number, sweep: Sweep): Verdict {
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
    const pdf = pdfText(file, sweep);
    if (!pdf.ok) return { kind: "unreadable", file, detail: pdf.detail };
    text = pdf.text;
  } else if (bytes.subarray(0, 8192).includes(0)) {
    return ALLOW; // not text: a binary file is not read
  } else {
    text = new TextDecoder().decode(bytes);
  }
  const findings = detectPersonalNumbers(text);
  if (findings.length) return { kind: "found", file, what: describeKinds(findings) };
  // A check that ran past the budget never allows.
  return outOfTime(sweep) ? { kind: "unreadable", file, detail: OUT_OF_TIME } : ALLOW;
}

/**
 * Check a path the call names: a regular file, or every regular file under a
 * folder that the reader would read. A path that does not exist names nothing
 * and is allowed (the call itself will fail); one the guard cannot look at
 * refuses. `follow` is true for a reader that follows links while it walks a
 * folder (`grep -R`, `rg -L`).
 */
export function checkPath(target: string, sweep: Sweep = newSweep(), follow = false): Verdict {
  if (outOfTime(sweep)) return { kind: "unreadable", file: target, detail: OUT_OF_TIME };
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
  if (info.isFile) return checkFile(target, real, info.size, sweep);
  if (!info.isDirectory) return ALLOW; // a socket, device or pipe is not a regular file
  const exempt = insideWebJamAppsRepo(real);
  // A reader that does not follow links reads only the tree's own files, all
  // inside the working tree. One that follows links is walked for its links.
  if (exempt && !follow) return ALLOW;
  return checkFolder(target, real, sweep, follow, exempt);
}

/**
 * Walk a folder as the reader would. The budget is checked before each entry
 * and again before the folder is allowed, so a walk that runs past it refuses.
 * In an exempt working tree only links are checked, each judged where it
 * points: every other entry is inside the tree.
 */
function checkFolder(
  folder: string,
  real: string,
  sweep: Sweep,
  follow: boolean,
  exempt: boolean,
): Verdict {
  // Already walked, or being walked further up this walk, with at least this coverage.
  const walkedFollowing = sweep.visited.get(real);
  if (walkedFollowing === true || (walkedFollowing === false && !follow)) return ALLOW;
  sweep.visited.set(real, follow);
  try {
    for (const entry of Deno.readDirSync(folder)) {
      if (++sweep.files > MAX_SWEEP_FILES || outOfTime(sweep)) {
        return { kind: "unreadable", file: folder, detail: TOO_MANY };
      }
      const child = path.join(folder, entry.name);
      let verdict: Verdict;
      if (entry.isSymlink) {
        let info: Deno.FileInfo;
        try {
          info = Deno.statSync(child);
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) continue; // a dangling link names nothing
          return { kind: "unreadable", file: child, detail: errorDetail(err) };
        }
        if (info.isFile) {
          verdict = checkPath(child, sweep, follow); // judged where it points
        } else if (info.isDirectory && follow) {
          verdict = checkPath(child, sweep, follow);
        } else continue; // a linked folder the reader does not follow
      } else if (entry.isDirectory) {
        const realChild = path.join(real, entry.name);
        const childExempt = exempt || insideWebJamAppsRepo(realChild);
        if (childExempt && !follow) continue;
        verdict = checkFolder(child, realChild, sweep, follow, childExempt);
      } else if (entry.isFile) {
        if (exempt) continue;
        verdict = checkPath(child, sweep, follow);
      } else continue;
      if (verdict.kind !== "allow") return verdict;
    }
  } catch (err) {
    return { kind: "unreadable", file: folder, detail: errorDetail(err) };
  }
  return outOfTime(sweep) ? { kind: "unreadable", file: folder, detail: TOO_MANY } : ALLOW;
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

/** What a reader command reads, as its own option parser would see it. */
interface ReaderArgs {
  /** File and folder operands: the reader's inputs. */
  inputs: string[];
  /** Other files it reads: an input redirection, or a pattern or ignore file. */
  alsoReads: string[];
  /** It walks folders, and with no input searches the folder it runs in. */
  recursive: boolean;
  /** It follows links while walking a folder. */
  follow: boolean;
}

/** Split off shell redirections: a file written is not read; a file redirected in is. */
function splitRedirections(words: string[]): { words: string[]; redirectedIn: string[] } {
  const kept: string[] = [];
  const redirectedIn: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (/^\d*(?:>>?|&>>?|>&|<>)$/.test(word)) {
      i++;
      continue;
    }
    if (/^\d*(?:>>?|&>>?|>&)/.test(word)) continue;
    if (/^\d*<$/.test(word)) {
      if (i + 1 < words.length) redirectedIn.push(words[++i]);
      continue;
    }
    if (/^\d*<[^<]/.test(word)) {
      redirectedIn.push(word.replace(/^\d*</, ""));
      continue;
    }
    if (/^\d*<</.test(word)) continue;
    kept.push(word);
  }
  return { words: kept, redirectedIn };
}

/**
 * The options of `grep` and `rg` that take a value, and those whose value is a
 * file the reader opens. Both parsers take options before, between and after
 * operands until `--`, as GNU getopt and ripgrep do.
 */
const SEARCH_OPTIONS = {
  grep: {
    shortValue: new Set("efmABCdD"),
    longValue: new Set([
      "regexp",
      "file",
      "max-count",
      "after-context",
      "before-context",
      "context",
      "directories",
      "devices",
      "label",
      "include",
      "exclude",
      "exclude-dir",
      "exclude-from",
      "binary-files",
      "group-separator",
    ]),
    readsFile: new Set(["f", "file", "exclude-from"]),
    pattern: new Set(["e", "f", "regexp", "file"]),
  },
  rg: {
    shortValue: new Set("efgtTmABCjMdEr"),
    longValue: new Set([
      "regexp",
      "file",
      "glob",
      "iglob",
      "type",
      "type-not",
      "type-add",
      "type-clear",
      "max-count",
      "after-context",
      "before-context",
      "context",
      "threads",
      "max-columns",
      "max-depth",
      "max-filesize",
      "encoding",
      "replace",
      "pre",
      "pre-glob",
      "ignore-file",
      "path-separator",
      "sort",
      "sortr",
      "color",
      "colors",
      "context-separator",
      "field-match-separator",
      "field-context-separator",
      "dfa-size-limit",
      "regex-size-limit",
      "engine",
      "hostname-bin",
      "hyperlink-format",
      "generate",
    ]),
    readsFile: new Set(["f", "file", "ignore-file"]),
    pattern: new Set(["e", "f", "regexp", "file"]),
  },
} as const;

/** `grep` and `rg`: the pattern and option values are not inputs; a pattern file is read. */
function searchArgs(name: "grep" | "rg", words: string[]): ReaderArgs {
  const spec = SEARCH_OPTIONS[name];
  const positionals: string[] = [];
  const alsoReads: string[] = [];
  let recursive = name === "rg";
  let follow = false;
  let patternGiven = false;
  let endOfOptions = false;
  const takeValue = (option: string, value: string | undefined) => {
    if (value === undefined) return;
    if ((spec.readsFile as ReadonlySet<string>).has(option) && value !== "-") alsoReads.push(value);
    if ((spec.pattern as ReadonlySet<string>).has(option)) patternGiven = true;
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (endOfOptions || word === "-" || !word.startsWith("-")) {
      positionals.push(word);
      continue;
    }
    if (word === "--") {
      endOfOptions = true;
      continue;
    }
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const option = word.slice(2, eq === -1 ? undefined : eq);
      if (option === "recursive") recursive = true;
      if (option === "dereference-recursive") recursive = follow = true;
      if (name === "rg" && option === "follow") follow = true;
      if (name === "rg" && (option === "files" || option === "type-list")) patternGiven = true;
      if (eq !== -1) takeValue(option, word.slice(eq + 1));
      else if ((spec.longValue as ReadonlySet<string>).has(option)) takeValue(option, words[++i]);
      continue;
    }
    // A bundle of short options: `-rn`, `-A3`, `-e PATTERN`, `-rnePATTERN`.
    for (let j = 1; j < word.length; j++) {
      const c = word[j];
      if (spec.shortValue.has(c)) {
        takeValue(c, j + 1 < word.length ? word.slice(j + 1) : words[++i]);
        break;
      }
      if (name === "grep" && c === "r") recursive = true;
      if (name === "grep" && c === "R") recursive = follow = true;
      if (name === "rg" && c === "L") follow = true;
    }
  }
  // With no -e or -f, the first operand is the pattern, not a file.
  const inputs = patternGiven ? positionals : positionals.slice(1);
  return { inputs: inputs.filter((w) => w !== "-"), alsoReads, recursive, follow };
}

/**
 * Any other reader: every word that is not an option may name a file it reads
 * (a script or filter that names no existing file is passed over when checked),
 * and the value of an `--opt=value` form can name a file too.
 */
function plainReaderArgs(words: string[]): ReaderArgs {
  const inputs: string[] = [];
  let endOfOptions = false;
  for (const word of words) {
    if (!endOfOptions && word === "--") {
      endOfOptions = true;
      continue;
    }
    if (word === "-") continue; // standard input
    if (!endOfOptions && word.startsWith("-")) {
      const eq = word.indexOf("=");
      if (word.startsWith("--") && eq !== -1) inputs.push(word.slice(eq + 1));
      continue;
    }
    inputs.push(word);
  }
  return { inputs, alsoReads: [], recursive: false, follow: false };
}

function readerArgs(argv: string[]): ReaderArgs {
  const name = path.basename(argv[0]);
  const { words, redirectedIn } = splitRedirections(argv.slice(1));
  const args = name === "grep" || name === "rg" ? searchArgs(name, words) : plainReaderArgs(words);
  return { ...args, alsoReads: [...args.alsoReads, ...redirectedIn] };
}

/** Resolve shell words to literal paths against the folder the command runs in. */
function resolveWords(words: string[], cwd: string | null): string[] {
  const home = homeDir();
  const out: string[] = [];
  for (const word of words) {
    if (!word) continue;
    const expanded = GLOB_CHARS.test(word) ? expandGlobFrom(word, cwd, home) : [word];
    for (const w of expanded) {
      const resolved = resolveCommandPath(w, cwd, home);
      if (resolved !== null) out.push(resolved);
    }
  }
  return out;
}

/** Every literal path a reader command reads, and whether it follows links in folders. */
function readerTargets(argv: string[], cwd: string | null): { targets: string[]; follow: boolean } {
  const args = readerArgs(argv);
  const inputs = resolveWords(args.inputs, cwd);
  const targets = [...inputs, ...resolveWords(args.alsoReads, cwd)];
  // `grep -r` and `rg` given no input search the folder they run in. An input
  // that does not exist is not counted, so a misread operand can only widen the check.
  if (args.recursive && cwd !== null && !inputs.some((t) => exists(t))) targets.push(cwd);
  return { targets, follow: args.follow };
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
export function checkShellCommand(
  command: string,
  cwd: string | null,
  depth = 0,
  sweep: Sweep = newSweep(),
): Verdict {
  if (depth > MAX_NESTED_DEPTH) {
    return { kind: "unreadable", file: "the command", detail: "too many nested shells to follow" };
  }
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
      const verdict = checkShellCommand(resolution.command, part.cwd, depth + 1, sweep);
      if (verdict.kind !== "allow") return verdict;
      continue;
    }
    const argv = resolution.argv.slice(resolution.argv.findIndex((w) => !ASSIGN_RE.test(w)));
    if (argv.length && ASSIGN_RE.test(argv[0])) continue; // assignments only
    if (!argv.length || !READER_COMMANDS.has(path.basename(argv[0]))) continue;
    const { targets, follow } = readerTargets(argv, part.cwd);
    for (const target of targets) {
      const verdict = checkPath(target, sweep, follow);
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
