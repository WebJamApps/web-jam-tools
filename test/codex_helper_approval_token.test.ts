import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { TEST_AUTHOR, withPassingProbe } from "./authored_by_test_helpers.ts";
import { resolveCodexTokenOwnerSync } from "../hooks/lib/codex_session_reader.ts";
import {
  checkIssueApprovalToken,
  checkIssueApprovalTokenAuto,
} from "../hooks/lib/check_issue_approval_token.ts";
import {
  checkApprovalToken,
  createIssueAndVerify,
  type ExecDeps,
  type IssueData,
} from "../src/create-issue/lib.ts";
import { filePlan } from "../src/design-issue/file_plan.ts";
import { installCodex } from "../src/install-codex/install.ts";

const SOL_P = "01900000-0000-7000-8000-000000000001";
const TERRA_H = "01900000-0000-7000-8000-000000000002";
const GRANDCHILD_X = "01900000-0000-7000-8000-000000000003";
const OTHER_Q = "01900000-0000-7000-8000-000000000004";
const EXEC_E = "01900000-0000-7000-8000-000000000005";
const VSCODE_V = "01900000-0000-7000-8000-000000000006";

const REPO = "WebJamApps/web-jam-tools";
const OTHER_REPO = "WebJamApps/JaMmusic";
const APPROVED_TITLE = "Sol approves Terra helper probe";
const UNAPPROVED_TITLE = "Unapproved title for helper";

function futureIso(hoursFromNow = 4): string {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

function pastIso(hoursAgo = 1): string {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

function envLookup(vars: Record<string, string | undefined>): (name: string) => string | undefined {
  return (name: string) => vars[name];
}

function sessionMetaLine(payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-11-21T12:00:00.000Z",
    type: "session_meta",
    payload,
  });
}

function userMessageLine(text: string): string {
  return JSON.stringify({
    timestamp: "2026-11-21T12:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

function humanPayload(
  id: string,
  source: "cli" | "vscode" | "exec" = "cli",
  originator = "codex-tui",
): Record<string, unknown> {
  return {
    id,
    timestamp: "2026-11-21T12:00:00.000Z",
    cwd: "/home/joshua/WebJamApps/web-jam-tools",
    originator,
    source,
    ...(source === "exec" ? { thread_source: "exec" } : { thread_source: "user" }),
  };
}

function helperPayload(
  id: string,
  nestedParentId: string,
  options: {
    topLevelParentId?: string | null;
    omitTopLevelParent?: boolean;
    depth?: number;
    threadSource?: string;
    originator?: string;
  } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id,
    timestamp: "2026-11-21T12:01:00.000Z",
    cwd: "/home/joshua/WebJamApps/web-jam-tools",
    originator: options.originator ?? "codex-tui",
    thread_source: options.threadSource ?? "subagent",
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: nestedParentId,
          depth: options.depth ?? 1,
          agent_nickname: "Terra",
          agent_role: "worker",
        },
      },
    },
  };
  if (!options.omitTopLevelParent) {
    payload.parent_thread_id = options.topLevelParentId === undefined
      ? nestedParentId
      : options.topLevelParentId;
  }
  return payload;
}

