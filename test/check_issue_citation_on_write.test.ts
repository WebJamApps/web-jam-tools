import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkIssueCitationOnWrite,
  extractBodyDetails,
  formatCitationDenial,
  isTargetGhCli,
  isTargetGhWriteCommand,
  isTargetTaskOrScript,
  resolveBodyFilePath,
} from "../hooks/lib/check_issue_citation_on_write.ts";

const HOOK_SCRIPT_PATH = new URL(
  "../hooks/check-issue-citation-on-write.sh",
  import.meta.url,
).pathname;

async function runHookScript(
  inputJson: string,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("bash", {
    args: [HOOK_SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env,
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(inputJson));
  await writer.close();
  const output = await child.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test("isTargetGhCli matches targeted gh write commands", () => {
  assertEquals(isTargetGhCli(["gh", "issue", "comment", "123", "--body", "text"]), true);
  assertEquals(isTargetGhCli(["gh", "issue", "create", "--body", "text"]), true);
  assertEquals(isTargetGhCli(["gh", "issue", "edit", "123", "--body", "text"]), true);
  assertEquals(isTargetGhCli(["gh", "pr", "comment", "123", "--body", "text"]), true);
  assertEquals(isTargetGhCli(["gh", "pr", "review", "123", "--body", "text"]), true);
  assertEquals(isTargetGhCli(["gh", "-R", "owner/repo", "issue", "comment", "123"]), true);

  // Non-target subcommands
  assertEquals(isTargetGhCli(["gh", "issue", "view", "123"]), false);
  assertEquals(isTargetGhCli(["gh", "issue", "list"]), false);
  assertEquals(isTargetGhCli(["gh", "pr", "checkout", "123"]), false);
  assertEquals(isTargetGhCli(["git", "commit", "-m", "gh issue comment"]), false);
});

Deno.test("Deno runner options identify only the task name and inspect its body", () => {
  for (
    const options of [
      "--quiet",
      "-q",
      "--config /tmp/deno.json",
      "--config=/tmp/deno.json",
      "-c /tmp/deno.json --quiet",
      "--cwd /tmp",
      "--cwd=/tmp",
      "--filter tools --jobs 1",
      "--if-present --",
    ]
  ) {
    const result = checkIssueCitationOnWrite(JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: `deno task ${options} post-pr-comment --body 'See #45'` },
    }));
    assertStringIncludes(result, "DENY:", options);
  }
  assertEquals(
    isTargetTaskOrScript(["deno", "task", "--config", "post-pr-comment", "test"]),
    false,
  );
  assertEquals(isTargetTaskOrScript(["deno", "task", "test", "post-pr-comment"]), false);
});

