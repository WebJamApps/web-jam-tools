// require_approval_token_on_issue_write_hook.test.ts — web-jam-tools#502
// (extended to the Bash filing path by web-jam-tools#747)
//
// Exercises hooks/require-approval-token-on-issue-write.sh end-to-end by
// shelling out to it (Deno.Command) with mocked PreToolUse JSON on stdin —
// same pattern as test/require_model_label_on_issue_create_hook.test.ts and
// test/haiku_only_gmail_gate_hook.test.ts (re-implementing the shell/deno
// logic in TypeScript would test a copy, not the real guard).
//
// The hook reads the approval token written by the plan gate (web-jam-tools#497,
// not this change) at the path named by ISSUE_APPROVAL_TOKEN_PATH, and decides
// whether a pending mcp__*__issue_write / mcp__*__sub_issue_write call, OR a
// Bash `gh issue create` / `deno task create-issue` call, is one Josh already
// approved:
//   - approved title, same session, same repo, not expired -> ALLOW (no prompt)
//   - anything else (unapproved title / missing / other-session / expired /
//     wrong-repo token)                                     -> DENY (never queried)
//   - issue_write method other than "create", sub_issue_write method other
//     than "add", Bash `gh issue edit`, or an unrelated command/tool -> PASS
//     (untouched, the standing `ask` rule still applies)

import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/require-approval-token-on-issue-write.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHook(
  payload: Record<string, unknown>,
  tokenPath: string,
): Promise<RunResult> {
  const input = JSON.stringify(payload);
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), ISSUE_APPROVAL_TOKEN_PATH: tokenPath },
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

function issueWriteCreate(
  title: string,
  sessionId: string,
  owner = "WebJamApps",
  repo = "web-jam-tools",
): Record<string, unknown> {
  return {
    session_id: sessionId,
    tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
    tool_input: { method: "create", owner, repo, title, type: "Task", labels: ["Sonnet"] },
  };
}

function issueWriteUpdate(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
    tool_input: { method: "update", owner: "WebJamApps", repo: "web-jam-tools", issue_number: 5 },
  };
}

function subIssueWriteAdd(
  sessionId: string,
  owner = "WebJamApps",
  repo = "web-jam-tools",
): Record<string, unknown> {
  return {
    session_id: sessionId,
    tool_name: "mcp__claude_ai_GitHub_MCP__sub_issue_write",
    tool_input: { method: "add", owner, repo, issue_number: 1, sub_issue_id: 2 },
  };
}

function subIssueWriteRemove(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    tool_name: "mcp__claude_ai_GitHub_MCP__sub_issue_write",
    tool_input: {
      method: "remove",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      issue_number: 1,
      sub_issue_id: 2,
    },
  };
}

async function withTokenFile(
  token: Record<string, unknown> | null,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/issue-approval-token.json`;
  try {
    if (token !== null) {
      await Deno.writeTextFile(path, JSON.stringify(token));
    }
    // token === null -> file deliberately not written, simulating "missing token"
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function futureIso(hoursFromNow = 4): string {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

function pastIso(hoursAgo = 1): string {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

function assertAllow(res: RunResult, titleFragment?: string) {
  assertEquals(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assertEquals(parsed.hookSpecificOutput.permissionDecision, "allow");
  if (titleFragment) {
    assertEquals(
      typeof parsed.hookSpecificOutput.permissionDecisionReason === "string" &&
        parsed.hookSpecificOutput.permissionDecisionReason.includes(titleFragment),
      true,
    );
  }
}

function assertDeny(res: RunResult) {
  assertEquals(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assertEquals(parsed.hookSpecificOutput.permissionDecision, "deny");
  assertEquals(typeof parsed.hookSpecificOutput.permissionDecisionReason, "string");
  assertEquals(parsed.hookSpecificOutput.permissionDecisionReason.length > 0, true);
}

function assertPass(res: RunResult) {
  assertEquals(res.code, 0, res.stderr);
  assertEquals(res.stdout.trim(), "");
}

// --- issue_write create: the four required decision paths ---

Deno.test("issue_write create with an approved title in this session's token is ALLOWED (no prompt)", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor", "Rename the widget"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        issueWriteCreate("Fix the flux capacitor", "session-A"),
        tokenPath,
      );
      assertAllow(res, "Fix the flux capacitor");
    },
  );
});

Deno.test("issue_write create with a title NOT in the token is DENIED, not queried", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        issueWriteCreate("An issue nobody approved", "session-A"),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("issue_write create with NO token file at all is DENIED", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(issueWriteCreate("Any title", "session-A"), tokenPath);
    assertDeny(res);
  });
});

Deno.test("issue_write create with a token from ANOTHER session does not apply and is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-OTHER",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        issueWriteCreate("Fix the flux capacitor", "session-A"),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

// --- extra decision paths named in the acceptance criteria ---

Deno.test("issue_write create with an EXPIRED token is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: pastIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        issueWriteCreate("Fix the flux capacitor", "session-A"),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("issue_write create with a token scoped to a DIFFERENT repo is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/JaMmusic",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        issueWriteCreate("Fix the flux capacitor", "session-A"),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("issue_write create with a malformed token (missing titles field) is DENIED (fail closed)", async () => {
  await withTokenFile(
    { session_id: "session-A", repo: "WebJamApps/web-jam-tools", expires_at: futureIso() },
    async (tokenPath) => {
      const res = await runHook(
        issueWriteCreate("Fix the flux capacitor", "session-A"),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("issue_write create with invalid JSON in the token file is DENIED (fail closed)", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/issue-approval-token.json`;
  try {
    await Deno.writeTextFile(tokenPath, "not valid json{{{");
    const res = await runHook(issueWriteCreate("Fix the flux capacitor", "session-A"), tokenPath);
    assertDeny(res);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- issue_write update: out of scope, passes through untouched ---

Deno.test("issue_write update passes through untouched even with no token", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(issueWriteUpdate("session-A"), tokenPath);
    assertPass(res);
  });
});

