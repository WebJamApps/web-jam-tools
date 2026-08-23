/**
 * Decision logic for block-irreversible-operations.sh (web-jam-tools#524,
 * web-jam-tools#716).
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
 *  2. Every rule — the remote-branch-deletion check (`git push --delete`,
 *     `-d`, or the empty-source `:branch` refspec) AND all 14
 *     `POSITIONAL_RULES` (`gh repo delete`, `heroku addons:destroy`, etc.,
 *     web-jam-tools#716) — is tokenized with splitShellTokens and matched
 *     POSITIONALLY against a segment's own resolved argv (command name +
 *     subcommand words at the actual invocation position), never against the
 *     flattened whole-command text. A quoted string or `--search` query
 *     value (e.g. `echo "git push --delete branch"`, or
 *     `gh issue list --search "gh repo delete false positive"`) can no
 *     longer masquerade as a real invocation, and the git-push colon-refspec
 *     check only fires when a colon is the FIRST character of an argument (a
 *     real empty-source refspec) rather than anywhere after `git push`, e.g.
 *     `git push origin HEAD:main` — a completely ordinary push — no longer
 *     false-positives.
 *  3. Fails CLOSED: this is a destructive-operation guard, unlike the agy
 *     cost guard (which deliberately fails open). Any parse exception, or an
 *     unterminated quote (an ambiguous parse — we cannot be sure what's
 *     really being executed), blocks with a generic description rather than
 *     passing the command through.
 *
 * SCOPE: this only ever sees a Bash tool_input.command string. It does not
 * see Write/Edit file writes, and it does not see anything agy does
 * internally — agy's own hooks are inert
 * (web-jam-tools#432 "agy hooks do not enforce...").
 *
 * WRAPPER-BYPASS FIX (guard-wrapper-bypass, and extended by web-jam-tools#716
 * to all 14 POSITIONAL_RULES): a positional check requires the real command
 * name at argv[0] (after any `VAR=value` prefix). A wrapper program
 * (`xargs`, `env`, `sudo`, `nohup`, `timeout`, `stdbuf`, `command`, `nice`,
 * `ionice`, `setsid`, or a nested-string form like `bash -c "..."` /
 * `eval "..."` / `ssh host "..."`) puts a different word at argv[0] and would
 * otherwise defeat the check entirely, even though the wrapped command still
 * runs for real. Every segment's argv is resolved through
 * `resolveThroughWrappers()` (shared with check_dangerous_git_deploy.ts via
 * normalize_command.ts) before any positional check runs; a nested command
 * string recurses into this same function with an incremented depth, capped
 * at MAX_WRAPPER_RECURSION_DEPTH, and both that cap and
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

/**
 * A positional rule: `words` must appear as consecutive argv tokens starting
 * at a resolved segment's own command position (index 0 after skipping any
 * `VAR=value` assignment prefixes and resolving wrapper layers) — the same
 * "own argv, not flattened text" technique `isGitPushDeletion` already uses
 * for `git push --delete` (web-jam-tools#716).
 *
 * `extraFlag`, when present, must additionally appear ANYWHERE later in that
 * segment's argv (matching the original `gh repo sync ... --force` rule,
 * where `--force` can trail other arguments like the repo name).
 */
interface PositionalRule {
  words: string[];
  extraFlag?: string;
  description: string;
}

const POSITIONAL_RULES: PositionalRule[] = [
  { words: ["gh", "repo", "delete"], description: "'gh repo delete'" },
  { words: ["gh", "label", "delete"], description: "'gh label delete'" },
  { words: ["gh", "project", "delete"], description: "'gh project delete'" },
  {
    words: ["gh", "project", "item-delete"],
    description: "'gh project item-delete'",
  },
  {
    words: ["gh", "project", "field-delete"],
    description: "'gh project field-delete'",
  },
  { words: ["heroku", "addons:destroy"], description: "'heroku addons:destroy'" },
  { words: ["gh", "auth", "token"], description: "'gh auth token' (credential exposure)" },
  { words: ["gh", "issue", "delete"], description: "'gh issue delete'" },
  { words: ["gh", "run", "delete"], description: "'gh run delete'" },
  {
    words: ["gh", "repo", "sync"],
    extraFlag: "--force",
    description: "'gh repo sync --force'",
  },
  { words: ["gh", "issue", "transfer"], description: "'gh issue transfer'" },
  { words: ["gh", "repo", "rename"], description: "'gh repo rename'" },
  { words: ["gh", "workflow", "run"], description: "'gh workflow run'" },
  { words: ["gh", "pr", "merge"], description: "'gh pr merge'" },
];

/**
 * True if `argv` (already resolved through wrapper layers) is a real
 * invocation of `rule`: the resolved command name (basename, after skipping
 * any `VAR=value` prefixes) equals `rule.words[0]`, and each subsequent word
 * in `rule.words` matches the next argv token exactly, positionally — not a
 * substring match anywhere in the command text.
 */
function matchesPositionalRule(argv: string[], rule: PositionalRule): boolean {
  let i = 0;
  while (i < argv.length && ASSIGN_RE.test(argv[i])) i++;
  if (i >= argv.length) return false;

  const commandName = argv[i].split("/").pop();
  if (commandName !== rule.words[0]) return false;

  for (let w = 1; w < rule.words.length; w++) {
    if (argv[i + w] !== rule.words[w]) return false;
  }

  if (rule.extraFlag) {
    return argv.slice(i + rule.words.length).includes(rule.extraFlag);
  }
  return true;
}

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

    for (const rule of POSITIONAL_RULES) {
      if (matchesPositionalRule(resolved.argv, rule)) {
        return block(rule.description);
      }
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
