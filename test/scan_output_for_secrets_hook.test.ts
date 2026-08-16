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
import { variedFakeBody, variedFakeBodyUpper } from "./support/varied_fake_value.ts";

const SCRIPT_PATH = new URL(
  "../hooks/scan-output-for-secrets.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stderr: string;
}

// Fake values assembled at runtime so no complete credential-shaped literal
// sits in the repo — otherwise this very file would trip the scanner. Bodies
// are VARIED (test/support/varied_fake_value.ts), not repeated characters:
// hooks/lib/detect_credential_literal.ts's synthetic-value heuristic treats
// an 8+ run of the same character as self-evidently not a live secret and
// would otherwise auto-suppress these "must be detected" fixtures.
const FAKE = {
  google: "AIza" + variedFakeBody(35, 10),
  github: "ghp_" + variedFakeBody(36, 11),
  openai: "sk-" + variedFakeBody(32, 12),
  slack: "xoxb-" + variedFakeBody(12, 13),
  deno: "ddp_" + variedFakeBody(24, 14),
  aws: "AKIA" + variedFakeBodyUpper(16, 15),
  anthropic: "sk-ant-" + variedFakeBody(24, 16),
};

async function runHookRaw(rawStdin: string): Promise<RunResult> {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(rawStdin));
  await writer.close();
  const { code, stderr } = await child.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

