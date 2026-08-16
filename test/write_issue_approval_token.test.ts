// write_issue_approval_token.test.ts — web-jam-tools#595
//
// Unit tests and round-trip integration tests for scripts/write_issue_approval_token.ts
// validating that the written approval token is accepted by
// hooks/lib/check_issue_approval_token.ts and hooks/require-approval-token-on-issue-write.sh.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildApprovalToken,
  writeApprovalToken,
  writeApprovalTokenSync,
} from "../scripts/write_issue_approval_token.ts";
import { checkIssueApprovalToken, loadToken } from "../hooks/lib/check_issue_approval_token.ts";

const SCRIPT_PATH = new URL(
  "../scripts/write_issue_approval_token.ts",
  import.meta.url,
).pathname;

const HOOK_PATH = new URL(
  "../hooks/require-approval-token-on-issue-write.sh",
  import.meta.url,
).pathname;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      SCRIPT_PATH,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function runHook(
  payload: Record<string, unknown>,
  tokenPath: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const input = JSON.stringify(payload);
  const cmd = new Deno.Command("bash", {
    args: [HOOK_PATH],
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

// --- buildApprovalToken unit tests ---

Deno.test("buildApprovalToken: builds valid token with defaults", () => {
  const token = buildApprovalToken({
    sessionId: "sess-123",
    repo: "web-jam-tools",
    titles: ["Fix bug A", "Add feature B"],
  });

  assertEquals(token.session_id, "sess-123");
  assertEquals(token.repo, "WebJamApps/web-jam-tools");
  assertEquals(token.titles, ["Fix bug A", "Add feature B"]);
  const expMs = Date.parse(token.expires_at);
  assertEquals(Number.isNaN(expMs), false);
  assert(expMs > Date.now() + 3 * 3600_000);
});

Deno.test("buildApprovalToken: preserves existing owner in repo string", () => {
  const token = buildApprovalToken({
    sessionId: "sess-123",
    repo: "CustomOwner/my-repo",
    titles: ["Title 1"],
  });
  assertEquals(token.repo, "CustomOwner/my-repo");
});

Deno.test("buildApprovalToken: honors custom explicit expiresAt", () => {
  const customIso = "2028-01-01T00:00:00.000Z";
  const token = buildApprovalToken({
    sessionId: "sess-123",
    repo: "web-jam-tools",
    titles: ["Title 1"],
    expiresAt: customIso,
  });
  assertEquals(token.expires_at, customIso);
});

Deno.test("buildApprovalToken: throws on missing or empty sessionId", () => {
  assertThrows(
    () => buildApprovalToken({ sessionId: "", repo: "web-jam-tools", titles: ["T1"] }),
    Error,
    "sessionId",
  );
});

Deno.test("buildApprovalToken: throws on missing or empty repo", () => {
  assertThrows(
    () => buildApprovalToken({ sessionId: "sess-1", repo: "", titles: ["T1"] }),
    Error,
    "repo",
  );
});

Deno.test("buildApprovalToken: throws on empty titles array", () => {
  assertThrows(
    () => buildApprovalToken({ sessionId: "sess-1", repo: "web-jam-tools", titles: [] }),
    Error,
    "titles",
  );
  assertThrows(
    () => buildApprovalToken({ sessionId: "sess-1", repo: "web-jam-tools", titles: ["  ", ""] }),
    Error,
    "titles",
  );
});

Deno.test("buildApprovalToken: throws on unparseable expiresAt", () => {
  assertThrows(
    () =>
      buildApprovalToken({
        sessionId: "sess-1",
        repo: "web-jam-tools",
        titles: ["T1"],
        expiresAt: "not-a-date",
      }),
    Error,
    "Invalid expiresAt",
  );
});

// --- writeApprovalToken & writeApprovalTokenSync unit tests ---

Deno.test("writeApprovalToken: writes valid token file and creates parent directories", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/nested/subdir/issue-approval-token.json`;
  try {
    const { token, path } = await writeApprovalToken({
      sessionId: "session-xyz",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Approved title 1", "Approved title 2"],
      tokenPath,
    });

    assertEquals(path, tokenPath);
    assertEquals(token.session_id, "session-xyz");

    const loaded = loadToken(tokenPath);
    assertEquals(loaded, token);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeApprovalTokenSync: writes token synchronously", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/issue-approval-token-sync.json`;
  try {
    const { token, path } = writeApprovalTokenSync({
      sessionId: "session-sync",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Sync title"],
      tokenPath,
    });

    assertEquals(path, tokenPath);
    const loaded = loadToken(tokenPath);
    assertEquals(loaded, token);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- CLI execution tests ---

Deno.test("CLI: writes token via repeated --title arguments", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-token.json`;
  try {
    const res = await runCli([
      "--session-id",
      "cli-session",
      "--repo",
      "web-jam-tools",
      "--title",
      "Title One",
      "--title",
      "Title Two",
      "--token-path",
      tokenPath,
    ]);

    assertEquals(res.code, 0, res.stderr);
    const loaded = loadToken(tokenPath);
    assert(loaded !== null);
    assertEquals(loaded?.session_id, "cli-session");
    assertEquals(loaded?.repo, "WebJamApps/web-jam-tools");
    assertEquals(loaded?.titles, ["Title One", "Title Two"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: writes token via --titles JSON array and --json stdout", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-token-json.json`;
  try {
    const res = await runCli([
      "--session-id",
      "json-session",
      "--repo",
      "WebJamApps/JaMmusic",
      "--titles",
      JSON.stringify(["Song list fix", "Tour dates update"]),
      "--token-path",
      tokenPath,
      "--json",
    ]);

    assertEquals(res.code, 0, res.stderr);
    const parsedStdout = JSON.parse(res.stdout);
    assertEquals(parsedStdout.session_id, "json-session");
    assertEquals(parsedStdout.repo, "WebJamApps/JaMmusic");
    assertEquals(parsedStdout.titles, ["Song list fix", "Tour dates update"]);

    const loaded = loadToken(tokenPath);
    assertEquals(loaded, parsedStdout);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: writes token via --titles-file argument", async () => {
  const dir = await Deno.makeTempDir();
  const titlesFilePath = `${dir}/titles.txt`;
  const tokenPath = `${dir}/file-token.json`;
  try {
    await Deno.writeTextFile(titlesFilePath, "File Title 1\nFile Title 2\n");
    const res = await runCli([
      "--session-id",
      "file-session",
      "--repo",
      "web-jam-tools",
      "--titles-file",
      titlesFilePath,
      "--token-path",
      tokenPath,
    ]);

    assertEquals(res.code, 0, res.stderr);
    const loaded = loadToken(tokenPath);
    assertEquals(loaded?.titles, ["File Title 1", "File Title 2"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: fails with exit code 1 when required arguments are missing", async () => {
  const res = await runCli(["--repo", "web-jam-tools"]);
  assertEquals(res.code, 1);
  assert(res.stderr.includes("sessionId is required"));
});

// --- Round-trip integration tests with hook and reader (web-jam-tools#595) ---

Deno.test("Round-trip: written token allows matching issue_write create without a prompt", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/round-trip-token.json`;
  try {
    await writeApprovalToken({
      sessionId: "sess-round-trip",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Approved title A", "Approved title B"],
      tokenPath,
    });

    // 1. Direct reader check
    const payload = JSON.stringify({
      session_id: "sess-round-trip",
      tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
      tool_input: {
        method: "create",
        owner: "WebJamApps",
        repo: "web-jam-tools",
        title: "Approved title A",
      },
    });
    const decision = checkIssueApprovalToken(payload, tokenPath, Date.now());
    assert(decision.startsWith("ALLOW:"));

    // 2. End-to-end hook check
    const res = await runHook(
      {
        session_id: "sess-round-trip",
        tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
        tool_input: {
          method: "create",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          title: "Approved title A",
        },
      },
      tokenPath,
    );

    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assertEquals(parsed.hookSpecificOutput.permissionDecision, "allow");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: written token DENIES unapproved title", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/round-trip-unapproved.json`;
  try {
    await writeApprovalToken({
      sessionId: "sess-round-trip",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Approved title A"],
      tokenPath,
    });

    const res = await runHook(
      {
        session_id: "sess-round-trip",
        tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
        tool_input: {
          method: "create",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          title: "Unapproved title",
        },
      },
      tokenPath,
    );

    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assertEquals(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert(parsed.hookSpecificOutput.permissionDecisionReason.includes("not among the titles"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: written token DENIES when token is expired", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/round-trip-expired.json`;
  try {
    await writeApprovalToken({
      sessionId: "sess-round-trip",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Approved title A"],
      expiresAt: new Date(Date.now() - 3600_000).toISOString(), // expired 1 hour ago
      tokenPath,
    });

    const res = await runHook(
      {
        session_id: "sess-round-trip",
        tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
        tool_input: {
          method: "create",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          title: "Approved title A",
        },
      },
      tokenPath,
    );

    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assertEquals(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert(parsed.hookSpecificOutput.permissionDecisionReason.includes("expired"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: written token DENIES when session ID does not match", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/round-trip-session.json`;
  try {
    await writeApprovalToken({
      sessionId: "sess-authorizing",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Approved title A"],
      tokenPath,
    });

    const res = await runHook(
      {
        session_id: "sess-other-session",
        tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
        tool_input: {
          method: "create",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          title: "Approved title A",
        },
      },
      tokenPath,
    );

    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assertEquals(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert(parsed.hookSpecificOutput.permissionDecisionReason.includes("different session"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
