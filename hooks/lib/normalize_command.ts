/**
 * Shared command normalization for the PreToolUse Bash guards.
 *
 * Reads the raw command from the CMD_FOR_PY environment variable and prints a
 * normalized, whitespace-collapsed form for the guards to pattern-match against.
 *
 * Two transformations, both about the same question: *is this text going to be
 * executed, or is it prose being recorded?*
 *
 * 1. stripHeredocs — drops heredoc BODIES, because a heredoc is usually how a
 *    PR body / commit message / issue text gets passed inline, and prose that
 *    merely mentions a dangerous command must not trip a guard.
 *
 *    ⚠️ EXCEPT when the heredoc feeds an interpreter. `bash <<EOF ... EOF`
 *    EXECUTES its body. Stripping that would turn every guard into a one-line
 *    bypass, so an interpreter-fed body is kept in scope. This was a live hole:
 *    before web-jam-tools#272 the secret guard stripped those bodies too.
 *
 * 2. dropProse — drops the values of flags that carry free-form authored text
 *    (--body, -m, --title, ...). Deliberately does NOT include -c: sh/bash/
 *    python3/node payloads are executed and must stay in scope.
 */

// Commands that EXECUTE a heredoc body rather than consume it as data. A body
// fed to one of these must stay in scope for matching.
const INTERPRETER =
  /(^|[\s;&|(])(env\s+)?((ba|z|k|da)?sh|python3?|node|deno|perl|ruby|awk|xargs)\b/;

export function findHeredocMarker(line: string): [string, boolean] | null {
  let inSquote = false;
  let inDquote = false;
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];
    if (inSquote) {
      if (ch === "'") inSquote = false;
      i++;
      continue;
    }
    if (inDquote) {
      if (ch === "\\" && i + 1 < n) {
        i += 2;
        continue;
      }
      if (ch === '"') inDquote = false;
      i++;
      continue;
    }
    if (ch === "'") {
      inSquote = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDquote = true;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < n) {
      i += 2;
      continue;
    }
    if (ch === "<" && i + 1 < n && line[i + 1] === "<") {
      let j = i + 2;
      let stripTabs = false;
      if (j < n && line[j] === "-") {
        stripTabs = true;
        j++;
      }
      while (j < n && line[j] === " ") j++;
      if (j < n && (line[j] === "'" || line[j] === '"')) j++;
      const start = j;
      while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++;
      const word = line.slice(start, j);
      if (word) {
        return [word, stripTabs];
      }
      i += 2;
      continue;
    }
    i++;
  }
  return null;
}

export function stripHeredocs(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i];
    out.push(line);
    const marker = findHeredocMarker(line);
    if (marker) {
      const [word, stripTabs] = marker;
      const executed = INTERPRETER.test(line);
      let j = i + 1;
      const body: string[] = [];
      let terminated = false;

      while (j < n) {
        const probe = stripTabs ? lines[j].replace(/^\t+/, "") : lines[j];
        if (probe.replace(/\r$/, "") === word) {
          terminated = true;
          j++;
          break;
        }
        body.push(lines[j]);
        j++;
      }

      if (executed || !terminated) {
        out.push(...body);
      }
      i = j;
      continue;
    }
    i++;
  }

  return out.join("\n");
}