function runHook(toolResponse: string): Promise<RunResult> {
  return runHookRaw(JSON.stringify({ tool_response: { stdout: toolResponse } }));
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

Deno.test("the warning tells the reader to verify liveness before rotating, not to treat it as settled fact", async () => {
  const res = await runHook(FAKE.github);
  assertEquals(res.code, 2);
  if (!res.stderr.includes("Verify whether it is a real, live credential")) {
    throw new Error(`expected verify-then-rotate guidance, got: ${res.stderr}`);
  }
  if (res.stderr.includes("must be treated as COMPROMISED")) {
    throw new Error(`expected no unconditional COMPROMISED claim, got: ${res.stderr}`);
  }
});

Deno.test("the warning truthfully attributes the match to the command's output (scan is narrowed to tool_response only, per item 5)", async () => {
  const res = await runHook(FAKE.github);
  assertEquals(res.code, 2);
  if (!res.stderr.includes("appeared in what this command printed")) {
    throw new Error(
      `expected the hook to attribute the match to the command's output, got: ${res.stderr}`,
    );
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

// A bare remote host with no userinfo names infrastructure, not a secret —
// this is the second false-positive class fixed alongside the fixture
// pragma: previously ANY non-local host, credentialed or not, was flagged.
Deno.test("a credential-free REMOTE mongodb URI in tool output is allowed", async () => {
  const res = await runHook("Connecting to mongodb+srv://cluster.example.invalid/test_db");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a credentialed remote mongodb URI in tool output is detected", async () => {
  // A resolvable-looking host + non-generic userinfo, so this proves real
  // detection rather than tripping the reserved-host/placeholder-userinfo
  // heuristic — still needs the pragma marker since the heuristic does not
  // cover it. The marker sits on the SAME line as the `uri` assignment
  // (not the later runHook call) so `deno fmt` line-wrapping a long call
  // can never separate it from the literal it annotates.
  const pw = variedFakeBody(20, 18);
  const uri = `mongodb+srv://svcAcct7x:${pw}@prodcluster9.realdomain.org/db`; // webjam-fixture-ok
  const res = await runHook(`Connecting to ${uri}`);
  assertEquals(res.code, 2);
  if (!res.stderr.includes("MongoDB connection string")) {
    throw new Error(`expected MongoDB connection string in stderr, got: ${res.stderr}`);
  }
});

Deno.test("a credentialed LOCAL mongodb URI in tool output is still detected", async () => {
  const res = await runHook("Connecting to mongodb://admin:hunter2@localhost:27017/db"); // webjam-fixture-ok
  assertEquals(res.code, 2);
  if (!res.stderr.includes("MongoDB connection string")) {
    throw new Error(`expected MongoDB connection string in stderr, got: ${res.stderr}`);
  }
});

// --- placeholder exemption tests (web-jam-tools#434) ---

Deno.test("placeholder example in web-jam-tools#304 body does not trigger scanner", async () => {
  const res = await runHook('Bash(export GEMINI_API_KEY="<key>")');
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("placeholder example in block-secret-literals.sh source does not trigger scanner", async () => {
  const res = await runHook('export GEMINI_API_KEY="..."');
  assertEquals(res.code, 0, res.stderr);
});

// --- fixture-pragma tests (issue-detector-false-positive) ---
// The pragma marker is a distinct string ("webjam-fixture-ok") so these
// literal usages below do not require importing the detector module.

Deno.test("a credential-shaped literal marked with the fixture pragma is allowed", async () => {
  const res = await runHook(`const token = "${FAKE.github}"; // webjam-fixture-ok`);
  assertEquals(res.code, 0, res.stderr);
});

// Per-literal specificity (a marker suppresses only the adjacent match, not
// an unrelated one elsewhere in the input) is covered at the unit level in
// test/detect_credential_literal.test.ts using real multi-line text. It is
// not re-tested here: this hook's payload is JSON (tool_response.stdout is
// JSON-string-escaped before it ever reaches the detector), so an embedded
// "\n" in the fixture arrives as the two literal characters backslash-n, not
// a real line break — line-adjacency semantics are not observable through
// this transport, only through direct text passed to the detector.

// --- item 5: the scan is narrowed to tool_response only ---

Deno.test("a credential-shaped literal ONLY in tool_input.command (not in the output) is NOT flagged by this hook", async () => {
  // Command TEXT is covered strictly earlier by hooks/block-secret-literals.sh
  // (PreToolUse) — this PostToolUse hook's only unique job is the OUTPUT.
  const payload = JSON.stringify({
    tool_input: { command: `echo hi # ${FAKE.github}` },
    tool_response: { stdout: "hi\n", stderr: "" },
  });
  const res = await runHookRaw(payload);
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a credential-shaped literal in tool_response.stderr (not stdout) is still detected", async () => {
  const payload = JSON.stringify({
    tool_response: { stdout: "", stderr: `warning: leaked ${FAKE.aws}` },
  });
  const res = await runHookRaw(payload);
  assertEquals(res.code, 2);
  if (!res.stderr.includes("AWS access key id")) {
    throw new Error(`expected stderr to be scanned too, got: ${res.stderr}`);
  }
});

Deno.test("an unrecognized tool_response shape (no stdout/stderr fields) still gets scanned via the whole-object fallback", async () => {
  // Models an Edit-shaped tool_response — no .stdout/.stderr at all.
  const payload = JSON.stringify({
    tool_response: { filePath: "/tmp/x.env", newString: `TOKEN=${FAKE.slack}` },
  });
  const res = await runHookRaw(payload);
  assertEquals(res.code, 2);
  if (!res.stderr.includes("Slack token")) {
    throw new Error(
      `expected the fallback to still scan an unrecognized shape, got: ${res.stderr}`,
    );
  }
});

Deno.test("malformed JSON input fails SAFE by scanning the whole raw input, not silently skipping", async () => {
  const res = await runHookRaw(`this is not valid json but contains ${FAKE.deno} anyway`);
  assertEquals(res.code, 2);
  if (!res.stderr.includes("Deno Deploy token")) {
    throw new Error(`expected fail-safe scanning of unparseable input, got: ${res.stderr}`);
  }
});

Deno.test("a PreToolUse-shaped payload with no tool_response at all is allowed cleanly (no crash)", async () => {
  const payload = JSON.stringify({ tool_input: { command: "ls -la" } });
  const res = await runHookRaw(payload);
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a realistic (non-degenerate, unmarked) high-entropy token in tool_response.stdout is still caught end to end", async () => {
  // Confirms the narrowed scan + synthetic-value heuristic together do not
  // create a new false-negative: an ordinary realistic credential is still
  // loud and blocking.
  const res = await runHook(`export GH_TOKEN=${FAKE.github}`);
  assertEquals(res.code, 2);
  if (!res.stderr.includes("GitHub token")) {
    throw new Error(`expected a realistic token to still be caught, got: ${res.stderr}`);
  }
});