async function writeRollout(
  codexHome: string,
  threadId: string,
  payload: Record<string, unknown>,
  options: { subDir?: string; prefix?: string; extraLines?: string[] } = {},
): Promise<string> {
  const dir = path.join(codexHome, "sessions", options.subDir ?? "2026/11/21");
  await Deno.mkdir(dir, { recursive: true });
  const filePath = path.join(
    dir,
    `${options.prefix ?? "rollout-2026-11-21T12-00-00"}-${threadId}.jsonl`,
  );
  const lines = [sessionMetaLine(payload), ...(options.extraLines ?? [])];
  await Deno.writeTextFile(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

async function writeTokenFile(
  home: string,
  sessionId: string,
  overrides: Partial<{
    session_id: string;
    approvals: Array<{ repo: string; titles: string[] }>;
    expires_at: string;
  }> = {},
): Promise<string> {
  const dir = path.join(home, ".claude/state/issue-approval-tokens");
  await Deno.mkdir(dir, { recursive: true });
  const tokenPath = path.join(dir, `${sessionId}.json`);
  await Deno.writeTextFile(
    tokenPath,
    JSON.stringify({
      session_id: overrides.session_id ?? sessionId,
      approvals: overrides.approvals ?? [{ repo: REPO, titles: [APPROVED_TITLE] }],
      expires_at: overrides.expires_at ?? futureIso(),
    }),
  );
  return tokenPath;
}

async function withCodexFixture(
  fn: (ctx: {
    tmpRoot: string;
    home: string;
    codexHome: string;
    sessionsDir: string;
  }) => Promise<void>,
): Promise<void> {
  const tmpRoot = await Deno.makeTempDir();
  const home = path.join(tmpRoot, "home");
  const codexHome = path.join(tmpRoot, "codex-home");
  const sessionsDir = path.join(codexHome, "sessions");
  await Deno.mkdir(home, { recursive: true });
  await Deno.mkdir(sessionsDir, { recursive: true });
  try {
    await fn({ tmpRoot, home, codexHome, sessionsDir });
  } finally {
    await Deno.remove(tmpRoot, { recursive: true });
  }
}

function makeFakeIssueAndPlanDeps(
  envVars: Record<string, string | undefined>,
  ghCalls: string[][],
): ExecDeps {
  let nextIssueNumber = 900;
  const createdIssues = new Map<number, IssueData>();
  return withPassingProbe({
    approvalEnv: envLookup(envVars),
    readFileText: (p) => Deno.readTextFile(p),
    runCmd(cmd: string[]) {
      ghCalls.push(cmd);
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "create") {
        const title = cmd[cmd.indexOf("--title") + 1] ?? APPROVED_TITLE;
        const labelIdx = cmd.indexOf("--label");
        const labels = labelIdx !== -1 ? [{ name: cmd[labelIdx + 1] }] : [{ name: "Terra" }];
        const number = nextIssueNumber++;
        createdIssues.set(number, {
          number,
          title,
          type: { name: "Task" },
          labels,
          milestone: { title: "AI Misbehaves", number: 42 },
          issue_field_values: [{
            issue_field_name: "Priority",
            single_select_option: { name: "High" },
          }],
        });
        return Promise.resolve({
          code: 0,
          stdout: `https://github.com/${REPO}/issues/${number}\n`,
          stderr: "",
        });
      }
      if (cmd[0] === "gh" && cmd[1] === "api") {
        if (cmd[2].includes("issues?state=open")) {
          return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
        }
        if (cmd[2] === "graphql") {
          const query = cmd.find((a) => a.startsWith("query=")) ?? "";
          if (query.includes("GetChildNodeId")) {
            return Promise.resolve({
              code: 0,
              stdout: JSON.stringify({
                data: {
                  repository: { issue: { id: "ISSUE_NODE_1" } },
                },
              }),
              stderr: "",
            });
          }
          if (query.includes("GetChildAndTypes") || query.includes("RepositoryIssueProjectItems")) {
            return Promise.resolve({
              code: 0,
              stdout: JSON.stringify({
                data: {
                  repository: {
                    issue: { id: "ISSUE_NODE_1" },
                    issueTypes: { nodes: [{ id: "TYPE_TASK", name: "Task" }] },
                  },
                },
              }),
              stderr: "",
            });
          }
          if (query.includes("SetIssueType")) {
            return Promise.resolve({
              code: 0,
              stdout: JSON.stringify({ data: { updateIssue: {} } }),
              stderr: "",
            });
          }
        }
        const match = cmd[2].match(/\/issues\/(\d+)$/);
        if (match) {
          const issue = createdIssues.get(Number(match[1])) ?? {
            number: Number(match[1]),
            title: APPROVED_TITLE,
            type: { name: "Task" },
            labels: [{ name: "Terra" }],
          };
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ ...issue, id: Number(match[1]) * 10 }),
            stderr: "",
          });
        }
      }
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
  });
}

function hookIssueWritePayload(
  sessionId: string,
  transcriptPath?: string,
  overrides: { method?: string; title?: string; repo?: string } = {},
): string {
  const payload: Record<string, unknown> = {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    tool_name: "mcp__github__issue_write",
    tool_input: {
      method: overrides.method ?? "create",
      owner: "WebJamApps",
      repo: overrides.repo ?? "web-jam-tools",
      title: overrides.title ?? APPROVED_TITLE,
    },
  };
  if (transcriptPath !== undefined) {
    payload.transcript_path = transcriptPath;
  }
  return JSON.stringify(payload);
}

function hookSubIssueWritePayload(
  sessionId: string,
  transcriptPath?: string,
  overrides: { method?: string; repo?: string } = {},
): string {
  const payload: Record<string, unknown> = {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    tool_name: "mcp__github__sub_issue_write",
    tool_input: {
      method: overrides.method ?? "add",
      owner: "WebJamApps",
      repo: overrides.repo ?? "web-jam-tools",
      issue_number: 1857,
      sub_issue_id: 1873,
    },
  };
  if (transcriptPath !== undefined) {
    payload.transcript_path = transcriptPath;
  }
  return JSON.stringify(payload);
}

function hookBashPayload(
  sessionId: string,
  command: string,
  transcriptPath?: string,
): string {
  const payload: Record<string, unknown> = {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command },
  };
  if (transcriptPath !== undefined) {
    payload.transcript_path = transcriptPath;
  }
  return JSON.stringify(payload);
}

// --- Core resolver & parity tests covering all rows of "Filing from a Codex helper" ---

