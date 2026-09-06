/**
 * Decision logic for block-dangerous-git-deploy.sh (false-positive fix, no
 * tracking issue — ad hoc).
 *
 * The shell version matched raw text against `grep -E`, including heredoc
 * BODIES and the insides of quoted string literals and `#` comments. That
 * meant text merely MENTIONING a dangerous command — a heredoc writing a
 * doc file, a quoted string, a comment — tripped the guard as though it were
 * the real thing:
 *
 *   cat <<EOF > /tmp/x.md
 *   we must not run git push --force origin main
 *   EOF
 *
 * was BLOCKED even though nothing in it is ever executed as `git push`.
 *
 * Fix, reusing the pattern already landed for the sibling guard
 * (hooks/lib/check_irreversible_operations.ts, web-jam-tools#524): decision
 * logic in a testable Deno lib, thin shell wrapper, real shell tokenization
 * instead of flat-text regex.
 *
 *  1. Heredoc bodies are stripped first, via the shared stripHeredocs() from
 *     normalize_command.ts (interpreter-fed bodies, e.g. `bash <<EOF`, stay
 *     in scope — stripping never becomes a bypass).
 *  2. What's left is split into simple-command segments on unquoted
 *     `&&`/`||`/`;`/`|`/newline (shared splitOnOperators()), then each
 *     segment is tokenized with splitShellTokens() and every rule below is
 *     matched POSITIONALLY against that segment's own argv — never against
 *     a flattened string. A quoted string or a `#` comment can no longer
 *     masquerade as a real command: its words either end up merged into one
 *     token (quotes) or as arguments to whatever unrelated command line they
 *     sit on (comments never even parse as `git`/`gh`/`deno` in argv[0]).
 *  3. `bash -c "..."` / `sh -c "..."` (and the other POSIX-ish shells) are a
 *     deliberate exception, same "interpreter executes this" reasoning as
 *     heredocs: the `-c` payload is itself executed, so it is recursively
 *     re-checked as its own command string rather than staying inert inside
 *     one merged token.
 *  4. Fails CLOSED: any parse exception, or an unterminated quote (an
 *     ambiguous parse), blocks rather than passing the command through —
 *     same contract as check_irreversible_operations.ts's
 *     "an unterminated quote fails CLOSED" behaviour.
 *
 * The six rules and their exact user-facing message text are unchanged from
 * the original grep-based script — this is a false-positive fix only.
 *
 * WRAPPER-BYPASS FIX (guard-wrapper-bypass): every rule below is positional
 * (it inspects argv[0], argv[1], ... of a specific segment), so a wrapper
 * program (`xargs`, `env`, `sudo`, `nohup`, `timeout`, `stdbuf`, `command`,
 * `nice`, `ionice`, `setsid`) ahead of the real command defeated all of them,
 * not just the `bash -c`/`sh -c` case this file already special-cased. Each
 * segment's argv is now resolved through the SHARED
 * `resolveThroughWrappers()` (normalize_command.ts — also used by
 * check_irreversible_operations.ts, so the two guards don't duplicate this
 * logic) before any positional rule runs; a nested command string (from
 * `bash -c "..."`, `eval "..."`, `ssh host "..."`) recurses into this same
 * top-level function with an incremented depth, capped at
 * MAX_WRAPPER_RECURSION_DEPTH. Both that cap and MAX_WRAPPER_ITERATIONS fail
 * CLOSED (block) rather than pass an unresolvable wrapper chain through.
 */
import {
  ASSIGN_RE,
  MAX_WRAPPER_RECURSION_DEPTH,
  resolveThroughWrappers,
  splitOnOperators,
  splitShellTokens,
  stripHeredocs,
} from "./normalize_command.ts";
import { isGitPushDeletion } from "./check_irreversible_operations.ts";

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

function hasToken(argv: string[], re: RegExp): boolean {
  return argv.some((t) => re.test(t));
}

/** True if `flag`/`value` appear back to back anywhere in argv, e.g. `-X PUT`. */
function hasFlagValue(argv: string[], flags: string[], values: string[]): boolean {
  for (let j = 0; j < argv.length - 1; j++) {
    if (flags.includes(argv[j]) && values.includes(argv[j + 1])) return true;
  }
  return false;
}