const SHELL_OP = /\$\(|`/;

const PROSE_FLAGS = new Set([
  "--body",
  "--body-file",
  "-m",
  "--message",
  "--summary",
  "--summary-file",
  "--test-plan",
  "--test-plan-file",
  "--test-evidence",
  "--test-evidence-file",
  "--notes",
  "--title",
  "-t",
]);

export function splitShellTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSquote = false;
  let inDquote = false;
  let escaped = false;
  let inToken = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      current += ch;
      escaped = false;
      inToken = true;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      inToken = true;
      continue;
    }
    if (inSquote) {
      if (ch === "'") {
        inSquote = false;
      } else {
        current += ch;
      }
      inToken = true;
      continue;
    }
    if (inDquote) {
      if (ch === '"') {
        inDquote = false;
      } else {
        current += ch;
      }
      inToken = true;
      continue;
    }
    if (ch === "'") {
      inSquote = true;
      inToken = true;
      continue;
    }
    if (ch === '"') {
      inDquote = true;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

// A leading `VAR=value` environment-assignment prefix on a simple command
// (e.g. `FOO=bar git push -d branch`). Shared by every guard that needs to
// find the REAL command name after skipping any such prefixes.
export const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split raw command text into simple-command segments on unquoted `&&`,
 * `||`, `;`, `|`, or a bare newline — WITHOUT requiring surrounding
 * whitespace (unlike a token-boundary split), so `false||git push -d x` and
 * `echo hi;git push origin :x` split correctly, not just the
 * whitespace-padded form. Also reports whether a quote was left open (an
 * unterminated quote is an ambiguous parse — the caller fails closed on
 * that).
 *
 * A bare newline is treated the same as `;`: without this, a real
 * multi-line script like
 *
 *   git status
 *   git push origin --delete some-branch
 *
 * would otherwise need to be recognized as two separate commands, not one
 * merged argv list — `splitShellTokens` alone treats `\n` as ordinary
 * whitespace, not a command boundary.
 *
 * A bare `&` (background/sequencing — `cmd1 & cmd2` runs cmd1 backgrounded
 * and cmd2 right after, two simple commands) is also a boundary, same as
 * `;`. This is deliberately NOT applied when the `&` is part of a redirect
 * rather than an operator: fd-duplication (`2>&1`, `>&2`, `<&3` — `&`
 * directly follows `>`/`<`) or the bash `&>`/`&>>` stdout+stderr redirect
 * (`&` directly precedes `>`). Those forms stay in the current segment.
 *
 * Unquoted `(`, `)`, `{` and `}` are also boundaries, same as `;` — they
 * bound subshell grouping (`( gh issue create ... )`) and brace grouping
 * (`{ gh issue create ...; }`), and are otherwise discarded (not appended
 * to either neighboring segment) rather than kept as their own token. A
 * grouping character can also appear as ordinary command SYNTAX ($(...)
 * command substitution, ${...} parameter expansion, $((...)) arithmetic,
 * `foo() { ...; }` function definitions, `{a,b}` brace expansion) — this
 * function does not try to distinguish those from real grouping and
 * splits on them too. Every matcher this file feeds (git-push-deletion,
 * dangerous-deploy, issue-creation) is a POSITIONAL check anchored on a
 * segment's own `tokens[0]`, so an extra split never invents a match out of
 * text that contains no gated command at all — it can only surface one a
 * merged segment would have hidden.
 *
 * It CAN, however, surface a gated command that appears in a position where
 * it would not actually run: `cleanup() { git push origin --delete b; }`
 * merely DEFINES a function, but splitting on `{` leaves a segment whose
 * `tokens[0]` is `git`, so the deletion guard blocks it. That is deliberate.
 * Over-blocking a definition is the safe direction for guards whose whole
 * purpose is to stop an irreversible operation, and unpicking definition
 * from invocation would mean parsing shell grammar rather than splitting it.
 *
 * Shared by hooks/lib/check_irreversible_operations.ts,
 * hooks/lib/check_dangerous_git_deploy.ts,
 * hooks/lib/check_issue_approval_token.ts and
 * hooks/lib/check_model_label_on_issue_create.ts — do not duplicate this in
 * any of them; import it from here.
 */
export function splitOnOperators(text: string): { segments: string[]; unterminated: boolean } {
  const segments: string[] = [];
  let current = "";
  let inSquote = false;
  let inDquote = false;
  let escaped = false;
  let i = 0;
  const n = text.length;

  const flush = () => {
    segments.push(current);
    current = "";
  };

  while (i < n) {
    const ch = text[i];
    if (escaped) {
      current += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      i++;
      continue;
    }
    if (inSquote) {
      current += ch;
      if (ch === "'") inSquote = false;
      i++;
      continue;
    }
    if (inDquote) {
      current += ch;
      if (ch === '"') inDquote = false;
      i++;
      continue;
    }
    if (ch === "'") {
      inSquote = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDquote = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      flush();
      i++;
      continue;
    }
    if ((ch === "&" && text[i + 1] === "&") || (ch === "|" && text[i + 1] === "|")) {
      flush();
      i += 2;
      continue;
    }
    if (ch === "|") {
      flush();
      i++;
      continue;
    }
    if (ch === "&") {
      const prevCh = i > 0 ? text[i - 1] : "";
      const nextCh = i + 1 < n ? text[i + 1] : "";
      if (prevCh === ">" || prevCh === "<" || nextCh === ">") {
        // Part of a redirect (`2>&1`, `>&2`, `<&3`, `&>file`, `&>>file`),
        // not the background/sequencing operator — keep it in the segment.
        current += ch;
        i++;
        continue;
      }
      flush();
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      flush();
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  flush();

  return { segments, unterminated: inSquote || inDquote };
}

export function dropProse(text: string): string {
  const tokens = splitShellTokens(text);
  const kept: string[] = [];
  let prevFlag: string | null = null;

  for (const tok of tokens) {
    if (tok.includes("=")) {
      const idx = tok.indexOf("=");
      const flag = tok.slice(0, idx);
      const value = tok.slice(idx + 1);
      if (PROSE_FLAGS.has(flag) && !SHELL_OP.test(value)) {
        kept.push(flag);
        prevFlag = null;
        continue;
      }
    }
    if (prevFlag !== null && !SHELL_OP.test(tok)) {
      prevFlag = null;
      continue;
    }
    kept.push(tok);
    prevFlag = PROSE_FLAGS.has(tok) ? tok : null;
  }
  return kept.join(" ");
}

export function normalize(cmd: string): string {
  let result: string;
  try {
    result = dropProse(stripHeredocs(cmd));
  } catch {
    result = cmd;
  }
  return result.replace(/\s+/g, " ").trim();
}

/**
 * Wrapper-program resolution (web-jam-tools, guard-wrapper-bypass fix).
 *
 * Both positional guards (`check_irreversible_operations.ts`'s
 * `isGitPushDeletion`, `check_dangerous_git_deploy.ts`'s `checkSegment`)
 * require the REAL command to sit at argv[0] (after skipping `VAR=value`
 * assignment prefixes). That's true for a bare `git push --delete x`, but a
 * wrapper program that execs its argument — `xargs`, `env`, `sudo`, `nohup`,
 * `timeout`, `stdbuf`, `command`, `nice`, `ionice`, `setsid`, or an
 * interpreter/eval/ssh form that carries a nested command STRING
 * (`bash -c "..."`, `eval "..."`, `ssh host "..."`) — puts a different word
 * at argv[0] and defeats the check entirely, even though the wrapped command
 * still runs for real. `SUBSTRING_RULES`-style flat-text regex checks are
 * unaffected (they see the whole command text regardless of argv shape);
 * this only matters for POSITIONAL checks.
 *
 * `resolveWrapperLayer` peels exactly ONE layer: either returning the argv
 * of whatever comes after the wrapper's own name/flags/required positionals,
 * or — for the nested-string forms — the payload as a fresh command STRING
 * that must be re-parsed (it may itself contain operators, further
 * wrappers, etc.), or `null` if argv[0] isn't a recognized wrapper (i.e. is
 * already the real command, or an ordinary unrelated command).
 *
 * `resolveThroughWrappers` loops that until it bottoms out, caps iterations
 * so a crafted `sudo sudo sudo ...` chain can't hang the hook, and reports a
 * `nested` command string separately from a fully-resolved `argv` so callers
 * can recurse into their OWN top-level checker (with its own depth cap) for
 * the nested-string case, while just re-checking `argv` positionally for the
 * plain wrapper-peel case.
 */

// Prefix wrappers: argv[0] is the wrapper name, then flags, then (for
// `timeout`) one required positional (the duration), then the real command's
// own argv continues as further tokens — no re-parsing needed, just skip
// forward.
interface PrefixWrapperSpec {
  // Flags that consume the NEXT token as their value when they appear as an
  // exact standalone token (e.g. `-u joshua`, `-n 1`). An attached form like
  // `-oL` or `-I{}` is a single token and is skipped on its own, no lookahead
  // — that's deliberately conservative: worst case we skip one token too few
  // and the loop below still finds the real command a token later.
  valueFlags: Set<string>;
  // Required non-flag positional arguments after the flags (e.g. timeout's
  // DURATION) that belong to the wrapper, not the wrapped command.
  positionals: number;
}

const PREFIX_WRAPPERS: Record<string, PrefixWrapperSpec> = {
  xargs: {
    valueFlags: new Set([
      "-I",
      "-n",
      "-P",
      "-L",
      "-s",
      "-a",
      "-E",
      "-e",
      "-d",
      "-l",
      "-p",
      "-x",
      "--delimiter",
      "--max-args",
      "--max-procs",
      "--replace",
      "--arg-file",
    ]),
    positionals: 0,
  },
  env: {
    valueFlags: new Set([
      "-u",
      "--unset",
      "-C",
      "--chdir",
      "-S",
      "--split-string",
      "--block-signal",
      "--ignore-signal",
      "--default-signal",
      "--argv0",
    ]),
    positionals: 0,
  },
  sudo: {
    valueFlags: new Set([
      "-u",
      "--user",
      "-g",
      "--group",
      "-p",
      "--prompt",
      "-r",
      "--role",
      "-t",
      "--type",
      "-C",
      "--close-from",
      "-h",
      "--host",
    ]),
    positionals: 0,
  },
  nohup: { valueFlags: new Set(), positionals: 0 },
  timeout: {
    valueFlags: new Set(["-s", "--signal", "-k", "--kill-after"]),
    positionals: 1,
  },
  stdbuf: {
    valueFlags: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
    positionals: 0,
  },
  command: { valueFlags: new Set(), positionals: 0 },
  nice: { valueFlags: new Set(["-n", "--adjustment"]), positionals: 0 },
  ionice: {
    valueFlags: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"]),
    positionals: 0,
  },
  setsid: { valueFlags: new Set(), positionals: 0 },
};

// Shells whose `-c` flag executes its next argument as shell code.
const SHELL_INTERPRETER_NAMES = new Set(["bash", "sh", "zsh", "ksh", "dash", "ash"]);

// Flags for `ssh` that consume a following value token, so the host isn't
// mistaken for a flag's value or vice versa.
const SSH_VALUE_FLAGS = new Set([
  "-i",
  "-p",
  "-o",
  "-l",
  "-F",
  "-J",
  "-L",
  "-R",
  "-D",
  "-W",
  "-B",
  "-b",
  "-c",
  "-e",
  "-Q",
  "-E",
]);

function basename(tok: string): string {
  return tok.split("/").pop() ?? tok;
}

export type WrapperLayer =
  | { kind: "argv"; argv: string[] }
  | { kind: "nested"; command: string };

/**
 * Peel exactly one wrapper layer from `argv`. Returns `null` if argv[0]
 * (after skipping `VAR=value` prefixes) is not a recognized wrapper — the
 * caller should treat `argv` as already resolved.
 */
export function resolveWrapperLayer(argv: string[]): WrapperLayer | null {
  let i = 0;
  while (i < argv.length && ASSIGN_RE.test(argv[i])) i++;
  if (i >= argv.length) return null;

  const name = basename(argv[i]);

  // `bash -c "..."` / `sh -c "..."` etc. — the payload is a nested command
  // STRING, not more argv for the same command.
  if (SHELL_INTERPRETER_NAMES.has(name) && argv[i + 1] === "-c" && i + 2 < argv.length) {
    return { kind: "nested", command: argv.slice(i + 2).join(" ") };
  }

  // `eval "..."` — eval joins ALL its arguments with a space and re-parses
  // the result as shell code.
  if (name === "eval" && i + 1 < argv.length) {
    return { kind: "nested", command: argv.slice(i + 1).join(" ") };
  }

  // `ssh host "..."` — everything after the (possibly-flagged) host is the
  // remote command string.
  if (name === "ssh") {
    let j = i + 1;
    while (j < argv.length && argv[j].startsWith("-") && argv[j] !== "-") {
      j += SSH_VALUE_FLAGS.has(argv[j]) ? 2 : 1;
    }
    if (j >= argv.length) return null; // no host — nothing to resolve
    j++; // skip the host itself
    if (j >= argv.length) return null; // interactive session, no remote command
    return { kind: "nested", command: argv.slice(j).join(" ") };
  }

  const spec = PREFIX_WRAPPERS[name];
  if (!spec) return null;

  let j = i + 1;
  while (j < argv.length && argv[j].startsWith("-") && argv[j] !== "-") {
    j += spec.valueFlags.has(argv[j]) ? 2 : 1;
  }
  j += spec.positionals;
  return { kind: "argv", argv: argv.slice(Math.min(j, argv.length)) };
}

// A "sane" cap on how many prefix-wrapper layers may be peeled for a single
// simple command — nothing legitimate nests this deep; this exists so a
// crafted `sudo sudo sudo ...` chain can't hang the hook. Hitting it fails
// CLOSED (block), same contract as every other parse failure in these
// guards.
export const MAX_WRAPPER_ITERATIONS = 25;

// A "sane" cap on how many NESTED command strings (`bash -c`, `eval`, `ssh`)
// a caller should recurse through. Hitting it also fails CLOSED.
export const MAX_WRAPPER_RECURSION_DEPTH = 6;

export type WrapperResolution =
  | { kind: "argv"; argv: string[] }
  | { kind: "nested"; command: string }
  | { kind: "cap-exceeded" };

/**
 * Resolve `argv` through as many prefix-wrapper layers as needed to reach
 * either the real command's own argv, or a nested command STRING that must
 * be re-parsed by the caller (recursing into its own top-level checker with
 * an incremented depth, capped at MAX_WRAPPER_RECURSION_DEPTH).
 */
export function resolveThroughWrappers(argv: string[]): WrapperResolution {
  let current = argv;
  let iterations = 0;
  while (true) {
    const layer = resolveWrapperLayer(current);
    if (layer === null) return { kind: "argv", argv: current };
    if (layer.kind === "nested") return { kind: "nested", command: layer.command };
    current = layer.argv;
    iterations++;
    if (iterations > MAX_WRAPPER_ITERATIONS) return { kind: "cap-exceeded" };
  }
}

if (import.meta.main) {
  const cmd = Deno.env.get("CMD_FOR_PY") || Deno.args[0] || "";
  if (Deno.env.get("NORMALIZE_MODE") === "heredoc-only") {
    try {
      console.log(stripHeredocs(cmd));
    } catch {
      console.log(cmd);
    }
  } else {
    console.log(normalize(cmd));
  }
}
