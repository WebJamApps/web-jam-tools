// check_dangerous_git_deploy_lib.test.ts — false-positive fix, no tracking issue.
//
// Unit tests for the pure decision logic in
// hooks/lib/check_dangerous_git_deploy.ts, exercised directly (no shelling
// out) — same pattern as test/check_irreversible_operations_lib.test.ts.
// End-to-end coverage of the shell wrapper (stdin JSON in, exit code +
// stderr out) lives in test/block_dangerous_git_deploy_hook.test.ts.

import { assertEquals } from "@std/assert";
import { checkDangerousGitDeploy } from "../hooks/lib/check_dangerous_git_deploy.ts";

// --- the reported false positive: heredoc body merely mentioning the phrase ---

Deno.test("heredoc body mentioning 'git push --force origin main' is NOT blocked (2026-08-13 repro)", () => {
  const cmd = [
    `cat <<EOF > /tmp/x.md`,
    `we must not run git push --force origin main`,
    `EOF`,
  ].join("\n");
  const result = checkDangerousGitDeploy(cmd);
  assertEquals(result, { blocked: false });
});

Deno.test("a quoted string literal (single quotes) mentioning the phrase is NOT blocked", () => {
  const result = checkDangerousGitDeploy(
    `echo 'we must not run git push --force origin main'`,
  );
  assertEquals(result, { blocked: false });
});

Deno.test("a quoted string literal (double quotes) mentioning the phrase is NOT blocked", () => {
  const result = checkDangerousGitDeploy(
    `echo "we must not run git push --force origin main"`,
  );
  assertEquals(result, { blocked: false });
});

Deno.test("the phrase in a # comment is NOT blocked", () => {
  const result = checkDangerousGitDeploy("# we must not run git push --force origin main");
  assertEquals(result, { blocked: false });
});

Deno.test("'gh pr merge' inside a quoted string is NOT blocked", () => {
  const result = checkDangerousGitDeploy(`echo "do not run gh pr merge 5"`);
  assertEquals(result, { blocked: false });
});

Deno.test("'git push --delete' inside a # comment is NOT blocked", () => {
  const result = checkDangerousGitDeploy("# git push origin --delete some-branch");
  assertEquals(result, { blocked: false });
});

Deno.test("a heredoc body mentioning 'gh api ... pulls/N/merge' is NOT blocked", () => {
  const cmd = [
    `cat >> docs/guard-notes.md <<'EOF'`,
    `The guard blocks 'gh api -X PUT .../pulls/N/merge' and 'deployctl deploy'.`,
    `EOF`,
  ].join("\n");
  const result = checkDangerousGitDeploy(cmd);
  assertEquals(result, { blocked: false });
});

// --- real dangerous commands must still block ---

Deno.test("real 'gh pr merge' is blocked", () => {
  const result = checkDangerousGitDeploy("gh pr merge 123 --squash");
  assertEquals(result.blocked, true);
});

Deno.test("real 'git push --force origin main' is blocked", () => {
  const result = checkDangerousGitDeploy("git push --force origin main");
  assertEquals(result.blocked, true);
});

Deno.test("real 'git push origin dev' is blocked", () => {
  const result = checkDangerousGitDeploy("git push origin dev");
  assertEquals(result.blocked, true);
});

Deno.test("real 'deno deploy --prod' is blocked", () => {
  const result = checkDangerousGitDeploy("deno deploy --org o --app a --prod --token x");
  assertEquals(result.blocked, true);
});

Deno.test("real 'deployctl deploy' is blocked", () => {
  const result = checkDangerousGitDeploy("deployctl deploy --project=foo main.ts");
  assertEquals(result.blocked, true);
});

Deno.test("real branch-protection write via 'gh api' is blocked", () => {
  const result = checkDangerousGitDeploy("gh api -X PUT repos/o/r/branches/main/protection -f x=1");
  assertEquals(result.blocked, true);
});

Deno.test("real REST 'gh api -X PUT .../pulls/N/merge' is blocked", () => {
  const result = checkDangerousGitDeploy(
    "gh api -X PUT repos/WebJamApps/web-jam-tools/pulls/314/merge -f merge_method=squash",
  );
  assertEquals(result.blocked, true);
});

