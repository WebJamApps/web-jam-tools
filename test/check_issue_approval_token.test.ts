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
  decide,
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

// Literal rows from the approval-token table in the hooks design's
// "Recognising Josh's approval to file an issue" section. Bash exemptions
// must be silent PASS, never an ALLOW that bypasses other permission checks.
const filingForms = [
  ["deno task create-issue --help", "pass"],
  ["deno task create-issue -h", "pass"],
  ["deno task create-issue", "pass"],
  ["deno run -A scripts/create-issue.ts --help", "pass"],
  [
    "cd /home/joshua/WebJamApps/web-jam-tools && deno task create-issue --help 2>&1 | head -40",
    "pass",
  ],
  ["deno task create-issue --repo WebJamApps/web-jam-tools --body-file /tmp/b.md", "pass"],
  ["gh issue create", "deny"],
  ['gh issue create --body "x"', "deny"],
  [
    'deno task create-issue --help && deno task create-issue --repo WebJamApps/web-jam-tools --title "not approved"',
    "deny",
  ],
] as const;

for (const [command, expected] of filingForms) {
  Deno.test(`approval-token design table: ${command}`, async () => {
    await withToken("S1", (tokenPath) => {
      assertEquals(decide("Bash", { command }, "S1", tokenPath, Date.now()).outcome, expected);
      // Help/title-less calls also pass without any session or approval token.
      assertEquals(decide("Bash", { command }, "", null, Date.now()).outcome, expected);
    });
  });
}

for (
  const [args, expected] of [
    ["--title ''", "pass"],
    ["--title=", "pass"],
    ["--title '   '", "deny"],
    ['--title "" --title "not approved"', "deny"],
    ['--title= --title="not approved"', "deny"],
    ['--title "not approved" --help', "pass"],
  ] as const
) {
  Deno.test(`approval-token script exemption boundaries: ${args}`, () => {
    assertEquals(
      decide("Bash", { command: `deno task create-issue ${args}` }, "", null, Date.now()).outcome,
      expected,
    );
  });
}

for (const flag of ["--help", "-h"]) {
  Deno.test(`create-issue task ${flag} prints usage and exits 0`, async () => {
    for (const extraArgs of [[], ["--title", "unused", "--body-file", "/must-not-read.md"]]) {
      const output = await new Deno.Command(Deno.execPath(), {
        args: ["task", "create-issue", flag, ...extraArgs],
        cwd: new URL("../", import.meta.url),
        stdout: "piped",
        stderr: "piped",
        stdin: "null",
      }).output();
      assertEquals(output.code, 0);
      const text = new TextDecoder().decode(output.stdout) +
        new TextDecoder().decode(output.stderr);
      assertStringIncludes(text, "Usage: deno task create-issue");
      assertStringIncludes(text, "--body-file");
    }
  });
}

Deno.test("create-issue without a title exits with usage before reading the body or filing", async () => {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-prompt", "scripts/create-issue.ts", "--body-file", "/must-not-read.md"],
    cwd: new URL("../", import.meta.url),
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();
  assertEquals(output.code, 1);
  assertStringIncludes(new TextDecoder().decode(output.stderr), "Usage: deno task create-issue");
});
