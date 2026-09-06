// check_irreversible_operations_lib.test.ts — web-jam-tools#524
//
// Unit tests for the pure decision logic in
// hooks/lib/check_irreversible_operations.ts, exercised directly (no shelling
// out) — same pattern as test/hooks_lib_helpers.test.ts for the other Deno
// libs. End-to-end coverage of the shell wrapper (stdin JSON in, exit code +
// stderr out) lives in test/block_irreversible_operations_hook.test.ts.

import { assertEquals } from "@std/assert";
import { checkIrreversibleOperation } from "../hooks/lib/check_irreversible_operations.ts";

// --- the reported false positive: heredoc body merely mentioning the patterns ---

Deno.test("heredoc body containing 'git push --delete*' text is NOT blocked (the exact repro from web-jam-tools#524)", () => {
  const cmd = [
    `cat >> test/install_hooks_script.test.ts <<'EOF'`,
    `Deno.test("deny list still contains git push --delete*, git push -d and git push origin :branch", () => {`,
    `  assertStringIncludes(denyList, "git push --delete*");`,
    `});`,
    `EOF`,
  ].join("\n");
  const result = checkIrreversibleOperation(cmd);
  assertEquals(result, { blocked: false });
});

Deno.test("heredoc body containing other rules' literal text (gh repo delete, heroku addons:destroy) is NOT blocked", () => {
  const cmd = [
    `cat >> docs/guard-notes.md <<'EOF'`,
    `The deny list blocks 'gh repo delete', 'gh label delete', 'heroku addons:destroy',`,
    `'gh issue delete', and 'gh pr merge'.`,
    `EOF`,
  ].join("\n");
  const result = checkIrreversibleOperation(cmd);
  assertEquals(result, { blocked: false });
});

Deno.test("a quoted string literal (no heredoc) containing 'git push --delete' is NOT blocked", () => {
  const result = checkIrreversibleOperation(`echo "git push --delete branch-name"`);
  assertEquals(result, { blocked: false });
});

Deno.test("a quoted string literal containing an empty-source colon refspec is NOT blocked", () => {
  const result = checkIrreversibleOperation(`echo 'example: git push origin :old-branch'`);
  assertEquals(result, { blocked: false });
});

// --- real deletions must still block ---

