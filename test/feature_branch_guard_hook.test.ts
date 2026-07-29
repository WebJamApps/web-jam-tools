// feature_branch_guard_hook.test.ts — web-jam-tools#285
//
// hooks/feature-branch-guard.sh had NO behaviour test before #285. It is a
// PreToolUse guard (matched on Edit|Write in scripts/install-hooks.sh) that
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
}

async function runHook(filePath: string): Promise<RunResult> {
  const input = JSON.stringify({ tool_input: { file_path: filePath } });
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

// --- fires: protected branches block the edit ---

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