Deno.test("Codex resolver & guards allow direct human cli and vscode sessions with their own token", async () => {
  await withCodexFixture(async ({ tmpRoot, home, codexHome }) => {
    const cliRollout = await writeRollout(codexHome, SOL_P, humanPayload(SOL_P, "cli"));
    const vscodeRollout = await writeRollout(codexHome, VSCODE_V, humanPayload(VSCODE_V, "vscode"));
    await writeTokenFile(home, SOL_P);
    await writeTokenFile(home, VSCODE_V);

    const bodyFile = path.join(tmpRoot, "body.md");
    await Deno.writeTextFile(bodyFile, "## What this builds\n\nBody.\n");

    for (const [id, rollout] of [[SOL_P, cliRollout], [VSCODE_V, vscodeRollout]] as const) {
      const env = { HOME: home, CODEX_HOME: codexHome, CODEX_THREAD_ID: id, WJT_SURFACE: "codex" };
      assertEquals(resolveCodexTokenOwnerSync({ env: envLookup(env) }), id);
      assertEquals(
        resolveCodexTokenOwnerSync({
          threadId: id,
          rolloutPath: rollout,
          requireRolloutPath: true,
          env: envLookup(env),
        }),
        id,
      );

      const envFn = envLookup(env);
      assertEquals(
        checkIssueApprovalTokenAuto(hookIssueWritePayload(id, rollout), Date.now(), { env: envFn })
          .startsWith("ALLOW:"),
        true,
      );
      assertEquals(
        checkIssueApprovalTokenAuto(
          hookBashPayload(id, `deno task create-issue --title "${APPROVED_TITLE}"`, rollout),
          Date.now(),
          { env: envFn },
        ),
        "PASS",
      );
      assertEquals(
        checkApprovalToken(REPO, APPROVED_TITLE, undefined, Date.now(), { env: envFn }),
        { ok: true },
      );

      const ghCalls: string[][] = [];
      const created = await createIssueAndVerify(
        {
          title: APPROVED_TITLE,
          bodyFile,
          labels: ["Terra"],
          milestone: "AI Misbehaves",
          priority: "High",
          author: TEST_AUTHOR,
        },
        makeFakeIssueAndPlanDeps(env, ghCalls),
      );
      assertStringIncludes(created, APPROVED_TITLE);
      assertEquals(ghCalls.some((c) => c[1] === "issue" && c[2] === "create"), true);
    }
  });
});

Deno.test("Codex resolver & guards honor parent token for direct helper (both parent fields & nested-only)", async () => {
  await withCodexFixture(async ({ tmpRoot, home, codexHome }) => {
    await writeRollout(codexHome, SOL_P, humanPayload(SOL_P, "cli"));
    await writeRollout(codexHome, VSCODE_V, humanPayload(VSCODE_V, "vscode"));
    const helperBothRollout = await writeRollout(
      codexHome,
      TERRA_H,
      helperPayload(TERRA_H, SOL_P),
    );
    const nestedHelperId = "01900000-0000-7000-8000-000000000007";
    const helperNestedOnlyRollout = await writeRollout(
      codexHome,
      nestedHelperId,
      helperPayload(nestedHelperId, VSCODE_V, { omitTopLevelParent: true }),
    );
    await writeTokenFile(home, SOL_P);
    await writeTokenFile(home, VSCODE_V);

    const bodyFile = path.join(tmpRoot, "body.md");
    await Deno.writeTextFile(bodyFile, "## What this builds\n\nBody.\n");
    const planPath = path.join(tmpRoot, "plan.json");
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        milestone: "AI Misbehaves",
        designDoc: "test/fixtures/design-issue/fixture-design.md",
        children: [
          {
            id: 1,
            title: APPROVED_TITLE,
            body:
              '## What this builds\n\nChild.\n\n## Acceptance criteria\n\n- [ ] builds "Architecture" as written\n- [ ] `deno task test` passes\n',
            type: "Task",
            priority: "High",
            tier: "Terra",
          },
        ],
      }),
    );

    const cases = [
      { id: TERRA_H, rollout: helperBothRollout, owner: SOL_P },
      { id: nestedHelperId, rollout: helperNestedOnlyRollout, owner: VSCODE_V },
    ];

    for (const c of cases) {
      const env = {
        HOME: home,
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: c.id,
        WJT_SURFACE: "codex",
      };
      const envFn = envLookup(env);
      assertEquals(resolveCodexTokenOwnerSync({ env: envFn }), c.owner);
      assertEquals(
        checkIssueApprovalTokenAuto(
          hookIssueWritePayload(c.id, c.rollout),
          Date.now(),
          { env: envFn },
        ).startsWith("ALLOW:"),
        true,
      );
      assertEquals(
        checkIssueApprovalTokenAuto(
          hookSubIssueWritePayload(c.id, c.rollout),
          Date.now(),
          { env: envFn },
        ).startsWith("ALLOW:"),
        true,
      );
      assertEquals(
        checkIssueApprovalTokenAuto(
          hookBashPayload(c.id, `deno task create-issue --title "${APPROVED_TITLE}"`, c.rollout),
          Date.now(),
          { env: envFn },
        ),
        "PASS",
      );
      assertEquals(
        checkApprovalToken(REPO, APPROVED_TITLE, undefined, Date.now(), { env: envFn }),
        { ok: true },
      );

      const ghCreateCalls: string[][] = [];
      const created = await createIssueAndVerify(
        {
          title: APPROVED_TITLE,
          bodyFile,
          labels: ["Terra"],
          milestone: "AI Misbehaves",
          priority: "High",
          author: TEST_AUTHOR,
        },
        makeFakeIssueAndPlanDeps(env, ghCreateCalls),
      );
      assertStringIncludes(created, APPROVED_TITLE);
      assertEquals(ghCreateCalls.some((cmd) => cmd[2] === "create"), true);

      const ghPlanCalls: string[][] = [];
      const planResult = await filePlan({
        planPath,
        dryRun: false,
        author: TEST_AUTHOR,
        deps: makeFakeIssueAndPlanDeps(env, ghPlanCalls),
      });
      assertEquals(planResult.totalIssuesFiled, 1);
      assertEquals(ghPlanCalls.some((cmd) => cmd[2] === "create"), true);
    }
  });
});

