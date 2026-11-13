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
 *     Literal paths, single-assignment path variables, and literal interpreter arguments name the
 *     file. Other script writes retain their folder as an explicitly unnamed destination.
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
 *   - `pushd`, and a `cd` inside a subshell that should not persist.
 */

import {
  ASSIGN_RE,
  commandPartsInFolders,
  type InterpreterInvocation,
  readInterpreterScript,
  resolveCommandPath,
  resolveThroughWrappers,
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
  cwd: string | null;
  home: string;
}

export const resolvePath = resolveCommandPath;

interface ScriptToken {
  text: string;
  literal?: string;
  start: number;
}

/** Read only names, punctuation and literal strings; comments and quoted code are not assignments. */
function scriptTokens(code: string): ScriptToken[] {
  const tokens: ScriptToken[] = [];
  for (let i = 0; i < code.length;) {
    const start = i;
    const ch = code[i];
    if (ch === "\n") {
      tokens.push({ text: ";", start });
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "#" || code.startsWith("//", i)) {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    if (["'", '"', "`"].includes(ch)) {
      let value = "";
      i++;
      while (i < code.length && code[i] !== ch) {
        if (code[i] === "\\" && i + 1 < code.length) i++;
        value += code[i++];
      }
      const closed = code[i] === ch;
      i++;
      tokens.push({ text: code.slice(start, i), literal: closed ? value : undefined, start });
      continue;
    }
    const word = /^[\w$]+/.exec(code.slice(i))?.[0];
    i += word?.length ?? 1;
    tokens.push({ text: word ?? ch, start });
  }
  return tokens;
}

function scriptPath(
  tokens: ScriptToken[],
  invocation?: InterpreterInvocation,
): string | null {
  if (tokens.length === 1 && tokens[0].literal !== undefined) return tokens[0].literal;
  const words = tokens.map((token) => token.text).join("");
  const argument = /^(sys\.argv|process\.argv|Deno\.args)\[(\d+)\]$/.exec(words);
  if (argument && invocation) {
    const offset = argument[1] === "sys.argv"
      ? 1
      : argument[1] === "process.argv"
      ? invocation.script?.kind === "inline" ? 1 : 2
      : 0;
    const family = argument[1] === "sys.argv"
      ? "python"
      : argument[1] === "process.argv"
      ? "javascript"
      : "typescript";
    if (invocation.language !== family) return null;
    return invocation.args[Number(argument[2]) - offset] ?? null;
  }
  const pathStart = tokens[0]?.text === "Path" ? 0 : words.startsWith("pathlib.Path(") ? 2 : -1;
  if (pathStart >= 0 && tokens[pathStart + 1]?.text === "(" && tokens.at(-1)?.text === ")") {
    return scriptPath(tokens.slice(pathStart + 2, -1), invocation);
  }
  return null;
}

function scriptVariables(
  tokens: ScriptToken[],
  invocation?: InterpreterInvocation,
): Map<string, { path: string | null; start: number }> {
  const assignments = new Map<string, { path: string | null; start: number }>();
  for (let i = 0; i + 1 < tokens.length; i++) {
    const name = tokens[i].text;
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || tokens[i - 1]?.text === ".") continue;
    const next = tokens[i + 1].text;
    if (
      ["+", "-", "*", "/", "%", "&", "|", "^"].includes(next) &&
      ["=", next].includes(tokens[i + 2]?.text)
    ) {
      assignments.set(name, { path: null, start: tokens[i].start });
      continue;
    }
    if (next !== "=" || tokens[i + 2]?.text === "=") continue;
    let end = i + 2;
    let nesting = 0;
    while (end < tokens.length) {
      const current = tokens[end];
      if (nesting === 0 && current.text === ";") break;
      if (["(", "["].includes(current.text)) nesting++;
      if ([")", "]"].includes(current.text)) nesting--;
      end++;
    }
    const value = scriptPath(tokens.slice(i + 2, end), invocation);
    assignments.set(name, {
      path: assignments.has(name) ? null : value,
      start: tokens[i].start,
    });
  }
  return assignments;
}

/** Targets written by interpreter code: literal paths where the call names one, otherwise the cwd. */
export function scriptWriteTargets(
  code: string,
  cwd: string | null,
  home: string,
  invocation?: InterpreterInvocation,
  unknown?: (cwd: string | null) => void,
): string[] {
  const targets: string[] = [];
  const tokens = scriptTokens(code);
  const variables = scriptVariables(tokens, invocation);
  const expressionPath = (expression: ScriptToken[], before: number) => {
    const variable = expression.length === 1 ? variables.get(expression[0].text) : undefined;
    return variable
      ? variable.start < before ? variable.path : null
      : scriptPath(expression, invocation);
  };
  for (const pattern of SCRIPT_WRITES) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code))) {
      // A write-looking string/comment is data, not a call.
      if (!tokens.some((token) => token.start === match!.index)) continue;
      let literal: string | null = match[2] ?? null;
      if (literal === null && pattern !== SCRIPT_WRITES[2]) {
        if (pattern === SCRIPT_WRITES[1]) {
          const receiver = match[0].slice(0, match[0].indexOf(".write_"));
          literal = expressionPath(scriptTokens(receiver), match.index);
        } else {
          const start = match.index + match[0].indexOf("(") + 1;
          const expression: ScriptToken[] = [];
          let nesting = 0;
          for (const token of tokens.filter((token) => token.start >= start)) {
            if (nesting === 0 && [",", ")", ";"].includes(token.text)) break;
            if (["(", "["].includes(token.text)) nesting++;
            if ([")", "]"].includes(token.text)) nesting--;
            expression.push(token);
          }
          literal = expressionPath(expression, match.index);
        }
      }
      const resolved = literal !== null ? resolvePath(literal, cwd, home) : null;
      if (resolved) targets.push(resolved);
      else if (unknown) unknown(cwd);
      else if (cwd !== null) targets.push(cwd);
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
  const canonical = name === "nodejs"
    ? "node"
    : /^python\d+(?:\.\d+)*$/.test(name)
    ? "python3"
    : name;
  const invocation = readInterpreterScript([canonical, ...args]);
  if (invocation) {
    return invocation.script?.kind === "inline" ? invocation.script.code : null;
  }
  if (name === "deno") return null;
  const codeFlags = ["-e", "-E", "-p", "--eval", "--print"];
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
  nested?: string;
}

