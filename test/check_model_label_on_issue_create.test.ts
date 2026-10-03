// check_model_label_on_issue_create.test.ts — web-jam-tools#709
import { assertEquals } from "@std/assert";
import {
  checkModelLabelOnIssueCreate,
  decide,
  ESCALATION_LABELS,
  extractEscalationReason,
  extractRepoValue,
  loadModelLabels,
} from "../hooks/lib/check_model_label_on_issue_create.ts";

const SIGNED_BODY = "Body.\n\n🤖 Authored by Claude Code — Opus";

const MODEL_LABELS_PATH = new URL(
  "../skills/fix-labels/model-labels.json",
  import.meta.url,
).pathname;

Deno.test("ESCALATION_LABELS contains Sonnet and Opus", () => {
  assertEquals(ESCALATION_LABELS.has("Sonnet"), true);
  assertEquals(ESCALATION_LABELS.has("Opus"), true);
  assertEquals(ESCALATION_LABELS.has("Flash High"), false);
  assertEquals(ESCALATION_LABELS.has("Haiku"), false);
});

Deno.test("extractEscalationReason: parses space-separated flag", () => {
  assertEquals(
    extractEscalationReason([
      "--title",
      "T",
      "--escalation-reason",
      "complex refactor",
    ]),
    "complex refactor",
  );
});

Deno.test("extractEscalationReason: parses equals-separated flag", () => {
  assertEquals(
    extractEscalationReason([
      "--title",
      "T",
      "--escalation-reason=complex refactor",
    ]),
    "complex refactor",
  );
});

Deno.test("extractEscalationReason: returns null on empty or missing values", () => {
  assertEquals(extractEscalationReason(["--title", "T"]), null);
  assertEquals(
    extractEscalationReason(["--title", "T", "--escalation-reason", ""]),
    null,
  );
  assertEquals(
    extractEscalationReason(["--title", "T", "--escalation-reason", "   "]),
    null,
  );
  assertEquals(
    extractEscalationReason(["--title", "T", "--escalation-reason="]),
    null,
  );
  assertEquals(
    extractEscalationReason(["--title", "T", "--escalation-reason"]),
    null,
  );
  assertEquals(
    extractEscalationReason([
      "--title",
      "T",
      "--escalation-reason",
      "--type",
      "Task",
    ]),
    null,
  );
});

Deno.test("extractRepoValue: parses --repo, --repo=, -R, and -R= (web-jam-tools#904 review)", () => {
  assertEquals(
    extractRepoValue(["--repo", "WebJamApps/web-jam-tools"]),
    "WebJamApps/web-jam-tools",
  );
  assertEquals(extractRepoValue(["--repo=WebJamApps/web-jam-tools"]), "WebJamApps/web-jam-tools");
  assertEquals(extractRepoValue(["-R", "WebJamApps/web-jam-tools"]), "WebJamApps/web-jam-tools");
  assertEquals(extractRepoValue(["-R=WebJamApps/web-jam-tools"]), "WebJamApps/web-jam-tools");
  assertEquals(extractRepoValue(["--title", "T"]), null);
});

Deno.test("decide: Sonnet and Opus require escalation justification", () => {
  const modelLabels = loadModelLabels(MODEL_LABELS_PATH);

  // Sonnet without reason
  const resSonnetNoReason = decide(["Sonnet"], modelLabels);
  assertEquals(
    resSonnetNoReason.startsWith(
      "DENY:Creating an issue labeled 'Sonnet' requires an explicit escalation justification.",
    ),
    true,
  );
  assertEquals(
    resSonnetNoReason.includes("Flash High is the default model tier"),
    true,
  );

  // Opus without reason
  const resOpusNoReason = decide(["Opus"], modelLabels);
  assertEquals(
    resOpusNoReason.startsWith(
      "DENY:Creating an issue labeled 'Opus' requires an explicit escalation justification.",
    ),
    true,
  );
  assertEquals(
    resOpusNoReason.includes("Flash High is the default model tier"),
    true,
  );

  // Sonnet with reason
  assertEquals(decide(["Sonnet"], modelLabels, "complex rewrite"), "PASS");

  // Opus with reason
  assertEquals(decide(["Opus"], modelLabels, "architectural design"), "PASS");

  // Flash High, Flash Med, Haiku require no reason
  assertEquals(decide(["Flash High"], modelLabels), "PASS");
  assertEquals(decide(["Flash Med"], modelLabels), "PASS");
  assertEquals(decide(["Haiku"], modelLabels), "PASS");
  assertEquals(decide(["Fable"], modelLabels), "PASS");

  // Josh carve-out
  assertEquals(decide(["Josh"], modelLabels), "PASS");
});