Deno.test("Codex helper refuses when parent token is missing even if another live token Q exists (no directory-scan fallback)", async () => {
  await withCodexFixture(async ({ tmpRoot, home, codexHome }) => {
    await writeRollout(codexHome, SOL_P, humanPayload(SOL_P, "cli"));
    const helperRollout = await writeRollout(codexHome, TERRA_H, helperPayload(TERRA_H, SOL_P));
    const otherTokenPath = await writeTokenFile(home, OTHER_Q);

    const bodyFile = path.join(tmpRoot, "body.md");
    await Deno.writeTextFile(bodyFile, "## What this builds\n\nBody.\n");
    const planPath = path.join(tmpRoot, "plan.json");
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: "test/fixtures/design-issue/fixture-design.md",
        children: [{
          title: APPROVED_TITLE,
          body:
            '## What this builds\n\nBody.\n\n## Acceptance criteria\n\n- [ ] builds "Architecture" as written\n',
          tier: "Terra",
          priority: "High",
        }],
      }),
    );

    for (
      const extraEnv of [
        {},
        { ISSUE_APPROVAL_TOKEN_PATH: otherTokenPath },
      ]
    ) {
      const env = {
        HOME: home,
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: TERRA_H,
        WJT_SURFACE: "codex",
        ...extraEnv,
      };
      const envFn = envLookup(env);

      assertStringIncludes(
        checkIssueApprovalToken(
          hookIssueWritePayload(TERRA_H, helperRollout),
          otherTokenPath,
          Date.now(),
          { env: envFn },
        ),
        "DENY:",
      );
      assertStringIncludes(
        checkIssueApprovalTokenAuto(
          hookIssueWritePayload(TERRA_H, helperRollout),
          Date.now(),
          { env: envFn },
        ),
        "DENY:",
      );
      assertStringIncludes(
        checkIssueApprovalTokenAuto(
          hookSubIssueWritePayload(TERRA_H, helperRollout),
          Date.now(),
          { env: envFn },
        ),
        "DENY:",
      );
      assertStringIncludes(
        checkIssueApprovalTokenAuto(
          hookBashPayload(
            TERRA_H,
            `deno task create-issue --title "${APPROVED_TITLE}"`,
            helperRollout,
          ),
          Date.now(),
          { env: envFn },
        ),
        "DENY:",
      );
      const tokenCheck = checkApprovalToken(
        REPO,
        APPROVED_TITLE,
        undefined,
        Date.now(),
        { env: envFn },
      );
      assertEquals(tokenCheck.ok, false);

      const ghCalls: string[][] = [];
      await assertRejects(
        () =>
          createIssueAndVerify(
            {
              title: APPROVED_TITLE,
              bodyFile,
              labels: ["Terra"],
              author: TEST_AUTHOR,
            },
            makeFakeIssueAndPlanDeps(env, ghCalls),
          ),
        Error,
        "Gate 2 approval required",
      );
      await assertRejects(
        () =>
          filePlan({
            planPath,
            dryRun: false,
            author: TEST_AUTHOR,
            deps: makeFakeIssueAndPlanDeps(env, ghCalls),
          }),
        Error,
      );
      assertEquals(ghCalls, []);
    }
  });
});