Deno.test("real 'git push origin --delete somebranch' is blocked", () => {
  const result = checkIrreversibleOperation("git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("real 'git push origin -d somebranch' is blocked", () => {
  const result = checkIrreversibleOperation("git push origin -d somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("real 'git push origin :somebranch' (empty-source refspec) is blocked", () => {
  const result = checkIrreversibleOperation("git push origin :somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("real deletion via a path to git (e.g. /usr/bin/git) is still blocked", () => {
  const result = checkIrreversibleOperation("/usr/bin/git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

// --- chained behind operators, still blocked ---

Deno.test("real deletion chained behind && is blocked", () => {
  const result = checkIrreversibleOperation("git status && git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("real deletion chained behind || is blocked", () => {
  const result = checkIrreversibleOperation("false || git push origin -d somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("real deletion chained behind ; is blocked", () => {
  const result = checkIrreversibleOperation("echo hi ; git push origin :somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("real deletion chained behind a pipe is blocked", () => {
  const result = checkIrreversibleOperation("echo hi | cat ; git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("real deletion on the second line of a multi-line command (no operator) is blocked", () => {
  const cmd = ["git status", "git push origin --delete somebranch"].join("\n");
  const result = checkIrreversibleOperation(cmd);
  assertEquals(result.blocked, true);
});

// --- the narrowed colon-refspec branch ---

Deno.test("an ordinary push with a colon refspec that has a SOURCE (git push origin HEAD:main) is NOT blocked", () => {
  const result = checkIrreversibleOperation("git push origin HEAD:main");
  assertEquals(result, { blocked: false });
});

Deno.test("an ordinary push with a branch:branch refspec is NOT blocked", () => {
  const result = checkIrreversibleOperation("git push origin feature-branch:feature-branch");
  assertEquals(result, { blocked: false });
});

Deno.test("a colon appearing in an unrelated later argument is NOT blocked", () => {
  const result = checkIrreversibleOperation(`git push origin main -o ci.skip:false`);
  assertEquals(result, { blocked: false });
});

// --- fail closed on unparseable input ---

Deno.test("an unterminated single quote fails CLOSED (blocked)", () => {
  const result = checkIrreversibleOperation(`git push origin 'unterminated`);
  assertEquals(result.blocked, true);
});

Deno.test("an unterminated double quote fails CLOSED (blocked)", () => {
  const result = checkIrreversibleOperation(`echo "unterminated`);
  assertEquals(result.blocked, true);
});

// --- ordinary commands pass through ---

Deno.test("ordinary 'git status' is not blocked", () => {
  const result = checkIrreversibleOperation("git status");
  assertEquals(result, { blocked: false });
});

Deno.test("ordinary 'git push origin main' is not blocked", () => {
  const result = checkIrreversibleOperation("git push origin main");
  assertEquals(result, { blocked: false });
});

Deno.test("empty command is not blocked", () => {
  const result = checkIrreversibleOperation("");
  assertEquals(result, { blocked: false });
});

// --- web-jam-tools#716: all 14 POSITIONAL_RULES match a command's own argv
// positionally, not the flattened whole-command text — so a real invocation
// still blocks, and the SAME rule text merely quoted/embedded in another
// command's argument (a --search query, an echo string, etc.) no longer
// false-positives. This is the exact reproduction class from the issue:
// `gh issue list --search "gh repo delete false positive"` used to block. ---

const POSITIONAL_RULE_CASES: Array<{ rule: string; real: string; quoted: string }> = [
  {
    rule: "gh repo delete",
    real: "gh repo delete owner/repo",
    quoted: `gh issue list --repo owner/repo --search "gh repo delete false positive"`,
  },
  {
    rule: "gh label delete",
    real: "gh label delete bug",
    quoted: `gh issue list --search "gh label delete false positive"`,
  },
  {
    rule: "gh project delete",
    real: "gh project delete 1",
    quoted: `echo "gh project delete removes the whole project"`,
  },
  {
    rule: "gh project item-delete",
    real: "gh project item-delete --id 1",
    quoted: `echo "gh project item-delete removes one item"`,
  },
  {
    rule: "gh project field-delete",
    real: "gh project field-delete --id 1",
    quoted: `echo "gh project field-delete removes a field"`,
  },
  {
    rule: "heroku addons:destroy",
    real: "heroku addons:destroy my-addon",
    quoted: `gh issue list --search "heroku addons:destroy false positive"`,
  },
  {
    rule: "gh auth token",
    real: "gh auth token",
    quoted: `echo "never run gh auth token in a script"`,
  },
  {
    rule: "gh issue delete",
    real: "gh issue delete 42",
    quoted: `echo "gh issue delete removes an issue permanently"`,
  },
  {
    rule: "gh run delete",
    real: "gh run delete 123",
    quoted: `echo "gh run delete removes a workflow run"`,
  },
  {
    rule: "gh repo sync --force",
    real: "gh repo sync owner/repo --force",
    quoted: `echo "gh repo sync owner/repo --force overwrites history"`,
  },
  {
    rule: "gh issue transfer",
    real: "gh issue transfer 42 dest/repo",
    quoted: `echo "gh issue transfer moves an issue to another repo"`,
  },
  {
    rule: "gh repo rename",
    real: "gh repo rename new-name",
    quoted: `echo "gh repo rename changes the repo slug"`,
  },
  {
    rule: "gh workflow run",
    real: "gh workflow run deploy.yml",
    quoted: `echo "gh workflow run triggers a workflow dispatch"`,
  },
  {
    rule: "gh pr merge",
    real: "gh pr merge 123",
    quoted: `echo "gh pr merge finalizes the PR"`,
  },
];

for (const { rule, real, quoted } of POSITIONAL_RULE_CASES) {
  Deno.test(`web-jam-tools#716: real '${rule}' invocation still blocks`, () => {
    const result = checkIrreversibleOperation(real);
    assertEquals(result.blocked, true, `expected '${real}' to block`);
  });

  Deno.test(
    `web-jam-tools#716: '${rule}' merely quoted/embedded in another command's argument is NOT blocked`,
    () => {
      const result = checkIrreversibleOperation(quoted);
      assertEquals(
        result,
        { blocked: false },
        `expected '${quoted}' to pass through, got: ${JSON.stringify(result)}`,
      );
    },
  );
}

// --- wrapper-bypass fix (guard-wrapper-bypass): isGitPushDeletion is a
// positional check requiring "git" at argv[0]; a wrapper program ahead of
// the real command previously defeated it entirely even though the wrapped
// deletion still ran for real. Every wrapper below must still block. ---

Deno.test("'git push origin --delete X' wrapped in xargs (no flags) is blocked", () => {
  const result = checkIrreversibleOperation("xargs git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'xargs -I{}' is blocked", () => {
  const result = checkIrreversibleOperation("xargs -I{} git push origin --delete {}");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'xargs -n1' is blocked", () => {
  const result = checkIrreversibleOperation("xargs -n1 git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'env' (no assignment) is blocked", () => {
  const result = checkIrreversibleOperation("env git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'env FOO=1' is blocked", () => {
  const result = checkIrreversibleOperation("env FOO=1 git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'sudo' is blocked", () => {
  const result = checkIrreversibleOperation("sudo git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'sudo -u user' is blocked", () => {
  const result = checkIrreversibleOperation("sudo -u joshua git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'nohup' is blocked", () => {
  const result = checkIrreversibleOperation("nohup git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'timeout 30' is blocked", () => {
  const result = checkIrreversibleOperation("timeout 30 git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'stdbuf -oL' is blocked", () => {
  const result = checkIrreversibleOperation("stdbuf -oL git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'command' is blocked", () => {
  const result = checkIrreversibleOperation("command git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'nice' is blocked", () => {
  const result = checkIrreversibleOperation("nice git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'ionice' is blocked", () => {
  const result = checkIrreversibleOperation("ionice git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'setsid' is blocked", () => {
  const result = checkIrreversibleOperation("setsid git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'bash -c \"...\"' is blocked", () => {
  const result = checkIrreversibleOperation(`bash -c "git push origin --delete somebranch"`);
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'sh -c \"...\"' is blocked", () => {
  const result = checkIrreversibleOperation(`sh -c "git push origin --delete somebranch"`);
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'eval \"...\"' is blocked", () => {
  const result = checkIrreversibleOperation(`eval "git push origin --delete somebranch"`);
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'ssh host \"...\"' is blocked", () => {
  const result = checkIrreversibleOperation(`ssh myhost "git push origin --delete somebranch"`);
  assertEquals(result.blocked, true);
});

Deno.test("nested wrappers ('sudo timeout 30 git push --delete') is blocked", () => {
  const result = checkIrreversibleOperation("sudo timeout 30 git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("nested wrappers ('sudo -u joshua timeout 30 stdbuf -oL git push --delete') is blocked", () => {
  const result = checkIrreversibleOperation(
    "sudo -u joshua timeout 30 stdbuf -oL git push origin --delete somebranch",
  );
  assertEquals(result.blocked, true);
});

Deno.test("the '-d' form wrapped in 'sudo' is blocked", () => {
  const result = checkIrreversibleOperation("sudo git push origin -d somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("the ':branch' empty-source refspec form wrapped in 'timeout 30' is blocked", () => {
  const result = checkIrreversibleOperation("timeout 30 git push origin :somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("a heredoc body merely mentioning a wrapped deletion is still NOT blocked", () => {
  const cmd = [
    `cat >> docs/notes.md <<'EOF'`,
    `Do not run: sudo timeout 30 git push origin --delete somebranch`,
    `EOF`,
  ].join("\n");
  const result = checkIrreversibleOperation(cmd);
  assertEquals(result, { blocked: false });
});

Deno.test("a quoted string mentioning a wrapped deletion is still NOT blocked", () => {
  const result = checkIrreversibleOperation(`echo "sudo git push origin --delete somebranch"`);
  assertEquals(result, { blocked: false });
});

Deno.test("a harmless wrapped command ('sudo ls') is NOT blocked", () => {
  const result = checkIrreversibleOperation("sudo ls");
  assertEquals(result, { blocked: false });
});

Deno.test("a harmless wrapped command ('env FOO=1 git status') is NOT blocked", () => {
  const result = checkIrreversibleOperation("env FOO=1 git status");
  assertEquals(result, { blocked: false });
});

Deno.test("a harmless wrapped command ('xargs echo') is NOT blocked", () => {
  const result = checkIrreversibleOperation("xargs echo hello");
  assertEquals(result, { blocked: false });
});

Deno.test("wrapper-resolution iteration cap exceeded fails CLOSED (blocked)", () => {
  const cmd = "sudo ".repeat(30) + "git status";
  const result = checkIrreversibleOperation(cmd);
  assertEquals(result.blocked, true);
});

Deno.test("nested-command recursion depth cap exceeded fails CLOSED (blocked), even for a harmless inner command", () => {
  const cmd = "eval ".repeat(10) + "git status";
  const result = checkIrreversibleOperation(cmd);
  assertEquals(result.blocked, true);
});

Deno.test("nested-command recursion within the cap still resolves and blocks a real deletion", () => {
  const cmd = "eval ".repeat(3) + "git push origin --delete somebranch";
  const result = checkIrreversibleOperation(cmd);
  assertEquals(result.blocked, true);
});

Deno.test("the SUBSTRING_RULES family ('gh repo delete') still blocks through a wrapper", () => {
  const result = checkIrreversibleOperation("sudo gh repo delete owner/repo");
  assertEquals(result.blocked, true);
});

Deno.test("the SUBSTRING_RULES family ('heroku addons:destroy') still blocks through a wrapper", () => {
  const result = checkIrreversibleOperation("timeout 30 heroku addons:destroy my-addon");
  assertEquals(result.blocked, true);
});