Deno.test("body files follow cd, task --cwd, and the task configuration directory", async () => {
  const root = await Deno.makeTempDir();
  const child = `${root}/child`;
  await Deno.mkdir(child);
  for (const directory of [root, child]) {
    await Deno.writeTextFile(`${directory}/deno.json`, '{"tasks":{"post-pr-comment":"echo"}}');
  }
  try {
    const commands = [
      "cd child && gh pr comment 1 --body-file comment.md",
      "cd -- child && deno task --quiet post-pr-comment --body-file comment.md",
      "deno task --cwd child post-pr-comment --body-file comment.md",
      "deno task --cwd=child post-pr-comment --body-file=comment.md",
      "deno task --config child/deno.json post-pr-comment --body-file comment.md",
      "deno task -c child/deno.json --cwd child post-pr-comment --body-file comment.md",
      "cd child && cd .. && cd child && gh issue comment 1 -F comment.md",
    ];
    for (const bareInChild of [true, false]) {
      await Deno.writeTextFile(`${root}/comment.md`, bareInChild ? "clean" : "See #99");
      await Deno.writeTextFile(`${child}/comment.md`, bareInChild ? "See #45" : "clean");
      for (const command of commands) {
        const result = checkIssueCitationOnWrite(JSON.stringify({
          tool_name: "Bash",
          cwd: root,
          tool_input: { command },
        }));
        if (bareInChild) assertStringIncludes(result, "- #45", command);
        else assertEquals(result, "PASS", command);
      }
    }
    // A task's flags after its name must not be mistaken for runner options.
    await Deno.writeTextFile(`${root}/comment.md`, "See #99");
    const result = checkIssueCitationOnWrite(JSON.stringify({
      tool_name: "Bash",
      cwd: root,
      tool_input: { command: "deno task post-pr-comment --cwd child --body-file comment.md" },
    }));
    assertStringIncludes(result, "- #99");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("unknown directories report skipped file reads instead of inspecting another file", () => {
  const result = checkIssueCitationOnWrite(JSON.stringify({
    tool_name: "Bash",
    cwd: "/tmp",
    tool_input: { command: "cd $UNKNOWN && gh issue comment 1 --body-file comment.md" },
  }));
  assertStringIncludes(result, "PASS:");
  assertStringIncludes(result, "could not determine working directory");
  assertStringIncludes(result, "could not read body file");
});

Deno.test("GitHub URLs use the shared citation rules for CLI bodies and MCP review comments", () => {
  for (const kind of ["issues", "pull"]) {
    const url = `https://github.com/WebJamApps/web-jam-tools/${kind}/45`;
    for (
      const [body, deny] of [
        [`See ${url}`, true],
        [`See ${url}#issuecomment-123`, true],
        [`See [${url}](${url})`, true],
        [`See ${url} "Real title"`, false],
        [`See [Real title](${url})`, false],
        [`See [web-jam-tools#45 "Real title"](${url})`, false],
        [`Example: \`${url}\``, false],
        [`\`\`\`\n${url}\n\`\`\``, false],
      ] as const
    ) {
      const inputs = [
        { tool_name: "Bash", tool_input: { command: `gh pr comment 1 --body '${body}'` } },
        { tool_name: "issue_write", tool_input: { body } },
        { tool_name: "pull_request_review_write", tool_input: { comments: [{ body }] } },
      ];
      for (const input of inputs) {
        const result = checkIssueCitationOnWrite(JSON.stringify(input));
        if (deny) {
          assertStringIncludes(result, "DENY:", body);
          assertStringIncludes(result, url, body);
        } else assertEquals(result, "PASS", body);
      }
    }
  }
});

Deno.test("invalid hook payloads allow with a diagnostic in the checker and shell", async () => {
  for (const input of ["{invalid", "null", "[]", '"text"', "123", '{"tool_input":42}']) {
    assertStringIncludes(checkIssueCitationOnWrite(input), "PASS:");
    const result = await runHookScript(input);
    assertEquals(result.code, 0);
    const output = JSON.parse(result.stdout);
    assertStringIncludes(output.hookSpecificOutput.additionalContext, "issue-citation guard:");
    assertEquals(result.stderr, "");
  }
});

Deno.test("checker subprocess failures and invalid results allow with diagnostic context", async () => {
  const directory = await Deno.makeTempDir();
  try {
    for (const script of ["exit 1", "echo PASS; exit 1", "exit 0", "echo UNKNOWN"]) {
      await Deno.writeTextFile(`${directory}/deno`, `#!/bin/sh\n${script}\n`);
      await Deno.chmod(`${directory}/deno`, 0o755);
      const result = await runHookScript("{}", { PATH: `${directory}:${Deno.env.get("PATH")}` });
      assertEquals(result.code, 0);
      const output = JSON.parse(result.stdout);
      assertStringIncludes(
        output.hookSpecificOutput.additionalContext,
        "citation check could not run",
      );
      assertStringIncludes(output.hookSpecificOutput.additionalContext, "proceeding");
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("isTargetTaskOrScript matches guarded tasks and script invocations", () => {
  assertEquals(
    isTargetTaskOrScript(["deno", "task", "post-issue-comment", "--body-file", "f"]),
    true,
  );
  assertEquals(isTargetTaskOrScript(["deno", "task", "post-pr-comment", "--body-file", "f"]), true);
  assertEquals(isTargetTaskOrScript(["deno", "task", "post-pr-review", "--body-file", "f"]), true);
  assertEquals(isTargetTaskOrScript(["deno", "task", "edit-issue", "--issue", "1"]), true);
  assertEquals(isTargetTaskOrScript(["deno", "task", "create-issue", "--title", "t"]), true);
  assertEquals(isTargetTaskOrScript(["deno", "task", "issue:create", "--title", "t"]), true);

  assertEquals(
    isTargetTaskOrScript(["deno", "run", "--allow-read", "scripts/post-issue-comment.ts"]),
    true,
  );
  assertEquals(isTargetTaskOrScript(["./scripts/post-issue-comment.ts", "--issue", "1"]), true);

  // Unrelated tasks
  assertEquals(isTargetTaskOrScript(["deno", "task", "test"]), false);
  assertEquals(isTargetTaskOrScript(["deno", "task", "lint"]), false);
});

Deno.test("isTargetGhWriteCommand matches both CLI and script forms", () => {
  assertEquals(isTargetGhWriteCommand(["gh", "issue", "comment", "1"]), true);
  assertEquals(isTargetGhWriteCommand(["deno", "task", "post-issue-comment"]), true);
  assertEquals(isTargetGhWriteCommand(["ls", "-la"]), false);
});

Deno.test("resolveBodyFilePath resolves relative paths and tildes", () => {
  assertEquals(resolveBodyFilePath("relative/file.md", "/base/dir"), "/base/dir/relative/file.md");
  assertEquals(resolveBodyFilePath("/absolute/file.md", "/base/dir"), "/absolute/file.md");
  assertEquals(resolveBodyFilePath("$VAR/file.md", "/base/dir"), "$VAR/file.md");

  const home = Deno.env.get("HOME");
  if (home) {
    assertEquals(resolveBodyFilePath("~/file.md"), `${home}/file.md`);
  }
});

Deno.test("formatCitationDenial formats message matching require-issue-citation-titles", () => {
  const formatted = formatCitationDenial(["#123", "wjt#456"]);
  assertStringIncludes(formatted, "BLOCKED (issue-citation guard)");
  assertStringIncludes(formatted, "  - #123\n  - wjt#456");
  assertStringIncludes(
    formatted,
    'web-jam-tools#299 "Delete replaced labels org-wide, after migration"',
  );
});

Deno.test("extractBodyDetails handles --body, -b, --body-file, and -F with relative path resolution", async () => {
  assertEquals(extractBodyDetails(["--body", "hello"]), { body: "hello", readError: undefined });
  assertEquals(extractBodyDetails(["-b", "world"]), { body: "world", readError: undefined });
  assertEquals(extractBodyDetails(["--body=foo", "-b=bar"]), {
    body: "foo\nbar",
    readError: undefined,
  });

  const tempDir = await Deno.makeTempDir();
  const filePath = `${tempDir}/test-body.txt`;
  await Deno.writeTextFile(filePath, "file body content");

  try {
    assertEquals(extractBodyDetails(["--body-file", filePath]), {
      body: "file body content",
      readError: undefined,
    });
    assertEquals(extractBodyDetails(["-F", "test-body.txt"], tempDir), {
      body: "file body content",
      readError: undefined,
    });

    const missing = extractBodyDetails(["-F", "missing.txt"], tempDir);
    assert(missing.readError?.includes("could not read body file 'missing.txt'"));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("checkIssueCitationOnWrite - Bash CLI bare citation denies with proper format", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'gh issue comment 123 --body "see wjt#45"',
    },
  });
  const res = checkIssueCitationOnWrite(payload);
  assertStringIncludes(res, "DENY:BLOCKED (issue-citation guard)");
  assertStringIncludes(res, "- wjt#45");
  assertStringIncludes(res, 'Every issue/PR mention needs the full form: repo#number "title"');
});

Deno.test("checkIssueCitationOnWrite - Bash CLI full citation allows", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "gh issue comment 123 --body 'see web-jam-tools#45 \"Real title here\"'",
    },
  });
  assertEquals(checkIssueCitationOnWrite(payload), "PASS");
});

Deno.test("checkIssueCitationOnWrite - Bash CLI bare #N denies", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'gh pr comment 456 -b "Fixed in #999 and #888"',
    },
  });
  const res = checkIssueCitationOnWrite(payload);
  assertStringIncludes(res, "DENY:");
  assertStringIncludes(res, "- #999");
  assertStringIncludes(res, "- #888");
});

