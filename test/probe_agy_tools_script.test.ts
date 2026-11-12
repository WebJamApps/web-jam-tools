// probe_agy_tools_script.test.ts — web-jam-tools#1055
//
// Tests for scripts/probe-agy-tools.sh and scripts/probe-agy-tools.ts:
// verifies tool argument parsing, PreToolUse detection for agy file edit
// and GitHub MCP tools, JSON output, and strict fail-closed refusal on write calls.

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { analyzeProbeLog, formatProbeReport } from "../scripts/probe-agy-tools.ts";

const SCRIPT_PATH = new URL("../scripts/probe-agy-tools.sh", import.meta.url).pathname;

const SAFE_RECORD = JSON.stringify({
  event: "PreToolUse",
  toolCall: { name: "replace_file_content", args: { TargetFile: "fixture.ts" } },
});
const DAMAGED_RECORDS = [
  '{"event":"PreToolUse","toolCall":{"name":"issue_write"',
  "null",
  "[]",
  '"issue_write"',
  "42",
  "true",
  "{}",
  JSON.stringify({ event: "PreToolUse", toolCall: { name: "issue_write", args: [] } }),
  JSON.stringify({ event: "PreToolUse", toolCall: { name: "call_mcp_tool", args: {} } }),
];

Deno.test("analyzeProbeLog refuses damaged records even beside valid records", () => {
  for (const damaged of DAMAGED_RECORDS) {
    assertThrows(
      () => analyzeProbeLog([SAFE_RECORD, "", damaged], "/tmp/damaged.jsonl"),
      Error,
      "Invalid probe log at /tmp/damaged.jsonl:3",
    );
  }
  assertThrows(
    () => analyzeProbeLog(["", "  "], "/tmp/empty.jsonl"),
    Error,
    "no tool event records",
  );
});

Deno.test("scripts/probe-agy-tools.sh refuses damaged or empty logs without certifying safety", async () => {
  const dir = await Deno.makeTempDir({ prefix: "probe-damaged-" });
  try {
    const logPath = `${dir}/damaged.jsonl`;
    for (const content of ["", ...DAMAGED_RECORDS.map((line) => `${SAFE_RECORD}\n${line}\n`)]) {
      await Deno.writeTextFile(logPath, content);
      for (const format of [[], ["--json"]]) {
        const { code, stdout, stderr } = await new Deno.Command("bash", {
          args: [SCRIPT_PATH, "--log", logPath, ...format],
          stdout: "piped",
          stderr: "piped",
        }).output();
        assertEquals(code, 1, content);
        assertEquals(
          new TextDecoder().decode(stdout),
          "",
          "No partial safety report may be emitted",
        );
        assertStringIncludes(new TextDecoder().decode(stderr), "refusing to verify probe log");
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scripts/probe-agy-tools.sh --help displays usage and returns 0", async () => {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH, "--help"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  const text = new TextDecoder().decode(stdout);
  assertEquals(code, 0);
  assertStringIncludes(text, "Usage: scripts/probe-agy-tools.sh");
  assertStringIncludes(text, "web-jam-tools#1055");
});

Deno.test("analyzeProbeLog extracts file edit tools, MCP tools, and asserts 0 writes", () => {
  const sampleLines = [
    JSON.stringify({
      event: "PreToolUse",
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: "foo.ts", Instruction: "edit", ReplacementContent: "bar" },
      },
    }),
    JSON.stringify({
      event: "PreToolUse",
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: "baz.txt", CodeContent: "hello" },
      },
    }),
    JSON.stringify({
      event: "PreToolUse",
      toolCall: {
        name: "call_mcp_tool",
        args: {
          ServerName: "github",
          ToolName: "issue_read",
          Arguments: { issue_number: 1055 },
        },
      },
    }),
  ];

  const summary = analyzeProbeLog(sampleLines, "/tmp/sample.jsonl");
  assertEquals(summary.totalLines, 3);
  assertEquals(summary.fileEditTools.replace_file_content.count, 1);
  assertEquals(summary.fileEditTools.replace_file_content.preToolUseFired, true);
  assertEquals(summary.fileEditTools.replace_file_content.argKeys, [
    "Instruction",
    "ReplacementContent",
    "TargetFile",
  ]);

  assertEquals(summary.fileEditTools.write_to_file.count, 1);
  assertEquals(summary.fileEditTools.write_to_file.preToolUseFired, true);
  assertEquals(summary.fileEditTools.write_to_file.argKeys, [
    "CodeContent",
    "TargetFile",
  ]);

  assertEquals(summary.mcpCalls.github.count, 1);
  assertEquals(summary.mcpCalls.github.preToolUseFired, true);
  assertEquals(summary.mcpCalls.github.observedTools, ["issue_read"]);

  assertEquals(summary.writeCallsDetected.issue_write, 0);
  assertEquals(summary.writeCallsDetected.sub_issue_write, 0);
  assertEquals(summary.verifiedNoWrites, true);

  const report = formatProbeReport(summary);
  assertStringIncludes(report, "replace_file_content:");
  assertStringIncludes(report, "write_to_file:");
  assertStringIncludes(report, "issue_read");
  assertStringIncludes(report, "VERIFIED SAFE (0 write calls made)");
});

