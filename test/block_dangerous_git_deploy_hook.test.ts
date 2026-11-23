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
import { COMMENT_HEREDOC_GUARD_CASES } from "./comment_heredoc_guard_cases.ts";

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

// --- web-jam-tools#1223: git global options before the subcommand ---
// Real hook script, full PreToolUse Bash payload, exit code per table row.
import {
  GLOBAL_OPTION_CASES as GLOBAL_OPTION_CASES_1223,
  PLAIN_REGRESSION_CASES as PLAIN_REGRESSION_CASES_1223,
} from "./git_global_options_cases.ts";

async function exitCodeFor1223(command: string): Promise<number> {
  const payload = JSON.stringify({
    tool_name: "Bash",
    hook_event_name: "PreToolUse",
    cwd: new URL("..", import.meta.url).pathname,
    tool_input: { command },
  });
  const child = new Deno.Command("bash", {
    args: [new URL("../hooks/block-dangerous-git-deploy.sh", import.meta.url).pathname],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(payload));
  await writer.close();
  return (await child.output()).code;
}

GLOBAL_OPTION_CASES_1223.forEach((row, n) => {
  Deno.test(`#1223 row ${n + 1}: ${row[0]}`, async () => {
    assertEquals(await exitCodeFor1223(row[0]), row[1]);
  });
});

PLAIN_REGRESSION_CASES_1223.forEach((row) => {
  Deno.test(`#1223 plain command unchanged: ${row[0]}`, async () => {
    assertEquals(await exitCodeFor1223(row[0]), row[1]);
  });
});

// --- web-jam-tools#1422: the merge/deploy column through the shell entry point ---
// Command strings travel as JSON on stdin; none of them is executed.

for (const row of COMMENT_HEREDOC_GUARD_CASES) {
  Deno.test(`apostrophe merge/deploy shell literal case ${row.id}: ${row.mergeDeploy}`, async () => {
    const res = await runHook(row.command);
    assertEquals(res.code, row.mergeDeploy === "allow" ? 0 : 2, res.stderr);
    if (row.mergeDeploy === "allow") {
      assertEquals(res.stderr, "");
    } else if (row.mergeDeploy === "operation") {
      assertOperationRefusal(res.stderr);
    } else {
      assertCouldNotRead(res.stderr);
    }
  });
}

function assertOperationRefusal(stderr: string) {
  assertBlocked(stderr);
  assertEquals(stderr.includes("This is Josh's action to perform"), true, stderr);
  assertEquals(stderr.includes("could not read the command"), false, stderr);
}

function assertCouldNotRead(stderr: string) {
  assertEquals(
    stderr.includes(
      "BLOCKED (merge/deploy guard): could not read the command; no protected operation was identified.",
    ),
    true,
    stderr,
  );
  assertEquals(stderr.includes("restate the same action"), true, stderr);
  assertEquals(stderr.includes("checked by this same guard"), true, stderr);
  assertEquals(stderr.includes("Do not change what the command does"), true, stderr);
  assertEquals(stderr.includes("end of the turn"), true, stderr);
  // D-51: never claims an operation was found and never hands the command to Josh.
  assertEquals(stderr.includes("Josh's action"), false, stderr);
  assertEquals(stderr.includes("Josh"), false, stderr);
  assertEquals(stderr.includes("STOP"), false, stderr);
}

Deno.test("apostrophe outcome 1: parsed and unmatched proceeds with exit 0 and no output", async () => {
  const res = await runHook("echo hi # don't");
  assertEquals(res, { code: 0, stderr: "" });
});

Deno.test("apostrophe outcome 2: parsed and matched refuses with exit 2 and the operation response", async () => {
  const res = await runHook("git push origin dev # don't");
  assertEquals(res.code, 2);
  assertOperationRefusal(res.stderr);
  assertEquals(res.stderr.includes("'git push' to a protected branch"), true, res.stderr);
});

Deno.test("apostrophe outcome 3: unreadable refuses with exit 2 and the could-not-read response", async () => {
  const res = await runHook(`echo "unclosed`);
  assertEquals(res.code, 2);
  assertCouldNotRead(res.stderr);
});

// Command-reader design, "Checker that could not run": a broken guard is reported as a guard
// that could not run, never as an unreadable command and never as a merge or deploy found.
function pathWithoutDeno(): string {
  return (Deno.env.get("PATH") ?? "").split(":").filter((dir) => {
    try {
      Deno.statSync(`${dir}/deno`);
      return false;
    } catch {
      return true;
    }
  }).join(":");
}

const CHECKER_COULD_NOT_RUN_CASES: {
  id: string;
  checker: string;
  noDeno?: boolean;
  /** A stand-in for the shared runner, in place of the real one. */
  runner?: string;
  /** Extra environment for the guard, such as an unusable TMPDIR. */
  env?: Record<string, string>;
  /** Hook input in place of a Bash call to `git status`. */
  stdin?: string;
  /** Run the guard with a PATH that holds only these tools, such as `cat` without jq. */
  onlyTools?: string[];
  expect: string[];
}[] = [
  {
    id: "R1",
    checker: "this is not (\n",
    expect: [
      "BLOCKED (block-dangerous-git-deploy): safety guard could not run (checker failed with exit code 1). Refusing action (safety default: fail closed).",
      "Stop and report this refusal to Josh; do not retry the action through another route.",
    ],
  },
  {
    id: "R2",
    checker: "await new Promise((r) => setTimeout(r, 60000));\n",
    expect: [
      "safety guard could not run (checker timed out after 15s)",
      "Stop and report this refusal to Josh",
    ],
  },
  {
    id: "R3",
    checker: 'console.log("OK");\n',
    noDeno: true,
    expect: [
      "safety guard could not run (Deno is unavailable on PATH)",
      "Stop and report this refusal to Josh",
    ],
  },
  {
    id: "R4",
    checker: 'console.log("");\n',
    expect: ["safety guard could not run", "no verdict", "Stop and report this refusal to Josh"],
  },
  {
    id: "R5",
    checker: 'console.log("MAYBE");\n',
    expect: ["safety guard could not run", "MAYBE", "Stop and report this refusal to Josh"],
  },
  // A refusal marker with no description, or a description over several lines, is not a verdict.
  ...[
    ["R6", 'console.log("BLOCK:");\n', "BLOCK verdict without a description"],
    ["R7", 'console.log("BLOCK:   ");\n', "BLOCK verdict without a description"],
    [
      "R8",
      'console.log("BLOCK:first line\\nsecond line");\n',
      "BLOCK verdict without a description",
    ],
    ["R9", 'console.log("UNREADABLE:");\n', "UNREADABLE verdict without a description"],
    ["R10", 'console.log("UNREADABLE: \\t ");\n', "UNREADABLE verdict without a description"],
    [
      "R11",
      'console.log("UNREADABLE:first line\\nsecond line");\n',
      "UNREADABLE verdict without a description",
    ],
  ].map(([id, checker, reason]) => ({
    id,
    checker,
    expect: [
      `BLOCKED (block-dangerous-git-deploy): safety guard could not run (checker gave ${
        reason.startsWith("BLOCK") ? "a" : "an"
      } ${reason}). Refusing action (safety default: fail closed).`,
      "Stop and report this refusal to Josh; do not retry the action through another route.",
    ],
  })),
  {
    id: "R12",
    checker: 'console.log("OK");\n',
    runner: "#!/usr/bin/env bash\ncat >/dev/null\nexit 2\n",
    expect: [
      "BLOCKED (block-dangerous-git-deploy): safety guard could not run (the shared runner failed with exit code 2 and gave no refusal). Refusing action (safety default: fail closed).",
      "Stop and report this refusal to Josh; do not retry the action through another route.",
    ],
  },
  {
    id: "R13",
    checker: 'console.log("OK");\n',
    runner: "#!/usr/bin/env bash\ncat >/dev/null\necho 'some unrelated error' >&2\nexit 1\n",
    expect: [
      "safety guard could not run (the shared runner failed with exit code 1 and gave no refusal)",
      "Stop and report this refusal to Josh",
    ],
  },
  {
    id: "R14",
    checker: 'console.log("OK");\n',
    runner: "#!/usr/bin/env bash\ncat >/dev/null\n" +
      "echo 'BLOCKED (block-dangerous-git-deploy): safety guard could not run (made-up runner reason). Refusing action (safety default: fail closed).' >&2\n" +
      "echo 'Stop and report this refusal to Josh; do not retry the action through another route.' >&2\nexit 2\n",
    expect: [
      "BLOCKED (block-dangerous-git-deploy): safety guard could not run (made-up runner reason). Refusing action (safety default: fail closed).\n" +
      "Stop and report this refusal to Josh; do not retry the action through another route.\n",
    ],
  },
  {
    id: "R15",
    checker: 'console.log("OK");\n',
    env: { TMPDIR: "/nonexistent-merge-deploy-guard-tmp" },
    expect: [
      "BLOCKED (block-dangerous-git-deploy): safety guard could not run (could not create a file to capture the checker's errors). Refusing action (safety default: fail closed).",
      "Stop and report this refusal to Josh; do not retry the action through another route.",
    ],
  },
  // Reading the hook input is part of the guard: jq missing, or input it cannot parse, refuses.
  {
    id: "R16",
    checker: 'console.log("OK");\n',
    onlyTools: ["cat"],
    expect: [
      "BLOCKED (block-dangerous-git-deploy): safety guard could not run (could not read the hook input). Refusing action (safety default: fail closed).",
      "Stop and report this refusal to Josh; do not retry the action through another route.",
    ],
  },
  {
    id: "R17",
    checker: 'console.log("OK");\n',
    stdin: '{"tool_name": "Bash", "tool_input": {"command": "gh pr merge 1 --squash"',
    expect: [
      "BLOCKED (block-dangerous-git-deploy): safety guard could not run (could not read the hook input). Refusing action (safety default: fail closed).",
      "Stop and report this refusal to Josh; do not retry the action through another route.",
    ],
  },
  // An empty stream, or one holding only whitespace, is no hook event: jq succeeds on it with no
  // value, so the guard checks for it before jq.
  ...[["R18", ""], ["R19", " \n\t \n"]].map(([id, stdin]) => ({
    id,
    checker: 'console.log("OK");\n',
    stdin,
    expect: [
      "BLOCKED (block-dangerous-git-deploy): safety guard could not run (the hook input was empty). Refusing action (safety default: fail closed).",
      "Stop and report this refusal to Josh; do not retry the action through another route.",
    ],
  })),
  // The input cannot be taken in: the PATH holds jq but not cat.
  {
    id: "R20",
    checker: 'console.log("OK");\n',
    onlyTools: ["jq"],
    expect: [
      "BLOCKED (block-dangerous-git-deploy): safety guard could not run (could not read the hook input). Refusing action (safety default: fail closed).",
      "Stop and report this refusal to Josh; do not retry the action through another route.",
    ],
  },
  // JSON that is not a hook event object.
  ...[["R21", "null"], ["R22", '"gh pr merge 1"'], ["R23", "[]"]].map(([id, stdin]) => ({
    id,
    checker: 'console.log("OK");\n',
    stdin,
    expect: [
      "BLOCKED (block-dangerous-git-deploy): safety guard could not run (could not read the hook input). Refusing action (safety default: fail closed).",
      "Stop and report this refusal to Josh; do not retry the action through another route.",
    ],
  })),
];

/** bash's own path, so the guard can run under a PATH that does not hold it. */
function bashPath(): string {
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")) {
    try {
      Deno.statSync(`${dir}/bash`);
      return `${dir}/bash`;
    } catch {
      // not in this directory
    }
  }
  return "bash";
}

