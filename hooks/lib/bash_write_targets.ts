/**
 * Files a Bash command writes to, for hooks/opus-delegation-gate.sh.
 *
 * The gate refuses an unapproved Opus session's Edit/Write/NotebookEdit to a file inside a git working
 * tree. Before this module, the same session could make the same change through Bash (a python script
 * that rewrote three repo files ran unblocked right after its Edit was refused). This module lists
 * the files a Bash command would write, so the gate can apply its unchanged Edit/Write decision to
 * each of them: a target outside any git working tree is exempt, exactly as an Edit there is.
 *
 * It closes the accidental path, not a determined bypass. Shapes recognized:
 *   - output redirection: `>`, `>>`, `>|`, `&>`, `&>>`, `N>` to a file. `/dev/null`, `/dev/std*`,
 *     `/dev/tty`, `/dev/fd/*` and fd duplication (`2>&1`, `>&2`) are not writes.
 *   - `tee`, `sed -i` / `--in-place`, `perl -i`, `cp` / `mv` / `install` (destination), `truncate`,
 *     `dd of=`, `patch` and `git apply` (which write the files named inside the patch, so they are
 *     judged by the directory they run in), each also behind `sudo`/`env`/`nohup`/... wrappers and
 *     inside `bash -c "..."` / `eval`.
 *   - inline interpreter code that writes: `python -c`, `node -e/-p`, `perl -e`, `ruby -e`,
 *     `deno eval`, and a heredoc fed to python/node/deno/perl/ruby. Write calls recognized:
 *     python `open(..., 'w'|'a'|'x'|'+')`, `.write_text(`, `.write_bytes(`, `shutil.copy` and
 *     `shutil.move` (and variants), `os.rename`, `os.replace`; node `fs.writeFile`, `appendFile`,
 *     `createWriteStream`, `copyFile`, `rename`, `cpSync` (and their Sync forms); Deno
 *     `writeTextFile`, `writeFile`, `create`, `copyFile`, `rename`, `truncate` (and Sync forms); perl `open(FH, '>...')`; ruby
 *     `File.write`, `IO.write`, `File.open(..., 'w'|'a')`.
 *     A literal quoted path as the write call's first argument is the target; a write through a
 *     variable is judged by the working directory, because the file it writes is unknown but the
 *     write itself is certain.
 * `cd <dir>` earlier in the command moves the working directory later targets resolve against.
 *
 * Known gaps (allowed, on purpose or for now):
 *   - a script file run by an interpreter (`python3 fix.py`, `deno run x.ts`, `node x.js`): its code is
 *     not read.
 *   - a redirect or argument naming its path through a shell variable or command substitution other
 *     than `$HOME`: the path is unknown, so it is allowed rather than guessed.
 *   - interpreter code choosing its write mode through a variable (`open(p, mode)`), `os.open`, and
 *     writes through other libraries or languages (`awk`, `ruby -i`, `rsync`, `ln`, `git checkout`,
 *     `git restore`, formatters like `deno fmt`).
 *   - `cd` into a variable, `pushd`, and a `cd` inside a subshell that should not persist.
 */

import {
  ASSIGN_RE,
  findHeredocMarker,
  resolveThroughWrappers,
  splitOnOperators,
  splitShellTokens,
} from "./normalize_command.ts";

/** Nesting cap for `bash -c` / `eval` strings; deeper nesting is not inspected. */
const MAX_DEPTH = 6;

const SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash"]);
const SCRIPT_INTERPRETER = /^(?:python(?:\d+(?:\.\d+)?)?|node|nodejs|deno|perl|ruby)$/;
const NOT_A_FILE = /^\/dev\/(?:null|stdout|stderr|stdin|tty|fd\/\d+)$/;

/**
 * Write calls inside interpreter code. Group 1, when it captured, is a literal first-argument path.
 * Each pattern names the call; the mode check for `open` requires a writing mode letter.
 */
