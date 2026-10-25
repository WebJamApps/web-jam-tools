// feature_branch_guard_hook.test.ts — web-jam-tools#285
//
// hooks/feature-branch-guard.sh had NO behaviour test before #285. It is a
// PreToolUse guard (matched on Bash|Edit|Write in scripts/install-hooks.sh) that
// blocks an edit whose target file's git repo is currently on a protected
// branch (dev/main/master), forcing a feature branch first. Exercised the
// same way as the other hooks — shelling out to it (Deno.Command) with
// mocked PreToolUse JSON on stdin — but this one also needs a REAL throwaway
// git repo per case (never the real web-jam-tools checkout) since the guard
// reads the actual current branch via `git branch --show-current`.

import { assert, assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/feature-branch-guard.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stderr: string;
  stdout: string;
}

async function runHookPayload(
  payload: Record<string, unknown>,
  args = [SCRIPT_PATH],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const input = JSON.stringify(payload);
  const cmd = new Deno.Command("bash", {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { BASH_ENV: "", AGY_HOOK_RECORD_PATH: "off", ...env },
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stderr, stdout } = await child.output();
  return {
    code,
    stderr: new TextDecoder().decode(stderr),
    stdout: new TextDecoder().decode(stdout),
  };
}

async function runHook(filePath: string): Promise<RunResult> {
  return await runHookPayload({ tool_input: { file_path: filePath } });
}

async function run(cmd: string, args: string[]): Promise<void> {
  const command = new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" });
  const { code, stderr } = await command.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
}

async function withRepoOnBranch(
  branch: string,
  fn: (filePath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await run("git", ["-C", dir, "init", "-q", "-b", branch]);
    await run("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
    await run("git", ["-C", dir, "config", "user.name", "Test"]);
    const filePath = `${dir}/some-file.ts`;
    await Deno.writeTextFile(filePath, "// placeholder\n");
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    await fn(filePath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function assertBlocked(stderr: string, branch: string) {
  assert(stderr.includes("BLOCKED"), `expected BLOCKED message, got: ${stderr}`);
  assert(stderr.includes(branch), `expected branch '${branch}' named in message, got: ${stderr}`);
}

for (const branch of ["dev", "main", "master", "feature/bash-writes"]) {
  Deno.test(`Bash write targets on ${branch}: direct hook and agy shim`, async () => {
    await withRepoOnBranch(branch, async (filePath) => {
      const cwd = filePath.slice(0, filePath.lastIndexOf("/"));
      const protectedBranch = branch !== "feature/bash-writes";
      const commands = [
        "sed -i 's/x/y/' deno.json",
        "echo x >> deno.json",
        "echo x > new/subdir/file.ts",
        "bash -c \"sed -i 's/x/y/' deno.json\"",
        "cp /tmp/input .",
      ];
      for (const command of commands) {
        const result = await runHookPayload({ tool_name: "Bash", cwd, tool_input: { command } });
        assertEquals(result.code, protectedBranch ? 2 : 0, command + result.stderr);
        const shim = await runHookPayload(
          { toolCall: { name: "run_command", args: { CommandLine: command, Cwd: cwd } } },
          [
            new URL("../hooks/agy-hook-shim.sh", import.meta.url).pathname,
            "PreToolUse",
            btoa("Bash|Edit|Write"),
            SCRIPT_PATH,
          ],
        );
        assertEquals(shim.code, 0, shim.stderr);
        assertEquals(JSON.parse(shim.stdout).decision, protectedBranch ? "deny" : "allow", command);
      }
      assertEquals(await Deno.readTextFile(filePath), "// placeholder\n");
    });
  });
}

// --- fires: protected branches block the edit ---

Deno.test("Bash: read-only commands and unrecognized write shapes stay allowed on dev", async () => {
  await withRepoOnBranch("dev", async (filePath) => {
    const cwd = filePath.slice(0, filePath.lastIndexOf("/"));
    for (
      const command of [
        "git commit -m 'record work'",
        "git status",
        "echo \"sed -i 's/x/y/' deno.json\"",
        "cat <<'EOF'\nsed -i 's/x/y/' deno.json\nEOF",
        'printf x > "$TARGET"',
        "python3 fix.py",
      ]
    ) {
      const result = await runHookPayload({ tool_name: "Bash", cwd, tool_input: { command } });
      assertEquals(result.code, 0, command + result.stderr);
    }
  });
});

Deno.test("Bash: cd and every recognized target use the target repository's branch", async () => {
  await withRepoOnBranch("feature/source", async (source) => {
    await withRepoOnBranch("dev", async (protectedFile) => {
      const cwd = source.slice(0, source.lastIndexOf("/"));
      const protectedDir = protectedFile.slice(0, protectedFile.lastIndexOf("/"));
      for (
        const command of [
          `cd '${protectedDir}' && sed -i 's/x/y/' deno.json`,
          `tee '${source}' '${protectedFile}'`,
          `git -C '${protectedDir}' apply /tmp/change.patch`,
        ]
      ) {
        const result = await runHookPayload({ tool_name: "Bash", cwd, tool_input: { command } });
        assertEquals(result.code, 2, command + result.stderr);
        assertBlocked(result.stderr, "dev");
      }
    });
  });
});

Deno.test("Bash: external files and a linked feature worktree stay allowed", async () => {
  await withRepoOnBranch("dev", async (filePath) => {
    const root = filePath.slice(0, filePath.lastIndexOf("/"));
    const scratch = await Deno.makeTempDir();
    try {
      const linked = `${scratch}/feature`;
      await run("git", ["-C", root, "worktree", "add", "-q", "-b", "feature/linked", linked]);
      for (
        const [cwd, command] of [
          [linked, "echo x >> some-file.ts"],
          [root, `echo x > '${scratch}/external.txt'`],
        ]
      ) {
        const result = await runHookPayload({ tool_name: "Bash", cwd, tool_input: { command } });
        assertEquals(result.code, 0, result.stderr);
      }
    } finally {
      await Deno.remove(scratch, { recursive: true });
    }
  });
});

Deno.test("workflow runner: checker crash allows with a note through the shell entry point", async () => {
  const shadow = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${shadow}/deno`, "#!/bin/sh\nexit 7\n");
    await Deno.chmod(`${shadow}/deno`, 0o755);
    const result = await runHookPayload(
      { tool_name: "Bash", tool_input: { command: "git status" } },
      [SCRIPT_PATH],
      { PATH: `${shadow}:${Deno.env.get("PATH") ?? ""}` },
    );
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stderr, "");
    assert(
      JSON.parse(result.stdout).hookSpecificOutput.additionalContext.includes("feature-branch"),
    );
  } finally {
    await Deno.remove(shadow, { recursive: true });
  }
});

Deno.test("editing a file on 'dev' is blocked", async () => {
  await withRepoOnBranch("dev", async (filePath) => {
    const res = await runHook(filePath);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr, "dev");
  });
});

Deno.test("editing a file on 'main' is blocked", async () => {
  await withRepoOnBranch("main", async (filePath) => {
    const res = await runHook(filePath);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr, "main");
  });
});

Deno.test("editing a file on 'master' is blocked", async () => {
  await withRepoOnBranch("master", async (filePath) => {
    const res = await runHook(filePath);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr, "master");
  });
});

// --- passes through: feature branch, or no git repo at all ---

Deno.test("editing a file on a feature branch is allowed", async () => {
  await withRepoOnBranch("claude/285-hook-behaviour-tests", async (filePath) => {
    const res = await runHook(filePath);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("editing a file outside any git repo is allowed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const filePath = `${dir}/scratch.txt`;
    await Deno.writeTextFile(filePath, "not in a repo\n");
    const res = await runHook(filePath);
    assertEquals(res.code, 0, res.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("no file_path at all is allowed (nothing to check)", async () => {
  const res = await runHook("");
  assertEquals(res.code, 0, res.stderr);
});

// --- Codex apply_patch tests (web-jam-tools#1138) ---

Deno.test("apply_patch: editing a file on 'dev' is blocked", async () => {
  await withRepoOnBranch("dev", async (filePath) => {
    const res = await runHookPayload({
      tool_name: "apply_patch",
      tool_input: {
        command: `*** Add File: ${filePath}\n+new content\n`,
      },
    });
    assertEquals(res.code, 2);
    assertBlocked(res.stderr, "dev");
  });
});

Deno.test("apply_patch: editing a file on a feature branch is allowed", async () => {
  await withRepoOnBranch("codex/1138-apply-patch-feature-branch", async (filePath) => {
    const res = await runHookPayload({
      tool_name: "apply_patch",
      tool_input: {
        command: `*** Add File: ${filePath}\n+new content\n`,
      },
    });
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("apply_patch: file outside any git repo is allowed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const res = await runHookPayload({
      tool_name: "apply_patch",
      tool_input: {
        command: `*** Update File: ${dir}/probe.txt\n--- a/probe.txt\n+++ b/probe.txt\n`,
      },
    });
    assertEquals(res.code, 0, res.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("apply_patch: two files in one patch where one is on 'dev' is blocked", async () => {
  await withRepoOnBranch("dev", async (devFilePath) => {
    const dir = await Deno.makeTempDir();
    try {
      const outOfTreeFile = `${dir}/out-of-tree.txt`;
      // Check two files where the first is out of tree and the second is on dev
      const res = await runHookPayload({
        tool_name: "apply_patch",
        tool_input: {
          command:
            `*** Add File: ${outOfTreeFile}\n+hello\n*** Update File: ${devFilePath}\n--- a/f\n+++ b/f\n`,
        },
      });
      assertEquals(res.code, 2);
      assertBlocked(res.stderr, "dev");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

Deno.test("apply_patch: patch with no parseable file path is refused (fails closed)", async () => {
  const res = await runHookPayload({
    tool_name: "apply_patch",
    tool_input: {
      command: "malformed patch without header lines\n+line 1\n",
    },
  });
  assertEquals(res.code, 2);
  assert(res.stderr.includes("BLOCKED"));
});
