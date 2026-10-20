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
  DEFAULT_RECORD_PATH,
  getRecordPath,
  mapAgyToolName,
  matcherMatches,
  MAX_RECORD_BYTES,
  normalize,
  recordInvocation,
  recoverPostToolOutput,
  redactSensitiveText,
  resolveCwd,
  RETAINED_RECORD_BYTES,
  runShim as runShimPure,
  toAgyReply,
  translateVerdict,
} from "../hooks/lib/agy_hook_shim.ts";
import { variedFakeBody } from "./support/varied_fake_value.ts";

const SHIM_PATH = new URL("../hooks/agy-hook-shim.sh", import.meta.url).pathname;
const HOOKS_DIR = new URL("../hooks/", import.meta.url).pathname;

interface ShimResult {
  code: number;
  decision: string;
  reason?: string;
  overwriteResult?: string;
  hasDecisionField: boolean;
  parsedKeys: string[];
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
    env: {
      ...Deno.env.toObject(),
      AGY_HOOK_RECORD_PATH: "off",
    },
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
  let overwriteResult: string | undefined;
  let hasDecisionField = false;
  let parsedKeys: string[] = [];
  try {
    const parsed = JSON.parse(stdoutText.trim());
    parsedKeys = Object.keys(parsed);
    hasDecisionField = Object.prototype.hasOwnProperty.call(parsed, "decision");
    decision = parsed.decision;
    reason = parsed.reason;
    overwriteResult = parsed.overwrite_result;
  } catch {
    // left empty; assertion messages below include raw stdout for debugging
  }
  return {
    code,
    decision,
    reason,
    overwriteResult,
    hasDecisionField,
    parsedKeys,
    stdout: stdoutText,
    stderr: stderrText,
  };
}

function agyRunCommand(command: string, extra: Record<string, unknown> = {}) {
  return {
    toolCall: { name: "run_command", args: { CommandLine: command, Cwd: "/home/joshua" } },
    conversationId: "conv-1",
    stepIdx: 1,
    modelName: "gemini-3.8-flash-high",
    artifactDirectoryPath: "/tmp/artifacts",
    workspacePaths: ["/home/joshua/WebJamApps/web-jam-tools"],
    ...extra,
  };
}

function agyReplaceFileContent(
  targetFile: string,
  targetContent = "old text",
  replacementContent = "new text",
  extra: Record<string, unknown> = {},
) {
  return {
    toolCall: {
      name: "replace_file_content",
      args: {
        TargetFile: targetFile,
        Instruction: "edit",
        TargetContent: targetContent,
        ReplacementContent: replacementContent,
        StartLine: 1,
        EndLine: 5,
        AllowMultiple: false,
        toolAction: "edit",
        toolSummary: "File edit",
      },
    },
    conversationId: "conv-1",
    stepIdx: 1,
    modelName: "gemini-3.8-flash-high",
    artifactDirectoryPath: "/tmp/artifacts",
    workspacePaths: ["/home/joshua/WebJamApps/web-jam-tools"],
    ...extra,
  };
}

function agyWriteToFile(
  targetFile: string,
  codeContent = "file content",
  overwrite = true,
  extra: Record<string, unknown> = {},
) {
  return {
    toolCall: {
      name: "write_to_file",
      args: {
        TargetFile: targetFile,
        CodeContent: codeContent,
        Overwrite: overwrite,
        Description: "create file",
        toolAction: "write",
        toolSummary: "File write",
      },
    },
    conversationId: "conv-1",
    stepIdx: 1,
    modelName: "gemini-3.8-flash-high",
    artifactDirectoryPath: "/tmp/artifacts",
    workspacePaths: ["/home/joshua/WebJamApps/web-jam-tools"],
    ...extra,
  };
}

function agyCallMcpTool(
  serverName: string,
  toolName: string,
  argumentsObj: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    toolCall: {
      name: "call_mcp_tool",
      args: {
        ServerName: serverName,
        ToolName: toolName,
        Arguments: argumentsObj,
        toolAction: "mcp",
        toolSummary: "MCP tool call",
      },
    },
    conversationId: "conv-1",
    stepIdx: 1,
    modelName: "gemini-3.8-flash-high",
    artifactDirectoryPath: "/tmp/artifacts",
    workspacePaths: ["/home/joshua/WebJamApps/web-jam-tools"],
    ...extra,
  };
}

// --- Unit tests: hooks/lib/agy_hook_shim.ts pure functions ---