Deno.test("checkIssueCitationOnWrite - Bash CLI chained commands and multi-flags", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'echo "starting" && gh -R WebJamApps/web-jam-tools pr review 10 --comment -b="see #100"',
    },
  });
  const res = checkIssueCitationOnWrite(payload);
  assertStringIncludes(res, "DENY:");
  assertStringIncludes(res, "- #100");
});

Deno.test("checkIssueCitationOnWrite - guarded task with body-file containing bare citation denies", async () => {
  const tempDir = await Deno.makeTempDir();
  const filePath = `${tempDir}/comment.md`;
  await Deno.writeTextFile(filePath, "This refers to #321 bare citation.");

  try {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: `deno task post-issue-comment --repo owner/repo --issue 5 --body-file ${filePath}`,
      },
    });
    const res = checkIssueCitationOnWrite(payload);
    assertStringIncludes(res, "DENY:");
    assertStringIncludes(res, "- #321");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("checkIssueCitationOnWrite - guarded task with clean body-file allows", async () => {
  const tempDir = await Deno.makeTempDir();
  const filePath = `${tempDir}/comment.md`;
  await Deno.writeTextFile(filePath, 'Clean comment with web-jam-tools#321 "Proper title".');

  try {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: `deno task post-issue-comment --repo owner/repo --issue 5 --body-file ${filePath}`,
      },
    });
    assertEquals(checkIssueCitationOnWrite(payload), "PASS");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("checkIssueCitationOnWrite - unreadable body file fails open (proceeds and says so)", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "gh issue comment 123 --body-file /non/existent/path/comment.md",
    },
  });
  const res = checkIssueCitationOnWrite(payload);
  assert(res.startsWith("PASS: could not read body file"));
});