Deno.test("Codex helper refuses unapproved title, wrong repo, and expired parent token before any gh call", async () => {
  await withCodexFixture(async ({ tmpRoot, home, codexHome }) => {
    await writeRollout(codexHome, SOL_P, humanPayload(SOL_P, "cli"));
    const helperRollout = await writeRollout(codexHome, TERRA_H, helperPayload(TERRA_H, SOL_P));
    const bodyFile = path.join(tmpRoot, "body.md");
    await Deno.writeTextFile(bodyFile, "## What this builds\n\nBody.\n");
    const env = {
      HOME: home,
      CODEX_HOME: codexHome,
      CODEX_THREAD_ID: TERRA_H,
      WJT_SURFACE: "codex",
    };
    const envFn = envLookup(env);

    // Live token for P, wrong title / wrong repo
    await writeTokenFile(home, SOL_P);
    assertStringIncludes(
      checkIssueApprovalTokenAuto(
        hookIssueWritePayload(TERRA_H, helperRollout, { title: UNAPPROVED_TITLE }),
        Date.now(),
        { env: envFn },
      ),
      "DENY:",
    );
    assertStringIncludes(
      checkIssueApprovalTokenAuto(
        hookSubIssueWritePayload(TERRA_H, helperRollout, { repo: "JaMmusic" }),
        Date.now(),
        { env: envFn },
      ),
      "DENY:",
    );
    const ghCalls: string[][] = [];
    await assertRejects(
      () =>
        createIssueAndVerify(
          { title: UNAPPROVED_TITLE, bodyFile, labels: ["Terra"], author: TEST_AUTHOR },
          makeFakeIssueAndPlanDeps(env, ghCalls),
        ),
      Error,
      "Gate 2 approval required",
    );
    await assertRejects(
      () =>
        createIssueAndVerify(
          {
            repo: OTHER_REPO,
            title: APPROVED_TITLE,
            bodyFile,
            labels: ["Terra"],
            author: TEST_AUTHOR,
          },
          makeFakeIssueAndPlanDeps(env, ghCalls),
        ),
      Error,
      "Gate 2 approval required",
    );
    assertEquals(ghCalls, []);

    // Expired token for P
    await writeTokenFile(home, SOL_P, { expires_at: pastIso() });
    assertStringIncludes(
      checkIssueApprovalTokenAuto(
        hookIssueWritePayload(TERRA_H, helperRollout),
        Date.now(),
        { env: envFn },
      ),
      "DENY:",
    );
    assertEquals(
      checkApprovalToken(REPO, APPROVED_TITLE, undefined, Date.now(), { env: envFn }).ok,
      false,
    );
  });
});