Deno.test("mapAgyToolName: maps agy shell, file-edit, and GitHub MCP tools; unknown names pass through", () => {
  assertEquals(mapAgyToolName("run_command"), "Bash");
  assertEquals(mapAgyToolName("replace_file_content"), "Edit");
  assertEquals(mapAgyToolName("multi_replace_file_content"), "Edit");
  assertEquals(mapAgyToolName("write_to_file"), "Write");
  assertEquals(mapAgyToolName("issue_write"), "mcp__github__issue_write");
  assertEquals(mapAgyToolName("sub_issue_write"), "mcp__github__sub_issue_write");
  assertEquals(mapAgyToolName("mcp_github_issue_write"), "mcp__github__issue_write");
  assertEquals(mapAgyToolName("mcp_github_sub_issue_write"), "mcp__github__sub_issue_write");
  assertEquals(
    mapAgyToolName("call_mcp_tool", { ServerName: "github", ToolName: "issue_write" }),
    "mcp__github__issue_write",
  );
  assertEquals(
    mapAgyToolName("call_mcp_tool", { ServerName: "github", ToolName: "sub_issue_write" }),
    "mcp__github__sub_issue_write",
  );
  assertEquals(
    mapAgyToolName("call_mcp_tool", { ServerName: "github", ToolName: "mcp_github_issue_write" }),
    "mcp__github__issue_write",
  );
  assertEquals(
    mapAgyToolName("call_mcp_tool", { ServerName: "github", ToolName: "issue_read" }),
    "call_mcp_tool",
  );
  assertEquals(mapAgyToolName("call_mcp_tool"), "call_mcp_tool");
  assertEquals(mapAgyToolName("send_email"), "send_email");
  assertEquals(mapAgyToolName("unknown_tool"), "unknown_tool");
  assertEquals(mapAgyToolName(""), "");
});

Deno.test("matcherMatches: alternation, regex, and non-match", () => {
  assert(matcherMatches("Bash", "Bash"));
  assert(matcherMatches("Bash|Edit|Write", "Edit"));
  assert(matcherMatches("Bash|Edit|Write", "Write"));
  assert(matcherMatches("mcp__.*__issue_write", "mcp__github__issue_write"));
  assert(matcherMatches("mcp__.*__(issue_write|sub_issue_write)", "mcp__github__sub_issue_write"));
  assert(!matcherMatches("Bash", "Write"));
  assert(!matcherMatches("Edit|Write", "Bash"));
  assert(!matcherMatches("mcp__.*__issue_write", "call_mcp_tool"));
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

Deno.test("buildToolInput: TargetContent/ReplacementContent -> old_string/new_string and content", () => {
  const out = buildToolInput({
    TargetFile: "foo.ts",
    TargetContent: "old code",
    ReplacementContent: "new code",
  });
  assertEquals(out.file_path, "foo.ts");
  assertEquals(out.old_string, "old code");
  assertEquals(out.new_string, "new code");
  assertEquals(out.content, "new code");
});

Deno.test("buildToolInput: unpacks Arguments object or JSON string from call_mcp_tool", () => {
  const outObj = buildToolInput({
    ServerName: "github",
    ToolName: "issue_write",
    Arguments: {
      method: "create",
      title: "Test Issue",
      owner: "WebJamApps",
      repo: "web-jam-tools",
    },
  });
  assertEquals(outObj.method, "create");
  assertEquals(outObj.title, "Test Issue");
  assertEquals(outObj.owner, "WebJamApps");
  assertEquals(outObj.repo, "web-jam-tools");
  assertEquals(outObj.ServerName, "github");

  const outStr = buildToolInput({
    ServerName: "github",
    ToolName: "issue_write",
    Arguments: JSON.stringify({ method: "create", title: "From String" }),
  });
  assertEquals(outStr.method, "create");
  assertEquals(outStr.title, "From String");
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
      modelName: "gemini-3.8-flash-high",
    },
    "PreToolUse",
  );
  assertEquals(toolName, "Bash");
  assertEquals(normalized.tool_name, "Bash");
  assertEquals(normalized.tool_input.command, "ls");
  assertEquals(normalized.transcript_path, "/tmp/t.jsonl");
  assertEquals(normalized.modelName, "gemini-3.8-flash-high");
  assertEquals(normalized.tool_response, undefined);
});

