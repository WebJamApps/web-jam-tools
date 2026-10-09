// test/agy_skill_run_script.test.ts — web-jam-tools#1319
//
// Tests for scripts/agy-skill-run.sh:
// Verifies that the script executes commands via bash -c and preserves:
// 1. The working directory
// 2. The output (stdout and stderr)
// 3. The exit status

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT_PATH = `${REPO_ROOT}scripts/agy-skill-run.sh`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runScript(
  commandArg: string,
  cwd?: string,
): Promise<RunResult> {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH, commandArg],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test("agy-skill-run.sh: fails with usage error when arguments count is not 1", async () => {
  const cmdNoArgs = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdout: "piped",
    stderr: "piped",
  });
  const resNoArgs = await cmdNoArgs.output();
  assertEquals(resNoArgs.code, 1);
  assertStringIncludes(new TextDecoder().decode(resNoArgs.stderr), "Usage:");

  const cmdMultiArgs = new Deno.Command("bash", {
    args: [SCRIPT_PATH, "echo 1", "echo 2"],
    stdout: "piped",
    stderr: "piped",
  });
  const resMultiArgs = await cmdMultiArgs.output();
  assertEquals(resMultiArgs.code, 1);
  assertStringIncludes(new TextDecoder().decode(resMultiArgs.stderr), "Usage:");
});

Deno.test("agy-skill-run.sh: keeps working directory, output, and exit status (manual verification check)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "agy-run-test-" });
  try {
    const res = await runScript(`pwd; echo "it's ok"; exit 3`, tmpDir);
    assertEquals(res.code, 3);
    assert(
      res.stdout.includes(tmpDir),
      `Expected stdout to contain ${tmpDir}, got: ${res.stdout}`,
    );
    assert(
      res.stdout.includes("it's ok"),
      `Expected stdout to contain "it's ok", got: ${res.stdout}`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("agy-skill-run.sh: keeps stdout and stderr streams", async () => {
  const res = await runScript(`echo "out message"; echo "err message" >&2; exit 0`);
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "out message");
  assertStringIncludes(res.stderr, "err message");
});

Deno.test("agy-skill-run.sh: propagates various exit codes faithfully", async () => {
  const res0 = await runScript("exit 0");
  assertEquals(res0.code, 0);

  const res1 = await runScript("exit 1");
  assertEquals(res1.code, 1);

  const res42 = await runScript("exit 42");
  assertEquals(res42.code, 42);

  const res127 = await runScript("non_existent_command_12345");
  assertEquals(res127.code, 127);
});

Deno.test("agy-skill-run.sh: handles multi-line commands with newlines", async () => {
  const multiline = `echo line1
echo line2
echo line3`;
  const res = await runScript(multiline);
  assertEquals(res.code, 0);
  assertEquals(res.stdout.trim(), "line1\nline2\nline3");
});

Deno.test("agy-skill-run.sh: handles complex pipes, redirects, and quotes", async () => {
  const cmd = `echo "it's a 'quoted' test" | tr "'" "_"`;
  const res = await runScript(cmd);
  assertEquals(res.code, 0);
  assertEquals(res.stdout.trim(), "it_s a _quoted_ test");
});
