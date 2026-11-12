#!/usr/bin/env -S deno run
// probe-agy-tools.ts — verify and summarize agy tool-invocation probe results (web-jam-tools#1055).
import { parseArgs } from "@std/cli";

export interface ProbeSummary {
  logPath: string;
  totalLines: number;
  fileEditTools: {
    replace_file_content: { count: number; preToolUseFired: boolean; argKeys: string[] };
    write_to_file: { count: number; preToolUseFired: boolean; argKeys: string[] };
    multi_replace_file_content: { count: number; preToolUseFired: boolean };
  };
  mcpCalls: {
    github: {
      count: number;
      preToolUseFired: boolean;
      observedTools: string[];
    };
  };
  writeCallsDetected: {
    issue_write: number;
    sub_issue_write: number;
  };
  verifiedNoWrites: boolean;
}

export function analyzeProbeLog(lines: string[], logPath: string): ProbeSummary {
  let totalLines = 0;
  let replaceCount = 0;
  let replacePreFired = false;
  const replaceArgKeys = new Set<string>();

  let writeCount = 0;
  let writePreFired = false;
  const writeArgKeys = new Set<string>();

  let multiReplaceCount = 0;
  let multiReplacePreFired = false;

  let githubMcpCount = 0;
  let githubMcpPreFired = false;
  const observedGithubTools = new Set<string>();

  let issueWriteCount = 0;
  let subIssueWriteCount = 0;

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    totalLines++;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      throw new Error(`Invalid probe log at ${logPath}:${index + 1}: malformed JSON`);
    }

    if (
      !isRecord(data) || typeof data.event !== "string" || !data.event.trim() ||
      !isRecord(data.toolCall) || typeof data.toolCall.name !== "string" ||
      !data.toolCall.name.trim() || !isRecord(data.toolCall.args)
    ) {
      throw new Error(`Invalid probe log at ${logPath}:${index + 1}: expected a tool event record`);
    }
    const event = data.event;
    const name = data.toolCall.name;
    const args = data.toolCall.args;
    if (
      name === "call_mcp_tool" &&
      (typeof args.ServerName !== "string" || !args.ServerName.trim() ||
        typeof args.ToolName !== "string" || !args.ToolName.trim())
    ) {
      throw new Error(`Invalid probe log at ${logPath}:${index + 1}: missing MCP tool identity`);
    }

    if (name === "replace_file_content") {
      replaceCount++;
      if (event === "PreToolUse") replacePreFired = true;
      for (const k of Object.keys(args)) replaceArgKeys.add(k);
    } else if (name === "write_to_file") {
      writeCount++;
      if (event === "PreToolUse") writePreFired = true;
      for (const k of Object.keys(args)) writeArgKeys.add(k);
    } else if (name === "multi_replace_file_content") {
      multiReplaceCount++;
      if (event === "PreToolUse") multiReplacePreFired = true;
    }

    // Check for MCP calls
    if (name === "call_mcp_tool" && args.ServerName === "github") {
      githubMcpCount++;
      if (event === "PreToolUse") githubMcpPreFired = true;
      if (typeof args.ToolName === "string") observedGithubTools.add(args.ToolName);
    }

    // Direct MCP naming or lazy call
    if (
      name === "issue_write" ||
      name === "mcp_github_issue_write" ||
      (name === "call_mcp_tool" && args.ToolName === "issue_write")
    ) {
      issueWriteCount++;
    }
    if (
      name === "sub_issue_write" ||
      name === "mcp_github_sub_issue_write" ||
      (name === "call_mcp_tool" && args.ToolName === "sub_issue_write")
    ) {
      subIssueWriteCount++;
    }
  }

  if (totalLines === 0) {
    throw new Error(`Invalid probe log at ${logPath}: no tool event records`);
  }

  return {
    logPath,
    totalLines,
    fileEditTools: {
      replace_file_content: {
        count: replaceCount,
        preToolUseFired: replacePreFired,
        argKeys: Array.from(replaceArgKeys).sort(),
      },
      write_to_file: {
        count: writeCount,
        preToolUseFired: writePreFired,
        argKeys: Array.from(writeArgKeys).sort(),
      },
      multi_replace_file_content: {
        count: multiReplaceCount,
        preToolUseFired: multiReplacePreFired,
      },
    },
    mcpCalls: {
      github: {
        count: githubMcpCount,
        preToolUseFired: githubMcpPreFired,
        observedTools: Array.from(observedGithubTools).sort(),
      },
    },
    writeCallsDetected: {
      issue_write: issueWriteCount,
      sub_issue_write: subIssueWriteCount,
    },
    verifiedNoWrites: issueWriteCount === 0 && subIssueWriteCount === 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatProbeReport(summary: ProbeSummary): string {
  const lines: string[] = [
    "============================================================",
    "  Antigravity (agy) Live Tool & Hook Probe Report",
    "  (web-jam-tools#1055)",
    "============================================================",
    `Log file: ${summary.logPath}`,
    `Total parsed entries: ${summary.totalLines}`,
    "",
    "1. agy Native File Edit / Write Tools:",
    `   - replace_file_content:`,
    `       Invocations in log: ${summary.fileEditTools.replace_file_content.count}`,
    `       PreToolUse fired:   ${
      summary.fileEditTools.replace_file_content.preToolUseFired ? "YES" : "NO"
    }`,
    `       Observed args:      ${
      summary.fileEditTools.replace_file_content.argKeys.join(", ") || "(none)"
    }`,
    `   - write_to_file:`,
    `       Invocations in log: ${summary.fileEditTools.write_to_file.count}`,
    `       PreToolUse fired:   ${
      summary.fileEditTools.write_to_file.preToolUseFired ? "YES" : "NO"
    }`,
    `       Observed args:      ${
      summary.fileEditTools.write_to_file.argKeys.join(", ") || "(none)"
    }`,
    `   - multi_replace_file_content:`,
    `       Identified in:      agy binary deterministic vetting configs`,
    `       Invocations in log: ${summary.fileEditTools.multi_replace_file_content.count}`,
    "",
    "2. agy GitHub MCP Server Tools:",
    `   - Dispatch interface:  call_mcp_tool (lazy MCP dispatch)`,
    `   - Invocations in log:  ${summary.mcpCalls.github.count}`,
    `   - PreToolUse fired:    ${summary.mcpCalls.github.preToolUseFired ? "YES" : "NO"}`,
    `   - Observed read tools: ${summary.mcpCalls.github.observedTools.join(", ") || "(none)"}`,
    `   - Derived write tools: issue_write, sub_issue_write (from observed schema/dispatch)`,
    "",
    "3. Safety Invariant Check (Zero Live Writes):",
    `   - issue_write calls:     ${summary.writeCallsDetected.issue_write}`,
    `   - sub_issue_write calls: ${summary.writeCallsDetected.sub_issue_write}`,
    `   - Status:                ${
      summary.verifiedNoWrites
        ? "VERIFIED SAFE (0 write calls made)"
        : "VIOLATION (Forbidden write calls detected!)"
    }`,
    "============================================================",
  ];
  return lines.join("\n");
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["log"],
    boolean: ["json", "help"],
    alias: { h: "help", l: "log" },
  });

  if (args.help) {
    console.log(`Usage: scripts/probe-agy-tools.sh [options]

Verify and summarize agy tool-invocation probe log (web-jam-tools#1055).

Options:
  -l, --log PATH   Path to agy hook invocations JSONL file
                   (default: AGY_HOOK_RECORD_PATH or /tmp/agy-hook-invocations.jsonl)
      --json       Output result as JSON
  -h, --help       Show this help message
`);
    Deno.exit(0);
  }

  const logPath = args.log || Deno.env.get("AGY_HOOK_RECORD_PATH") ||
    "/tmp/agy-hook-invocations.jsonl";

  let content = "";
  try {
    content = await Deno.readTextFile(logPath);
  } catch (err) {
    console.error(`error: could not read probe log from ${logPath}: ${err}`);
    Deno.exit(1);
  }

  const lines = content.split("\n");
  let summary: ProbeSummary;
  try {
    summary = analyzeProbeLog(lines, logPath);
  } catch (err) {
    console.error(
      `error: refusing to verify probe log: ${err instanceof Error ? err.message : err}`,
    );
    Deno.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatProbeReport(summary));
  }

  if (!summary.verifiedNoWrites) {
    console.error("FATAL: Probe log contains unpermitted issue_write or sub_issue_write calls!");
    Deno.exit(1);
  }

  Deno.exit(0);
}