Deno.test("Codex resolver & guards refuse grandchild helpers, non-human parents, conflicting parent fields, and broken rollouts", async () => {
  await withCodexFixture(async ({ tmpRoot, home, codexHome }) => {
    await writeRollout(codexHome, SOL_P, humanPayload(SOL_P, "cli"));
    await writeRollout(codexHome, OTHER_Q, humanPayload(OTHER_Q, "cli"));
    await writeRollout(codexHome, EXEC_E, humanPayload(EXEC_E, "exec", "codex_exec"));
    await writeRollout(codexHome, TERRA_H, helperPayload(TERRA_H, SOL_P));
    const xDepth2 = await writeRollout(
      codexHome,
      GRANDCHILD_X,
      helperPayload(GRANDCHILD_X, TERRA_H, { depth: 2 }),
    );
    const xForgedId = "01900000-0000-7000-8000-000000000008";
    const xForgedDepth1 = await writeRollout(
      codexHome,
      xForgedId,
      helperPayload(xForgedId, TERRA_H, { depth: 1 }),
    );
    const execChildId = "01900000-0000-7000-8000-000000000009";
    const execChildRollout = await writeRollout(
      codexHome,
      execChildId,
      helperPayload(execChildId, EXEC_E),
    );
    const conflictId = "01900000-0000-7000-8000-000000000010";
    const conflictRollout = await writeRollout(
      codexHome,
      conflictId,
      helperPayload(conflictId, SOL_P, { topLevelParentId: OTHER_Q }),
    );
    const topOnlyId = "01900000-0000-7000-8000-000000000011";
    const topOnlyRollout = await writeRollout(
      codexHome,
      topOnlyId,
      {
        id: topOnlyId,
        originator: "codex-tui",
        source: "cli",
        thread_source: "user",
        parent_thread_id: SOL_P,
      },
    );
    const missingParentId = "01900000-0000-7000-8000-000000000012";
    const missingParentUuid = "01900000-0000-7000-8000-000000000099";
    const missingParentChildRollout = await writeRollout(
      codexHome,
      missingParentId,
      helperPayload(missingParentId, missingParentUuid),
    );
    const mismatchMetaId = "01900000-0000-7000-8000-000000000013";
    const mismatchMetaRollout = await writeRollout(
      codexHome,
      mismatchMetaId,
      humanPayload(SOL_P, "cli"),
    );
    const dupId = "01900000-0000-7000-8000-000000000014";
    const dupRollout1 = await writeRollout(
      codexHome,
      dupId,
      helperPayload(dupId, SOL_P),
      { prefix: "a" },
    );
    await writeRollout(codexHome, dupId, helperPayload(dupId, SOL_P), { prefix: "b" });

    // Parent Q also has a duplicate rollout so a helper citing Q must refuse.
    await writeRollout(codexHome, OTHER_Q, humanPayload(OTHER_Q, "cli"), { subDir: "2026/11/22" });
    const dupParentChildId = "01900000-0000-7000-8000-000000000015";
    const dupParentChildRollout = await writeRollout(
      codexHome,
      dupParentChildId,
      helperPayload(dupParentChildId, OTHER_Q),
    );

    await writeTokenFile(home, SOL_P);
    await writeTokenFile(home, OTHER_Q);
    await writeTokenFile(home, EXEC_E);
    await writeTokenFile(home, TERRA_H);

    const bodyFile = path.join(tmpRoot, "body.md");
    await Deno.writeTextFile(bodyFile, "## What this builds\n\nBody.\n");

    const invalidCases = [
      { label: "grandchild depth 2", id: GRANDCHILD_X, rollout: xDepth2 },
      { label: "grandchild forged depth 1", id: xForgedId, rollout: xForgedDepth1 },
      { label: "exec parent", id: execChildId, rollout: execChildRollout },
      { label: "conflicting parent_thread_id", id: conflictId, rollout: conflictRollout },
      {
        label: "top-level parent_thread_id without subagent",
        id: topOnlyId,
        rollout: topOnlyRollout,
      },
      { label: "missing parent rollout", id: missingParentId, rollout: missingParentChildRollout },
      { label: "mismatched meta.id", id: mismatchMetaId, rollout: mismatchMetaRollout },
      { label: "duplicate parent rollout", id: dupParentChildId, rollout: dupParentChildRollout },
    ];

    for (const c of invalidCases) {
      const env = {
        HOME: home,
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: c.id,
        WJT_SURFACE: "codex",
      };
      const envFn = envLookup(env);

      assertThrows(
        () => resolveCodexTokenOwnerSync({ env: envFn }),
        Error,
        undefined,
        c.label,
      );
      assertStringIncludes(
        checkIssueApprovalTokenAuto(
          hookIssueWritePayload(c.id, c.rollout),
          Date.now(),
          { env: envFn },
        ),
        "DENY:",
        c.label,
      );
      assertStringIncludes(
        checkIssueApprovalTokenAuto(
          hookBashPayload(c.id, `deno task create-issue --title "${APPROVED_TITLE}"`, c.rollout),
          Date.now(),
          { env: envFn },
        ),
        "DENY:",
        c.label,
      );
      assertEquals(
        checkApprovalToken(REPO, APPROVED_TITLE, undefined, Date.now(), { env: envFn }).ok,
        false,
        c.label,
      );

      const ghCalls: string[][] = [];
      await assertRejects(
        () =>
          createIssueAndVerify(
            { title: APPROVED_TITLE, bodyFile, labels: ["Terra"], author: TEST_AUTHOR },
            makeFakeIssueAndPlanDeps(env, ghCalls),
          ),
        Error,
        "Gate 2 approval required",
      );
      assertEquals(ghCalls, [], c.label);
    }

    // Duplicate helper rollout for CODEX_THREAD_ID lookup refuses in resolveCodexTokenOwnerSync / checkApprovalToken
    const dupEnv = envLookup({
      HOME: home,
      CODEX_HOME: codexHome,
      CODEX_THREAD_ID: dupId,
      WJT_SURFACE: "codex",
    });
    assertThrows(
      () => resolveCodexTokenOwnerSync({ env: dupEnv }),
      Error,
      "Multiple session files",
    );
    assertEquals(
      checkApprovalToken(REPO, APPROVED_TITLE, undefined, Date.now(), { env: dupEnv }).ok,
      false,
    );
    // Unused outside check keeps helper clean
    assertEquals(typeof dupRollout1, "string");
  });
});

Deno.test("Codex hook enforces transcript_path inside native sessions store (and leaves non-creating calls PASS)", async () => {
  await withCodexFixture(async ({ tmpRoot, home, codexHome }) => {
    await writeRollout(codexHome, SOL_P, humanPayload(SOL_P, "cli"));
    const helperRollout = await writeRollout(codexHome, TERRA_H, helperPayload(TERRA_H, SOL_P));
    await writeTokenFile(home, SOL_P);

    const outsideRollout = path.join(tmpRoot, `outside-${TERRA_H}.jsonl`);
    await Deno.writeTextFile(outsideRollout, await Deno.readTextFile(helperRollout));
    const symlinkInStore = path.join(codexHome, "sessions", `link-${TERRA_H}.jsonl`);
    await Deno.symlink(outsideRollout, symlinkInStore);

    const envFn = envLookup({ HOME: home, CODEX_HOME: codexHome, WJT_SURFACE: "codex" });

    for (
      const badPath of [
        undefined,
        "",
        `sessions/2026/11/21/rollout-${TERRA_H}.jsonl`,
        `${codexHome}/sessions/../sessions/2026/11/21/rollout-2026-11-21T12-00-00-${TERRA_H}.jsonl`,
        outsideRollout,
        symlinkInStore,
      ]
    ) {
      assertStringIncludes(
        checkIssueApprovalTokenAuto(
          hookIssueWritePayload(TERRA_H, badPath),
          Date.now(),
          { env: envFn },
        ),
        "DENY:",
      );
      assertStringIncludes(
        checkIssueApprovalTokenAuto(
          hookBashPayload(TERRA_H, `deno task create-issue --title "${APPROVED_TITLE}"`, badPath),
          Date.now(),
          { env: envFn },
        ),
        "DENY:",
      );
    }

    // Non-creating commands, --help, update, remove still PASS even with missing transcript_path and no token
    assertEquals(
      checkIssueApprovalTokenAuto(hookBashPayload(TERRA_H, "git status"), Date.now(), {
        env: envFn,
      }),
      "PASS",
    );
    assertEquals(
      checkIssueApprovalTokenAuto(
        hookBashPayload(TERRA_H, "deno task create-issue --help"),
        Date.now(),
        { env: envFn },
      ),
      "PASS",
    );
    assertEquals(
      checkIssueApprovalTokenAuto(
        hookIssueWritePayload(TERRA_H, undefined, { method: "update" }),
        Date.now(),
        { env: envFn },
      ),
      "PASS",
    );
    assertEquals(
      checkIssueApprovalTokenAuto(
        hookSubIssueWritePayload(TERRA_H, undefined, { method: "remove" }),
        Date.now(),
        { env: envFn },
      ),
      "PASS",
    );
  });
});

