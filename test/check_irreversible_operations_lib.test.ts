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

// --- the other 16 substring rules still fire on real invocations ---

Deno.test("real 'gh repo delete' is blocked", () => {
  const result = checkIrreversibleOperation("gh repo delete owner/repo");
  assertEquals(result.blocked, true);
});

Deno.test("real 'gh pr merge' is blocked", () => {
  const result = checkIrreversibleOperation("gh pr merge 123");
  assertEquals(result.blocked, true);
});

Deno.test("real 'heroku addons:destroy' is blocked", () => {
  const result = checkIrreversibleOperation("heroku addons:destroy my-addon");
  assertEquals(result.blocked, true);
});
