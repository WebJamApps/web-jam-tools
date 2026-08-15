// agy_hook_shim_hook.test.ts — web-jam-tools#432
//
// Two layers of coverage:
//   1. Pure-logic unit tests against the exported functions in
//      hooks/lib/agy_hook_shim.ts (mapping, matcher matching, payload
//      normalization, output recovery, verdict translation).
//   2. End-to-end tests that actually shell out to hooks/agy-hook-shim.sh
//      (Deno.Command) with a REAL agy PreToolUse/PostToolUse payload shape
//      on stdin — camelCase toolCall.name/args, transcriptPath,
//      conversationId, stepIdx, modelName — wrapping the UNMODIFIED existing
//      hook scripts, and asserting the shim's stdout is agy's own
//      `{"decision":"deny"|"allow","reason":"..."}` veto form. This is the
//      proof the issue's acceptance criteria ask for: a hook that decides to
//      block actually blocks on Antigravity.

import { assert, assertEquals } from "@std/assert";
import {
  buildToolInput,
  mapAgyToolName,
  matcherMatches,
  normalize,
  recoverPostToolOutput,
  translateVerdict,
} from "../hooks/lib/agy_hook_shim.ts";

const SHIM_PATH = new URL("../hooks/agy-hook-shim.sh", import.meta.url).pathname;
const HOOKS_DIR = new URL("../hooks/", import.meta.url).pathname;

interface ShimResult {
  code: number;
  decision: string;
  reason?: string;
  stdout: string;
  stderr: string;
}