/** Targets named by one resolved argv (wrappers already peeled). */
function argvTargets(
  argv: string[],
  cwd: string | null,
  home: string,
  unknown: (cwd: string | null) => void,
): ArgvResult {
  let i = 0;
  while (i < argv.length && ASSIGN_RE.test(argv[i])) i++;
  if (i >= argv.length) return { targets: [] };
  const name = argv[i].split("/").pop() ?? argv[i];
  const args = argv.slice(i + 1);
  const resolveAll = (paths: string[]) =>
    paths.flatMap((path) => {
      const resolved = resolvePath(path, cwd, home);
      if (!resolved && cwd === null) unknown(null);
      return resolved ? [resolved] : [];
    });
  const scriptTargets = (code: string) =>
    scriptWriteTargets(
      code,
      cwd,
      home,
      readInterpreterScript(argv) ?? undefined,
      unknown,
    );

  switch (name) {
    case "cd":
      return { targets: [] };
    case "tee":
      return { targets: resolveAll(nonOptionArgs(args)) };
    case "sed":
      return { targets: resolveAll(sedInPlaceFiles(args)) };
    case "perl": {
      const code = inlineCode(name, args);
      return {
        targets: [
          ...resolveAll(perlInPlaceFiles(args)),
          ...(code ? scriptTargets(code) : []),
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
        return { targets: code ? scriptTargets(code) : [] };
      }
      return { targets: [] };
    }
  }
}

export interface BashWriteAnalysis {
  targets: string[];
  unknownFiles: string[];
  unknownDirectory: boolean;
}

/** Known files and uncertain writes are separate, so guards never mistake a folder for a file. */
export function analyzeBashWrites(
  command: string,
  opts: WriteTargetOptions,
  depth = 0,
): BashWriteAnalysis {
  const analysis: BashWriteAnalysis = { targets: [], unknownFiles: [], unknownDirectory: false };
  if (depth > MAX_DEPTH) return analysis;
  const { home } = opts;
  const unknown = (cwd: string | null) => {
    if (cwd === null) analysis.unknownDirectory = true;
    else analysis.unknownFiles.push(cwd);
  };
  const nested = (text: string, cwd: string | null) => {
    const result = analyzeBashWrites(text, { cwd, home }, depth + 1);
    analysis.targets.push(...result.targets);
    analysis.unknownFiles.push(...result.unknownFiles);
    analysis.unknownDirectory ||= result.unknownDirectory;
  };
  for (const part of commandPartsInFolders(command, opts.cwd, home)) {
    const { cwd } = part;
    if (part.script) {
      analysis.targets.push(...scriptWriteTargets(part.text, cwd, home, part.invocation, unknown));
      continue;
    }
    const segment = part.text;
    for (const word of redirectTargets(segment)) {
      const resolved = resolvePath(word, cwd, home);
      if (resolved) analysis.targets.push(resolved);
      else if (cwd === null) unknown(null);
    }
    const tokens = withoutRedirections(splitShellTokens(segment));
    if (tokens.length === 0) continue;
    const resolution = resolveThroughWrappers(tokens);
    if (resolution.kind === "cap-exceeded") continue;
    if (resolution.kind === "nested") {
      nested(resolution.command, cwd);
      continue;
    }
    const result = argvTargets(resolution.argv, cwd, home, unknown);
    analysis.targets.push(...result.targets);
    if (result.nested) {
      nested(result.nested, cwd);
    }
  }
  analysis.targets = [...new Set(analysis.targets)];
  analysis.unknownFiles = [...new Set(analysis.unknownFiles)];
  return analysis;
}

/** The CLI's legacy path list includes the folder of a script whose file cannot be named. */
export function bashWriteTargets(command: string, opts: WriteTargetOptions, depth = 0): string[] {
  const result = analyzeBashWrites(command, opts, depth);
  return [...new Set([...result.targets, ...result.unknownFiles])];
}

if (import.meta.main) {
  try {
    const payload = JSON.parse(await new Response(Deno.stdin.readable).text());
    const command = typeof payload?.tool_input?.command === "string"
      ? payload.tool_input.command
      : "";
    const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : Deno.cwd();
    const home = Deno.env.get("HOME") ?? "";
    if (Deno.args.includes("--json")) {
      console.log(JSON.stringify(analyzeBashWrites(command, { cwd, home })));
    } else for (const target of bashWriteTargets(command, { cwd, home })) console.log(target);
  } catch {
    // An unreadable payload names no target, so the gate allows it — the same as an Edit with no path.
  }
}
