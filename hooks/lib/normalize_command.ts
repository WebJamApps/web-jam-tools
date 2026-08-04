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
const INTERPRETER = /(^|[\s;&|(])(env\s+)?((ba|z|k|da)?sh|python3?|node|deno|perl|ruby|awk|xargs)\b/;

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
