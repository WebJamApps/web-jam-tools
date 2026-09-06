// Tests for hooks/block-dangerous-git-deploy.sh — the merge/deploy guard.
//
// This hook had NO tests before web-jam-tools#272. It is exercised the same way
// as the secret-dump guard: by shelling out to it with mocked PreToolUse JSON on
// stdin, the same shape Claude Code's hook runner feeds it. Exit 2 = blocked.
//
// The change under test: this guard now shares hooks/lib/normalize_command.py
// with block-secret-dumps.sh. Previously only the secret guard stripped heredoc
// bodies and prose flag values, so text that merely MENTIONED a deploy — a PR
// body, or a test fixture asserting `deno deploy --prod` is blocked — tripped
// this guard while identical text passed the other. That is the inconsistency.
import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/block-dangerous-git-deploy.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stderr: string;
}

async function runHook(command: string): Promise<RunResult> {
  const input = JSON.stringify({ tool_input: { command } });
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stderr } = await child.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

function assertBlocked(stderr: string) {
  if (!stderr.includes("BLOCKED (merge/deploy guard)")) {
    throw new Error(`expected BLOCKED message in stderr, got: ${stderr}`);
  }
}

// --- the four original rules must still fire ---

Deno.test("gh pr merge is blocked", async () => {
  const res = await runHook("gh pr merge 277 --squash");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a production deploy is blocked", async () => {
  const res = await runHook(
    'deno deploy --org webjamapps --app web-jam-devotional --prod --token "$T"',
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("deployctl deploy is blocked", async () => {
  const res = await runHook("deployctl deploy --project=foo main.ts");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("git push to main is blocked", async () => {
  const res = await runHook("git push origin main");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("git push to dev is blocked", async () => {
  const res = await runHook("git push origin dev");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("branch-protection writes via gh api are blocked", async () => {
  const res = await runHook(
    "gh api -X PUT repos/o/r/branches/main/protection -f x=1",
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("pushing a feature branch is allowed", async () => {
  const res = await runHook("git push -u origin claude/272-block-secret-var");
  assertEquals(res.code, 0, res.stderr);
});

// --- web-jam-tools#272: prose that MENTIONS a dangerous command is not one ---

Deno.test("a heredoc PR body mentioning a production deploy is allowed", async () => {
  const res = await runHook(
    [
      "gh pr create --body-file - <<'EOF'",
      "This fixes the build that runs deno deploy --prod from CI.",
      "EOF",
    ].join("\n"),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a heredoc writing a TEST FIXTURE containing a deploy command is allowed", async () => {
  // The exact case that blocked authoring this file's sibling tests.
  const res = await runHook(
    [
      "cat >> test/some_test.ts <<'EOF'",
      'const res = await runHook("deno deploy --prod");',
      "EOF",
    ].join("\n"),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a commit message mentioning gh pr merge is allowed", async () => {
  const res = await runHook(
    'git commit -m "explain why gh pr merge is blocked for agents"',
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a PR body mentioning a push to main is allowed", async () => {
  const res = await runHook(
    [
      "gh pr create --body-file - <<'EOF'",
      "Never run git push origin main directly.",
      "EOF",
    ].join("\n"),
  );
  assertEquals(res.code, 0, res.stderr);
});

// --- and stripping must NOT become a bypass ---

Deno.test("a deploy inside an EXECUTED bash heredoc is still blocked", async () => {
  const res = await runHook(
    ["bash <<'EOF'", "deno deploy --prod --token x", "EOF"].join("\n"),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a merge inside an EXECUTED sh heredoc is still blocked", async () => {
  const res = await runHook(
    ["sh <<'EOF'", "gh pr merge 1 --admin", "EOF"].join("\n"),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a push to main inside an EXECUTED bash heredoc is still blocked", async () => {
  const res = await runHook(
    ["bash <<'EOF'", "git push origin main", "EOF"].join("\n"),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("an unterminated heredoc keeps its body in scope (fail safe)", async () => {
  const res = await runHook(
    ["cat > notes.txt <<'EOF'", "deno deploy --prod"].join("\n"),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- web-jam-tools#308 follow-up gap 1: REST/GraphQL merge endpoints ---
// Rule 1 only matches the `gh pr merge` CLI subcommand. These hit the same
// underlying GitHub merge operations directly via `gh api` and bypassed rule
// 1 entirely before this fix. Endpoint shapes verified against the live
// GitHub REST/GraphQL docs (PUT .../pulls/{n}/merge, POST .../merges, and the
// mergePullRequest/mergeBranch GraphQL mutations, confirmed against
// https://docs.github.com/public/fpt/schema.docs.graphql).

Deno.test("REST 'gh api -X PUT .../pulls/N/merge' is blocked", async () => {
  const res = await runHook(
    "gh api -X PUT repos/WebJamApps/web-jam-tools/pulls/314/merge -f merge_method=squash",
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("REST 'gh api --method PUT .../pulls/N/merge' is blocked", async () => {
  const res = await runHook(
    "gh api --method PUT repos/WebJamApps/web-jam-tools/pulls/314/merge",
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("REST 'gh api -X POST repos/OWNER/REPO/merges' (merge a branch) is blocked", async () => {
  const res = await runHook(
    "gh api -X POST repos/WebJamApps/web-jam-tools/merges -f base=main -f head=dev",
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("GraphQL 'gh api graphql' mergePullRequest mutation is blocked", async () => {
  const res = await runHook(
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_x\"}) { pullRequest { merged } } }'",
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("GraphQL 'gh api graphql' mergeBranch mutation is blocked", async () => {
  const res = await runHook(
    'gh api graphql -f query=\'mutation { mergeBranch(input: {base: "main", head: "dev"}) { mergeCommit { oid } } }\'',
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- web-jam-tools#345: remote branch deletion blocking ---

Deno.test("git push origin :branch (empty-source colon) is blocked", async () => {
  const res = await runHook("git push origin :b");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("git push origin :refs/heads/branch is blocked", async () => {
  const res = await runHook("git push origin :refs/heads/b");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("git push origin :branch in compound command is blocked", async () => {
  const res = await runHook("cd /some/dir && git push origin :b");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("git push origin -d branch is blocked", async () => {
  const res = await runHook("git push origin -d feature-branch");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("git push origin --delete branch is blocked", async () => {
  const res = await runHook("git push origin --delete feature-branch");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("git push -d origin branch is blocked", async () => {
  const res = await runHook("git push -d origin feature-branch");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("git push --delete origin branch is blocked", async () => {
  const res = await runHook("git push --delete origin feature-branch");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("git push HEAD:branch (non-empty source) is allowed", async () => {
  const res = await runHook("git push origin HEAD:my-feature");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("git push refs/heads/a:refs/heads/b is allowed", async () => {
  const res = await runHook("git push origin refs/heads/a:refs/heads/b");
  assertEquals(res.code, 0, res.stderr);
});

// --- unrelated commands pass through ---

Deno.test("an ordinary command is allowed", async () => {
  const res = await runHook("deno task test");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a non-merge 'gh api' read call is allowed", async () => {
  const res = await runHook(
    "gh api repos/WebJamApps/web-jam-tools/pulls/314 --jq .state",
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("'gh pr view' is allowed", async () => {
  const res = await runHook("gh pr view 314");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("pushing a feature branch (agy naming) is allowed", async () => {
  const res = await runHook("git push -u origin agy/308-merge-guard-coverage");
  assertEquals(res.code, 0, res.stderr);
});

// --- false-positive fix: heredoc bodies, quotes, and comments merely
// MENTIONING a dangerous command are not the command itself (the reported
// 2026-08-13 repro: a heredoc body mentioning 'git push --force origin
// main' blocked writing a file that had nothing to do with git) ---

Deno.test("the exact reported repro: a heredoc body mentioning 'git push --force origin main' is allowed", async () => {
  const res = await runHook(
    ["cat <<EOF > /tmp/x.md", "we must not run git push --force origin main", "EOF"].join("\n"),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("the same phrase inside single quotes is allowed", async () => {
  const res = await runHook(`echo 'we must not run git push --force origin main'`);
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("the same phrase inside double quotes is allowed", async () => {
  const res = await runHook(`echo "we must not run git push --force origin main"`);
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("the same phrase in a # comment is allowed", async () => {
  const res = await runHook("# we must not run git push --force origin main");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("'gh pr merge' inside double quotes is allowed", async () => {
  const res = await runHook(`echo "do not run gh pr merge 5"`);
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("'git push --delete' inside a # comment is allowed", async () => {
  const res = await runHook("# git push origin --delete some-branch");
  assertEquals(res.code, 0, res.stderr);
});

// --- real dangerous commands must still block, including chained forms ---

Deno.test("a real 'git push --force origin main' is blocked", async () => {
  const res = await runHook("git push --force origin main");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a real push to main chained behind && is blocked", async () => {
  const res = await runHook("git fetch && git push origin main");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a real push to main chained behind || is blocked", async () => {
  const res = await runHook("false || git push origin main");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a real push to main chained behind ; is blocked", async () => {
  const res = await runHook("echo hi; git push origin main");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a real push to main chained behind a pipe is blocked", async () => {
  const res = await runHook("echo hi | cat; git push origin main");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a real 'git push --force origin main' executed via bash -c is still blocked", async () => {
  const res = await runHook(`bash -c "git push --force origin main; echo done"`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- fail closed ---

Deno.test("an unterminated quote fails CLOSED (blocked)", async () => {
  const res = await runHook(`echo "unterminated git push --force origin main`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});