Deno.test("decide: MCP mode formats denial message with tool input property instructions", () => {
  const modelLabels = loadModelLabels(MODEL_LABELS_PATH);
  const res = decide(["Sonnet"], modelLabels, null, undefined, "mcp");
  assertEquals(res.includes("supply an 'escalation_reason' property"), true);
});

Deno.test("checkModelLabelOnIssueCreate: end-to-end payload evaluation", async () => {
  const cliSonnetNoReason = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'gh issue create --title "T" --body "B\n\n🤖 Authored by Claude Code — Opus" --type Task --label Sonnet',
    },
  });
  assertEquals(
    (await checkModelLabelOnIssueCreate(cliSonnetNoReason, MODEL_LABELS_PATH)).startsWith(
      "DENY:Creating an issue labeled 'Sonnet'",
    ),
    true,
  );

  const cliSonnetWithReason = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'gh issue create --title "T" --body "B\n\n🤖 Authored by Claude Code — Opus" --type Task --label Sonnet --escalation-reason "complex refactor"',
    },
  });
  assertEquals(
    await checkModelLabelOnIssueCreate(cliSonnetWithReason, MODEL_LABELS_PATH),
    "PASS",
  );

  const mcpSonnetNoReason = JSON.stringify({
    tool_name: "mcp__github__issue_write",
    tool_input: {
      method: "create",
      type: "Task",
      labels: ["Sonnet"],
    },
  });
  assertEquals(
    (await checkModelLabelOnIssueCreate(mcpSonnetNoReason, MODEL_LABELS_PATH)).startsWith(
      "DENY:Creating an issue labeled 'Sonnet'",
    ),
    true,
  );

  const mcpSonnetWithReason = JSON.stringify({
    tool_name: "mcp__github__issue_write",
    tool_input: {
      method: "create",
      type: "Task",
      labels: ["Sonnet"],
      escalation_reason: "complex refactor",
      body: SIGNED_BODY,
    },
  });
  assertEquals(
    await checkModelLabelOnIssueCreate(mcpSonnetWithReason, MODEL_LABELS_PATH),
    "PASS",
  );
});

Deno.test("loadModelLabels: error handling on bad json", () => {
  const tempFile = Deno.makeTempFileSync();
  try {
    Deno.writeTextFileSync(tempFile, JSON.stringify({ modelLabels: [] }));
    let threw = false;
    try {
      loadModelLabels(tempFile);
    } catch {
      threw = true;
    }
    assertEquals(threw, true);

    Deno.writeTextFileSync(tempFile, JSON.stringify({ modelLabels: [123] }));
    threw = false;
    try {
      loadModelLabels(tempFile);
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  } finally {
    Deno.removeSync(tempFile);
  }
});

Deno.test("checkModelLabelOnIssueCreate: invalid json or empty command returns PASS", async () => {
  assertEquals(await checkModelLabelOnIssueCreate("not-json", MODEL_LABELS_PATH), "PASS");
  assertEquals(
    await checkModelLabelOnIssueCreate(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "" } }),
      MODEL_LABELS_PATH,
    ),
    "PASS",
  );
});

// --- Duplicate-search enforcement (web-jam-tools#901) ---

const EXISTING_TITLE =
  "skills/design-issue: support and validate structured Revision History tables for multi-phase design document updates";

function fakeRunnerReturning(issues: Array<{ number: number; title: string }>) {
  return () => Promise.resolve({ code: 0, stdout: JSON.stringify(issues), stderr: "" });
}

