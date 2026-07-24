// block_secret_dumps_hook.test.ts — web-jam-tools#257
//
// Exercises hooks/block-secret-dumps.sh's cp/test exception end-to-end by
// actually shelling out to it (Deno.Command) with mocked PreToolUse JSON on
// stdin, the same shape Claude Code's hook runner feeds it. This is the only
// reliable way to test a bash script's behavior — re-implementing its
// regexes in TypeScript would test a copy, not the real guard.
//
// A secret-file substring (".env") appears throughout this file's fixture
// commands, which is exactly what the guard matches on. Because this file is
// executed via `deno test`/`deno task test` (a Deno subprocess), not as a
// Claude Code Bash tool call, it never passes through the *installed*
// PreToolUse hook itself — only through the copy of the script under test.

import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL("../hooks/block-secret-dumps.sh", import.meta.url).pathname;

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

// --- newly allowed: cp ---

Deno.test("cp .env <dest> is allowed", async () => {
  const res = await runHook("cp .env /tmp/worktree/.env");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("cp .env.test <dest> is allowed", async () => {
  const res = await runHook("cp .env.test /tmp/worktree/.env.test");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("cp credentials.json <dest> is allowed (exception applies to the whole secret-file match, not just .env)", async () => {
  const res = await runHook("cp credentials.json /tmp/worktree/credentials.json");
  assertEquals(res.code, 0, res.stderr);
});

// --- newly allowed: test / [ existence checks ---

Deno.test("test -f .env is allowed", async () => {
  const res = await runHook("test -f .env");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("test -e .env is allowed", async () => {
  const res = await runHook("test -e .env");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("[ -f .env ] is allowed", async () => {
  const res = await runHook("[ -f .env ]");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("[ -e .env ] is allowed", async () => {
  const res = await runHook("[ -e .env ]");
  assertEquals(res.code, 0, res.stderr);
});

// --- still blocked: content-dumping forms ---

Deno.test("cat .env is still blocked", async () => {
  const res = await runHook("cat .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("head .env is still blocked", async () => {
  const res = await runHook("head .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("grep foo .env is still blocked", async () => {
  const res = await runHook("grep foo .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cat .env.test is still blocked (suffixed secret file, not just bare .env)", async () => {
  const res = await runHook("cat .env.test");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cat .env.local is still blocked (suffixed secret file)", async () => {
  const res = await runHook("cat .env.local");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("echo $(cat .env) is still blocked (command substitution dump)", async () => {
  const res = await runHook("echo $(cat .env)");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- still blocked: cp/test forms that can still exfiltrate ---

Deno.test("cp .env /dev/stdout is still blocked (writes contents to stdout)", async () => {
  const res = await runHook("cp .env /dev/stdout");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cp .env /proc/self/fd/1 is still blocked (proc fd alias for stdout)", async () => {
  const res = await runHook("cp .env /proc/self/fd/1");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cp .env /proc/1234/fd/2 is still blocked (proc fd alias for another process' stderr)", async () => {
  const res = await runHook("cp .env /proc/1234/fd/2");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cp .env /dev/tty is still blocked (writes contents to the terminal)", async () => {
  const res = await runHook("cp .env /dev/tty");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cp .env /tmp/seed.env is still allowed (plain destination, not a proc fd or tty)", async () => {
  const res = await runHook("cp .env /tmp/seed.env");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("cp .env - | cat is still blocked (piped)", async () => {
  const res = await runHook("cp .env - | cat");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("test -f .env && cat .env is still blocked (chained dump)", async () => {
  const res = await runHook("test -f .env && cat .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("test -f .env; cat .env is still blocked (chained via semicolon)", async () => {
  const res = await runHook("test -f .env; cat .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cp .env $(mktemp) is still blocked (command substitution)", async () => {
  const res = await runHook("cp .env $(mktemp)");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- still blocked: other ops on secret files (not just cp/test) ---

Deno.test("ln -s .env /tmp/x is still blocked", async () => {
  const res = await runHook("ln -s .env /tmp/x");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("mv .env /tmp/x is still blocked", async () => {
  const res = await runHook("mv .env /tmp/x");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("stat .env is still blocked", async () => {
  const res = await runHook("stat .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("rm .env is still blocked", async () => {
  const res = await runHook("rm .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- still blocked: whole-environment / whole-config dumps (unrelated to
// the filename-match branch, but must remain intact) ---

Deno.test("bare env is still blocked (whole-environment dump)", async () => {
  const res = await runHook("env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("bare printenv is still blocked (whole-environment dump)", async () => {
  const res = await runHook("printenv");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("bare heroku config is still blocked (whole-config dump)", async () => {
  const res = await runHook("heroku config -a myapp");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("rclone config show is still blocked", async () => {
  const res = await runHook("rclone config show gdrive");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- unrelated commands pass through untouched ---

Deno.test("a command with no secret-file reference is allowed", async () => {
  const res = await runHook("ls -la src/");
  assertEquals(res.code, 0, res.stderr);
});

function assertBlocked(stderr: string) {
  if (!stderr.includes("BLOCKED (secret-dump guard)")) {
    throw new Error(`expected BLOCKED message in stderr, got: ${stderr}`);
  }
}