Deno.test("checkIssueCitationOnWrite - unterminated quotes in bash command fails open", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'gh issue comment 123 --body "unclosed quote',
    },
  });
  const res = checkIssueCitationOnWrite(payload);
  assert(res.startsWith("PASS: command could not be parsed"));
});

Deno.test("checkIssueCitationOnWrite - unrelated bash commands pass cleanly", () => {
  assertEquals(
    checkIssueCitationOnWrite(JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "commit referencing #123"' },
    })),
    "PASS",
  );
  assertEquals(
    checkIssueCitationOnWrite(JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "git status" },
    })),
    "PASS",
  );
  assertEquals(
    checkIssueCitationOnWrite(JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh issue view 123" },
    })),
    "PASS",
  );
});

Deno.test("checkIssueCitationOnWrite - MCP issue_write bare citation denies", () => {
  const payload = JSON.stringify({
    tool_name: "mcp__github__issue_write",
    tool_input: {
      method: "update",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      issue_number: 123,
      body: "Updated issue pointing to bare #45",
    },
  });
  const res = checkIssueCitationOnWrite(payload);
  assertStringIncludes(res, "DENY:");
  assertStringIncludes(res, "- #45");
});

Deno.test("checkIssueCitationOnWrite - MCP issue_write full citation allows", () => {
  const payload = JSON.stringify({
    tool_name: "mcp__github__issue_write",
    tool_input: {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "New feature",
      body: 'See web-jam-tools#45 "Original issue"',
    },
  });
  assertEquals(checkIssueCitationOnWrite(payload), "PASS");
});