Deno.test("Token writer refuses --session-id P and --session-id H when run inside helper H (Row 16)", async () => {
  await withCodexFixture(async ({ home, codexHome }) => {
    await writeRollout(codexHome, SOL_P, humanPayload(SOL_P, "cli"), {
      extraLines: [userMessageLine("/design-issue")],
    });
    await writeRollout(codexHome, TERRA_H, helperPayload(TERRA_H, SOL_P), {
      extraLines: [userMessageLine("/design-issue")],
    });

    const repoRoot = path.resolve(path.fromFileUrl(new URL("../", import.meta.url)));
    for (const requestedId of [SOL_P, TERRA_H]) {
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-env",
          "--allow-read",
          "--allow-write",
          "--allow-run",
          path.join(repoRoot, "scripts/write_issue_approval_token.ts"),
          "--repo",
          REPO,
          "--title",
          APPROVED_TITLE,
          "--session-id",
          requestedId,
        ],
        env: {
          HOME: home,
          CODEX_HOME: codexHome,
          CODEX_THREAD_ID: TERRA_H,
          PATH: Deno.env.get("PATH") ?? "",
          AGY_HOOK_RECORD_PATH: "off",
        },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      assertEquals(out.code !== 0, true, `writer unexpectedly succeeded for ${requestedId}`);
      await assertRejects(
        () => Deno.stat(path.join(home, `.claude/state/issue-approval-tokens/${requestedId}.json`)),
        Deno.errors.NotFound,
      );
    }
  });
});

