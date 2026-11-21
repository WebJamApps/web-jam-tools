import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { TEST_AUTHOR, withPassingProbe } from "./authored_by_test_helpers.ts";
import { resolveAntigravityTokenOwnerSync } from "../hooks/lib/agy_session_reader.ts";
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

const P = "11111111-1111-4111-8111-111111111111";
const H = "22222222-2222-4222-8222-222222222222";
const X = "33333333-3333-4333-8333-333333333333";
const G = "44444444-4444-4444-8444-444444444444";

const REPO = "WebJamApps/web-jam-tools";
const OTHER_REPO = "WebJamApps/web-jam-back";
const APPROVED_TITLE = "Hydrogen approval probe";
const OTHER_TITLE = "Another title";

const NOW_MS = Date.parse("2026-11-20T21:00:00Z");
const EXPIRES_AT = "2026-11-20T22:00:00Z";
const EXPIRED_MS = Date.parse("2026-11-20T22:00:01Z");

const CREATE_CMD =
  'deno task create-issue --repo WebJamApps/web-jam-tools --title "Hydrogen approval probe" --type Task --label Hydrogen';

function envLookup(vars: Record<string, string | undefined>): (name: string) => string | undefined {
  return (name: string) => vars[name];
}

function brainTranscriptPath(brainRoot: string, convId: string): string {
  return path.join(brainRoot, convId, ".system_generated/logs/transcript.jsonl");
}

async function writeSubagentRecord(
  brainRoot: string,
  parentId: string,
  childFileId: string,
  content: string | Record<string, unknown>,
): Promise<string> {
  const dir = path.join(brainRoot, parentId, ".system_generated/subagents");
  await Deno.mkdir(dir, { recursive: true });
  const recordPath = path.join(dir, `${childFileId}.json`);
  const serialized = typeof content === "string" ? content : JSON.stringify(content);
  await Deno.writeTextFile(recordPath, serialized);
  return recordPath;
}

function defaultWorkerRecord(childId: string): Record<string, unknown> {
  return {
    conversationId: childId,
    subagentDescriptor: { typeName: "worker", role: "Swarm Worker (hydrogen-filer)" },
  };
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
      expires_at: overrides.expires_at ?? EXPIRES_AT,
    }),
  );
  return tokenPath;
}

async function writeTranscriptFile(
  brainRoot: string,
  convId: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  const logPath = brainTranscriptPath(brainRoot, convId);
  await Deno.mkdir(path.dirname(logPath), { recursive: true });
  await Deno.writeTextFile(logPath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return logPath;
}

async function withAgyFixture(
  fn: (ctx: {
    tmpRoot: string;
    home: string;
    brainRoot: string;
    bodyFile: string;
    planPath: string;
  }) => Promise<void>,
): Promise<void> {
  const tmpRoot = await Deno.makeTempDir();
  const home = path.join(tmpRoot, "home");
  const brainRoot = path.join(home, ".gemini/antigravity-cli/brain");
  await Deno.mkdir(brainRoot, { recursive: true });
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
            '## What this builds\n\nBody.\n\n## Acceptance criteria\n\n- [ ] builds "Architecture" as written\n',
          type: "Task",
          priority: "High",
          tier: "Hydrogen",
        },
      ],
    }),
  );
  try {
    await fn({ tmpRoot, home, brainRoot, bodyFile, planPath });
  } finally {
    await Deno.chmod(brainRoot, 0o755).catch(() => {});
    await Deno.remove(tmpRoot, { recursive: true });
  }
}