async function runShim(
  event: "PreToolUse" | "PostToolUse",
  matcher: string,
  targetHookName: string,
  payload: unknown,
): Promise<ShimResult> {
  const matcherB64 = btoa(matcher);
  const targetHookPath = `${HOOKS_DIR}${targetHookName}`;
  const cmd = new Deno.Command("bash", {
    args: [SHIM_PATH, event, matcherB64, targetHookPath],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  const stdoutText = new TextDecoder().decode(stdout);
  const stderrText = new TextDecoder().decode(stderr);
  let decision = "";
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(stdoutText.trim());
    decision = parsed.decision;
    reason = parsed.reason;
  } catch {
    // left empty; assertion messages below include raw stdout for debugging
  }
  return { code, decision, reason, stdout: stdoutText, stderr: stderrText };
}

function agyRunCommand(command: string, extra: Record<string, unknown> = {}) {
  return {
    toolCall: { name: "run_command", args: { CommandLine: command, Cwd: "/home/joshua" } },
    conversationId: "conv-1",
    stepIdx: 1,
    modelName: "gemini-3.7-flash-high",
    artifactDirectoryPath: "/tmp/artifacts",
    workspacePaths: ["/home/joshua/WebJamApps/web-jam-tools"],
    ...extra,
  };
}

// --- Unit tests: hooks/lib/agy_hook_shim.ts pure functions ---

Deno.test("mapAgyToolName: run_command -> Bash (verified, finding 3); unknown names pass through", () => {
  assertEquals(mapAgyToolName("run_command"), "Bash");
  assertEquals(mapAgyToolName("send_email"), "send_email");
  assertEquals(mapAgyToolName(""), "");
});

Deno.test("matcherMatches: alternation, regex, and non-match", () => {
  assert(matcherMatches("Bash", "Bash"));
  assert(matcherMatches("Bash|Edit|Write", "Edit"));
  assert(matcherMatches("mcp__.*__issue_write", "mcp__gmail__issue_write"));
  assert(!matcherMatches("Bash", "Write"));
  assert(!matcherMatches("Edit|Write", "Bash"));
});

Deno.test("matcherMatches: an unparseable matcher never matches (fails closed on enforcement)", () => {
  assert(!matcherMatches("(unbalanced", "Bash"));
});

Deno.test("buildToolInput: CommandLine/Cwd -> command/cwd, originals preserved", () => {
  const out = buildToolInput({ CommandLine: "ls -la", Cwd: "/tmp" });
  assertEquals(out.command, "ls -la");
  assertEquals(out.cwd, "/tmp");
  assertEquals(out.CommandLine, "ls -la");
});

Deno.test("buildToolInput: TargetFile/CodeContent -> file_path/content", () => {
  const out = buildToolInput({ TargetFile: ".env", CodeContent: "SECRET=x" });
  assertEquals(out.file_path, ".env");
  assertEquals(out.content, "SECRET=x");
});

Deno.test("buildToolInput: ReplacementContent used when CodeContent absent", () => {
  const out = buildToolInput({ ReplacementContent: "replacement text" });
  assertEquals(out.content, "replacement text");
});

Deno.test("buildToolInput: already-Claude-named fields are never overwritten", () => {
  const out = buildToolInput({ command: "echo hi", CommandLine: "echo bye" });
  assertEquals(out.command, "echo hi");
});

Deno.test("recoverPostToolOutput: extracts the matching stepIdx entry's output field", () => {
  const transcript = [
    JSON.stringify({ stepIdx: 1, output: "unrelated earlier step" }),
    JSON.stringify({ stepIdx: 2, output: "the real output text" }),
    "not json, ignored",
  ].join("\n");
  assertEquals(recoverPostToolOutput(transcript, 2), "the real output text");
});

Deno.test("recoverPostToolOutput: falls back to the whole transcript text when nothing structured matches", () => {
  const transcript = "just some plain text, no JSON lines at all";
  assertEquals(recoverPostToolOutput(transcript, 5), transcript);
});

Deno.test("normalize: PreToolUse builds tool_name/tool_input/transcript_path, no tool_response", () => {
  const { toolName, normalized } = normalize(
    {
      toolCall: { name: "run_command", args: { CommandLine: "ls" } },
      transcriptPath: "/tmp/t.jsonl",
      modelName: "gemini-3.7-flash-high",
    },
    "PreToolUse",
  );
  assertEquals(toolName, "Bash");
  assertEquals(normalized.tool_name, "Bash");
  assertEquals(normalized.tool_input.command, "ls");
  assertEquals(normalized.transcript_path, "/tmp/t.jsonl");
  assertEquals(normalized.modelName, "gemini-3.7-flash-high");
  assertEquals(normalized.tool_response, undefined);
});

Deno.test("normalize: PostToolUse attaches tool_response.stdout from the recovered transcript text", () => {
  const { normalized } = normalize(
    { toolCall: { name: "run_command", args: {} }, stepIdx: 9 },
    "PostToolUse",
    JSON.stringify({ stepIdx: 9, output: "captured output" }),
  );
  assertEquals(normalized.tool_response?.stdout, "captured output");
});

Deno.test("translateVerdict: exit 0, no output -> allow", () => {
  assertEquals(translateVerdict(0, "", ""), { decision: "allow" });
});

Deno.test("translateVerdict: exit 0 with hookSpecificOutput deny JSON -> deny with reason", () => {
  const stdout = JSON.stringify({
    hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "nope" },
  });
  assertEquals(translateVerdict(0, stdout, ""), { decision: "deny", reason: "nope" });
});

Deno.test("translateVerdict: exit 0 with hookSpecificOutput ask JSON -> ask", () => {
  const stdout = JSON.stringify({
    hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "confirm?" },
  });
  assertEquals(translateVerdict(0, stdout, ""), { decision: "ask", reason: "confirm?" });
});

Deno.test("translateVerdict: exit 2 -> deny with stderr as reason", () => {
  assertEquals(translateVerdict(2, "", "BLOCKED: bad thing\n"), {
    decision: "deny",
    reason: "BLOCKED: bad thing",
  });
});

Deno.test("translateVerdict: unexpected nonzero exit fails CLOSED (deny)", () => {
  const v = translateVerdict(1, "", "");
  assertEquals(v.decision, "deny");
});

// --- End-to-end: real agy payload shape, through the shim, wrapping the
// UNMODIFIED underlying hooks (none of the twelve hooks under hooks/ are
// edited to achieve this) ---

Deno.test("a hook that decides to block actually blocks on Antigravity (block-secret-dumps.sh)", async () => {
  const res = await runShim(
    "PreToolUse",
    "Bash",
    "block-secret-dumps.sh",
    agyRunCommand("rclone config show gdrive"),
  );
  assertEquals(res.code, 0, res.stderr);
  assertEquals(res.decision, "deny", res.stdout);
  assert(res.reason && res.reason.length > 0, "expected a non-empty reason");
});

