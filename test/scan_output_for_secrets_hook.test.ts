// Tests for hooks/scan-output-for-secrets.sh — the PostToolUse output scanner
// (web-jam-tools#272 Layer 2).
//
// Every credential string below is SYNTHETIC — generated for these tests, never
// issued by any provider. They only need to match the documented SHAPE.
//
// The scanner exists because the PreToolUse guards are blocklists: they can
// only stop leak shapes someone enumerated in advance, and three credentials
// leaked in two days in three shapes nobody had. This one ignores HOW the value
// was printed and matches only that something credential-shaped appeared.
import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/scan-output-for-secrets.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stderr: string;
}

// Fake values assembled at runtime so no complete credential-shaped literal
// sits in the repo — otherwise this very file would trip the scanner.
const FAKE = {
  google: "AIza" + "B".repeat(35),
  github: "ghp_" + "C".repeat(36),
  openai: "sk-" + "D".repeat(32),
  slack: "xoxb-" + "1".repeat(12),
  deno: "ddp_" + "E".repeat(24),
  aws: "AKIA" + "F".repeat(16),
  anthropic: "sk-ant-" + "G".repeat(24),
};

async function runHook(toolResponse: string): Promise<RunResult> {
  const input = JSON.stringify({ tool_response: { stdout: toolResponse } });
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

// --- credential shapes are detected regardless of how they were printed ---

Deno.test("a Deno Deploy token in output is detected (the 2026-07-26 leak)", async () => {
  const res = await runHook(`DENO_DEPLOY_TOKEN: SET ${FAKE.deno}`);
  assertEquals(res.code, 2);
  if (!res.stderr.includes("Deno Deploy token")) {
    throw new Error(`expected the shape to be named, got: ${res.stderr}`);
  }
});

Deno.test("a Google API key in output is detected", async () => {
  const res = await runHook(`"key": "${FAKE.google}"`);
  assertEquals(res.code, 2);
});

Deno.test("a GitHub token in output is detected", async () => {
  const res = await runHook(`export GH_TOKEN=${FAKE.github}`);
  assertEquals(res.code, 2);
});

Deno.test("an OpenAI-style key in output is detected", async () => {
  const res = await runHook(FAKE.openai);
  assertEquals(res.code, 2);
});

Deno.test("a Slack token in output is detected", async () => {
  const res = await runHook(FAKE.slack);
  assertEquals(res.code, 2);
});

Deno.test("an AWS access key id in output is detected", async () => {
  const res = await runHook(FAKE.aws);
  assertEquals(res.code, 2);
});

Deno.test("an Anthropic API key in output is detected", async () => {
  const res = await runHook(FAKE.anthropic);
  assertEquals(res.code, 2);
});

// --- the alarm must never repeat the value ---

Deno.test("the warning names the credential type but NEVER echoes the value", async () => {
  const res = await runHook(`token is ${FAKE.deno}`);
  assertEquals(res.code, 2);
  if (res.stderr.includes(FAKE.deno)) {
    throw new Error("the hook echoed the secret back into stderr");
  }
});

Deno.test("the warning tells the reader to surface and rotate it", async () => {
  const res = await runHook(FAKE.github);
  assertEquals(res.code, 2);
  if (!res.stderr.includes("COMPROMISED")) {
    throw new Error(`expected rotation guidance, got: ${res.stderr}`);
  }
});

// --- ordinary output must pass untouched ---

Deno.test("ordinary command output is allowed", async () => {
  const res = await runHook("total 24\ndrwxr-xr-x 3 joshua joshua 4096 src");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("prose merely mentioning a token is allowed", async () => {
  const res = await runHook("the GH_TOKEN env var is set in ~/.bashrc");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a short sk- string that is not key-shaped is allowed", async () => {
  const res = await runHook("sk-short");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a git sha is not mistaken for a credential", async () => {
  const res = await runHook("commit 2992da92f1b0c4e8a7d6b5c4e3f2a1b0c9d8e7f6");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("empty output is allowed", async () => {
  const res = await runHook("");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a credential-free localhost mongodb URI in tool output is allowed", async () => {
  const res = await runHook("Connected to mongodb://localhost:27018/test_db");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a credentialed remote mongodb URI in tool output is detected", async () => {
  const res = await runHook("Connecting to mongodb+srv://user:pass@cluster.example.invalid/db");
  assertEquals(res.code, 2);
  if (!res.stderr.includes("MongoDB connection string")) {
    throw new Error(`expected MongoDB connection string in stderr, got: ${res.stderr}`);
  }
});