// --- sub_issue_write: no title field, so only session/repo/expiry gate it ---

Deno.test("sub_issue_write add with a valid same-session token is ALLOWED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(subIssueWriteAdd("session-A"), tokenPath);
      assertAllow(res);
    },
  );
});

Deno.test("sub_issue_write add with NO token is DENIED", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(subIssueWriteAdd("session-A"), tokenPath);
    assertDeny(res);
  });
});

Deno.test("sub_issue_write add with a token from ANOTHER session is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-OTHER",
      repo: "WebJamApps/web-jam-tools",
      titles: [],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(subIssueWriteAdd("session-A"), tokenPath);
      assertDeny(res);
    },
  );
});

Deno.test("sub_issue_write remove (not add) passes through untouched even with no token", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(subIssueWriteRemove("session-A"), tokenPath);
    assertPass(res);
  });
});

// --- other tools / server prefixes ---

Deno.test("a different MCP server prefix is still gated (server-agnostic matcher)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      {
        session_id: "session-A",
        tool_name: "mcp__github__issue_write",
        tool_input: { method: "create", owner: "WebJamApps", repo: "web-jam-tools", title: "T" },
      },
      tokenPath,
    );
    assertDeny(res);
  });
});

Deno.test("a non-issue_write MCP tool call passes through untouched", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      {
        session_id: "session-A",
        tool_name: "mcp__claude_ai_GitHub_MCP__pull_request_read",
        tool_input: { method: "get" },
      },
      tokenPath,
    );
    assertPass(res);
  });
});

Deno.test("a Bash tool call passes through untouched", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      { session_id: "session-A", tool_name: "Bash", tool_input: { command: "ls -la" } },
      tokenPath,
    );
    assertPass(res);
  });
});

// --- Bash surface: gh issue create / deno task create-issue (web-jam-tools#747) ---

function bashCall(command: string, sessionId = "session-A"): Record<string, unknown> {
  return { session_id: sessionId, tool_name: "Bash", tool_input: { command } };
}

Deno.test("Bash gh issue create with an approved title in this session's token is ALLOWED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(`gh issue create --title "Fix the flux capacitor" --body B --type Task`),
        tokenPath,
      );
      assertAllow(res, "Fix the flux capacitor");
    },
  );
});

Deno.test("Bash gh issue create with NO token file at all is DENIED (AC3)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(`gh issue create --title "Untokenized test title" --body B --type Task`),
      tokenPath,
    );
    assertDeny(res);
  });
});

Deno.test("Bash gh issue create with a title NOT in the token is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(`gh issue create --title "An issue nobody approved" --body B --type Task`),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("Bash gh issue create with --repo pointing at a different repo than the token is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/JaMmusic",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(
          `gh issue create --repo WebJamApps/web-jam-tools --title "Fix the flux capacitor" --body B --type Task`,
        ),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("Bash gh issue create with no --title at all is DENIED (fail closed)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(bashCall(`gh issue create --body B --type Task`), tokenPath);
    assertDeny(res);
  });
});

Deno.test("Bash deno task create-issue with an approved title is ALLOWED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(
          `deno task create-issue --title "Fix the flux capacitor" --body-file /tmp/b.md --type Task --label "Flash High"`,
        ),
        tokenPath,
      );
      assertAllow(res, "Fix the flux capacitor");
    },
  );
});

Deno.test("Bash deno task create-issue with NO token file at all is DENIED (AC4)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `deno task create-issue --title "Untokenized test title" --body-file /tmp/b.md --type Task --label Haiku`,
      ),
      tokenPath,
    );
    assertDeny(res);
  });
});

Deno.test("Bash direct scripts/create-issue.ts invocation with an approved title is ALLOWED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(
          `scripts/create-issue.ts --title "Fix the flux capacitor" --body-file /tmp/b.md --type Task --label Haiku`,
        ),
        tokenPath,
      );
      assertAllow(res, "Fix the flux capacitor");
    },
  );
});

Deno.test("Bash gh issue edit (not create) passes through untouched even with no token", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(bashCall(`gh issue edit 5 --add-label bug`), tokenPath);
    assertPass(res);
  });
});

Deno.test("Bash gh issue create with a token from ANOTHER session does not apply and is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-OTHER",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(`gh issue create --title "Fix the flux capacitor" --body B --type Task`),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("Bash gh issue create chained after another command (&&) is still gated", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(`echo hi && gh issue create --title "Untokenized test title" --body B --type Task`),
      tokenPath,
    );
    assertDeny(res);
  });
});

Deno.test("invalid JSON on stdin passes through (nothing this hook can act on)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const cmd = new Deno.Command("bash", {
      args: [SCRIPT_PATH],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: { ...Deno.env.toObject(), ISSUE_APPROVAL_TOKEN_PATH: tokenPath },
    });
    const child = cmd.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode("not valid json{{{"));
    await writer.close();
    const { code, stdout } = await child.output();
    assertEquals(code, 0);
    assertEquals(new TextDecoder().decode(stdout).trim(), "");
  });
});
