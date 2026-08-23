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

Deno.test("checkModelLabelOnIssueCreate: end-to-end payload evaluation", () => {
  const cliSonnetNoReason = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'gh issue create --title "T" --body "B" --type Task --label Sonnet',
    },
  });
  assertEquals(
    checkModelLabelOnIssueCreate(cliSonnetNoReason, MODEL_LABELS_PATH).startsWith(
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
    checkModelLabelOnIssueCreate(cliSonnetWithReason, MODEL_LABELS_PATH),
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
    checkModelLabelOnIssueCreate(mcpSonnetNoReason, MODEL_LABELS_PATH).startsWith(
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
    checkModelLabelOnIssueCreate(mcpSonnetWithReason, MODEL_LABELS_PATH),
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

Deno.test("checkModelLabelOnIssueCreate: invalid json or empty command returns PASS", () => {
  assertEquals(checkModelLabelOnIssueCreate("not-json", MODEL_LABELS_PATH), "PASS");
  assertEquals(
    checkModelLabelOnIssueCreate(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "" } }),
      MODEL_LABELS_PATH,
    ),
    "PASS",
  );
});