Deno.test("real REST 'gh api -X POST repos/OWNER/REPO/merges' is blocked", () => {
  const result = checkDangerousGitDeploy(
    "gh api -X POST repos/WebJamApps/web-jam-tools/merges -f base=main -f head=dev",
  );
  assertEquals(result.blocked, true);
});

Deno.test("real GraphQL mergePullRequest mutation via 'gh api graphql' is blocked", () => {
  const result = checkDangerousGitDeploy(
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_x"}) { pullRequest { merged } } }'`,
  );
  assertEquals(result.blocked, true);
});

Deno.test("real 'git push origin --delete somebranch' is blocked", () => {
  const result = checkDangerousGitDeploy("git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

// --- chained behind operators, still blocked ---

Deno.test("real push to main chained behind && is blocked", () => {
  const result = checkDangerousGitDeploy("git fetch && git push origin main");
  assertEquals(result.blocked, true);
});

Deno.test("real push to main chained behind || is blocked", () => {
  const result = checkDangerousGitDeploy("false || git push origin main");
  assertEquals(result.blocked, true);
});

Deno.test("real push to main chained behind ; is blocked", () => {
  const result = checkDangerousGitDeploy("echo hi; git push origin main");
  assertEquals(result.blocked, true);
});

Deno.test("real push to main chained behind a pipe is blocked", () => {
  const result = checkDangerousGitDeploy("echo hi | cat; git push origin main");
  assertEquals(result.blocked, true);
});

Deno.test("real delete chained behind && is blocked", () => {
  const result = checkDangerousGitDeploy("git fetch && git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

// --- stripping must NOT become a bypass: interpreter-executed content stays in scope ---

Deno.test("a push to main inside an EXECUTED bash heredoc is still blocked", () => {
  const cmd = ["bash <<'EOF'", "git push origin main", "EOF"].join("\n");
  const result = checkDangerousGitDeploy(cmd);
  assertEquals(result.blocked, true);
});

Deno.test("a real push to main via 'bash -c \"...\"' is still blocked", () => {
  const result = checkDangerousGitDeploy(`bash -c "git push --force origin main; echo done"`);
  assertEquals(result.blocked, true);
});

Deno.test("a merge via 'sh -c \"...\"' is still blocked", () => {
  const result = checkDangerousGitDeploy(`sh -c "gh pr merge 1 --admin"`);
  assertEquals(result.blocked, true);
});

// --- ordinary commands pass through ---

Deno.test("ordinary 'git push origin main' with a trailing comment is still blocked (comment doesn't neutralize a real push)", () => {
  const result = checkDangerousGitDeploy("git push origin main # deploy");
  assertEquals(result.blocked, true);
});

Deno.test("ordinary 'git push -u origin feature-branch' is not blocked", () => {
  const result = checkDangerousGitDeploy("git push -u origin claude/some-feature");
  assertEquals(result, { blocked: false });
});

Deno.test("'git push origin HEAD:main' (explicit refspec to main) is blocked — pushing to main is the danger regardless of refspec form", () => {
  const result = checkDangerousGitDeploy("git push origin HEAD:main");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin HEAD:my-feature' is not blocked", () => {
  const result = checkDangerousGitDeploy("git push origin HEAD:my-feature");
  assertEquals(result, { blocked: false });
});

Deno.test("a non-merge 'gh api' read call is not blocked", () => {
  const result = checkDangerousGitDeploy(
    "gh api repos/WebJamApps/web-jam-tools/pulls/314 --jq .state",
  );
  assertEquals(result, { blocked: false });
});

Deno.test("'gh pr view' is not blocked", () => {
  const result = checkDangerousGitDeploy("gh pr view 314");
  assertEquals(result, { blocked: false });
});

Deno.test("empty command is not blocked", () => {
  const result = checkDangerousGitDeploy("");
  assertEquals(result, { blocked: false });
});

// --- fail closed on unparseable input ---

Deno.test("an unterminated single quote fails CLOSED (blocked)", () => {
  const result = checkDangerousGitDeploy(`git push origin 'unterminated`);
  assertEquals(result.blocked, true);
});

Deno.test("an unterminated double quote fails CLOSED (blocked)", () => {
  const result = checkDangerousGitDeploy(`echo "unterminated git push --force origin main`);
  assertEquals(result.blocked, true);
});

// --- wrapper-bypass fix (guard-wrapper-bypass): every rule in this guard is
// positional, so a wrapper program ahead of the real command previously
// defeated all of them. Same shared resolveThroughWrappers() used by
// check_irreversible_operations.ts — pin representative wrappers here too. ---

Deno.test("'git push origin --delete X' wrapped in 'sudo' is blocked", () => {
  const result = checkDangerousGitDeploy("sudo git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'timeout 30' is blocked", () => {
  const result = checkDangerousGitDeploy("timeout 30 git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'env FOO=1' is blocked", () => {
  const result = checkDangerousGitDeploy("env FOO=1 git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'xargs' is blocked", () => {
  const result = checkDangerousGitDeploy("xargs git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'eval \"...\"' is blocked", () => {
  const result = checkDangerousGitDeploy(`eval "git push origin --delete somebranch"`);
  assertEquals(result.blocked, true);
});

Deno.test("'git push origin --delete X' wrapped in 'ssh host \"...\"' is blocked", () => {
  const result = checkDangerousGitDeploy(`ssh myhost "git push origin --delete somebranch"`);
  assertEquals(result.blocked, true);
});

Deno.test("nested wrappers ('sudo timeout 30 git push --delete') is blocked", () => {
  const result = checkDangerousGitDeploy("sudo timeout 30 git push origin --delete somebranch");
  assertEquals(result.blocked, true);
});

Deno.test("push to a protected branch (main) wrapped in 'sudo' is blocked", () => {
  const result = checkDangerousGitDeploy("sudo git push origin main");
  assertEquals(result.blocked, true);
});

Deno.test("'gh pr merge' wrapped in 'sudo' is blocked", () => {
  const result = checkDangerousGitDeploy("sudo gh pr merge 123 --squash");
  assertEquals(result.blocked, true);
});

Deno.test("'gh pr merge' wrapped in 'timeout 30 sh -c \"...\"' (nested + prefix) is blocked", () => {
  const result = checkDangerousGitDeploy(`timeout 30 sh -c "gh pr merge 1 --admin"`);
  assertEquals(result.blocked, true);
});

Deno.test("production deploy ('deno deploy --prod') wrapped in 'timeout 60' is blocked", () => {
  const result = checkDangerousGitDeploy("timeout 60 deno deploy --org o --app a --prod --token x");
  assertEquals(result.blocked, true);
});

Deno.test("a heredoc body merely mentioning a wrapped dangerous command is still NOT blocked", () => {
  const cmd = [
    `cat >> docs/notes.md <<'EOF'`,
    `Do not run: sudo timeout 30 git push origin --delete somebranch`,
    `EOF`,
  ].join("\n");
  const result = checkDangerousGitDeploy(cmd);
  assertEquals(result, { blocked: false });
});

Deno.test("a quoted string mentioning a wrapped dangerous command is still NOT blocked", () => {
  const result = checkDangerousGitDeploy(`echo "sudo git push origin --delete somebranch"`);
  assertEquals(result, { blocked: false });
});

Deno.test("a harmless wrapped command ('sudo gh pr view 314') is NOT blocked", () => {
  const result = checkDangerousGitDeploy("sudo gh pr view 314");
  assertEquals(result, { blocked: false });
});

Deno.test("a harmless wrapped command ('env FOO=1 git status') is NOT blocked", () => {
  const result = checkDangerousGitDeploy("env FOO=1 git status");
  assertEquals(result, { blocked: false });
});

Deno.test("wrapper-resolution iteration cap exceeded fails CLOSED (blocked)", () => {
  const cmd = "sudo ".repeat(30) + "gh pr view 314";
  const result = checkDangerousGitDeploy(cmd);
  assertEquals(result.blocked, true);
});

Deno.test("nested-command recursion depth cap exceeded fails CLOSED (blocked), even for a harmless inner command", () => {
  const cmd = "eval ".repeat(10) + "gh pr view 314";
  const result = checkDangerousGitDeploy(cmd);
  assertEquals(result.blocked, true);
});
