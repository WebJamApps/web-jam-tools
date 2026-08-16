// block_human_only_credentials_hook.test.ts — web-jam-tools#344
//
// Exercises hooks/block-human-only-credentials.sh end-to-end by shelling out to it
// (Deno.Command) with mocked PreToolUse JSON on stdin, the same shape Claude Code
// and Antigravity harness feed it.

import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/block-human-only-credentials.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stderr: string;
}

async function runHook(payload: {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}): Promise<RunResult> {
  const input = JSON.stringify(payload);
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
  if (!stderr.includes("BLOCKED (human-only-credentials guard)")) {
    throw new Error(`expected BLOCKED message in stderr, got: ${stderr}`);
  }
  if (!stderr.includes("KeePass")) {
    throw new Error(`expected KeePass mention in stderr, got: ${stderr}`);
  }
}

// Registered human-only identifier from hooks/human-only-credentials.yaml
const HUMAN_CREDENTIAL = "webjam.claude@gmail.com";

// --- Blocking export / assignment shell commands ---

Deno.test("export of registered human-only credential is blocked", async () => {
  const res = await runHook({
    tool_name: "Bash",
    tool_input: { command: `export GMAIL_USER="${HUMAN_CREDENTIAL}"` },
  });
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("shell variable assignment of registered human-only credential is blocked", async () => {
  const res = await runHook({
    tool_name: "Bash",
    tool_input: { command: `MY_EMAIL=${HUMAN_CREDENTIAL}` },
  });
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("appending registered human-only credential to .bashrc is blocked", async () => {
  const res = await runHook({
    tool_name: "Bash",
    tool_input: { command: `echo "export ACCOUNT=${HUMAN_CREDENTIAL}" >> ~/.bashrc` },
  });
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- Blocking edits / writes to env, shell rc, or config files ---

Deno.test("writing registered human-only credential into .env file is blocked", async () => {
  const res = await runHook({
    tool_name: "Write",
    tool_input: {
      path: "/home/joshua/project/.env",
      content: `USER_EMAIL=${HUMAN_CREDENTIAL}`,
    },
  });
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("editing registered human-only credential into config.json is blocked", async () => {
  const res = await runHook({
    tool_name: "Edit",
    tool_input: {
      file_path: "/home/joshua/project/config.json",
      new_string: `{"email": "${HUMAN_CREDENTIAL}"}`,
    },
  });
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("writing registered human-only credential into settings.yaml is blocked", async () => {
  const res = await runHook({
    tool_name: "Write",
    tool_input: {
      TargetFile: "/home/joshua/project/settings.yaml",
      CodeContent: `account: ${HUMAN_CREDENTIAL}`,
    },
  });
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- Allowing documentation and markdown files ---

Deno.test("editing documentation file in docs/ containing human-only credential is allowed", async () => {
  const res = await runHook({
    tool_name: "Edit",
    tool_input: {
      file_path: "/home/joshua/WebJamApps/web-jam-tools/docs/josh-manual-controls.md",
      content: `Profile for ${HUMAN_CREDENTIAL}`,
    },
  });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("editing AGENTS.md containing human-only credential is allowed", async () => {
  const res = await runHook({
    tool_name: "Write",
    tool_input: {
      file_path: "/home/joshua/WebJamApps/web-jam-tools/AGENTS.md",
      content: `Rules mentioning ${HUMAN_CREDENTIAL}`,
    },
  });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("editing human-only-credentials.yaml itself is allowed", async () => {
  const res = await runHook({
    tool_name: "Write",
    tool_input: {
      file_path: "/home/joshua/WebJamApps/web-jam-tools/hooks/human-only-credentials.yaml",
      content: `identifier: "${HUMAN_CREDENTIAL}"`,
    },
  });
  assertEquals(res.code, 0, res.stderr);
});

// --- Allowing ordinary exports and machine-consumed tokens ---

Deno.test("ordinary export FOO=bar is allowed", async () => {
  const res = await runHook({
    tool_name: "Bash",
    tool_input: { command: "export FOO=bar" },
  });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("machine-consumed GITHUB_TOKEN export is allowed by this hook", async () => {
  const res = await runHook({
    tool_name: "Bash",
    // No fixture-pragma marker needed: this value's sequential-digit body is
    // independently suppressed by the synthetic-value heuristic (proven in
    // test/detect_credential_literal.test.ts).
    tool_input: { command: "export GITHUB_TOKEN=ghp_123456789012345678901234567890123456" },
  });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("machine-consumed GEMINI_API_KEY export is allowed by this hook", async () => {
  const res = await runHook({
    tool_name: "Bash",
    tool_input: { command: "export GEMINI_API_KEY=$MY_KEY" },
  });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("ordinary ls command passes through allowed", async () => {
  const res = await runHook({
    tool_name: "Bash",
    tool_input: { command: "ls -la src/" },
  });
  assertEquals(res.code, 0, res.stderr);
});
