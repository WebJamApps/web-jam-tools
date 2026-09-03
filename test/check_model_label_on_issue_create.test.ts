// check_model_label_on_issue_create.test.ts — web-jam-tools#709
import { assertEquals } from "@std/assert";
import {
  checkModelLabelOnIssueCreate,
  decide,
  ESCALATION_LABELS,
  extractEscalationReason,
  loadModelLabels,
} from "../hooks/lib/check_model_label_on_issue_create.ts";

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
      command: 'gh issue create --title "T" --body "B" --type Task --label Sonnet',
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
        'gh issue create --title "T" --body "B" --type Task --label Sonnet --escalation-reason "complex refactor"',
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
        'gh issue create --repo WebJamApps/web-jam-tools --title "skills/design-issue: support and validate structured Revision History tables" --body "B" --type Task --label "Flash High"',
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

Deno.test("checkModelLabelOnIssueCreate: CLI create with no similar OPEN issue proceeds unchanged", async () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'gh issue create --repo WebJamApps/web-jam-tools --title "docs: fix a broken link in the README" --body "B" --type Task --label "Flash High"',
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
        'gh issue create --repo WebJamApps/web-jam-tools --title "skills/design-issue: support and validate structured Revision History tables" --body "B" --type Task --label "Flash High"',
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
        'gh issue create --repo WebJamApps/web-jam-tools --title "skills/design-issue: support and validate structured Revision History tables" --body "B" --type Task --label "Flash High" ' +
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
        'gh issue create --repo WebJamApps/web-jam-tools --title "T" --body "B" --type Task --label "Flash High"',
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
        'gh issue create --title "A reasonably descriptive title here" --body "B" --type Task --label "Flash High"',
    },
  });
  const res = await checkModelLabelOnIssueCreate(payload, MODEL_LABELS_PATH, () => {
    called = true;
    return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
  });
  assertEquals(res, "PASS");
  assertEquals(called, false);
});