function checkSegment(argv: string[], depth: number): CheckResult {
  const resolved = resolveThroughWrappers(argv);
  if (resolved.kind === "cap-exceeded") {
    return block("wrapper resolution exceeded iteration cap — failing closed");
  }
  if (resolved.kind === "nested") {
    if (depth >= MAX_WRAPPER_RECURSION_DEPTH) {
      return block("wrapper/interpreter nesting exceeded recursion cap — failing closed");
    }
    return checkDangerousGitDeploy(resolved.command, depth + 1);
  }

  const resolvedArgv = resolved.argv;
  let i = 0;
  while (i < resolvedArgv.length && ASSIGN_RE.test(resolvedArgv[i])) i++;
  if (i >= resolvedArgv.length) return ok();

  const cmd0 = resolvedArgv[i].split("/").pop();
  const rest = resolvedArgv.slice(i + 1);

  // 1) Any PR merge (includes --admin / --squash / --rebase / --merge —
  //    they're just further tokens after "merge", not required here).
  if (cmd0 === "gh" && rest[0] === "pr" && rest[1] === "merge") {
    return block("'gh pr merge' — merging a PR is Josh's decision.");
  }

  // 2) & 5) `gh api ...` — branch-protection writes, and the REST/GraphQL
  //    merge endpoints (web-jam-tools#308 follow-up: these hit the same
  //    underlying GitHub merge operations directly and bypass rule 1).
  if (cmd0 === "gh" && rest[0] === "api") {
    const apiArgs = rest.slice(1);

    // 2) Branch-protection writes via the API (PUT/DELETE/PATCH on
    //    .../protection).
    if (
      hasToken(apiArgs, /branches\/[^ ]*protection/) &&
      hasFlagValue(apiArgs, ["-X", "--method"], ["PUT", "DELETE", "PATCH"])
    ) {
      return block("writing branch protection via 'gh api .../protection' is Josh's call.");
    }

    // 5a) REST: PUT repos/{owner}/{repo}/pulls/{n}/merge — merge a pull request.
    if (
      hasToken(apiArgs, /pulls\/[^ ]+\/merge(\?|$| |\/)/) &&
      hasFlagValue(apiArgs, ["-X", "--method"], ["PUT"])
    ) {
      return block(
        "'gh api ... pulls/N/merge' (PUT) — merging a PR via the REST API is Josh's decision.",
      );
    }

    // 5b) REST: POST repos/{owner}/{repo}/merges — merge a branch.
    if (hasToken(apiArgs, /repos\/[^ ]+\/merges(\?|$| |\/)/)) {
      return block(
        "'gh api ... repos/OWNER/REPO/merges' — merging a branch via the REST API is Josh's decision.",
      );
    }

    // 5c) GraphQL: the mergePullRequest / mergeBranch mutations via
    //     'gh api graphql'.
    if (
      apiArgs.includes("graphql") &&
      hasToken(apiArgs, /merge(PullRequest|Branch)/)
    ) {
      return block(
        "'gh api graphql' merge mutation — merging via the GraphQL API is Josh's decision.",
      );
    }
  }

  // 3) Pushing to a protected branch (main/dev), force or not. Allows
  //    feature branches (e.g. 'git push -u origin claude/...').
  if (cmd0 === "git" && rest[0] === "push") {
    for (const a of rest.slice(1)) {
      if (a === "main" || a === "dev" || /:(?:main|dev)$/.test(a)) {
        return block("'git push' to a protected branch (main/dev) — open a PR instead.");
      }
    }
  }

  // 4) Production deploy.
  if (cmd0 === "deno" && rest[0] === "deploy" && rest.includes("--prod")) {
    return block("production deploy command — deploying is Josh's decision.");
  }
  if (cmd0 === "deployctl" && rest[0] === "deploy") {
    return block("production deploy command — deploying is Josh's decision.");
  }

  // 6) Deleting a remote branch via 'git push' (--delete, -d, or
  //    empty-source refspec :branch). Reuses the sibling guard's exact
  //    predicate — the underlying question is identical, only the
  //    user-facing message differs.
  if (isGitPushDeletion(resolvedArgv.slice(i))) {
    return block(
      "deleting a remote branch via 'git push' (--delete, -d, or :branch) — deleting a remote branch is Josh's decision.",
    );
  }

  return ok();
}

export function checkDangerousGitDeploy(rawCmd: string, depth = 0): CheckResult {
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
    const result = checkSegment(argv, depth);
    if (result.blocked) return result;
  }

  return ok();
}

if (import.meta.main) {
  const cmd = Deno.env.get("CMD_FOR_PY") || Deno.args[0] || "";
  const result = checkDangerousGitDeploy(cmd);
  if (result.blocked) {
    console.log("BLOCK:" + (result.description ?? "dangerous git/deploy operation"));
  } else {
    console.log("OK");
  }
}