Deno.test("normalize: translates agy file-edit and MCP payloads into Claude-shaped tool_name and tool_input", () => {
  const editPayload = normalize(
    {
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: "src/main.ts", TargetContent: "a", ReplacementContent: "b" },
      },
    },
    "PreToolUse",
  );
  assertEquals(editPayload.toolName, "Edit");
  assertEquals(editPayload.normalized.tool_name, "Edit");
  assertEquals(editPayload.normalized.tool_input.file_path, "src/main.ts");
  assertEquals(editPayload.normalized.tool_input.old_string, "a");
  assertEquals(editPayload.normalized.tool_input.new_string, "b");

  const writePayload = normalize(
    {
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: "new.ts", CodeContent: "console.log('hi');" },
      },
    },
    "PreToolUse",
  );
  assertEquals(writePayload.toolName, "Write");
  assertEquals(writePayload.normalized.tool_name, "Write");
  assertEquals(writePayload.normalized.tool_input.file_path, "new.ts");
  assertEquals(writePayload.normalized.tool_input.content, "console.log('hi');");

  const mcpPayload = normalize(
    {
      toolCall: {
        name: "call_mcp_tool",
        args: {
          ServerName: "github",
          ToolName: "issue_write",
          Arguments: { method: "create", title: "New Bug", labels: ["Bug", "Sol"] },
        },
      },
    },
    "PreToolUse",
  );
  assertEquals(mcpPayload.toolName, "mcp__github__issue_write");
  assertEquals(mcpPayload.normalized.tool_name, "mcp__github__issue_write");
  assertEquals(mcpPayload.normalized.tool_input.method, "create");
  assertEquals(mcpPayload.normalized.tool_input.title, "New Bug");
});

Deno.test("normalize: PostToolUse attaches tool_response.stdout from the recovered transcript text", () => {
  const { normalized } = normalize(
    { toolCall: { name: "run_command", args: {} }, stepIdx: 9 },
    "PostToolUse",
    JSON.stringify({ stepIdx: 9, output: "captured output" }),
  );
  assertEquals(normalized.tool_response?.stdout, "captured output");
});

Deno.test("resolveCwd: selects explicit payload.cwd, toolInput.cwd, or args.Cwd", () => {
  assertEquals(
    resolveCwd({ cwd: "/workspace/explicit" }, {}),
    "/workspace/explicit",
  );
  assertEquals(
    resolveCwd({}, { cwd: "/workspace/input" }),
    "/workspace/input",
  );
  assertEquals(
    resolveCwd({ toolCall: { name: "run_command", args: { Cwd: "/workspace/args" } } }, {}),
    "/workspace/args",
  );
});

Deno.test("resolveCwd: single workspace path is resolved authoritative cwd", () => {
  assertEquals(
    resolveCwd({ workspacePaths: ["/workspace/single"] }, {}),
    "/workspace/single",
  );
});

Deno.test("resolveCwd: multiple workspace paths match targetFile or fall back to primary", () => {
  const ws = ["/workspace/repo-a", "/workspace/repo-b", "/workspace/repo-b/nested"];
  // Matches repo-b
  assertEquals(
    resolveCwd(
      { workspacePaths: ws },
      { file_path: "/workspace/repo-b/src/file.ts" },
    ),
    "/workspace/repo-b",
  );
  // Matches nested (longest match)
  assertEquals(
    resolveCwd(
      { workspacePaths: ws },
      { file_path: "/workspace/repo-b/nested/src/file.ts" },
    ),
    "/workspace/repo-b/nested",
  );
  // Unmatched target falls back to primary (first) root
  assertEquals(
    resolveCwd(
      { workspacePaths: ws },
      { file_path: "/outside/file.ts" },
    ),
    "/workspace/repo-a",
  );
});

Deno.test("resolveCwd: ignores non-absolute paths and returns undefined when absent", () => {
  assertEquals(
    resolveCwd({ workspacePaths: ["relative/path", "another/relative"] }, {}),
    undefined,
  );
  assertEquals(
    resolveCwd({}, {}),
    undefined,
  );
});