Deno.test("block-dangerous-git-deploy.sh denies a protected-branch push on an agy payload", async () => {
  const res = await runShim(
    "PreToolUse",
    "Bash",
    "block-dangerous-git-deploy.sh",
    agyRunCommand("git push origin main"),
  );
  assertEquals(res.decision, "deny", res.stdout);
});

Deno.test("block-irreversible-operations.sh denies an irreversible operation on an agy payload", async () => {
  const res = await runShim(
    "PreToolUse",
    "Bash",
    "block-irreversible-operations.sh",
    agyRunCommand("gh repo delete owner/repo"),
  );
  assertEquals(res.decision, "deny", res.stdout);
});

Deno.test("block-human-only-credentials.sh denies a human-only credential export on an agy payload", async () => {
  const res = await runShim(
    "PreToolUse",
    "Bash|Edit|Write",
    "block-human-only-credentials.sh",
    agyRunCommand("echo webjam.claude@gmail.com >> ~/.bashrc"),
  );
  assertEquals(res.decision, "deny", res.stdout);
});

Deno.test("a benign, unmatched command is allowed", async () => {
  const res = await runShim("PreToolUse", "Bash", "block-secret-dumps.sh", agyRunCommand("ls -la"));
  assertEquals(res.decision, "allow", res.stdout);
});

// --- Matcher semantics hold on agy (agy itself ignores the field) ---

Deno.test("matcher semantics: a hook registered for Edit|Write does not fire on a mapped Bash call", async () => {
  const res = await runShim(
    "PreToolUse",
    "Edit|Write",
    "block-secret-dumps.sh",
    agyRunCommand("rclone config show gdrive"),
  );
  assertEquals(res.decision, "allow", res.stdout);
});

Deno.test("matcher semantics: an unmapped/unknown agy tool name doesn't match a Bash-only matcher", async () => {
  const res = await runShim("PreToolUse", "Bash", "block-secret-dumps.sh", {
    toolCall: { name: "some_other_tool", args: { CommandLine: "rclone config show gdrive" } },
  });
  assertEquals(res.decision, "allow", res.stdout);
});

// --- PostToolUse: scan-output-for-secrets.sh recovers output from transcriptPath ---

Deno.test("scan-output-for-secrets.sh detects a canary credential recovered from transcriptPath", async () => {
  const fakeGoogleKey = "AIza" + "B".repeat(35);
  const transcriptPath = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    await Deno.writeTextFile(
      transcriptPath,
      JSON.stringify({ stepIdx: 4, output: `some output containing "${fakeGoogleKey}"` }) + "\n",
    );
    const res = await runShim("PostToolUse", "Bash", "scan-output-for-secrets.sh", {
      toolCall: { name: "run_command", args: { CommandLine: "cat somefile" } },
      transcriptPath,
      stepIdx: 4,
    });
    assertEquals(res.decision, "deny", res.stdout);
  } finally {
    await Deno.remove(transcriptPath);
  }
});

Deno.test("scan-output-for-secrets.sh allows output with no credential shape", async () => {
  const transcriptPath = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    await Deno.writeTextFile(
      transcriptPath,
      JSON.stringify({ stepIdx: 1, output: "totally ordinary output" }) + "\n",
    );
    const res = await runShim("PostToolUse", "Bash", "scan-output-for-secrets.sh", {
      toolCall: { name: "run_command", args: { CommandLine: "cat somefile" } },
      transcriptPath,
      stepIdx: 1,
    });
    assertEquals(res.decision, "allow", res.stdout);
  } finally {
    await Deno.remove(transcriptPath);
  }
});

// --- Malformed input fails safe ---

Deno.test("unparseable stdin JSON is allowed (nothing to match or normalize)", async () => {
  const matcherB64 = btoa("Bash");
  const cmd = new Deno.Command("bash", {
    args: [SHIM_PATH, "PreToolUse", matcherB64, `${HOOKS_DIR}block-secret-dumps.sh`],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("not json at all"));
  await writer.close();
  const { code, stdout } = await child.output();
  assertEquals(code, 0);
  assertEquals(JSON.parse(new TextDecoder().decode(stdout).trim()), { decision: "allow" });
});