const SCRIPT_WRITES: RegExp[] = [
  // python open('path', 'w') / open(path, mode='a')
  /\bopen\(\s*(?:(['"])([^'"\n]*)\1|[^,()\n]+)\s*,\s*(?:mode\s*=\s*)?['"](?![<>])[^'"\n]*[wax+][^'"\n]*['"]/g,
  // pathlib Path('path').write_text / write_bytes, or p.write_text
  /(?:\bPath\(\s*(['"])([^'"\n]*)\1\s*\)|[\w\])]+)\.write_(?:text|bytes)\(/g,
  // shutil / os moves and copies: destination is the second argument, so the path is never literal here
  /\b(?:shutil\.(?:copy|copy2|copyfile|copytree|move)|os\.(?:rename|replace))\((?:())()/g,
  // node fs
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|cpSync)\(\s*(?:(['"`])([^'"`\n]*)\1)?/g,
  // Deno
  /\bDeno\.(?:writeTextFile|writeTextFileSync|writeFile|writeFileSync|create|createSync|copyFile|copyFileSync|rename|renameSync|truncate|truncateSync)\(\s*(?:(['"`])([^'"`\n]*)\1)?/g,
  // perl open(FH, '>path') / open(my $fh, '>>', 'path')
  /\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*(['"])\s*(?:>>?|\+<)\s*([^'"\n]*)\1/g,
  // ruby
  /\b(?:File|IO)\.write\(\s*(?:(['"])([^'"\n]*)\1)?/g,
  /\bFile\.open\(\s*(?:(['"])([^'"\n]*)\1|[^,()\n]+)\s*,\s*['"][^'"\n]*[wa+][^'"\n]*['"]/g,
];

export interface WriteTargetOptions {
  cwd: string;
  home: string;
}

/** Joins a path onto a base, without touching the filesystem. `~` and `$HOME` expand. */
export function resolvePath(raw: string, cwd: string, home: string): string | null {
  let p = raw.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (p === "" || /[$`]/.test(p)) return null;
  if (!p.startsWith("/")) p = `${cwd.replace(/\/+$/, "")}/${p}`;
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Targets written by interpreter code: literal paths where the call names one, otherwise the cwd. */
export function scriptWriteTargets(code: string, cwd: string, home: string): string[] {
  const targets: string[] = [];
  for (const pattern of SCRIPT_WRITES) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code))) {
      const literal = match[2];
      const resolved = literal ? resolvePath(literal, cwd, home) : null;
      targets.push(resolved ?? cwd);
    }
  }
  return [...new Set(targets)];
}

/** The file words that redirections in one simple command write to. */
export function redirectTargets(segment: string): string[] {
  const out: string[] = [];
  let inS = false;
  let inD = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (inS) {
      if (ch === "'") inS = false;
      continue;
    }
    if (inD) {
      if (ch === "\\") i++;
      else if (ch === '"') inD = false;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'") {
      inS = true;
      continue;
    }
    if (ch === '"') {
      inD = true;
      continue;
    }
    if (ch !== ">") continue;
    if (i > 0 && segment[i - 1] === "<") continue; // `<>` read-write open of stdin: not a file write we model
    let j = i + 1;
    if (segment[j] === ">" || segment[j] === "|") j++;
    if (segment[j] === "&") { // `>&2`, `2>&1`: fd duplication
      i = j;
      continue;
    }
    while (j < segment.length && /[ \t]/.test(segment[j])) j++;
    const word = splitShellTokens(segment.slice(j))[0] ?? "";
    const rawWord = segment.slice(j).match(/^\S+/)?.[0] ?? "";
    i = j + Math.max(rawWord.length, 1) - 1;
    if (word && !NOT_A_FILE.test(word) && !word.startsWith("(")) out.push(word);
  }
  return out;
}

/**
 * Drops redirection operators and their file words from a token list, so `tee f > /dev/null` is not
 * read as `tee` writing to `>`. Redirect targets are collected separately by redirectTargets.
 */
export function withoutRedirections(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^(?:\d*|&)(?:>>?|>\||<<?<?)$/.test(t)) {
      i++;
      continue;
    }
    if (/^(?:\d*|&)(?:>>?|>\||<<?<?)\S/.test(t)) continue;
    out.push(t);
  }
  return out;
}

function nonOptionArgs(args: string[], valueFlags: Set<string> = new Set()): string[] {
  const out: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!endOfOptions && a === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && a.startsWith("-") && a !== "-") {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function sedInPlaceFiles(args: string[]): string[] {
  const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
  if (!inPlace) return [];
  const hasScriptFlag = args.some((a) =>
    a === "-e" || a === "-f" || a.startsWith("--expression") || a.startsWith("--file")
  );
  const positional = nonOptionArgs(args, new Set(["-e", "-f", "-l", "--expression", "--file"]));
  return hasScriptFlag ? positional : positional.slice(1);
}

function perlInPlaceFiles(args: string[]): string[] {
  let inPlace = false;
  let hasCode = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-[a-zA-Z0-9]*[eE]$/.test(a)) {
      hasCode = true;
      if (/^-[a-zA-Z0-9]*i/.test(a)) inPlace = true;
      i++;
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      // -M/-m/-I carry a module name or include path, whose letters are not switches.
      if (!/^-[MmI]/.test(a) && /^-[a-zA-Z0-9]*i/.test(a)) inPlace = true;
      continue;
    }
    positional.push(a);
  }
  if (!inPlace) return [];
  return hasCode ? positional : positional.slice(1);
}

/** Inline code passed to an interpreter by flag (`-c`, `-e`, `-p`) or `deno eval`, or null. */
function inlineCode(name: string, args: string[]): string | null {
  if (name === "deno") {
    return args[0] === "eval" ? nonOptionArgs(args.slice(1)).join(" ") : null;
  }
  const codeFlags = name.startsWith("python") ? ["-c"] : ["-e", "-E", "-p", "--eval", "--print"];
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (codeFlags.includes(a) && i + 1 < args.length) {
      parts.push(args[++i]);
    } else if (name === "perl" && /^-[a-zA-Z0-9]*[eE]$/.test(a) && i + 1 < args.length) {
      parts.push(args[++i]);
    }
  }
  return parts.length ? parts.join("\n") : null;
}

interface ArgvResult {
  targets: string[];
  cd?: string;
  nested?: string;
}

/** Targets named by one resolved argv (wrappers already peeled). */
function argvTargets(argv: string[], cwd: string, home: string): ArgvResult {
  let i = 0;
  while (i < argv.length && ASSIGN_RE.test(argv[i])) i++;
  if (i >= argv.length) return { targets: [] };
  const name = argv[i].split("/").pop() ?? argv[i];
  const args = argv.slice(i + 1);
  const resolveAll = (paths: string[]) =>
    paths.map((p) => resolvePath(p, cwd, home)).filter((p): p is string => p !== null);

  switch (name) {
    case "cd": {
      const dir = args.find((a) => !a.startsWith("-")) ?? home;
      if (args.includes("-")) return { targets: [] };
      return { targets: [], cd: resolvePath(dir, cwd, home) ?? undefined };
    }
    case "tee":
      return { targets: resolveAll(nonOptionArgs(args)) };
    case "sed":
      return { targets: resolveAll(sedInPlaceFiles(args)) };
    case "perl": {
      const code = inlineCode(name, args);
      return {
        targets: [
          ...resolveAll(perlInPlaceFiles(args)),
          ...(code ? scriptWriteTargets(code, cwd, home) : []),
        ],
      };
    }
    case "cp":
    case "mv":
    case "install": {
      const targetFlag = args.findIndex((a) => a === "-t" || a.startsWith("--target-directory"));
      if (targetFlag >= 0) {
        const flag = args[targetFlag];
        const dir = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : args[targetFlag + 1];
        return { targets: dir ? resolveAll([dir]) : [] };
      }
      const positional = nonOptionArgs(args, new Set(["-S", "--suffix", "-m", "-o", "-g"]));
      return { targets: positional.length >= 2 ? resolveAll(positional.slice(-1)) : [] };
    }
    case "truncate":
      return { targets: resolveAll(nonOptionArgs(args, new Set(["-s", "-r"]))) };
    case "dd":
      return {
        targets: resolveAll(args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3))),
      };
    case "patch": {
      if (args.includes("--dry-run")) return { targets: [] };
      const out = args.findIndex((a) => a === "-o" || a === "--output");
      if (out >= 0 && args[out + 1]) return { targets: resolveAll([args[out + 1]]) };
      const dirFlag = args.findIndex((a) => a === "-d" || a === "--directory");
      const dir = dirFlag >= 0 && args[dirFlag + 1] ? args[dirFlag + 1] : ".";
      return { targets: resolveAll([dir]) };
    }
    case "git": {
      let j = 0;
      let dir = ".";
      while (j < args.length && args[j].startsWith("-")) {
        if (args[j] === "-C" && args[j + 1]) {
          dir = args[j + 1];
          j += 2;
        } else if (args[j] === "-c") j += 2;
        else j++;
      }
      if (args[j] !== "apply") return { targets: [] };
      const rest = args.slice(j + 1);
      const readOnly =
        rest.some((a) => ["--check", "--stat", "--numstat", "--summary"].includes(a)) &&
        !rest.includes("--apply");
      return { targets: readOnly ? [] : resolveAll([dir]) };
    }
    default: {
      if (SHELLS.has(name)) {
        const c = args.indexOf("-c");
        return { targets: [], nested: c >= 0 && args[c + 1] ? args[c + 1] : undefined };
      }
      if (SCRIPT_INTERPRETER.test(name)) {
        const code = inlineCode(name, args);
        return { targets: code ? scriptWriteTargets(code, cwd, home) : [] };
      }
      return { targets: [] };
    }
  }
}

interface Split {
  shell: string;
  scripts: string[];
}

/**
 * Separates heredoc bodies from shell text. A body fed to python/node/deno/perl/ruby is interpreter
 * code; a body fed to a shell stays shell text; any other body (a commit message, `cat > f <<EOF`
 * content) is data and dropped. The redirect or `tee` on the marker line still names the file.
 */
export function splitHeredocs(command: string): Split {
  const lines = command.split("\n");
  const shell: string[] = [];
  const scripts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    shell.push(line);
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
    // Every command word on the marker line, before or after `<<` (`cat <<EOF | python3`).
    const words = splitShellTokens(line.replace(/[|;&()]/g, " ")).map((w) =>
      w.split("/").pop() ?? w
    );
    if (words.some((w) => SCRIPT_INTERPRETER.test(w))) scripts.push(body.join("\n"));
    else if (words.some((w) => SHELLS.has(w))) shell.push(...body);
    i = j;
  }
  return { shell: shell.join("\n"), scripts };
}

/** Absolute paths (or working directories, for unknown destinations) that `command` writes to. */
export function bashWriteTargets(
  command: string,
  opts: WriteTargetOptions,
  depth = 0,
): string[] {
  if (depth > MAX_DEPTH) return [];
  const { home } = opts;
  let cwd = opts.cwd;
  const { shell, scripts } = splitHeredocs(command);
  const targets: string[] = [];

  for (const segment of splitOnOperators(shell).segments) {
    for (const word of redirectTargets(segment)) {
      const resolved = resolvePath(word, cwd, home);
      if (resolved) targets.push(resolved);
    }
    const tokens = withoutRedirections(splitShellTokens(segment));
    if (tokens.length === 0) continue;
    const resolution = resolveThroughWrappers(tokens);
    if (resolution.kind === "cap-exceeded") continue;
    if (resolution.kind === "nested") {
      targets.push(...bashWriteTargets(resolution.command, { cwd, home }, depth + 1));
      continue;
    }
    const result = argvTargets(resolution.argv, cwd, home);
    targets.push(...result.targets);
    if (result.nested) {
      targets.push(...bashWriteTargets(result.nested, { cwd, home }, depth + 1));
    }
    if (result.cd) cwd = result.cd;
  }
  // A heredoc script is judged from the last `cd` in the command (`cd repo && python3 - <<EOF`).
  for (const code of scripts) {
    targets.push(...scriptWriteTargets(code, cwd, home));
  }
  return [...new Set(targets)];
}

if (import.meta.main) {
  try {
    const payload = JSON.parse(await new Response(Deno.stdin.readable).text());
    const command = typeof payload?.tool_input?.command === "string"
      ? payload.tool_input.command
      : "";
    const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : Deno.cwd();
    const home = Deno.env.get("HOME") ?? "";
    for (const target of bashWriteTargets(command, { cwd, home })) console.log(target);
  } catch {
    // An unreadable payload names no target, so the gate allows it — the same as an Edit with no path.
  }
}