Deno.test("checkModelLabelOnIssueCreate: CLI create with a similar OPEN issue is denied, naming the candidate", async () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'gh issue create --repo WebJamApps/web-jam-tools --title "skills/design-issue: support and validate structured Revision History tables" --body "B\n\n🤖 Authored by Claude Code — Opus" --type Task --label "Flash High"',
    },
  });
  const res = await checkModelLabelOnIssueCreate(
    payload,
    MODEL_LABELS_PATH,
    fakeRunnerReturning([{ number: 885, title: EXISTING_TITLE }]),
  );
  assertEquals(res.startsWith("DENY:possible duplicate issue(s) found"), true);
  assertEquals(res.includes('web-jam-tools#885 "'), true);
});

Deno.test("checkModelLabelOnIssueCreate: CLI create using -R (gh's repo shorthand) is still searched, not silently skipped (web-jam-tools#904 review)", async () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'gh issue create -R WebJamApps/web-jam-tools --title "skills/design-issue: support and validate structured Revision History tables" --body "B\n\n🤖 Authored by Claude Code — Opus" --type Task --label "Flash High"',
    },
  });
  const res = await checkModelLabelOnIssueCreate(
    payload,
    MODEL_LABELS_PATH,
    fakeRunnerReturning([{ number: 885, title: EXISTING_TITLE }]),
  );
  assertEquals(res.startsWith("DENY:possible duplicate issue(s) found"), true);
});

Deno.test("checkModelLabelOnIssueCreate: raw gh issue create whose body file cannot be read is refused before the duplicate search (web-jam-tools#1167)", async () => {
  const missingPath = `/tmp/nonexistent_body_file_${Date.now()}.md`;
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        `gh issue create --repo WebJamApps/web-jam-tools --title "skills/design-issue: support and validate structured Revision History tables" --body-file ${missingPath} --type Task --label "Flash High"`,
    },
  });
  let searched = false;
  const res = await checkModelLabelOnIssueCreate(payload, MODEL_LABELS_PATH, () => {
    searched = true;
    return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
  });
  assertEquals(res.startsWith("DENY:couldn't read the issue body"), true, res);
  assertEquals(res.includes(missingPath), true, res);
  assertEquals(searched, false);
});

Deno.test("checkModelLabelOnIssueCreate: deno task create-issue whose body file cannot be read is still searched for duplicates, and the task checks the body (web-jam-tools#1167)", async () => {
  const missingPath = `/tmp/nonexistent_body_file_${Date.now()}.md`;
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        `deno task create-issue --repo WebJamApps/web-jam-tools --title "skills/design-issue: support and validate structured Revision History tables" --body-file ${missingPath} --type Task --label "Flash High"`,
    },
  });
  const denied = await checkModelLabelOnIssueCreate(
    payload,
    MODEL_LABELS_PATH,
    fakeRunnerReturning([{ number: 885, title: EXISTING_TITLE }]),
  );
  assertEquals(denied.startsWith("DENY:possible duplicate issue(s) found"), true);
  const allowed = await checkModelLabelOnIssueCreate(
    payload,
    MODEL_LABELS_PATH,
    fakeRunnerReturning([]),
  );
  assertEquals(allowed, "PASS: body checked by create-issue itself");
});

Deno.test("checkModelLabelOnIssueCreate: MCP create with a non-string body is refused (web-jam-tools#1167)", async () => {
  const payload = JSON.stringify({
    tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
    tool_input: {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "skills/design-issue: support and validate structured Revision History tables",
      type: "Task",
      labels: ["Flash High"],
      body: 12345,
    },
  });
  const res = await checkModelLabelOnIssueCreate(
    payload,
    MODEL_LABELS_PATH,
    fakeRunnerReturning([]),
  );
  assertEquals(res.startsWith("DENY:the issue_write body is not a string"), true, res);
});

Deno.test("checkModelLabelOnIssueCreate: CLI create with no similar OPEN issue proceeds unchanged", async () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'gh issue create --repo WebJamApps/web-jam-tools --title "docs: fix a broken link in the README" --body "B\n\n🤖 Authored by Claude Code — Opus" --type Task --label "Flash High"',
    },
  });
  const res = await checkModelLabelOnIssueCreate(
    payload,
    MODEL_LABELS_PATH,
    fakeRunnerReturning([{ number: 885, title: EXISTING_TITLE }]),
  );
  assertEquals(res, "PASS");
});