/** A PATH holding only the named tools, linked from where the test's own PATH finds them. */
async function pathWithOnly(dir: string, tools: string[]): Promise<string> {
  const bin = `${dir}/bin-with-only-${tools.join("-")}`;
  await Deno.mkdir(bin);
  for (const tool of tools) {
    for (const pathDir of (Deno.env.get("PATH") ?? "").split(":")) {
      try {
        Deno.statSync(`${pathDir}/${tool}`);
        await Deno.symlink(`${pathDir}/${tool}`, `${bin}/${tool}`);
        break;
      } catch {
        // not in this directory
      }
    }
  }
  return bin;
}

for (const row of CHECKER_COULD_NOT_RUN_CASES) {
  Deno.test(`checker that could not run ${row.id}: refuses as a guard that could not run`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "merge-deploy-broken-" });
    try {
      await Deno.mkdir(`${dir}/hooks/lib`, { recursive: true });
      await Deno.copyFile(SCRIPT_PATH, `${dir}/hooks/block-dangerous-git-deploy.sh`);
      if (row.runner) {
        await Deno.writeTextFile(`${dir}/hooks/lib/run_hook.sh`, row.runner);
      } else {
        const runner = new URL("../hooks/lib/run_hook.sh", import.meta.url).pathname;
        await Deno.copyFile(runner, `${dir}/hooks/lib/run_hook.sh`);
      }
      await Deno.chmod(`${dir}/hooks/lib/run_hook.sh`, 0o755);
      await Deno.writeTextFile(`${dir}/hooks/lib/check_dangerous_git_deploy.ts`, row.checker);
      const env: Record<string, string> = { BASH_ENV: "", AGY_HOOK_RECORD_PATH: "off" };
      if (row.noDeno) env.PATH = pathWithoutDeno();
      if (row.onlyTools) env.PATH = await pathWithOnly(dir, row.onlyTools);
      Object.assign(env, row.env ?? {});
      const child = new Deno.Command(bashPath(), {
        args: [`${dir}/hooks/block-dangerous-git-deploy.sh`],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        env,
      }).spawn();
      const writer = child.stdin.getWriter();
      await writer.write(
        new TextEncoder().encode(
          row.stdin ??
            JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }),
        ),
      );
      await writer.close();
      const out = await child.output();
      const stderr = new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 2, stderr);
      for (const text of row.expect) {
        assertEquals(stderr.includes(text), true, `${text} in ${stderr}`);
      }
      assertEquals(stderr.includes("could not read the command"), false, stderr);
      assertEquals(stderr.includes("restate the same action"), false, stderr);
      assertEquals(stderr.includes("This is Josh's action to perform"), false, stderr);
      assertEquals(stderr.includes("never-merge-or-deploy-without-permission"), false, stderr);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("hook input that parses but names no command is let through with no output", async () => {
  const child = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/tmp/made-up.txt" } }),
    ),
  );
  await writer.close();
  const out = await child.output();
  assertEquals({ code: out.code, stderr: new TextDecoder().decode(out.stderr) }, {
    code: 0,
    stderr: "",
  });
});