Deno.test("normalize: populates top-level cwd and backfills tool_input.cwd", () => {
  const { normalized } = normalize(
    {
      toolCall: { name: "write_to_file", args: { TargetFile: "/workspace/repo/new.txt" } },
      workspacePaths: ["/workspace/repo"],
    },
    "PreToolUse",
  );
  assertEquals(normalized.cwd, "/workspace/repo");
  assertEquals(normalized.tool_input.cwd, "/workspace/repo");
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

// --- toAgyReply: agy's actual per-event reply contract (web-jam-tools#1038) ---
// PostToolHookResult has no `decision` field on agy's own proto (decoded
// from the shipped binary — only PreToolHookResult/StopHookResult carry
// one), so a PostToolUse reply must never contain "decision" at all.

Deno.test("toAgyReply: PreToolUse passes the verdict through unchanged (allow)", () => {
  const verdict = { decision: "allow" as const };
  assertEquals(toAgyReply("PreToolUse", verdict), verdict);
});

Deno.test("toAgyReply: PreToolUse passes the verdict through unchanged (deny + reason)", () => {
  const verdict = { decision: "deny" as const, reason: "nope" };
  assertEquals(toAgyReply("PreToolUse", verdict), verdict);
});

Deno.test("toAgyReply: PostToolUse allow becomes the empty object, no decision field", () => {
  const reply = toAgyReply("PostToolUse", { decision: "allow" });
  assertEquals(reply, {});
  assert(!Object.prototype.hasOwnProperty.call(reply, "decision"));
});

Deno.test("toAgyReply: PostToolUse deny becomes overwrite_result, no decision field", () => {
  const reply = toAgyReply("PostToolUse", { decision: "deny", reason: "credential detected" }) as {
    overwrite_result?: string;
  };
  assert(!Object.prototype.hasOwnProperty.call(reply, "decision"));
  assert(reply.overwrite_result !== undefined);
  assert(reply.overwrite_result!.includes("credential detected"));
});

Deno.test("toAgyReply: PostToolUse ask also becomes overwrite_result (no post-hoc ask on agy)", () => {
  const reply = toAgyReply("PostToolUse", { decision: "ask", reason: "confirm?" }) as {
    overwrite_result?: string;
  };
  assert(!Object.prototype.hasOwnProperty.call(reply, "decision"));
  assert(reply.overwrite_result !== undefined);
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

// web-jam-tools#716: the same false-positive fix must be exercised through
// the agy shim, not just Claude Code's own hook wrapper — no separate
// agy-only matching logic exists, so a quoted mention must NOT deny here
// either.
Deno.test(
  "web-jam-tools#716: block-irreversible-operations.sh allows a quoted mention of 'gh repo delete' on an agy payload",
  async () => {
    const res = await runShim(
      "PreToolUse",
      "Bash",
      "block-irreversible-operations.sh",
      agyRunCommand(`gh issue list --repo owner/repo --search "gh repo delete false positive"`),
    );
    assertEquals(res.decision, "allow", res.stdout);
  },
);

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

async function withRepoOnBranch(
  branch: string,
  fn: (repoDir: string, filePath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "shim-git-test-" });
  try {
    const run = async (cmd: string, args: string[]) => {
      const command = new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" });
      const { code, stderr } = await command.output();
      assertEquals(code, 0, new TextDecoder().decode(stderr));
    };
    await run("git", ["-C", dir, "init", "-q", "-b", branch]);
    await run("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
    await run("git", ["-C", dir, "config", "user.name", "Test"]);
    const filePath = `${dir}/some-file.ts`;
    await Deno.writeTextFile(filePath, "// placeholder\n");
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    await fn(dir, filePath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// --- Row 10 Replay: agy file-edit tools reach Edit|Write-registered guards (web-jam-tools#1057) ---

Deno.test("replaying replace_file_content on protected branch denies under feature-branch-guard.sh", async () => {
  await withRepoOnBranch("dev", async (_dir, filePath) => {
    const res = await runShim(
      "PreToolUse",
      "Edit|Write",
      "feature-branch-guard.sh",
      agyReplaceFileContent(filePath),
    );
    assertEquals(res.code, 0);
    assertEquals(res.decision, "deny", res.stdout);
    assert(
      res.reason?.includes("protected branch 'dev'"),
      `expected protected branch reason, got: ${res.reason}`,
    );
  });
});

Deno.test("replaying write_to_file on protected branch denies under feature-branch-guard.sh", async () => {
  await withRepoOnBranch("dev", async (_dir, filePath) => {
    const newFile = `${filePath}.new.txt`;
    const res = await runShim(
      "PreToolUse",
      "Edit|Write",
      "feature-branch-guard.sh",
      agyWriteToFile(newFile),
    );
    assertEquals(res.code, 0);
    assertEquals(res.decision, "deny", res.stdout);
    assert(
      res.reason?.includes("protected branch 'dev'"),
      `expected protected branch reason, got: ${res.reason}`,
    );
  });
});

Deno.test("replaying replace_file_content targeting path outside workspace denies under block-out-of-tree-write.sh", async () => {
  await withRepoOnBranch("feature/test", async (dir) => {
    // Target is an out-of-workspace path outside /tmp (e.g. /home/joshua/outside-workspace.ts)
    // while workspacePaths points to the test git repo.
    const outOfWorkspaceTarget = "/home/joshua/outside-workspace.ts";
    const res = await runShim(
      "PreToolUse",
      "Edit|Write|NotebookEdit",
      "block-out-of-tree-write.sh",
      agyReplaceFileContent(outOfWorkspaceTarget, "old text", "new text", {
        workspacePaths: [dir],
      }),
    );
    assertEquals(res.code, 0);
    assertEquals(res.decision, "deny", res.stdout);
    assert(
      res.reason?.includes("out-of-tree write guard"),
      `expected out-of-tree write guard reason, got: ${res.reason}`,
    );
  });
});

Deno.test("replaying replace_file_content outside git repo allows under feature-branch-guard.sh", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "non-git-" });
  try {
    const nonRepoFile = `${tmpDir}/non-git-scratch.txt`;
    await Deno.writeTextFile(nonRepoFile, "hello\n");
    const res = await runShim(
      "PreToolUse",
      "Edit|Write",
      "feature-branch-guard.sh",
      agyReplaceFileContent(nonRepoFile),
    );
    assertEquals(res.code, 0);
    assertEquals(res.decision, "allow", res.stdout);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- Row 10 Replay: agy GitHub MCP issue-write / sub_issue_write reach guards (web-jam-tools#1057) ---

Deno.test("replaying call_mcp_tool issue_write lacking model label denies under require-model-label-on-issue-create.sh", async () => {
  const res = await runShim(
    "PreToolUse",
    "Bash|mcp__.*__issue_write",
    "require-model-label-on-issue-create.sh",
    agyCallMcpTool("github", "issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      type: "Task",
      title: "Task with no model label",
      labels: [],
      body: "## What this builds\nTask",
    }),
  );
  assertEquals(res.code, 0);
  assertEquals(res.decision, "deny", res.stdout);
  assert(
    res.reason?.includes("model-label guard") || res.reason?.includes("model label"),
    `expected model-label deny reason, got: ${res.reason}`,
  );
});

Deno.test("replaying direct issue_write lacking model label denies under require-model-label-on-issue-create.sh", async () => {
  const res = await runShim(
    "PreToolUse",
    "Bash|mcp__.*__issue_write",
    "require-model-label-on-issue-create.sh",
    {
      toolCall: {
        name: "issue_write",
        args: {
          method: "create",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          type: "Task",
          title: "Direct write no model label",
          labels: [],
          body: "## What this builds\nTask",
        },
      },
    },
  );
  assertEquals(res.code, 0);
  assertEquals(res.decision, "deny", res.stdout);
  assert(
    res.reason?.includes("model-label guard") || res.reason?.includes("model label"),
    `expected model-label deny reason, got: ${res.reason}`,
  );
});

Deno.test("replaying call_mcp_tool issue_write lacking approval token denies under require-approval-token-on-issue-write.sh", async () => {
  const res = await runShim(
    "PreToolUse",
    "Bash|mcp__.*__(issue_write|sub_issue_write)",
    "require-approval-token-on-issue-write.sh",
    agyCallMcpTool("github", "issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "Unapproved issue title",
      type: "Task",
      labels: ["Flash"],
    }),
  );
  assertEquals(res.code, 0);
  assertEquals(res.decision, "deny", res.stdout);
  assert(
    res.reason?.includes("plan") || res.reason?.includes("approval") ||
      res.reason?.includes("token"),
    `expected approval-token deny reason, got: ${res.reason}`,
  );
});

Deno.test("replaying direct issue_write lacking approval token denies under require-approval-token-on-issue-write.sh", async () => {
  const res = await runShim(
    "PreToolUse",
    "Bash|mcp__.*__(issue_write|sub_issue_write)",
    "require-approval-token-on-issue-write.sh",
    {
      toolCall: {
        name: "issue_write",
        args: {
          method: "create",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          title: "Direct unapproved title",
          type: "Task",
          labels: ["Flash"],
        },
      },
    },
  );
  assertEquals(res.code, 0);
  assertEquals(res.decision, "deny", res.stdout);
});

Deno.test("replaying call_mcp_tool sub_issue_write lacking approval token denies under require-approval-token-on-issue-write.sh", async () => {
  const res = await runShim(
    "PreToolUse",
    "Bash|mcp__.*__(issue_write|sub_issue_write)",
    "require-approval-token-on-issue-write.sh",
    agyCallMcpTool("github", "sub_issue_write", {
      method: "add",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      issue_number: 1055,
      sub_issue_id: 1057,
    }),
  );
  assertEquals(res.code, 0);
  assertEquals(res.decision, "deny", res.stdout);
});

Deno.test("replaying direct sub_issue_write lacking approval token denies under require-approval-token-on-issue-write.sh", async () => {
  const res = await runShim(
    "PreToolUse",
    "Bash|mcp__.*__(issue_write|sub_issue_write)",
    "require-approval-token-on-issue-write.sh",
    {
      toolCall: {
        name: "sub_issue_write",
        args: {
          method: "add",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          issue_number: 1055,
          sub_issue_id: 1057,
        },
      },
    },
  );
  assertEquals(res.code, 0);
  assertEquals(res.decision, "deny", res.stdout);
});

// --- Unmapped tools pass through and proceed ---

Deno.test("replaying call_mcp_tool issue_read allows without firing write guards", async () => {
  const res = await runShim(
    "PreToolUse",
    "Bash|mcp__.*__issue_write",
    "require-model-label-on-issue-create.sh",
    agyCallMcpTool("github", "issue_read", {
      method: "get",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      issue_number: 1055,
    }),
  );
  assertEquals(res.code, 0);
  assertEquals(res.decision, "allow", res.stdout);
});

Deno.test("unmapped agy tool name allows under Edit|Write matcher", async () => {
  const res = await runShim(
    "PreToolUse",
    "Edit|Write",
    "feature-branch-guard.sh",
    {
      toolCall: {
        name: "custom_unmapped_action",
        args: { TargetFile: "/home/joshua/WebJamApps/web-jam-tools/CLAUDE.md" },
      },
    },
  );
  assertEquals(res.code, 0);
  assertEquals(res.decision, "allow", res.stdout);
});

// --- PostToolUse: scan-output-for-secrets.sh recovers output from transcriptPath ---

Deno.test("scan-output-for-secrets.sh detects a canary credential recovered from transcriptPath", async () => {
  // Varied, not repeated — the credential detector's synthetic-value
  // heuristic would otherwise auto-suppress an 8+ run of the same character.
  const fakeGoogleKey = "AIza" + variedFakeBody(35, 50);
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
    // PostToolUse never carries a `decision` field (web-jam-tools#1038) —
    // agy's PostToolHookResult proto has no such field; only
    // `overwrite_result` exists. A detected credential is translated into
    // overwrite_result so the model never sees the raw output.
    assert(!res.hasDecisionField, `unexpected "decision" field in ${res.stdout}`);
    assert(res.overwriteResult !== undefined, res.stdout);
    assertEquals(res.parsedKeys, ["overwrite_result"], res.stdout);
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
    // PostToolUse allow is the empty object — no `decision` field at all
    // (web-jam-tools#1038; printing `{"decision":"allow"}` here is exactly
    // what made agy replace every allowed tool's real output with an
    // unmarshal error).
    assert(!res.hasDecisionField, `unexpected "decision" field in ${res.stdout}`);
    assertEquals(res.stdout.trim(), "{}", res.stdout);
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
    env: {
      ...Deno.env.toObject(),
      AGY_HOOK_RECORD_PATH: "off",
    },
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("not json at all"));
  await writer.close();
  const { code, stdout } = await child.output();
  assertEquals(code, 0);
  assertEquals(JSON.parse(new TextDecoder().decode(stdout).trim()), { decision: "allow" });
});

// --- Invocation recording (web-jam-tools#816) ---

Deno.test("DEFAULT_RECORD_PATH and getRecordPath: default path, AGY_HOOK_RECORD_PATH override, and disable values", () => {
  assertEquals(DEFAULT_RECORD_PATH, "/tmp/agy-hook-invocations.jsonl");

  const original = Deno.env.get("AGY_HOOK_RECORD_PATH");
  try {
    Deno.env.delete("AGY_HOOK_RECORD_PATH");
    assertEquals(getRecordPath(), "/tmp/agy-hook-invocations.jsonl");

    Deno.env.set("AGY_HOOK_RECORD_PATH", "/tmp/custom-record-path.jsonl");
    assertEquals(getRecordPath(), "/tmp/custom-record-path.jsonl");

    for (const offVal of ["off", "false", "0", "none", ""]) {
      Deno.env.set("AGY_HOOK_RECORD_PATH", offVal);
      assertEquals(getRecordPath(), undefined);
    }
  } finally {
    if (original !== undefined) {
      Deno.env.set("AGY_HOOK_RECORD_PATH", original);
    } else {
      Deno.env.delete("AGY_HOOK_RECORD_PATH");
    }
  }
});

Deno.test("redactSensitiveText and recordInvocation: redacts live credential literals", async () => {
  const secretKey = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const lineWithSecret = `run_command export GITHUB_TOKEN=${secretKey}`;
  const redacted = redactSensitiveText(lineWithSecret);
  assert(!redacted.includes(secretKey));
  assert(redacted.includes("[REDACTED_CREDENTIAL]"));

  const tempPath = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    await recordInvocation({ command: lineWithSecret }, tempPath);
    const content = await Deno.readTextFile(tempPath);
    assert(!content.includes(secretKey));
    assert(content.includes("[REDACTED_CREDENTIAL]"));
  } finally {
    await Deno.remove(tempPath);
  }
});

Deno.test("recordInvocation: skips writing when disabled via AGY_HOOK_RECORD_PATH=off", async () => {
  const original = Deno.env.get("AGY_HOOK_RECORD_PATH");
  try {
    Deno.env.set("AGY_HOOK_RECORD_PATH", "off");
    // When disabled, recordInvocation with default path is a no-op and does not write
    await recordInvocation({ event: "PreToolUse" });
    assertEquals(getRecordPath(), undefined);
  } finally {
    if (original !== undefined) {
      Deno.env.set("AGY_HOOK_RECORD_PATH", original);
    } else {
      Deno.env.delete("AGY_HOOK_RECORD_PATH");
    }
  }
});

Deno.test("recordInvocation: bounds file size by rotating older entries on overflow", async () => {
  const tempPath = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    // Write data exceeding MAX_RECORD_BYTES
    const largeLine = "A".repeat(1024) + "\n";
    const repeatCount = Math.floor(MAX_RECORD_BYTES / 1024) + 10;
    await Deno.writeTextFile(tempPath, largeLine.repeat(repeatCount));

    const preStat = await Deno.stat(tempPath);
    assert(preStat.size > MAX_RECORD_BYTES);

    // Recording next line should trigger rotation
    await recordInvocation({ event: "PreToolUse", step: 999 }, tempPath);

    const postStat = await Deno.stat(tempPath);
    assert(postStat.size <= RETAINED_RECORD_BYTES + 2048);

    const content = await Deno.readTextFile(tempPath);
    assert(content.includes('"step":999'));
  } finally {
    await Deno.remove(tempPath);
  }
});

Deno.test("recordInvocation: appends multiple JSON lines to recordPath", async () => {
  const tempPath = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    await recordInvocation({ event: "PreToolUse", step: 1 }, tempPath);
    await recordInvocation({ event: "PostToolUse", step: 2 }, tempPath);

    const content = await Deno.readTextFile(tempPath);
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(lines.length, 2);
    assertEquals(lines[0], { event: "PreToolUse", step: 1 });
    assertEquals(lines[1], { event: "PostToolUse", step: 2 });
  } finally {
    await Deno.remove(tempPath);
  }
});

Deno.test("recordInvocation: fails safe on unwritable path without throwing", async () => {
  // A path that cannot be written to (e.g. directory as file or non-existent nested dir with no permission)
  const invalidPath = "/proc/invalid-file-path-cannot-write-here.jsonl";
  // Must not throw
  await recordInvocation({ test: "data" }, invalidPath);
});

Deno.test("runShim: records full invocation field set to recordPath without changing verdicts", async () => {
  const tempPath = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    const rawInput = JSON.stringify({
      toolCall: { name: "run_command", args: { CommandLine: "ls", Cwd: "/tmp" } },
      transcriptPath: "/tmp/fake-transcript.jsonl",
      conversationId: "conv-xyz-123",
      stepIdx: 7,
      artifactDirectoryPath: "/tmp/artifacts-dir",
      workspacePaths: ["/home/joshua/WebJamApps/web-jam-tools"],
      modelName: "gemini-3.8-flash-high",
      error: null,
    });

    const verdict = await runShimPure(
      "PreToolUse",
      "Bash",
      `${HOOKS_DIR}block-secret-dumps.sh`,
      rawInput,
      tempPath,
    );
    assertEquals(verdict.decision, "allow");

    const content = await Deno.readTextFile(tempPath);
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(lines.length, 1);
    const record = lines[0];

    assertEquals(record.event, "PreToolUse");
    assertEquals(record.matcher, "Bash");
    assertEquals(record.targetHookPath, `${HOOKS_DIR}block-secret-dumps.sh`);
    assertEquals(record.conversationId, "conv-xyz-123");
    assertEquals(record.stepIdx, 7);
    assertEquals(record.artifactDirectoryPath, "/tmp/artifacts-dir");
    assertEquals(record.workspacePaths, ["/home/joshua/WebJamApps/web-jam-tools"]);
    assertEquals(record.modelName, "gemini-3.8-flash-high");
    assertEquals(record.error, null);
    assertEquals(record.toolCall, {
      name: "run_command",
      args: { CommandLine: "ls", Cwd: "/tmp" },
    });
    assertEquals(record.transcriptPath, "/tmp/fake-transcript.jsonl");
    assert(typeof record.timestamp === "string" && record.timestamp.length > 0);
  } finally {
    await Deno.remove(tempPath);
  }
});

Deno.test("runShim: synthetic subagent-shaped payload captures all fields and preserves verdicts", async () => {
  const tempPath = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    // Synthetic subagent invocation payload carrying subagent identifiers
    const subagentPayload = {
      toolCall: {
        name: "run_command",
        args: { CommandLine: "rclone config show gdrive", Cwd: "/tmp" },
      },
      transcriptPath: "/tmp/subagent-transcript.jsonl",
      conversationId: "subagent-conv-456",
      stepIdx: 3,
      artifactDirectoryPath: "/tmp/artifacts-subagent",
      workspacePaths: ["/home/joshua/WebJamApps/web-jam-tools"],
      modelName: "gemini-3.8-flash-high",
      subagentType: "research",
      parentConversationId: "main-conv-001",
      error: undefined,
    };

    const verdict = await runShimPure(
      "PreToolUse",
      "Bash",
      `${HOOKS_DIR}block-secret-dumps.sh`,
      JSON.stringify(subagentPayload),
      tempPath,
    );
    // Should still deny because command is dangerous
    assertEquals(verdict.decision, "deny");

    const content = await Deno.readTextFile(tempPath);
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(lines.length, 1);
    const record = lines[0];

    assertEquals(record.conversationId, "subagent-conv-456");
    assertEquals(record.parentConversationId, "main-conv-001");
    assertEquals(record.subagentType, "research");
    assertEquals(record.modelName, "gemini-3.8-flash-high");
    assertEquals(record.stepIdx, 3);
  } finally {
    await Deno.remove(tempPath);
  }
});