Deno.test("checkModelLabelOnIssueCreate: CLI create is refused when the duplicate search itself fails", async () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'gh issue create --repo WebJamApps/web-jam-tools --title "skills/design-issue: support and validate structured Revision History tables" --body "B\n\n🤖 Authored by Claude Code — Opus" --type Task --label "Flash High"',
    },
  });
  const res = await checkModelLabelOnIssueCreate(
    payload,
    MODEL_LABELS_PATH,
    () => Promise.resolve({ code: 1, stdout: "", stderr: "auth error" }),
  );
  assertEquals(res.startsWith("DENY:couldn't search"), true);
  assertEquals(res.includes("the search failed"), true);
});

Deno.test("checkModelLabelOnIssueCreate: CLI --dedup-override clears a duplicate deny", async () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'gh issue create --repo WebJamApps/web-jam-tools --title "skills/design-issue: support and validate structured Revision History tables" --body "B\n\n🤖 Authored by Claude Code — Opus" --type Task --label "Flash High" ' +
        '--dedup-override web-jam-tools#885 --dedup-override-reason "narrower scope, docs only"',
    },
  });
  const res = await checkModelLabelOnIssueCreate(
    payload,
    MODEL_LABELS_PATH,
    fakeRunnerReturning([{ number: 885, title: EXISTING_TITLE }]),
  );
  assertEquals(res, "PASS");
});

Deno.test("checkModelLabelOnIssueCreate: MCP create with a similar OPEN issue is denied, naming the candidate", async () => {
  const payload = JSON.stringify({
    tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
    tool_input: {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "skills/design-issue: Revision History table support and validation",
      type: "Task",
      labels: ["Flash High"],
    },
  });
  const res = await checkModelLabelOnIssueCreate(
    payload,
    MODEL_LABELS_PATH,
    fakeRunnerReturning([{ number: 885, title: EXISTING_TITLE }]),
  );
  assertEquals(res.startsWith("DENY:possible duplicate issue(s) found"), true);
});

Deno.test("checkModelLabelOnIssueCreate: MCP create with dedup_override_reason clears the deny", async () => {
  const payload = JSON.stringify({
    tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
    tool_input: {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "skills/design-issue: Revision History table support and validation",
      type: "Task",
      labels: ["Flash High"],
      dedup_override: "web-jam-tools#885",
      dedup_override_reason: "different scope, already reviewed",
      body: SIGNED_BODY,
    },
  });
  const res = await checkModelLabelOnIssueCreate(
    payload,
    MODEL_LABELS_PATH,
    fakeRunnerReturning([{ number: 885, title: EXISTING_TITLE }]),
  );
  assertEquals(res, "PASS");
});

Deno.test("checkModelLabelOnIssueCreate: create with a generic short title skips the dedup search entirely (no runner call)", async () => {
  let called = false;
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'gh issue create --repo WebJamApps/web-jam-tools --title "T" --body "B\n\n🤖 Authored by Claude Code — Opus" --type Task --label "Flash High"',
    },
  });
  const res = await checkModelLabelOnIssueCreate(payload, MODEL_LABELS_PATH, () => {
    called = true;
    return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
  });
  assertEquals(res, "PASS");
  assertEquals(called, false);
});

Deno.test("checkModelLabelOnIssueCreate: create with no --repo skips the dedup search entirely (no runner call)", async () => {
  let called = false;
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'gh issue create --title "A reasonably descriptive title here" --body "B\n\n🤖 Authored by Claude Code — Opus" --type Task --label "Flash High"',
    },
  });
  const res = await checkModelLabelOnIssueCreate(payload, MODEL_LABELS_PATH, () => {
    called = true;
    return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
  });
  assertEquals(res, "PASS");
  assertEquals(called, false);
});

// --- Authored-by footer (web-jam-tools#1205) ---

const NOT_ON_ROSTER =
  "ERROR: --author 'x' does not name a model on the roster (web-jam-tools#190).";
