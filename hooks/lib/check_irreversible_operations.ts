/**
 * Decision logic for block-irreversible-operations.sh (web-jam-tools#524).
 *
 * The shell version flattened the WHOLE command string — including heredoc
 * BODIES and the insides of quoted string literals — into one blob and
 * grepped it. That meant a test file or doc that merely mentioned
 * `git push --delete`, written via `cat >> file <<'EOF' ... EOF`, tripped the
 * guard as though it were a real deletion: the guard blocked documenting the
 * guard.
 *
 * Fix, matching the check_agy_model.ts precedent (decision logic in a
 * testable Deno lib, thin shell wrapper):
 *
 *  1. Heredoc bodies are stripped before ANY matching, via the shared
 *     stripHeredocs() from normalize_command.ts. It keeps an
 *     INTERPRETER-fed body in scope (`bash <<EOF ... EOF` really executes
 *     its body) so stripping never becomes a bypass.
 *  2. The remote-branch-deletion check (`git push --delete`, `-d`, or the
 *     empty-source `:branch` refspec) is tokenized with splitShellTokens and
 *     matched POSITIONALLY against the git-push invocation's own argv, so a
 *     quoted string (e.g. `echo "git push --delete branch"`) can no longer
 *     masquerade as a real command, and the colon-refspec check only fires
 *     when a colon is the FIRST character of an argument (a real
 *     empty-source refspec) rather than anywhere after `git push`, e.g.
 *     `git push origin HEAD:main` — a completely ordinary push — no longer
 *     false-positives.
 *  3. Fails CLOSED: this is a destructive-operation guard, unlike the agy
 *     cost guard (which deliberately fails open). Any parse exception, or an
 *     unterminated quote (an ambiguous parse — we cannot be sure what's
 *     really being executed), blocks with a generic description rather than
 *     passing the command through.
 *
 * The other 16 rules below (gh repo delete, heroku addons:destroy, etc.) are
 * unchanged literal substring checks — same matching semantics as before —
 * except they now run against heredoc-stripped text, so the exact false
 * positive reported in web-jam-tools#524 (a test/doc heredoc merely
 * mentioning one of these patterns) can no longer trip any of them.
 *
 * SCOPE: this only ever sees a Bash tool_input.command string. It does not
 * see Write/Edit file writes, and it does not see anything agy does
 * internally — agy's own hooks are inert
 * (web-jam-tools#432 "agy hooks do not enforce...").
 *
 * WRAPPER-BYPASS FIX (guard-wrapper-bypass): `isGitPushDeletion` is a
 * positional check — it requires "git" at argv[0] (after any `VAR=value`
 * prefix). A wrapper program (`xargs`, `env`, `sudo`, `nohup`, `timeout`,
 * `stdbuf`, `command`, `nice`, `ionice`, `setsid`, or a nested-string form
 * like `bash -c "..."` / `eval "..."` / `ssh host "..."`) puts a different
 * word at argv[0] and defeated the check entirely, even though the wrapped
 * `git push --delete` still ran for real — this was a regression: before
 * web-jam-tools#526 the rule was a flat `grep -E` over the whole command
 * text, which a wrapper does NOT defeat, and #526's positional rewrite
 * silently dropped that coverage. Every segment's argv is now resolved
 * through `resolveThroughWrappers()` (shared with
 * check_dangerous_git_deploy.ts via normalize_command.ts) before the
 * positional check runs; a nested command string recurses into this same
 * function with an incremented depth, capped at
 * MAX_WRAPPER_RECURSION_DEPTH, and both that cap and
 * MAX_WRAPPER_ITERATIONS fail CLOSED (block) rather than pass an
 * unresolvable wrapper chain through.
 */
import {
  ASSIGN_RE,
  MAX_WRAPPER_RECURSION_DEPTH,
  resolveThroughWrappers,
  splitOnOperators,
  splitShellTokens,
  stripHeredocs,
} from "./normalize_command.ts";

export interface CheckResult {
  blocked: boolean;
  description?: string;
}

function ok(): CheckResult {
  return { blocked: false };
}

function block(description: string): CheckResult {
  return { blocked: true, description };
}