Deno.test("end-to-end: agy-hook-shim.sh records invocation payload to AGY_HOOK_RECORD_PATH", async () => {
  const tempPath = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    const payload = agyRunCommand("echo test-recording", {
      conversationId: "conv-e2e-record",
      stepIdx: 12,
    });
    const matcherB64 = btoa("Bash");
    const cmd = new Deno.Command("bash", {
      args: [SHIM_PATH, "PreToolUse", matcherB64, `${HOOKS_DIR}block-secret-dumps.sh`],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: {
        ...Deno.env.toObject(),
        AGY_HOOK_RECORD_PATH: tempPath,
      },
    });
    const child = cmd.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
    await writer.close();
    const { code, stdout } = await child.output();
    assertEquals(code, 0);
    const verdict = JSON.parse(new TextDecoder().decode(stdout).trim());
    assertEquals(verdict.decision, "allow");

    const content = await Deno.readTextFile(tempPath);
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(lines.length, 1);
    assertEquals(lines[0].conversationId, "conv-e2e-record");
    assertEquals(lines[0].stepIdx, 12);
  } finally {
    await Deno.remove(tempPath);
  }
});

Deno.test(
  "regression (web-jam-tools#830): runShim helper sets AGY_HOOK_RECORD_PATH=off so production path is untouched",
  async () => {
    const prodPath = DEFAULT_RECORD_PATH;
    let prodExistedBefore = false;
    let prodContentBefore = "";
    try {
      prodContentBefore = await Deno.readTextFile(prodPath);
      prodExistedBefore = true;
    } catch {
      prodExistedBefore = false;
    }

    const res = await runShim(
      "PreToolUse",
      "Bash",
      "block-secret-dumps.sh",
      agyRunCommand("echo regression-web-jam-tools-830"),
    );
    assertEquals(res.decision, "allow");

    if (prodExistedBefore) {
      const prodContentAfter = await Deno.readTextFile(prodPath);
      assertEquals(
        prodContentAfter,
        prodContentBefore,
        "production record file must not be modified by test runs",
      );
    } else {
      let prodExistsAfter = false;
      try {
        await Deno.stat(prodPath);
        prodExistsAfter = true;
      } catch {
        prodExistsAfter = false;
      }
      assertEquals(
        prodExistsAfter,
        false,
        "production record file must not be created by test runs",
      );
    }
  },
);