function makeFakeGhDeps(
  envVars: Record<string, string | undefined>,
  ghCalls: string[][],
): ExecDeps {
  let nextIssueNumber = 901;
  const created = new Map<number, IssueData>();
  return withPassingProbe({
    approvalEnv: envLookup(envVars),
    readFileText: (p: string) => Deno.readTextFile(p),
    runCmd(cmd: string[]) {
      ghCalls.push(cmd);
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "create") {
        const title = cmd[cmd.indexOf("--title") + 1] ?? APPROVED_TITLE;
        const number = nextIssueNumber++;
        created.set(number, {
          number,
          title,
          type: { name: "Task" },
          labels: [{ name: "Hydrogen" }],
          milestone: { title: "AI Misbehaves", number: 5 },
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
              stdout: JSON.stringify({ data: { repository: { issue: { id: "ISSUE_NODE_1" } } } }),
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
          const issue = created.get(Number(match[1])) ?? {
            number: Number(match[1]),
            title: APPROVED_TITLE,
            type: { name: "Task" },
            labels: [{ name: "Hydrogen" }],
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

function hookBash(convId: string, transcriptPath: string | undefined, command: string): string {
  return JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    conversationId: convId,
    session_id: convId,
    modelName: "gemini-4-hydrogen-high",
    ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
  });
}

function hookIssueWrite(
  convId: string,
  transcriptPath: string | undefined,
  overrides: { title?: string; repo?: string; method?: string } = {},
): string {
  return JSON.stringify({
    tool_name: "mcp__github__issue_write",
    tool_input: {
      method: overrides.method ?? "create",
      owner: "WebJamApps",
      repo: overrides.repo ?? "web-jam-tools",
      title: overrides.title ?? APPROVED_TITLE,
    },
    conversationId: convId,
    session_id: convId,
    modelName: "gemini-4-hydrogen-high",
    ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
  });
}

function hookSubIssueWrite(
  convId: string,
  transcriptPath: string | undefined,
  repo = "web-jam-tools",
  method = "add",
): string {
  return JSON.stringify({
    tool_name: "mcp__github__sub_issue_write",
    tool_input: {
      method,
      owner: "WebJamApps",
      repo,
      issue_number: 1857,
      sub_issue_id: 1,
    },
    conversationId: convId,
    session_id: convId,
    modelName: "gemini-4-hydrogen-high",
    ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
  });
}

Deno.test("Antigravity resolver & guards: root session P passes under own token (Row 1)", async () => {
  await withAgyFixture(async ({ home, brainRoot, bodyFile, planPath }) => {
    await writeTokenFile(home, P, { expires_at: new Date(Date.now() + 3600_000).toISOString() });
    const pTranscript = brainTranscriptPath(brainRoot, P);
    const env = {
      HOME: home,
      WJT_SURFACE: "agy",
      AGY_CONVERSATION_ID: P,
      AGY_TRANSCRIPT_PATH: pTranscript,
      AGY_MODEL_NAME: "gemini-4-hydrogen-high",
    };
    const envFn = envLookup(env);

    assertEquals(resolveAntigravityTokenOwnerSync({ env: envFn }), P);
    assertEquals(
      checkIssueApprovalTokenAuto(hookBash(P, pTranscript, CREATE_CMD), NOW_MS, { env: envFn }),
      "PASS",
    );
    assertEquals(
      checkIssueApprovalTokenAuto(hookIssueWrite(P, pTranscript), NOW_MS, { env: envFn })
        .startsWith(
          "ALLOW:",
        ),
      true,
    );
    assertEquals(
      checkApprovalToken(REPO, APPROVED_TITLE, undefined, NOW_MS, { env: envFn }),
      { ok: true },
    );

    const ghCreateCalls: string[][] = [];
    const created = await createIssueAndVerify(
      {
        title: APPROVED_TITLE,
        bodyFile,
        labels: ["Hydrogen"],
        milestone: "AI Misbehaves",
        priority: "High",
        author: TEST_AUTHOR,
      },
      makeFakeGhDeps(env, ghCreateCalls),
    );
    assertStringIncludes(created, APPROVED_TITLE);
    assertEquals(ghCreateCalls.some((c) => c[2] === "create"), true);

    const ghPlanCalls: string[][] = [];
    const planRes = await filePlan({
      planPath,
      dryRun: false,
      author: TEST_AUTHOR,
      deps: makeFakeGhDeps(env, ghPlanCalls),
    });
    assertEquals(planRes.totalIssuesFiled, 1);
    assertEquals(ghPlanCalls.some((c) => c[2] === "create"), true);
  });
});

Deno.test("Antigravity resolver & guards: direct helper H (swarm worker & subagent) passes under P's token (Rows 2 & 14)", async () => {
  await withAgyFixture(async ({ home, brainRoot, bodyFile, planPath }) => {
    await writeSubagentRecord(brainRoot, P, H, defaultWorkerRecord(H));
    await writeTokenFile(home, P, { expires_at: new Date(Date.now() + 3600_000).toISOString() });
    const hTranscript = brainTranscriptPath(brainRoot, H);
    const env = {
      HOME: home,
      WJT_SURFACE: "agy",
      AGY_CONVERSATION_ID: H,
      AGY_TRANSCRIPT_PATH: hTranscript,
      AGY_MODEL_NAME: "gemini-4-hydrogen-high",
    };
    const envFn = envLookup(env);

    assertEquals(resolveAntigravityTokenOwnerSync({ env: envFn }), P);
    assertEquals(
      checkIssueApprovalTokenAuto(hookBash(H, hTranscript, CREATE_CMD), NOW_MS, { env: envFn }),
      "PASS",
    );
    assertEquals(
      checkIssueApprovalTokenAuto(hookIssueWrite(H, hTranscript), NOW_MS, { env: envFn })
        .startsWith(
          "ALLOW:",
        ),
      true,
    );
    // Row 14: sub_issue_write add in approved repo allows; other repo denies
    assertEquals(
      checkIssueApprovalTokenAuto(
        hookSubIssueWrite(H, hTranscript, "web-jam-tools", "add"),
        NOW_MS,
        { env: envFn },
      ).startsWith("ALLOW:"),
      true,
    );
    assertStringIncludes(
      checkIssueApprovalTokenAuto(
        hookSubIssueWrite(H, hTranscript, "web-jam-back", "add"),
        NOW_MS,
        { env: envFn },
      ),
      "DENY:",
    );
    assertEquals(
      checkApprovalToken(REPO, APPROVED_TITLE, undefined, NOW_MS, { env: envFn }),
      { ok: true },
    );

    const ghCreateCalls: string[][] = [];
    const created = await createIssueAndVerify(
      {
        title: APPROVED_TITLE,
        bodyFile,
        labels: ["Hydrogen"],
        milestone: "AI Misbehaves",
        priority: "High",
        author: TEST_AUTHOR,
      },
      makeFakeGhDeps(env, ghCreateCalls),
    );
    assertStringIncludes(created, APPROVED_TITLE);
    assertEquals(ghCreateCalls.some((c) => c[2] === "create"), true);

    const ghPlanCalls: string[][] = [];
    const planRes = await filePlan({
      planPath,
      dryRun: false,
      author: TEST_AUTHOR,
      deps: makeFakeGhDeps(env, ghPlanCalls),
    });
    assertEquals(planRes.totalIssuesFiled, 1);
    assertEquals(ghPlanCalls.some((c) => c[2] === "create"), true);
  });
});

Deno.test("Antigravity helper refuses wrong title, wrong repo, expired token, and unrelated root X (Rows 3, 4, 5, 6)", async () => {
  await withAgyFixture(async ({ home, brainRoot, bodyFile, planPath }) => {
    await writeSubagentRecord(brainRoot, P, H, defaultWorkerRecord(H));
    const pTokenPath = await writeTokenFile(home, P, { expires_at: EXPIRES_AT });
    const hTranscript = brainTranscriptPath(brainRoot, H);
    const xTranscript = brainTranscriptPath(brainRoot, X);

    const envH = {
      HOME: home,
      WJT_SURFACE: "agy",
      AGY_CONVERSATION_ID: H,
      AGY_TRANSCRIPT_PATH: hTranscript,
    };
    const envFnH = envLookup(envH);

    // Row 3: --title "Another title"
    const wrongTitleCmd =
      'deno task create-issue --repo WebJamApps/web-jam-tools --title "Another title" --type Task --label Hydrogen';
    assertStringIncludes(
      checkIssueApprovalTokenAuto(hookBash(H, hTranscript, wrongTitleCmd), NOW_MS, { env: envFnH }),
      "DENY:",
    );
    assertStringIncludes(
      checkIssueApprovalTokenAuto(
        hookIssueWrite(H, hTranscript, { title: OTHER_TITLE }),
        NOW_MS,
        { env: envFnH },
      ),
      "DENY:",
    );

    // Row 4: --repo WebJamApps/web-jam-back
    const wrongRepoCmd =
      'deno task create-issue --repo WebJamApps/web-jam-back --title "Hydrogen approval probe" --type Task --label Hydrogen';
    assertStringIncludes(
      checkIssueApprovalTokenAuto(hookBash(H, hTranscript, wrongRepoCmd), NOW_MS, { env: envFnH }),
      "DENY:",
    );

    // Row 5: clock past expiry (2026-11-20T22:00:01Z)
    assertStringIncludes(
      checkIssueApprovalTokenAuto(hookBash(H, hTranscript, CREATE_CMD), EXPIRED_MS, {
        env: envFnH,
      }),
      "DENY:",
    );
    assertEquals(
      checkApprovalToken(REPO, APPROVED_TITLE, undefined, EXPIRED_MS, { env: envFnH }).ok,
      false,
    );

    // Refresh P's token relative to Date.now() so createIssueAndVerify / filePlan test title, repo, and unrelated root X without expiry confusion
    await writeTokenFile(home, P, { expires_at: new Date(Date.now() + 3600_000).toISOString() });
    const ghCalls: string[][] = [];
    await assertRejects(
      () =>
        createIssueAndVerify(
          { title: OTHER_TITLE, bodyFile, labels: ["Hydrogen"], author: TEST_AUTHOR },
          makeFakeGhDeps(envH, ghCalls),
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
            labels: ["Hydrogen"],
            author: TEST_AUTHOR,
          },
          makeFakeGhDeps(envH, ghCalls),
        ),
      Error,
      "Gate 2 approval required",
    );

    // Row 6: Unrelated root conversation X with no token refuses even with P's live token present (and even if ISSUE_APPROVAL_TOKEN_PATH points at P's token!)
    const envX = {
      HOME: home,
      WJT_SURFACE: "agy",
      AGY_CONVERSATION_ID: X,
      AGY_TRANSCRIPT_PATH: xTranscript,
    };
    const envFnX = envLookup(envX);
    assertEquals(resolveAntigravityTokenOwnerSync({ env: envFnX }), X);
    assertStringIncludes(
      checkIssueApprovalTokenAuto(hookBash(X, xTranscript, CREATE_CMD), NOW_MS, { env: envFnX }),
      "DENY:",
    );
    assertStringIncludes(
      checkIssueApprovalToken(hookIssueWrite(X, xTranscript), pTokenPath, NOW_MS, { env: envFnX }),
      "DENY:",
    );
    assertEquals(
      checkApprovalToken(REPO, APPROVED_TITLE, undefined, NOW_MS, { env: envFnX }).ok,
      false,
    );
    await assertRejects(
      () =>
        createIssueAndVerify(
          { title: APPROVED_TITLE, bodyFile, labels: ["Hydrogen"], author: TEST_AUTHOR },
          makeFakeGhDeps(envX, ghCalls),
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
          deps: makeFakeGhDeps(envX, ghCalls),
        }),
      Error,
    );
    assertEquals(ghCalls, []);
  });
});

Deno.test("Antigravity helper refuses mismatched conversationId, malformed record, ambiguous parent, grandchild, missing parent token, unreadable brain, and '..' path (Rows 7-12)", async () => {
  await withAgyFixture(async ({ tmpRoot, home, brainRoot, bodyFile, planPath }) => {
    const hTranscript = brainTranscriptPath(brainRoot, H);
    const liveExpires = new Date(Date.now() + 3600_000).toISOString();
    await writeTokenFile(home, P, { expires_at: liveExpires });
    await writeTokenFile(home, X, { expires_at: liveExpires });
    await writeTokenFile(home, G, { expires_at: liveExpires });

    const assertAllRefuse = async (
      label: string,
      envVars: Record<string, string | undefined>,
      transcriptArg: string | undefined,
    ) => {
      const envFn = envLookup(envVars);
      assertThrows(
        () => resolveAntigravityTokenOwnerSync({ env: envFn }),
        Error,
        undefined,
        `${label} resolver`,
      );
      assertStringIncludes(
        checkIssueApprovalTokenAuto(
          hookBash(envVars.AGY_CONVERSATION_ID ?? "", transcriptArg, CREATE_CMD),
          Date.now(),
          { env: envFn },
        ),
        "DENY:",
        `${label} hook bash`,
      );
      assertStringIncludes(
        checkIssueApprovalTokenAuto(
          hookIssueWrite(envVars.AGY_CONVERSATION_ID ?? "", transcriptArg),
          Date.now(),
          { env: envFn },
        ),
        "DENY:",
        `${label} hook issue_write`,
      );
      assertEquals(
        checkApprovalToken(REPO, APPROVED_TITLE, undefined, Date.now(), { env: envFn }).ok,
        false,
        `${label} checkApprovalToken`,
      );
      const ghCalls: string[][] = [];
      await assertRejects(
        () =>
          createIssueAndVerify(
            { title: APPROVED_TITLE, bodyFile, labels: ["Hydrogen"], author: TEST_AUTHOR },
            makeFakeGhDeps(envVars, ghCalls),
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
            deps: makeFakeGhDeps(envVars, ghCalls),
          }),
        Error,
      );
      assertEquals(ghCalls, [], label);
    };

    const baseEnv = {
      HOME: home,
      WJT_SURFACE: "agy",
      AGY_CONVERSATION_ID: H,
      AGY_TRANSCRIPT_PATH: hTranscript,
    };

    // Row 7: conversationId mismatch inside subagent record
    const recordPath = await writeSubagentRecord(brainRoot, P, H, defaultWorkerRecord(X));
    await assertAllRefuse("Row 7 mismatched conversationId", baseEnv, hTranscript);

    // Row 8: malformed JSON
    await writeSubagentRecord(brainRoot, P, H, "{not-valid-json");
    await assertAllRefuse("Row 8 malformed subagent JSON", baseEnv, hTranscript);

    // Row 9: both P and X hold subagents/<H>.json (ambiguous parent)
    await writeSubagentRecord(brainRoot, P, H, defaultWorkerRecord(H));
    const xRec = await writeSubagentRecord(brainRoot, X, H, defaultWorkerRecord(H));
    await assertAllRefuse("Row 9 ambiguous parent", baseEnv, hTranscript);
    await Deno.remove(xRec);

    // Row 10: grandchild — P is named under G/.system_generated/subagents/<P>.json
    const gRec = await writeSubagentRecord(brainRoot, G, P, defaultWorkerRecord(P));
    await assertAllRefuse("Row 10 grandchild helper", baseEnv, hTranscript);
    await Deno.remove(gRec);

    // Row 11: valid direct helper H, but P's token file is missing (even with H's own token present)
    await writeTokenFile(home, H, { expires_at: liveExpires });
    await Deno.remove(path.join(home, `.claude/state/issue-approval-tokens/${P}.json`));
    assertEquals(resolveAntigravityTokenOwnerSync({ env: envLookup(baseEnv) }), P);
    assertStringIncludes(
      checkIssueApprovalTokenAuto(hookBash(H, hTranscript, CREATE_CMD), Date.now(), {
        env: envLookup(baseEnv),
      }),
      "DENY:",
    );
    assertEquals(
      checkApprovalToken(REPO, APPROVED_TITLE, undefined, Date.now(), { env: envLookup(baseEnv) })
        .ok,
      false,
    );
    await writeTokenFile(home, P, { expires_at: liveExpires });

    // Row 12a: '..' in transcript_path
    const dotDotTranscript = `${brainRoot}/${H}/.system_generated/logs/../logs/transcript.jsonl`;
    await assertAllRefuse(
      "Row 12a '..' in transcript path",
      { ...baseEnv, AGY_TRANSCRIPT_PATH: dotDotTranscript },
      dotDotTranscript,
    );

    // Row 12b: transcript_path outside <brain>
    const outsideTranscript = path.join(tmpRoot, "outside/logs/transcript.jsonl");
    await assertAllRefuse(
      "Row 12b transcript path outside brain",
      { ...baseEnv, AGY_TRANSCRIPT_PATH: outsideTranscript },
      outsideTranscript,
    );

    // Row 12c: unreadable <brain>
    await Deno.chmod(brainRoot, 0o000);
    try {
      await assertAllRefuse("Row 12c unreadable brain", baseEnv, hTranscript);
    } finally {
      await Deno.chmod(brainRoot, 0o755);
    }

    assertEquals(typeof recordPath, "string");
  });
});

Deno.test("Antigravity helper H cannot write approval token for P or H (Row 13)", async () => {
  await withAgyFixture(async ({ home, brainRoot }) => {
    await writeSubagentRecord(brainRoot, P, H, defaultWorkerRecord(H));
    await writeTranscriptFile(brainRoot, P, [
      {
        source: "USER_INPUT",
        conversationId: P,
        content: `<USER_REQUEST>\n/design-issue\n</USER_REQUEST>`,
      },
    ]);
    const hTranscript = await writeTranscriptFile(brainRoot, H, [
      {
        source: "USER_INPUT",
        conversationId: H,
        content: `<USER_REQUEST>\n/design-issue\n</USER_REQUEST>`,
      },
    ]);

    const repoRoot = path.resolve(path.fromFileUrl(new URL("../", import.meta.url)));
    for (const sessionId of [P, H]) {
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
          sessionId,
        ],
        env: {
          HOME: home,
          AGY_CONVERSATION_ID: H,
          AGY_TRANSCRIPT_PATH: hTranscript,
          PATH: Deno.env.get("PATH") ?? "",
          AGY_HOOK_RECORD_PATH: "off",
        },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      assertEquals(out.code !== 0, true, `writer unexpectedly succeeded for ${sessionId}`);
      await assertRejects(
        () => Deno.stat(path.join(home, `.claude/state/issue-approval-tokens/${sessionId}.json`)),
        Deno.errors.NotFound,
      );
    }
  });
});

Deno.test("Installed agy probe via agy-hook-shim.sh, createIssueAndVerify, and filePlan (Both surfaces)", async () => {
  await withAgyFixture(async ({ home, brainRoot, bodyFile, planPath }) => {
    const repoRoot = path.resolve(path.fromFileUrl(new URL("../", import.meta.url)));
    const hooksDest = path.join(home, ".claude/hooks");
    await Deno.mkdir(hooksDest, { recursive: true });
    for (
      const name of ["require-approval-token-on-issue-write.sh", "agy-hook-shim.sh"]
    ) {
      await Deno.symlink(path.join(repoRoot, "hooks", name), path.join(hooksDest, name));
    }

    await writeSubagentRecord(brainRoot, P, H, defaultWorkerRecord(H));
    await writeSubagentRecord(brainRoot, P, G, defaultWorkerRecord(G));
    await writeSubagentRecord(brainRoot, G, X, defaultWorkerRecord(X)); // X is grandchild of P via G
    await writeTokenFile(home, P, { expires_at: new Date(Date.now() + 3600_000).toISOString() });

    const hTranscript = await writeTranscriptFile(brainRoot, H, []);
    const xTranscript = await writeTranscriptFile(brainRoot, X, []);
    const matcherB64 = btoa("Bash|mcp__.*__(issue_write|sub_issue_write)");
    const installedTargetHook = path.join(hooksDest, "require-approval-token-on-issue-write.sh");
    const shimPath = path.join(hooksDest, "agy-hook-shim.sh");

    const runShimHook = async (agyRawPayload: Record<string, unknown>) => {
      const cmd = new Deno.Command("bash", {
        args: [shimPath, "PreToolUse", matcherB64, installedTargetHook],
        env: {
          HOME: home,
          PATH: Deno.env.get("PATH") ?? "",
          AGY_HOOK_RECORD_PATH: "off",
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });
      const child = cmd.spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify(agyRawPayload)));
      await writer.close();
      const out = await child.output();
      assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
      return JSON.parse(new TextDecoder().decode(out.stdout)) as {
        decision: string;
        reason?: string;
      };
    };

    // Direct helper H allowed for approved issue_write and create-issue Bash call through agy shim
    const issueWriteAllow = await runShimHook({
      conversationId: H,
      modelName: "gemini-4-hydrogen-high",
      transcriptPath: hTranscript,
      toolCall: {
        name: "issue_write",
        args: {
          method: "create",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          title: APPROVED_TITLE,
        },
      },
    });
    assertEquals(issueWriteAllow.decision, "allow");

    const bashPass = await runShimHook({
      conversationId: H,
      modelName: "gemini-4-hydrogen-high",
      transcriptPath: hTranscript,
      toolCall: { name: "run_command", args: { CommandLine: CREATE_CMD } },
    });
    assertEquals(bashPass.decision, "allow");

    // Grandchild X denied through agy shim
    const grandchildDeny = await runShimHook({
      conversationId: X,
      modelName: "gemini-4-hydrogen-high",
      transcriptPath: xTranscript,
      toolCall: {
        name: "issue_write",
        args: {
          method: "create",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          title: APPROVED_TITLE,
        },
      },
    });
    assertEquals(grandchildDeny.decision, "deny");

    // Real Deno.env execution for createIssueAndVerify & filePlan (no custom approvalEnv!)
    const prev = {
      HOME: Deno.env.get("HOME"),
      ISSUE_APPROVAL_TOKEN_PATH: Deno.env.get("ISSUE_APPROVAL_TOKEN_PATH"),
      CODEX_THREAD_ID: Deno.env.get("CODEX_THREAD_ID"),
      CODEX_HOME: Deno.env.get("CODEX_HOME"),
      WJT_SURFACE: Deno.env.get("WJT_SURFACE"),
      AGY_CONVERSATION_ID: Deno.env.get("AGY_CONVERSATION_ID"),
      AGY_TRANSCRIPT_PATH: Deno.env.get("AGY_TRANSCRIPT_PATH"),
      AGY_MODEL_NAME: Deno.env.get("AGY_MODEL_NAME"),
    };
    try {
      Deno.env.delete("ISSUE_APPROVAL_TOKEN_PATH");
      Deno.env.delete("CODEX_THREAD_ID");
      Deno.env.delete("CODEX_HOME");
      Deno.env.set("HOME", home);
      Deno.env.set("WJT_SURFACE", "agy");
      Deno.env.set("AGY_CONVERSATION_ID", H);
      Deno.env.set("AGY_TRANSCRIPT_PATH", hTranscript);
      Deno.env.set("AGY_MODEL_NAME", "gemini-4-hydrogen-high");

      const createCalls: string[][] = [];
      const created = await createIssueAndVerify(
        {
          title: APPROVED_TITLE,
          bodyFile,
          labels: ["Hydrogen"],
          milestone: "AI Misbehaves",
          priority: "High",
          author: TEST_AUTHOR,
        },
        withPassingProbe({
          readFileText: (p: string) => Deno.readTextFile(p),
          runCmd: makeFakeGhDeps(
            {
              HOME: home,
              WJT_SURFACE: "agy",
              AGY_CONVERSATION_ID: H,
              AGY_TRANSCRIPT_PATH: hTranscript,
            },
            createCalls,
          ).runCmd,
        }),
      );
      assertStringIncludes(created, APPROVED_TITLE);
      assertEquals(createCalls.some((c) => c[2] === "create"), true);

      const planCalls: string[][] = [];
      const planResult = await filePlan({
        planPath,
        dryRun: false,
        author: TEST_AUTHOR,
        deps: withPassingProbe({
          readFileText: (p: string) => Deno.readTextFile(p),
          runCmd: makeFakeGhDeps(
            {
              HOME: home,
              WJT_SURFACE: "agy",
              AGY_CONVERSATION_ID: H,
              AGY_TRANSCRIPT_PATH: hTranscript,
            },
            planCalls,
          ).runCmd,
        }),
      });
      assertEquals(planResult.totalIssuesFiled, 1);
      assertEquals(planCalls.some((c) => c[2] === "create"), true);

      // Switch to grandchild X -> refuses with zero fake gh calls
      Deno.env.set("AGY_CONVERSATION_ID", X);
      Deno.env.set("AGY_TRANSCRIPT_PATH", xTranscript);
      const grandchildCalls: string[][] = [];
      await assertRejects(
        () =>
          createIssueAndVerify(
            { title: APPROVED_TITLE, bodyFile, labels: ["Hydrogen"], author: TEST_AUTHOR },
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
      if (prev.ISSUE_APPROVAL_TOKEN_PATH === undefined) {
        Deno.env.delete("ISSUE_APPROVAL_TOKEN_PATH");
      } else Deno.env.set("ISSUE_APPROVAL_TOKEN_PATH", prev.ISSUE_APPROVAL_TOKEN_PATH);
      if (prev.CODEX_THREAD_ID === undefined) Deno.env.delete("CODEX_THREAD_ID");
      else Deno.env.set("CODEX_THREAD_ID", prev.CODEX_THREAD_ID);
      if (prev.CODEX_HOME === undefined) Deno.env.delete("CODEX_HOME");
      else Deno.env.set("CODEX_HOME", prev.CODEX_HOME);
      if (prev.WJT_SURFACE === undefined) Deno.env.delete("WJT_SURFACE");
      else Deno.env.set("WJT_SURFACE", prev.WJT_SURFACE);
      if (prev.AGY_CONVERSATION_ID === undefined) Deno.env.delete("AGY_CONVERSATION_ID");
      else Deno.env.set("AGY_CONVERSATION_ID", prev.AGY_CONVERSATION_ID);
      if (prev.AGY_TRANSCRIPT_PATH === undefined) Deno.env.delete("AGY_TRANSCRIPT_PATH");
      else Deno.env.set("AGY_TRANSCRIPT_PATH", prev.AGY_TRANSCRIPT_PATH);
      if (prev.AGY_MODEL_NAME === undefined) Deno.env.delete("AGY_MODEL_NAME");
      else Deno.env.set("AGY_MODEL_NAME", prev.AGY_MODEL_NAME);
    }
  });
});