Deno.test("checkIssueCitationOnWrite - MCP pull_request_review_write bare citation denies", () => {
  const payload = JSON.stringify({
    tool_name: "pull_request_review_write",
    tool_input: {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      pullNumber: 50,
      body: "Please fix #1056 first",
    },
  });
  const res = checkIssueCitationOnWrite(payload);
  assertStringIncludes(res, "DENY:");
  assertStringIncludes(res, "- #1056");
});

Deno.test("checkIssueCitationOnWrite - MCP add_comment_to_pending_review and add_reply_to_pull_request_comment", () => {
  const payload1 = JSON.stringify({
    tool_name: "mcp__github__add_comment_to_pending_review",
    tool_input: {
      body: "Note on #777",
    },
  });
  assertStringIncludes(checkIssueCitationOnWrite(payload1), "DENY:");

  const payload2 = JSON.stringify({
    tool_name: "mcp__github__add_reply_to_pull_request_comment",
    tool_input: {
      body: 'Replied per web-jam-tools#777 "Title"',
    },
  });
  assertEquals(checkIssueCitationOnWrite(payload2), "PASS");
});

Deno.test("checkIssueCitationOnWrite - MCP add_issue_comment and update_issue_comment", () => {
  const payload1 = JSON.stringify({
    tool_name: "add_issue_comment",
    tool_input: {
      issue_number: 1,
      body: "Bare #44",
    },
  });
  assertStringIncludes(checkIssueCitationOnWrite(payload1), "DENY:");

  const payload2 = JSON.stringify({
    tool_name: "update_issue_comment",
    tool_input: {
      comment_id: 1,
      body: 'Clean web-jam-tools#44 "Some title"',
    },
  });
  assertEquals(checkIssueCitationOnWrite(payload2), "PASS");
});

Deno.test("checkIssueCitationOnWrite - MCP tool with non-string body fails open", () => {
  const payload = JSON.stringify({
    tool_name: "issue_write",
    tool_input: {
      body: 12345,
    },
  });
  assertEquals(checkIssueCitationOnWrite(payload), "PASS: tool_input.body is not a string");
});

Deno.test("checkIssueCitationOnWrite - unrelated MCP tool passes", () => {
  const payload = JSON.stringify({
    tool_name: "mcp__github__get_file_contents",
    tool_input: {
      path: "some/path/#123",
    },
  });
  assertEquals(checkIssueCitationOnWrite(payload), "PASS");
});

Deno.test("hooks/check-issue-citation-on-write.sh end-to-end: denies with exit 2 and formatted message", async () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'gh issue comment 123 --body "see wjt#45"',
    },
  });
  const res = await runHookScript(payload);
  assertEquals(res.code, 2);
  assertStringIncludes(res.stderr, "BLOCKED (issue-citation guard)");
  assertStringIncludes(res.stderr, "- wjt#45");
  assertStringIncludes(
    res.stderr,
    "(rule: cite-issues-with-title-repo-number — do not retry with the same bare number)",
  );
});

Deno.test("hooks/check-issue-citation-on-write.sh end-to-end: allows clean write with exit 0", async () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "gh issue comment 123 --body 'see web-jam-tools#45 \"Real title here\"'",
    },
  });
  const res = await runHookScript(payload);
  assertEquals(res.code, 0);
  assertEquals(res.stderr, "");
});

Deno.test("hooks/check-issue-citation-on-write.sh end-to-end: MCP bare citation denies with exit 2", async () => {
  const payload = JSON.stringify({
    tool_name: "mcp__github__issue_write",
    tool_input: {
      body: "bare #45 in issue_write",
    },
  });
  const res = await runHookScript(payload);
  assertEquals(res.code, 2);
  assertStringIncludes(res.stderr, "BLOCKED (issue-citation guard)");
  assertStringIncludes(res.stderr, "- #45");
});

Deno.test("hooks/check-issue-citation-on-write.sh end-to-end: unreadable body file proceeds with exit 0", async () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "gh issue comment 123 -F /nonexistent/file.txt",
    },
  });
  const res = await runHookScript(payload);
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "additionalContext");
  assertStringIncludes(res.stdout, "could not read body file");
});