// Literal substring rules, unchanged from the original grep patterns other
// than now running on heredoc-stripped text. Each pattern requires the
// literal command words with flexible whitespace, same as the shell `grep -E`
// version did.
const SUBSTRING_RULES: Array<[RegExp, string]> = [
  [/gh +repo +delete( |$)/, "'gh repo delete'"],
  [/gh +label +delete( |$)/, "'gh label delete'"],
  [/gh +project +delete( |$)/, "'gh project delete'"],
  [/gh +project +item-delete( |$)/, "'gh project item-delete'"],
  [/gh +project +field-delete( |$)/, "'gh project field-delete'"],
  [/heroku +addons:destroy( |$)/, "'heroku addons:destroy'"],
  [/gh +auth +token( |$)/, "'gh auth token' (credential exposure)"],
  [/gh +issue +delete( |$)/, "'gh issue delete'"],
  [/gh +run +delete( |$)/, "'gh run delete'"],
  [/gh +repo +sync +.*--force( |$)/, "'gh repo sync --force'"],
  [/gh +issue +transfer( |$)/, "'gh issue transfer'"],
  [/gh +repo +rename( |$)/, "'gh repo rename'"],
  [/gh +workflow +run( |$)/, "'gh workflow run'"],
  [/gh +pr +merge( |$)/, "'gh pr merge'"],
];

/**
 * True if this simple command's argv is a `git push` invocation that deletes
 * a remote branch: `--delete`, `-d`, or an empty-source `:branch` refspec
 * (colon as the FIRST character of an argument — NOT a colon anywhere, which
 * would also match an ordinary `git push origin HEAD:main`).
 *
 * Exported so hooks/lib/check_dangerous_git_deploy.ts can reuse this exact
 * predicate for its own remote-branch-deletion rule instead of duplicating
 * it — the two guards report different user-facing text, but the underlying
 * "is this argv a branch deletion" question is identical.
 */
export function isGitPushDeletion(argv: string[]): boolean {
  let i = 0;
  while (i < argv.length && ASSIGN_RE.test(argv[i])) i++;
  if (i >= argv.length) return false;

  const commandName = argv[i].split("/").pop();
  if (commandName !== "git") return false;
  if (argv[i + 1] !== "push") return false;

  for (const a of argv.slice(i + 2)) {
    if (a === "--delete" || a === "-d") return true;
    if (a.length > 1 && a.startsWith(":")) return true;
  }
  return false;
}

export function checkIrreversibleOperation(rawCmd: string, depth = 0): CheckResult {
  if (!rawCmd) return ok();

  if (depth > MAX_WRAPPER_RECURSION_DEPTH) {
    return block("wrapper/interpreter nesting exceeded recursion cap — failing closed");
  }

  let stripped: string;
  try {
    stripped = stripHeredocs(rawCmd);
  } catch {
    return block("unparseable command (heredoc parse failure) — failing closed");
  }

  const flat = stripped.replace(/\s+/g, " ").trim();

  for (const [re, desc] of SUBSTRING_RULES) {
    if (re.test(flat)) return block(desc);
  }

  const { segments, unterminated } = splitOnOperators(stripped);
  if (unterminated) {
    return block("unparseable command (unterminated quote) — failing closed");
  }

  for (const seg of segments) {
    let argv: string[];
    try {
      argv = splitShellTokens(seg);
    } catch {
      return block("unparseable command (tokenizer failure) — failing closed");
    }

    const resolved = resolveThroughWrappers(argv);
    if (resolved.kind === "cap-exceeded") {
      return block("wrapper resolution exceeded iteration cap — failing closed");
    }
    if (resolved.kind === "nested") {
      const nestedResult = checkIrreversibleOperation(resolved.command, depth + 1);
      if (nestedResult.blocked) {
        return block(nestedResult.description ?? "blocked via wrapped/nested command");
      }
      continue;
    }
    if (isGitPushDeletion(resolved.argv)) {
      return block("remote branch deletion via 'git push'");
    }
  }

  return ok();
}

if (import.meta.main) {
  const cmd = Deno.env.get("CMD_FOR_PY") || Deno.args[0] || "";
  const result = checkIrreversibleOperation(cmd);
  if (result.blocked) {
    console.log("BLOCK:" + (result.description ?? "irreversible operation"));
  } else {
    console.log("OK");
  }
}
