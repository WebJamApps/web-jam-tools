import { assertEquals } from "@std/assert";
import { checkGmailWrite, GMAIL_TOOL_NAMES } from "../hooks/lib/check_gmail_write.ts";
import {
  GMAIL_FENCE_CASES,
  GMAIL_SCHEMA_INPUTS,
  IRREVERSIBLE_GMAIL_TOOLS,
} from "./support/gmail_fence_fixtures.ts";

for (const server of [undefined, "gmail", "configured-local-gmail"]) {
  const prefix = server ? `mcp__${server}__` : "";
  Deno.test(`Gmail classifier: complete server vocabulary and literal fixtures (${prefix || "raw"})`, () => {
    assertEquals([...GMAIL_TOOL_NAMES].sort(), Object.keys(GMAIL_SCHEMA_INPUTS).sort());
    assertEquals(GMAIL_TOOL_NAMES.length, 19);
    for (const [tool, input] of Object.entries(GMAIL_SCHEMA_INPUTS)) {
      assertEquals(
        checkGmailWrite(prefix + tool, input, server),
        IRREVERSIBLE_GMAIL_TOOLS.includes(tool) ? "deny" : "allow",
        tool,
      );
    }
    for (const fixture of GMAIL_FENCE_CASES) {
      assertEquals(
        checkGmailWrite(prefix + fixture.tool, fixture.input, server),
        fixture.decision,
        JSON.stringify(fixture),
      );
    }
  });
}

Deno.test("Gmail classifier: irreversible tools refuse every input", () => {
  for (const tool of IRREVERSIBLE_GMAIL_TOOLS) {
    for (const input of [null, undefined, [], "", {}, 42]) {
      assertEquals(checkGmailWrite(tool, input), "deny");
    }
  }
});

Deno.test("Gmail classifier: malformed safety arguments and unknown local tools refuse", () => {
  for (
    const input of [
      null,
      undefined,
      [],
      "TRASH",
      false,
      1,
      {},
      { messageId: "probe", addLabelIds: null },
      { messageId: "probe", addLabelIds: [false] },
      { messageId: "probe", removeLabelIds: "TRASH" },
      { messageId: "probe", addLabels: ["TRASH"] },
      { messageId: "probe", labelIds: ["TRASH"], removeLabelIds: {} },
    ]
  ) assertEquals(checkGmailWrite("modify_email", input), "deny");
  for (
    const input of [
      { messageIds: "probe" },
      { messageIds: ["probe"], labelIds: [] },
      { messageIds: ["probe"], addLabelIds: "TRASH" },
      { messageIds: ["probe"], removeLabelIds: [null] },
      { messageIds: ["probe"], batchSize: 0 },
      { messageIds: ["probe"], batchSize: "50" },
    ]
  ) assertEquals(checkGmailWrite("batch_modify_emails", input), "deny");
  for (const tool of [undefined, null, 1, "", "unknown", "mcp__gmail__unknown"]) {
    assertEquals(checkGmailWrite(tool, {}), "deny");
  }
  assertEquals(checkGmailWrite("read_email", null), "deny");
});

Deno.test("Gmail classifier: both add fields are checked, removing TRASH alone proceeds", () => {
  assertEquals(
    checkGmailWrite("modify_email", {
      messageId: "probe",
      labelIds: ["TRASH"],
      addLabelIds: ["IMPORTANT"],
    }),
    "trash",
  );
  assertEquals(
    checkGmailWrite("modify_email", {
      messageId: "probe",
      labelIds: ["IMPORTANT"],
      addLabelIds: ["TRASH"],
      removeLabelIds: ["TRASH"],
    }),
    "trash",
  );
  assertEquals(
    checkGmailWrite("batch_modify_emails", { messageIds: ["probe"], removeLabelIds: ["TRASH"] }),
    "allow",
  );
});

Deno.test("Gmail classifier: unrelated servers do not inherit Gmail restrictions", () => {
  for (
    const tool of [
      "mcp__other__delete_label",
      "mcp__gmail_extra__send_email",
      "mcp__github__delete_filter",
    ]
  ) {
    assertEquals(checkGmailWrite(tool, null), "unrelated");
  }
});