const probeOk = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
const probeNotOnRoster = () => Promise.resolve({ code: 1, stdout: "", stderr: NOT_ON_ROSTER });
const probeBroken = () => Promise.resolve({ code: 127, stdout: "", stderr: "not found" });
const probeThrows = () => Promise.reject(new Error("spawn ENOENT"));

function rawCreate(type: string, body: string): string {
  return JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: `gh issue create --title "T" --body "${body}" --type ${type} --label Haiku`,
    },
  });
}

function mcpCreate(type: string, body: unknown): string {
  return JSON.stringify({
    tool_name: "mcp__github__issue_write",
    tool_input: { method: "create", type, labels: ["Haiku"], body },
  });
}

for (const type of ["Task", "Epic"]) {
  const routes: Array<[string, (body: string) => string]> = [
    ["raw gh issue create", (b) => rawCreate(type, b)],
    ["connector issue_write create", (b) => mcpCreate(type, b)],
  ];
  for (const [route, make] of routes) {
    Deno.test(`footer check (${type}, ${route}): no footer as the last line is denied`, async () => {
      for (const body of ["Body", "Body\n\n🤖 Authored by Claude Code — Opus\n\nMore text"]) {
        const res = await checkModelLabelOnIssueCreate(
          make(body),
          MODEL_LABELS_PATH,
          undefined,
          probeOk,
        );
        assertEquals(res.startsWith("DENY:"), true, res);
        assertEquals(res.includes("Authored by"), true, res);
        assertEquals(res.includes("deno task create-issue --author"), true, res);
      }
    });

    Deno.test(`footer check (${type}, ${route}): a footer not on the roster is denied`, async () => {
      const res = await checkModelLabelOnIssueCreate(
        make("Body\n\n🤖 Authored by Codex — GPT-6"),
        MODEL_LABELS_PATH,
        undefined,
        probeNotOnRoster,
      );
      assertEquals(res.startsWith("DENY:"), true, res);
      assertEquals(res.includes("Codex — GPT-6"), true, res);
      assertEquals(res.includes("not on the author roster"), true, res);
    });

    Deno.test(`footer check (${type}, ${route}): a footer on the roster is allowed`, async () => {
      const res = await checkModelLabelOnIssueCreate(
        make("Body\n\n🤖 Authored by Claude Code — Opus\n"),
        MODEL_LABELS_PATH,
        undefined,
        probeOk,
      );
      assertEquals(res, "PASS");
    });

    Deno.test(`footer check (${type}, ${route}): a probe that cannot run is denied as could-not-run, not not-on-roster`, async () => {
      for (const probe of [probeBroken, probeThrows]) {
        const res = await checkModelLabelOnIssueCreate(
          make("Body\n\n🤖 Authored by Claude Code — Opus"),
          MODEL_LABELS_PATH,
          undefined,
          probe,
        );
        assertEquals(res.startsWith("DENY:"), true, res);
        assertEquals(res.includes("author check could not run"), true, res);
        assertEquals(res.includes("not on the author roster"), false, res);
      }
    });
  }
}

Deno.test("footer check: an unreadable body file on a raw create, and a non-string connector body, deny with the could-not-run message", async () => {
  const raw = await checkModelLabelOnIssueCreate(
    JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command:
          "gh issue create --title T --body-file /nonexistent/b.md --type Task --label Haiku",
      },
    }),
    MODEL_LABELS_PATH,
    undefined,
    probeOk,
  );
  assertEquals(raw.startsWith("DENY:"), true, raw);
  assertEquals(raw.includes("author check could not run"), true, raw);
  const mcp = await checkModelLabelOnIssueCreate(
    mcpCreate("Task", 42),
    MODEL_LABELS_PATH,
    undefined,
    probeOk,
  );
  assertEquals(mcp.startsWith("DENY:"), true, mcp);
  assertEquals(mcp.includes("author check could not run"), true, mcp);
});

Deno.test("footer check: deno task create-issue is left to the task's own check (no footer needed in the file)", async () => {
  const res = await checkModelLabelOnIssueCreate(
    JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: "deno task create-issue --title T --body-file /tmp/b.md --type Task --label Haiku",
      },
    }),
    MODEL_LABELS_PATH,
    undefined,
    probeNotOnRoster,
  );
  assertEquals(res.includes("Authored by"), false, res);
});
