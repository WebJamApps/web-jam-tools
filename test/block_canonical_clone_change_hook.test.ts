import { assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HOOK_SCRIPT = `${REPO_ROOT}hooks/block-canonical-clone-change.sh`;
const AGY_SHIM = `${REPO_ROOT}hooks/agy-hook-shim.sh`;
const CANONICAL = "/home/joshua/WebJamApps/web-jam-tools";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHook(
  payload: Record<string, unknown>,
  envOverrides: Record<string, string> = {},
): Promise<RunResult> {
  const cmd = new Deno.Command("bash", {
    args: [HOOK_SCRIPT],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      HOME: "/home/joshua",
      ...envOverrides,
    },
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

interface AppendixRow {
  id: number;
  dir: string;
  command: string;
  result: "refuse" | "pass" | "pass-with-note";
  namedCommand?: string;
}

const APPENDIX_A_ROWS: AppendixRow[] = [
  {
    id: 1,
    dir: "/home/joshua",
    command:
      "cd /home/joshua/WebJamApps/web-jam-tools && git switch -c fix/sonnet-label-description dev && git branch --show-current",
    result: "refuse",
    namedCommand: "switch",
  },
  {
    id: 2,
    dir: CANONICAL,
    command:
      "git status --short && git switch -q dev && git switch -q -c fix/milestone-topic-designations",
    result: "refuse",
    namedCommand: "switch",
  },
  {
    id: 3,
    dir: CANONICAL,
    command:
      "git worktree add -b fix/sonnet-label-description-update /tmp/pr-1807-target origin/fix/sonnet-label-description && git cherry-pick 589bd1b",
    result: "refuse",
    namedCommand: "cherry-pick",
  },
  {
    id: 4,
    dir: CANONICAL,
    command:
      "git worktree add -b feat /tmp/wjt-x origin/dev && cd /tmp/wjt-x && git cherry-pick 589bd1b",
    result: "pass",
  },
  {
    id: 5,
    dir: "/home/joshua",
    command: "git -C /home/joshua/WebJamApps/web-jam-tools commit -m x",
    result: "refuse",
    namedCommand: "commit",
  },
  {
    id: 6,
    dir: CANONICAL,
    command: "git checkout 4870c27",
    result: "refuse",
    namedCommand: "checkout",
  },
  {
    id: 7,
    dir: CANONICAL,
    command: "git checkout -b feat",
    result: "refuse",
    namedCommand: "checkout",
  },
  {
    id: 8,
    dir: CANONICAL,
    command: "git merge origin/feat",
    result: "refuse",
    namedCommand: "merge",
  },
  {
    id: 9,
    dir: CANONICAL,
    command: "git rebase origin/dev",
    result: "refuse",
    namedCommand: "rebase",
  },
  {
    id: 10,
    dir: CANONICAL,
    command: "git reset --hard origin/dev",
    result: "refuse",
    namedCommand: "reset",
  },
  {
    id: 11,
    dir: CANONICAL,
    command: "git stash push -u -m wip",
    result: "refuse",
    namedCommand: "stash",
  },
  {
    id: 12,
    dir: CANONICAL,
    command: "git pull origin feat",
    result: "refuse",
    namedCommand: "pull",
  },
  {
    id: 13,
    dir: CANONICAL,
    command: "git pull origin dev",
    result: "pass",
  },
  {
    id: 14,
    dir: CANONICAL,
    command: "git pull --ff-only",
    result: "pass",
  },
  {
    id: 15,
    dir: CANONICAL,
    command: "git fetch --prune origin",
    result: "pass",
  },
  {
    id: 16,
    dir: CANONICAL,
    command: "git status -sb && git log --oneline -3 && git diff --stat",
    result: "pass",
  },
  {
    id: 17,
    dir: CANONICAL,
    command: "git worktree add -b feat /tmp/wjt-x origin/dev",
    result: "pass",
  },
  {
    id: 18,
    dir: CANONICAL,
    command: "git worktree remove /tmp/wjt-x && git branch -D feat",
    result: "pass",
  },
  {
    id: 19,
    dir: "/tmp/wjt-x",
    command: "git switch -c feat2 && git commit -m x && git cherry-pick 589bd1b",
    result: "pass",
  },
  {
    id: 20,
    dir: "/home/joshua/WebJamApps/JaMmusic",
    command: "git switch -c feat",
    result: "pass",
  },
  {
    id: 21,
    dir: CANONICAL,
    command: 'bash -c "$CMD"',
    result: "pass-with-note",
  },
];

for (const row of APPENDIX_A_ROWS) {
  Deno.test(`hook shell script Appendix A row ${row.id} (Claude Code): ${row.command}`, async () => {
    const res = await runHook({
      cwd: row.dir,
      tool_name: "Bash",
      tool_input: { command: row.command },
    });
    if (row.result === "refuse") {
      assertEquals(res.code, 2, res.stdout + res.stderr);
      assertStringIncludes(res.stderr, CANONICAL);
      assertStringIncludes(res.stderr, "scripts/new-agent-worktree.sh");
      if (row.namedCommand) {
        assertStringIncludes(res.stderr, row.namedCommand);
      }
    } else if (row.result === "pass-with-note") {
      assertEquals(res.code, 0, res.stderr);
      const parsed = JSON.parse(res.stdout.trim());
      assertEquals(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
      assertStringIncludes(parsed.hookSpecificOutput.additionalContext, "could not be read");
    } else {
      assertEquals(res.code, 0, res.stderr);
      assertEquals(res.stdout.trim(), "");
    }
  });

  Deno.test(`hook shell script Appendix A row ${row.id} (Codex): ${row.command}`, async () => {
    const res = await runHook({
      cwd: "/tmp/other-session-cwd",
      tool_name: "Bash",
      tool_input: { command: row.command, workdir: row.dir },
    });
    if (row.result === "refuse") {
      assertEquals(res.code, 2, res.stdout + res.stderr);
      assertStringIncludes(res.stderr, CANONICAL);
      assertStringIncludes(res.stderr, "scripts/new-agent-worktree.sh");
      if (row.namedCommand) {
        assertStringIncludes(res.stderr, row.namedCommand);
      }
    } else if (row.result === "pass-with-note") {
      assertEquals(res.code, 0, res.stderr);
      const parsed = JSON.parse(res.stdout.trim());
      assertEquals(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
      assertStringIncludes(parsed.hookSpecificOutput.additionalContext, "could not be read");
    } else {
      assertEquals(res.code, 0, res.stderr);
      assertEquals(res.stdout.trim(), "");
    }
  });
}

Deno.test("issue local check: git switch -c x exits 2, git status --short exits 0", async () => {
  const blocked = await runHook({ cwd: CANONICAL, tool_input: { command: "git switch -c x" } });
  assertEquals(blocked.code, 2);
  assertStringIncludes(blocked.stderr, CANONICAL);
  assertStringIncludes(blocked.stderr, "switch");

  const allowed = await runHook({ cwd: CANONICAL, tool_input: { command: "git status --short" } });
  assertEquals(allowed.code, 0, allowed.stderr);
});

Deno.test("workflow fallback: missing Deno allows with additionalContext note", async () => {
  const cmd = new Deno.Command("bash", {
    args: [HOOK_SCRIPT],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      PATH: "/usr/bin:/bin",
      BASH_ENV: "",
    },
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({ cwd: CANONICAL, tool_input: { command: "git switch -c x" } }),
    ),
  );
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  const parsed = JSON.parse(new TextDecoder().decode(stdout).trim());
  assertEquals(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assertStringIncludes(parsed.hookSpecificOutput.additionalContext, "Deno is unavailable");
});

Deno.test("agy shim translates refusal without claiming agy honours refusals", async () => {
  const cmd = new Deno.Command("bash", {
    args: [AGY_SHIM, "PreToolUse", btoa("Bash"), HOOK_SCRIPT],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      HOME: "/home/joshua",
      AGY_HOOK_RECORD_PATH: "off",
    },
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(JSON.stringify({
      workspacePaths: [CANONICAL],
      toolCall: {
        name: "run_command",
        args: { CommandLine: "git switch -c x", Cwd: CANONICAL },
      },
    })),
  );
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  const verdict = JSON.parse(new TextDecoder().decode(stdout).trim());
  assertEquals(verdict.decision, "deny");
  assertStringIncludes(verdict.reason, CANONICAL);
});

Deno.test("hook shell script: subshell cd restores parent cwd in both directions on Claude Code and Codex shapes", async () => {
  const worktree = "/tmp/wjt-x";
  const fromCanonical = "(cd /tmp/wjt-x && git status); git commit -m x";
  const fromWorktree = `(cd ${CANONICAL} && git status); git commit -m x`;

  for (
    const payload of [
      { cwd: CANONICAL, tool_name: "Bash", tool_input: { command: fromCanonical } },
      {
        cwd: worktree,
        tool_name: "Bash",
        tool_input: { command: fromCanonical, workdir: CANONICAL },
      },
    ]
  ) {
    const res = await runHook(payload);
    assertEquals(res.code, 2, res.stdout);
    assertStringIncludes(res.stderr, CANONICAL);
    assertStringIncludes(res.stderr, "commit");
  }

  for (
    const payload of [
      { cwd: worktree, tool_name: "Bash", tool_input: { command: fromWorktree } },
      {
        cwd: CANONICAL,
        tool_name: "Bash",
        tool_input: { command: fromWorktree, workdir: worktree },
      },
    ]
  ) {
    const res = await runHook(payload);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "");
  }

  const indeterminate = await runHook({
    cwd: CANONICAL,
    tool_name: "Bash",
    tool_input: { command: "if false; then cd /tmp/wjt-x; fi; git commit -m x" },
  });
  assertEquals(indeterminate.code, 0, indeterminate.stderr);
  const parsed = JSON.parse(indeterminate.stdout.trim());
  assertEquals(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assertStringIncludes(parsed.hookSpecificOutput.additionalContext, "folder");
});
