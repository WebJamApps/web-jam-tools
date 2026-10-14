import { assertEquals, assertStringIncludes } from "@std/assert";
import { checkModelLabelOnIssueCreate } from "../hooks/lib/check_model_label_on_issue_create.ts";

const hooksDir = new URL("../hooks/", import.meta.url).pathname;

// Exercise the installed shell entry points, including failures before the
// TypeScript checker can emit a verdict. The fake runtime never runs a tool.
for (
  const [script, payload, field] of [
    ["haiku-only-gmail-gate.sh", { transcript_path: import.meta.filename }, "session model"],
    ["require-model-label-on-issue-create.sh", {
      tool_name: "Bash",
      tool_input: { command: "gh issue create --type Task --label Haiku" },
    }, "model-label"],
    ["block-out-of-tree-write.sh", {
      cwd: Deno.cwd(),
      tool_name: "Write",
      tool_input: { file_path: "/etc/probe.txt" },
    }, "repository root"],
    ["agy-model-guard.sh", { modelName: "gemini-3.8-flash-high" }, "modelName"],
  ] as const
) {
  Deno.test(`${script}: a runtime lookup failure allows with an agent note`, async () => {
    const runtimeDir = await Deno.makeTempDir();
    try {
      const runtime = `${runtimeDir}/deno`;
      await Deno.writeTextFile(runtime, "#!/bin/sh\nprintf '%s\\n' claude-opus-4-6\nexit 1\n");
      await Deno.chmod(runtime, 0o755);
      const child = new Deno.Command("bash", {
        args: [`${hooksDir}${script}`],
        env: {
          PATH: `${runtimeDir}:${Deno.env.get("PATH")}`,
          // CI's Bash startup file prepends the real Deno to PATH. Keep the
          // fake runtime first so these tests exercise checker startup failures.
          BASH_ENV: "",
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
      await writer.close();
      const result = await child.output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      const output = JSON.parse(new TextDecoder().decode(result.stdout)).hookSpecificOutput;
      assertEquals(output.hookEventName, "PreToolUse");
      assertEquals(output.permissionDecision, undefined);
      assertStringIncludes(output.additionalContext, field);
      assertStringIncludes(output.additionalContext, "proceeding");
    } finally {
      await Deno.remove(runtimeDir, { recursive: true });
    }
  });
}

Deno.test("model-label lookup throws: CLI and MCP allow with a note naming the registry", async () => {
  for (
    const payload of [
      { tool_name: "Bash", tool_input: { command: "gh issue create --type Task --label Haiku" } },
      {
        tool_name: "mcp__github__issue_write",
        tool_input: { method: "create", type: "Task", labels: ["Haiku"] },
      },
    ]
  ) {
    const result = await checkModelLabelOnIssueCreate(
      JSON.stringify(payload),
      "/missing-model-labels.json",
    );
    assertStringIncludes(result, "PASS: ");
    assertStringIncludes(result, "model-labels.json");
    assertStringIncludes(result, "Verify");
  }
});

Deno.test("unreadable agy session record allows with a modelName note", async () => {
  const child = new Deno.Command("bash", {
    args: [`${hooksDir}agy-model-guard.sh`],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("unreadable session record"));
  await writer.close();
  const result = await child.output();
  assertEquals(result.code, 0);
  const output = JSON.parse(new TextDecoder().decode(result.stdout)).hookSpecificOutput;
  assertEquals(output.permissionDecision, undefined);
  assertStringIncludes(output.additionalContext, "modelName");
});

Deno.test("repository lookup throws: denied subprocess permission allows with a repository root note", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--allow-env",
      "--allow-read",
      `${hooksDir}lib/check_out_of_tree_write.ts`,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify({
    cwd: Deno.cwd(),
    tool_name: "Write",
    tool_input: { file_path: "/etc/probe.txt" },
  })));
  await writer.close();
  const result = await child.output();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  const output = JSON.parse(new TextDecoder().decode(result.stdout)).hookSpecificOutput;
  assertEquals(output.permissionDecision, undefined);
  assertStringIncludes(output.additionalContext, "repository root");
});
