// check_issue_approval_token.test.ts — web-jam-tools#1054 (design decision D-36)
//
// The approval-token guard honours Josh's approved token when a SUBAGENT of the approving session
// files: the subagent's payload carries its own session_id, but its transcript_path is the approving
// session's own subagent transcript, `<project>/<session_id>/subagents/agent-<agent_id>.jsonl`. The
// token's session matches then; every other mismatch still refuses.

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  approvingSessionId,
  checkIssueApprovalToken,
  checkIssueApprovalTokenAuto,
} from "../hooks/lib/check_issue_approval_token.ts";

const PROJECT = "/home/joshua/.claude/projects/-home-joshua";
const TITLE = "Approved title";

function payload(
  sessionId: string,
  transcriptPath?: string,
): string {
  return JSON.stringify({
    session_id: sessionId,
    ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
    tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
    tool_input: {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: TITLE,
    },
  });
}

async function withToken(
  sessionId: string,
  fn: (tokenPath: string) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/token.json`;
  try {
    await Deno.writeTextFile(
      tokenPath,
      JSON.stringify({
        session_id: sessionId,
        repo: "WebJamApps/web-jam-tools",
        titles: [TITLE],
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    await fn(tokenPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("guard: a subagent of the approving session passes (token S1, payload S2, transcript under S1/subagents)", async () => {
  await withToken("S1", (tokenPath) => {
    const decision = checkIssueApprovalToken(
      payload("S2", `${PROJECT}/S1/subagents/agent-a1.jsonl`),
      tokenPath,
      Date.now(),
    );
    assertEquals(decision.startsWith("ALLOW:"), true, decision);
  });
});

Deno.test("guard: a subagent transcript under a different session's directory refuses", async () => {
  await withToken("S1", (tokenPath) => {
    const decision = checkIssueApprovalToken(
      payload("S2", `${PROJECT}/S3/subagents/agent-a1.jsonl`),
      tokenPath,
      Date.now(),
    );
    assertStringIncludes(decision, "DENY:");
    assertStringIncludes(decision, "different session");
  });
});

Deno.test("guard: another session's main transcript path refuses", async () => {
  await withToken("S1", (tokenPath) => {
    const decision = checkIssueApprovalToken(
      payload("S2", `${PROJECT}/S2.jsonl`),
      tokenPath,
      Date.now(),
    );
    assertStringIncludes(decision, "DENY:");
  });
});

Deno.test("guard: a mismatched session with no transcript_path refuses", async () => {
  await withToken("S1", (tokenPath) => {
    const decision = checkIssueApprovalToken(payload("S2"), tokenPath, Date.now());
    assertStringIncludes(decision, "DENY:");
    assertStringIncludes(decision, "different session");
  });
});

Deno.test("guard: an unparseable or non-string transcript_path with a mismatched session refuses", async () => {
  await withToken("S1", (tokenPath) => {
    for (
      const bad of [
        "",
        "not-a-path",
        `${PROJECT}/S1/subagents/agent-a1.txt`,
        `${PROJECT}/S1/subagents/`,
      ]
    ) {
      const decision = checkIssueApprovalToken(payload("S2", bad), tokenPath, Date.now());
      assertStringIncludes(decision, "DENY:", `transcript_path ${JSON.stringify(bad)}`);
    }
    const nonString = JSON.stringify({
      ...JSON.parse(payload("S2")),
      transcript_path: { path: `${PROJECT}/S1/subagents/agent-a1.jsonl` },
    });
    assertStringIncludes(checkIssueApprovalToken(nonString, tokenPath, Date.now()), "DENY:");
  });
});

Deno.test("guard: a path that climbs out with '..' never borrows the named session", async () => {
  await withToken("S1", (tokenPath) => {
    const decision = checkIssueApprovalToken(
      payload("S2", `${PROJECT}/S3/../S1/subagents/agent-a1.jsonl`),
      tokenPath,
      Date.now(),
    );
    assertStringIncludes(decision, "DENY:");
  });
});

Deno.test("guard: the approving session itself still passes, unchanged (payload S1)", async () => {
  await withToken("S1", (tokenPath) => {
    const decision = checkIssueApprovalToken(payload("S1"), tokenPath, Date.now());
    assertEquals(decision.startsWith("ALLOW:"), true, decision);
  });
});

Deno.test("guard: a subagent of the approving session still needs a title the token approved", async () => {
  await withToken("S1", (tokenPath) => {
    const other = JSON.stringify({
      ...JSON.parse(payload("S2", `${PROJECT}/S1/subagents/agent-a1.jsonl`)),
      tool_input: {
        method: "create",
        owner: "WebJamApps",
        repo: "web-jam-tools",
        title: "A title nobody approved",
      },
    });
    assertStringIncludes(checkIssueApprovalToken(other, tokenPath, Date.now()), "DENY:");
  });
});

Deno.test("guard: a subagent of the approving session cannot use an expired token", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/token.json`;
  try {
    await Deno.writeTextFile(
      tokenPath,
      JSON.stringify({
        session_id: "S1",
        repo: "WebJamApps/web-jam-tools",
        titles: [TITLE],
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const decision = checkIssueApprovalToken(
      payload("S2", `${PROJECT}/S1/subagents/agent-a1.jsonl`),
      tokenPath,
      Date.now(),
    );
    assertStringIncludes(decision, "DENY:");
    assertStringIncludes(decision, "expired");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("guard (per-session token files): a subagent loads the approving session's own file", async () => {
  const home = await Deno.makeTempDir();
  const previous = {
    HOME: Deno.env.get("HOME"),
    override: Deno.env.get("ISSUE_APPROVAL_TOKEN_PATH"),
  };
  try {
    Deno.env.delete("ISSUE_APPROVAL_TOKEN_PATH");
    Deno.env.set("HOME", home);
    const dir = `${home}/.claude/state/issue-approval-tokens`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/S1.json`,
      JSON.stringify({
        session_id: "S1",
        repo: "WebJamApps/web-jam-tools",
        titles: [TITLE],
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    const sub = checkIssueApprovalTokenAuto(
      payload("S2", `${PROJECT}/S1/subagents/agent-a1.jsonl`),
      Date.now(),
    );
    assertEquals(sub.startsWith("ALLOW:"), true, sub);

    const wrongDir = checkIssueApprovalTokenAuto(
      payload("S2", `${PROJECT}/S3/subagents/agent-a1.jsonl`),
      Date.now(),
    );
    assertStringIncludes(wrongDir, "DENY:");

    const noPath = checkIssueApprovalTokenAuto(payload("S2"), Date.now());
    assertStringIncludes(noPath, "DENY:");
  } finally {
    if (previous.HOME === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", previous.HOME);
    if (previous.override !== undefined) {
      Deno.env.set("ISSUE_APPROVAL_TOKEN_PATH", previous.override);
    }
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("approvingSessionId: resolves only a session's own subagent transcript", () => {
  assertEquals(approvingSessionId("S2", `${PROJECT}/S1/subagents/agent-a1.jsonl`), "S1");
  assertEquals(approvingSessionId("S2", `${PROJECT}/S1/subagents/agent-ab_9-x.jsonl`), "S1");
  assertEquals(approvingSessionId("S2", `${PROJECT}/S2.jsonl`), "S2");
  assertEquals(approvingSessionId("S2", undefined), "S2");
  assertEquals(approvingSessionId("S2", null), "S2");
  assertEquals(approvingSessionId("S2", `${PROJECT}/S1/subagents/agent-a1.jsonl/extra`), "S2");
  assertEquals(approvingSessionId("S2", `${PROJECT}/S1/agent-a1.jsonl`), "S2");
});