Deno.test("Installed Sol-to-Terra probe exercises registered Codex hook, createIssueAndVerify, and filePlan", async () => {
  await withCodexFixture(async ({ tmpRoot, home, codexHome }) => {
    const repoRoot = path.resolve(path.fromFileUrl(new URL("../", import.meta.url)));
    const hooksDest = path.join(home, ".claude/hooks");
    await Deno.mkdir(hooksDest, { recursive: true });
    for await (const entry of Deno.readDir(path.join(repoRoot, "hooks"))) {
      if (entry.isFile && entry.name.endsWith(".sh")) {
        await Deno.symlink(
          path.join(repoRoot, "hooks", entry.name),
          path.join(hooksDest, entry.name),
        );
      }
    }
    assertEquals(installCodex({ home, repo: repoRoot }), 0);

    const codexConfigRaw = await Deno.readTextFile(path.join(home, ".codex/config.toml"));
    const hookMatch = codexConfigRaw.match(
      /command\s*=\s*"([^"]*require-approval-token-on-issue-write\.sh[^"]*)"/,
    );
    const installedHookCmd = hookMatch?.[1];
    assertEquals(typeof installedHookCmd, "string");

    // Sol (P) human-started session with live approval token; Terra (H) direct depth-1 helper
    await writeRollout(codexHome, SOL_P, humanPayload(SOL_P, "cli"));
    const terraRollout = await writeRollout(codexHome, TERRA_H, helperPayload(TERRA_H, SOL_P));
    const grandchildRollout = await writeRollout(
      codexHome,
      GRANDCHILD_X,
      helperPayload(GRANDCHILD_X, TERRA_H, { depth: 2 }),
    );
    await writeTokenFile(home, SOL_P);

    const runInstalledHook = async (stdinJson: string) => {
      const cmd = new Deno.Command("bash", {
        args: ["-c", installedHookCmd!],
        env: {
          HOME: home,
          CODEX_HOME: codexHome,
          PATH: Deno.env.get("PATH") ?? "",
          AGY_HOOK_RECORD_PATH: "off",
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });
      const child = cmd.spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdinJson));
      await writer.close();
      const out = await child.output();
      return {
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    };

    // 1. Installed Codex shell hook allows Terra's approved issue_write and passes approved Bash create
    const allowRes = await runInstalledHook(hookIssueWritePayload(TERRA_H, terraRollout));
    assertEquals(allowRes.code, 0, allowRes.stderr);
    assertStringIncludes(allowRes.stdout, "allow");

    const passBashRes = await runInstalledHook(
      hookBashPayload(TERRA_H, `deno task create-issue --title "${APPROVED_TITLE}"`, terraRollout),
    );
    assertEquals(passBashRes.code, 0, passBashRes.stderr);

    // 2. Installed Codex shell hook refuses grandchild X and unapproved titles
    const denyGrandchild = await runInstalledHook(
      hookIssueWritePayload(GRANDCHILD_X, grandchildRollout),
    );
    assertEquals(denyGrandchild.code !== 0 || denyGrandchild.stdout.includes("deny"), true);

    // 3. Real Deno.env execution of createIssueAndVerify and filePlan (no custom approvalEnv!)
    const prev = {
      HOME: Deno.env.get("HOME"),
      CODEX_HOME: Deno.env.get("CODEX_HOME"),
      CODEX_THREAD_ID: Deno.env.get("CODEX_THREAD_ID"),
      ISSUE_APPROVAL_TOKEN_PATH: Deno.env.get("ISSUE_APPROVAL_TOKEN_PATH"),
    };
    const bodyFile = path.join(tmpRoot, "probe-body.md");
    await Deno.writeTextFile(bodyFile, "## What this builds\n\nSol-to-Terra probe.\n");
    const planPath = path.join(tmpRoot, "probe-plan.json");
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        milestone: "AI Misbehaves",
        designDoc: "test/fixtures/design-issue/fixture-design.md",
        children: [
          {
            id: 1,
            title: APPROVED_TITLE,
            body:
              '## What this builds\n\nProbe.\n\n## Acceptance criteria\n\n- [ ] builds "Architecture" as written\n- [ ] `deno task test` passes\n',
            type: "Task",
            priority: "High",
            tier: "Terra",
          },
        ],
      }),
    );

    try {
      Deno.env.delete("ISSUE_APPROVAL_TOKEN_PATH");
      Deno.env.set("HOME", home);
      Deno.env.set("CODEX_HOME", codexHome);
      Deno.env.set("CODEX_THREAD_ID", TERRA_H);

      const terraCalls: string[][] = [];
      const terraRunner = makeFakeIssueAndPlanDeps(
        { HOME: home, CODEX_HOME: codexHome, CODEX_THREAD_ID: TERRA_H },
        terraCalls,
      ).runCmd;
      const deps = withPassingProbe({
        readFileText: (p: string) => Deno.readTextFile(p),
        runCmd: terraRunner,
      });
      const created = await createIssueAndVerify(
        {
          title: APPROVED_TITLE,
          bodyFile,
          labels: ["Terra"],
          milestone: "AI Misbehaves",
          priority: "High",
          author: TEST_AUTHOR,
        },
        deps,
      );
      assertStringIncludes(created, APPROVED_TITLE);
      assertEquals(terraCalls.some((c) => c[2] === "create"), true);

      const planCalls: string[][] = [];
      const planRunner = makeFakeIssueAndPlanDeps(
        { HOME: home, CODEX_HOME: codexHome, CODEX_THREAD_ID: TERRA_H },
        planCalls,
      ).runCmd;
      const planResult = await filePlan({
        planPath,
        dryRun: false,
        author: TEST_AUTHOR,
        deps: withPassingProbe({
          readFileText: (p: string) => Deno.readTextFile(p),
          runCmd: planRunner,
        }),
      });
      assertEquals(planResult.totalIssuesFiled, 1);

      // Grandchild X refuses in real Deno.env BEFORE any fake gh call
      Deno.env.set("CODEX_THREAD_ID", GRANDCHILD_X);
      const grandchildCalls: string[][] = [];
      await assertRejects(
        () =>
          createIssueAndVerify(
            { title: APPROVED_TITLE, bodyFile, labels: ["Terra"], author: TEST_AUTHOR },
            withPassingProbe({
              readFileText: (p: string) => Deno.readTextFile(p),
              runCmd: (cmd: string[]) => {
                grandchildCalls.push(cmd);
                return Promise.resolve({ code: 0, stdout: "", stderr: "" });
              },
            }),
          ),
        Error,
        "Gate 2 approval required",
      );
      assertEquals(grandchildCalls, []);
    } finally {
      if (prev.HOME === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", prev.HOME);
      if (prev.CODEX_HOME === undefined) Deno.env.delete("CODEX_HOME");
      else Deno.env.set("CODEX_HOME", prev.CODEX_HOME);
      if (prev.CODEX_THREAD_ID === undefined) Deno.env.delete("CODEX_THREAD_ID");
      else Deno.env.set("CODEX_THREAD_ID", prev.CODEX_THREAD_ID);
      if (prev.ISSUE_APPROVAL_TOKEN_PATH === undefined) {
        Deno.env.delete("ISSUE_APPROVAL_TOKEN_PATH");
      } else Deno.env.set("ISSUE_APPROVAL_TOKEN_PATH", prev.ISSUE_APPROVAL_TOKEN_PATH);
    }
  });
});