Deno.test("analyzeProbeLog flags issue_write calls and marks verifiedNoWrites false", () => {
  const violatingLines = [
    JSON.stringify({
      event: "PreToolUse",
      toolCall: {
        name: "call_mcp_tool",
        args: {
          ServerName: "github",
          ToolName: "issue_write",
          Arguments: { title: "Unpermitted issue" },
        },
      },
    }),
  ];

  const summary = analyzeProbeLog(violatingLines, "/tmp/violating.jsonl");
  assertEquals(summary.writeCallsDetected.issue_write, 1);
  assertEquals(summary.verifiedNoWrites, false);
});

Deno.test("scripts/probe-agy-tools.sh executes end-to-end on fixture and exits 0", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wjt1055-probe-" });
  const logPath = `${dir}/fixture.jsonl`;
  try {
    const lines = [
      JSON.stringify({
        event: "PreToolUse",
        toolCall: {
          name: "replace_file_content",
          args: { TargetFile: "test.ts" },
        },
      }),
      JSON.stringify({
        event: "PreToolUse",
        toolCall: {
          name: "call_mcp_tool",
          args: { ServerName: "github", ToolName: "issue_read" },
        },
      }),
    ];
    await Deno.writeTextFile(logPath, lines.join("\n") + "\n");

    const cmd = new Deno.Command("bash", {
      args: [SCRIPT_PATH, "--log", logPath, "--json"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const stdoutStr = new TextDecoder().decode(stdout);
    const stderrStr = new TextDecoder().decode(stderr);
    assertEquals(code, 0, stderrStr);

    const parsed = JSON.parse(stdoutStr);
    assertEquals(parsed.verifiedNoWrites, true);
    assertEquals(parsed.fileEditTools.replace_file_content.preToolUseFired, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scripts/probe-agy-tools.sh fails closed with exit 1 on forbidden issue_write fixture", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wjt1055-violation-" });
  const logPath = `${dir}/violation.jsonl`;
  try {
    const lines = [
      JSON.stringify({
        event: "PreToolUse",
        toolCall: {
          name: "issue_write",
          args: { title: "Bad issue" },
        },
      }),
    ];
    await Deno.writeTextFile(logPath, lines.join("\n") + "\n");

    const cmd = new Deno.Command("bash", {
      args: [SCRIPT_PATH, "--log", logPath],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    const stderrStr = new TextDecoder().decode(stderr);
    assertEquals(code, 1);
    assertStringIncludes(stderrStr, "FATAL: Probe log contains unpermitted issue_write");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probe launcher scopes permissions and supports explicit and environment log paths with commas", async () => {
  const dir = await Deno.makeTempDir({ prefix: "probe,permissions-" });
  try {
    const logPath = `${dir}/selected,log.jsonl`;
    const argsPath = `${dir}/deno-args.txt`;
    const configPath = `${dir}/permissions.json`;
    const wrapperPath = `${dir}/record-deno`;
    await Deno.writeTextFile(logPath, `${SAFE_RECORD}\n`);
    await Deno.writeTextFile(
      wrapperPath,
      `#!/bin/sh
printf '%s\\n' "$@" > "$PROBE_TEST_ARGS"
if [ "$2" = "--config" ]; then cp "$3" "$PROBE_TEST_CONFIG"; fi
exec "$PROBE_TEST_DENO" "$@"
`,
    );
    await Deno.chmod(wrapperPath, 0o755);
    for (const logArgs of [[], ["--log", logPath], ["-l", logPath], [`--log=${logPath}`]]) {
      const output = await new Deno.Command("bash", {
        args: [SCRIPT_PATH, "--json", ...logArgs],
        env: {
          DENO_BIN: wrapperPath,
          PROBE_TEST_ARGS: argsPath,
          PROBE_TEST_CONFIG: configPath,
          PROBE_TEST_DENO: Deno.execPath(),
          // Explicit log selection must override even an unreadable environment fallback.
          AGY_HOOK_RECORD_PATH: logArgs.length ? `${dir}/missing.jsonl` : logPath,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
      assertEquals(JSON.parse(new TextDecoder().decode(output.stdout)).verifiedNoWrites, true);

      const denoArgs = (await Deno.readTextFile(argsPath)).trim().split("\n");
      assertEquals(denoArgs.includes("--allow-read"), false);
      assertEquals(denoArgs.some((arg) => arg.startsWith("--allow-env")), false);
      assertEquals(denoArgs.includes("-P=launcher"), true);
      const permissions = JSON.parse(await Deno.readTextFile(configPath)).permissions.launcher;
      const grants: string[] = permissions.read;
      assertEquals(Object.keys(permissions), ["read"]);
      assertEquals(grants.includes(logPath), true);
      assertEquals(grants.some((entry) => entry === dir || entry === "/" || entry === "."), false);
      assertEquals(grants.length, 3);
      await assertRejects(
        () => Deno.stat(denoArgs[denoArgs.indexOf("--config") + 1]),
        Deno.errors.NotFound,
      );
    }

    // Check Deno's runtime view of permissions outside the selected log.
    const audit = `${dir}/audit.ts`;
    await Deno.writeTextFile(
      audit,
      `console.log(JSON.stringify(await Promise.all([
        { name: "read", path: Deno.args[0] },
        { name: "write", path: Deno.args[1] },
        { name: "env", variable: "HOME" },
        { name: "net", host: "example.com" },
        { name: "run", command: "bash" },
      ].map(async (p) => (await Deno.permissions.query(p)).state))));`,
    );
    const auditOutput = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--config", configPath, "-P=launcher", audit, `${dir}/neighbor`, logPath],
    }).output();
    assertEquals(auditOutput.code, 0, new TextDecoder().decode(auditOutput.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(auditOutput.stdout)), Array(5).fill("prompt"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
