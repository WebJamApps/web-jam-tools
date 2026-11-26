// business_deadline_reminder_hook.test.ts

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { readHookRegistrations } from "../src/install-codex/hooks.ts";
import {
  type DeadlineEntry,
  parseDeadlines,
} from "../hooks/lib/check_business_deadline_reminder.ts";

const SCRIPT_PATH = new URL(
  "../hooks/business-deadline-reminder.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
}

async function runHook(env: Record<string, string>): Promise<RunResult> {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env,
  });
  const child = cmd.spawn();
  await child.stdin.close();
  const { code, stdout } = await child.output();
  return { code, stdout: new TextDecoder().decode(stdout) };
}

async function withSandbox(
  fn: (listPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(`${dir}/web-jam-llc-deadlines.md`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const TEST_NOW = "2026-11-08";

Deno.test("due in 31 days (silent)", async () => {
  await withSandbox(async (listPath) => {
    // 31 days from 2026-11-08 is 2026-12-09
    const markdown = `# Web Jam LLC Deadlines

| Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation |
|---|---|---|---|---|---|---|
| Sample Far Registration Fee | 2026-12-09 | $50.00 | https://example.invalid/pay | 30 | - | - |
`;
    await Deno.writeTextFile(listPath, markdown);

    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: TEST_NOW,
    });
    assertEquals(res.code, 0);
    assertEquals(res.stdout, "");
  });
});

Deno.test("due in 30 days (shown)", async () => {
  await withSandbox(async (listPath) => {
    // 30 days from 2026-11-08 is 2026-12-08
    const markdown = `# Web Jam LLC Deadlines

| Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation |
|---|---|---|---|---|---|---|
| Sample State Registration Fee | 2026-12-08 | $50.00 | https://example.invalid/pay | 30 | - | - |
`;
    await Deno.writeTextFile(listPath, markdown);

    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: TEST_NOW,
    });
    assertEquals(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assertStringIncludes(parsed.systemMessage, "Sample State Registration Fee");
    assertStringIncludes(parsed.systemMessage, "$50.00");
    assertStringIncludes(parsed.systemMessage, "due in 30 days");
    assertStringIncludes(parsed.systemMessage, "2026-12-08");
    assertStringIncludes(parsed.systemMessage, "https://example.invalid/pay");
  });
});

Deno.test("due today (shown)", async () => {
  await withSandbox(async (listPath) => {
    const markdown = `# Web Jam LLC Deadlines

| Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation |
|---|---|---|---|---|---|---|
| Today Renewal License | 2026-11-08 | $75.00 | https://example.invalid/renew | 30 | - | - |
`;
    await Deno.writeTextFile(listPath, markdown);

    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: TEST_NOW,
    });
    assertEquals(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assertStringIncludes(parsed.systemMessage, "Today Renewal License");
    assertStringIncludes(parsed.systemMessage, "due today");
    assertStringIncludes(parsed.systemMessage, "2026-11-08");
  });
});

Deno.test("overdue and unpaid (shown)", async () => {
  await withSandbox(async (listPath) => {
    // 5 days overdue from 2026-11-08 is 2026-11-03
    const markdown = `# Web Jam LLC Deadlines

| Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation |
|---|---|---|---|---|---|---|
| Overdue Local Filing | 2026-11-03 | $120.00 | Local City Hall | 30 | - | - |
`;
    await Deno.writeTextFile(listPath, markdown);

    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: TEST_NOW,
    });
    assertEquals(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assertStringIncludes(parsed.systemMessage, "Overdue Local Filing");
    assertStringIncludes(parsed.systemMessage, "5 days overdue");
    assertStringIncludes(parsed.systemMessage, "2026-11-03");
  });
});

Deno.test("overdue and paid (silent)", async () => {
  await withSandbox(async (listPath) => {
    const markdown = `# Web Jam LLC Deadlines

| Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation |
|---|---|---|---|---|---|---|
| Settled Local Filing | 2026-11-03 | $120.00 | Local City Hall | 30 | 2026-11-02 | CONF-ABC-123 |
`;
    await Deno.writeTextFile(listPath, markdown);

    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: TEST_NOW,
    });
    assertEquals(res.code, 0);
    assertEquals(res.stdout, "");
  });
});

Deno.test("list missing (silent)", async () => {
  await withSandbox(async (listPath) => {
    // Pass a path that definitely does not exist
    const res = await runHook({
      BUSINESS_DEADLINES_PATH: `${listPath}.nonexistent`,
      BUSINESS_DEADLINES_NOW: TEST_NOW,
    });
    assertEquals(res.code, 0);
    assertEquals(res.stdout, "");
  });
});

Deno.test("malformed entry (named, others still shown)", async () => {
  await withSandbox(async (listPath) => {
    const markdown = `# Web Jam LLC Deadlines

| Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation |
|---|---|---|---|---|---|---|
| Corrupt Unparseable Item | not-a-valid-date | $10.00 | https://example.invalid | 30 | - | - |
| Valid 30-Day Item | 2026-12-08 | $50.00 | https://example.invalid | 30 | - | - |
`;
    await Deno.writeTextFile(listPath, markdown);

    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: TEST_NOW,
    });
    assertEquals(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    // Malformed entry is named in the output
    assertStringIncludes(parsed.systemMessage, "Corrupt Unparseable Item");
    assertStringIncludes(parsed.systemMessage, "Malformed entry");
    // Other valid entry is still shown
    assertStringIncludes(parsed.systemMessage, "Valid 30-Day Item");
    assertStringIncludes(parsed.systemMessage, "due in 30 days");
  });
});

Deno.test("previous-cycle payment does not suppress next yearly deadline (shown)", async () => {
  await withSandbox(async (listPath) => {
    // Due 2027-12-08, paid in previous cycle on 2026-12-08, evaluated on 2027-11-08 (due in 30 days)
    const markdown = `# Web Jam LLC Deadlines

| Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation |
|---|---|---|---|---|---|---|
| Virginia SCC Annual Registration Fee | 2027-12-08 | $50.00 | https://cis.scc.virginia.gov | 30 | 2026-12-08 | CONF-PREV-YEAR |
`;
    await Deno.writeTextFile(listPath, markdown);

    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: "2027-11-08",
    });
    assertEquals(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assertStringIncludes(parsed.systemMessage, "Virginia SCC Annual Registration Fee");
    assertStringIncludes(parsed.systemMessage, "due in 30 days");
    assertStringIncludes(parsed.systemMessage, "2027-12-08");
  });
});

Deno.test("current-cycle payment suppresses reminder (silent)", async () => {
  await withSandbox(async (listPath) => {
    // Due 2027-12-08, paid for current cycle on 2027-11-08, evaluated on 2027-11-08
    const markdown = `# Web Jam LLC Deadlines

| Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation |
|---|---|---|---|---|---|---|
| Virginia SCC Annual Registration Fee | 2027-12-08 | $50.00 | https://cis.scc.virginia.gov | 30 | 2027-11-08 | CONF-CURRENT-YEAR |
`;
    await Deno.writeTextFile(listPath, markdown);

    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: "2027-11-08",
    });
    assertEquals(res.code, 0);
    assertEquals(res.stdout, "");
  });
});

Deno.test("advance payment earlier than 90 days suppresses reminder (silent)", async () => {
  await withSandbox(async (listPath) => {
    // Due 2027-12-08, paid 122 days early on 2027-08-08, evaluated on 2027-11-08 (30 days before due)
    const markdown = `# Web Jam LLC Deadlines

| Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation |
|---|---|---|---|---|---|---|
| Synthetic annual fee | 2027-12-08 | $50.00 | https://cis.scc.virginia.gov | 30 | 2027-08-08 | CONF-ADVANCE |
`;
    await Deno.writeTextFile(listPath, markdown);

    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: "2027-11-08",
    });
    assertEquals(res.code, 0);
    assertEquals(res.stdout, "");
  });
});

Deno.test("explicit Paid Through column covering current cycle suppresses reminder (silent)", async () => {
  await withSandbox(async (listPath) => {
    const markdown = `# Web Jam LLC Deadlines

| Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation | Paid Through |
|---|---|---|---|---|---|---|---|
| Virginia SCC Annual Registration Fee | 2027-12-08 | $50.00 | https://cis.scc.virginia.gov | 30 | 2027-01-20 | CONF-123 | 2027-12-08 |
`;
    await Deno.writeTextFile(listPath, markdown);

    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: "2027-11-08",
    });
    assertEquals(res.code, 0);
    assertEquals(res.stdout, "");
  });
});

Deno.test("explicit Paid Through column covering only prior cycle does not suppress reminder (shown)", async () => {
  await withSandbox(async (listPath) => {
    const markdown = `# Web Jam LLC Deadlines

| Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation | Paid Through |
|---|---|---|---|---|---|---|---|
| Virginia SCC Annual Registration Fee | 2027-12-08 | $50.00 | https://cis.scc.virginia.gov | 30 | 2026-12-08 | CONF-PRIOR | 2026-12-08 |
`;
    await Deno.writeTextFile(listPath, markdown);

    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: "2027-11-08",
    });
    assertEquals(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assertStringIncludes(parsed.systemMessage, "Virginia SCC Annual Registration Fee");
    assertStringIncludes(parsed.systemMessage, "due in 30 days");
  });
});

Deno.test("hook is absent from Codex and agy registrations", () => {
  // Assert absence on Codex
  const installHooksScript = Deno.readTextFileSync(
    new URL("../scripts/install-hooks.sh", import.meta.url),
  );
  const codexRegistrations = readHookRegistrations(installHooksScript, "/tmp/home");
  for (const [event, regs] of Object.entries(codexRegistrations)) {
    for (const reg of regs) {
      for (const hook of reg.hooks) {
        assert(
          !hook.command.includes("business-deadline-reminder.sh"),
          `business-deadline-reminder.sh must not be registered on Codex (${event})`,
        );
      }
    }
  }

  // Helper verifying an agy hooks.json configuration lacks business-deadline-reminder.sh
  function assertAgyConfigLacksReminder(rawAgy: string) {
    assert(
      !rawAgy.includes("business-deadline-reminder.sh"),
      "business-deadline-reminder.sh must not be registered in agy config",
    );
  }

  // 1. Verify live agy configuration if present (restricting exception handling to missing/unreadable file)
  const geminiHooksPath = `${Deno.env.get("HOME")}/.gemini/config/hooks.json`;
  let liveAgyContent: string | null = null;
  try {
    liveAgyContent = Deno.readTextFileSync(geminiHooksPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound) && !(err instanceof Deno.errors.PermissionDenied)) {
      throw err;
    }
  }

  // Assertion is outside the try/catch so any failure is reported immediately
  if (liveAgyContent !== null) {
    assertAgyConfigLacksReminder(liveAgyContent);
  }

  // 2. Verify clean generated/isolated agy fixture passes
  const cleanAgyFixture = JSON.stringify({
    hooks: {
      PreToolUse: [{ command: "hooks/agy-model-guard.sh" }],
    },
  });
  assertAgyConfigLacksReminder(cleanAgyFixture);

  // 3. Verify that a forbidden-registration fixture deliberately containing
  // business-deadline-reminder.sh fails the assertion (cannot silently pass)
  const forbiddenAgyFixture = JSON.stringify({
    hooks: {
      SessionStart: [{ command: "hooks/business-deadline-reminder.sh" }],
    },
  });
  assertThrows(
    () => assertAgyConfigLacksReminder(forbiddenAgyFixture),
    Error,
    "business-deadline-reminder.sh must not be registered in agy config",
  );
});

// Literal case table from "Yearly deadlines" ("How the list is read") of
// web-jam-music-media-design.md (revision 1.5.0). Each row is one literal input
// and its parser result.
type Expect =
  | { field: keyof DeadlineEntry; value: string | number }
  | { field: "dueDate"; value: string; warnDays: number }
  | { malformed: string };

const TABLE_HEADER =
  "| Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation |\n" +
  "|---|---|---|---|---|---|---|";

const LITERAL_CASES: Array<[string, Expect]> = [
  ["- **Due:** 2028-01-31 (the last day of January, the LLC's anniversary month)", {
    field: "dueDate",
    value: "2028-01-31",
  }],
  ["- **Due**: 2028-01-31", { field: "dueDate", value: "2028-01-31" }],
  ["- Due: 2028-01-31", { field: "dueDate", value: "2028-01-31" }],
  ["- **Due:** 2026-02-30 (invalid calendar date)", { malformed: "invalid due date" }],
  ["- **Due:** January 31, 2028", { malformed: "invalid due date" }],
  ["- **Due:** not-a-valid-date", { malformed: "invalid due date" }],
  ["- **Warn:** 30 days ahead", { field: "warnDays", value: 30 }],
  ["- **Warn:** 14 days", { field: "warnDays", value: 14 }],
  ["- **Warn:** 1 day before", { field: "warnDays", value: 1 }],
  ["- **Warn:** 0", { field: "warnDays", value: 0 }],
  ["- **Warn:** 30", { field: "warnDays", value: 30 }],
  ["- **Warn:** soon", { malformed: "invalid warn days" }],
  ["- **Warn:** -5 days", { malformed: "invalid warn days" }],
  ["- **Warn:** 30 weeks ahead", { malformed: "invalid warn days" }],
  ["- **Paid through:** 2027 (the 2025-01-31 payment covered 2025, 2026 and 2027)", {
    field: "paidThrough",
    value: "2027",
  }],
  ["- **Paid through:** 2027-01-31 (verified)", { field: "paidThrough", value: "2027-01-31" }],
  ["- **Paid through:** next year", { malformed: "invalid paid through" }],
  ["- **Last payment:** 2025-01-31. Receipt saved in Correspondence.", {
    field: "lastPaidDate",
    value: "2025-01-31",
  }],
  ["- **Last paid:** 2025-01-31", { field: "lastPaidDate", value: "2025-01-31" }],
  ["- **Last payment:** 2025-13-45. Bad date.", { malformed: "invalid last paid date" }],
  ["| Sample Fee | 2026-12-08 | $50.00 | https://example.invalid | 30 | - | - |", {
    field: "dueDate",
    value: "2026-12-08",
    warnDays: 30,
  }],
  ["| Corrupt Item | not-a-valid-date | $10.00 | https://example.invalid | 30 | - | - |", {
    malformed: "invalid due date",
  }],
];

/** Wraps one literal line in the smallest document that parses it as one entry. */
function documentFor(literal: string): string {
  if (literal.startsWith("|")) return `${TABLE_HEADER}\n${literal}\n`;
  // Non-Due lines need a valid Due so the entry can be built.
  const due = /^- (\*\*)?Due/.test(literal) ? "" : "- Due: 2028-01-31\n";
  return `## Case\n${due}${literal}\n`;
}

Deno.test("literal case table has all 22 design rows", () => {
  assertEquals(LITERAL_CASES.length, 22);
});

for (const [literal, expected] of LITERAL_CASES) {
  Deno.test(`literal case: ${literal}`, () => {
    const result = parseDeadlines(documentFor(literal));
    if ("malformed" in expected) {
      assertEquals(result.entries, []);
      assertEquals(result.malformed.length, 1);
      assertStringIncludes(result.malformed[0].reason, expected.malformed);
      return;
    }
    assertEquals(result.malformed, []);
    assertEquals(result.entries.length, 1);
    assertEquals(result.entries[0][expected.field], expected.value);
    if ("warnDays" in expected) assertEquals(result.entries[0].warnDays, expected.warnDays);
  });
}

const NATURAL_BLOCK = `# Web Jam LLC Deadlines

## Virginia SCC Annual Registration Fee
- **Due:** 2026-12-08 (the anniversary-month due date)
- **Amount:** $50.00
- **Where:** https://example.invalid/pay
- **Warn:** 30 days ahead
- **Paid through:** 2025 (the prior payment covered 2025)
- **Last payment:** 2025-01-31. Receipt saved in Correspondence.
`;

Deno.test("outcome: natural block entry is valid and shown with no malformed message", async () => {
  await withSandbox(async (listPath) => {
    await Deno.writeTextFile(listPath, NATURAL_BLOCK);
    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: TEST_NOW,
    });
    assertEquals(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assertStringIncludes(parsed.systemMessage, "Virginia SCC Annual Registration Fee");
    assertStringIncludes(parsed.systemMessage, "due in 30 days");
    assert(!parsed.systemMessage.includes("Malformed"), parsed.systemMessage);
  });
});

Deno.test("outcome: malformed block entry is named while valid entries are still evaluated", async () => {
  await withSandbox(async (listPath) => {
    const markdown = `${NATURAL_BLOCK}
## Broken Warn Entry
- **Due:** 2026-11-20
- **Warn:** soon
`;
    await Deno.writeTextFile(listPath, markdown);
    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: TEST_NOW,
    });
    assertEquals(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assertStringIncludes(
      parsed.systemMessage,
      `Malformed entry: "Broken Warn Entry" (invalid warn days`,
    );
    assertStringIncludes(parsed.systemMessage, "Virginia SCC Annual Registration Fee");
    // The malformed entry is named only, never also evaluated with a default warn window.
    assert(!parsed.systemMessage.includes("Broken Warn Entry is due"), parsed.systemMessage);
  });
});

Deno.test("outcome: unreadable list path proceeds silently", async () => {
  await withSandbox(async (listPath) => {
    // A directory at the list path cannot be read as a file.
    await Deno.mkdir(listPath);
    const res = await runHook({
      BUSINESS_DEADLINES_PATH: listPath,
      BUSINESS_DEADLINES_NOW: TEST_NOW,
    });
    assertEquals(res.code, 0);
    assertEquals(res.stdout, "");
  });
});

Deno.test("block bullet labelled like an Object.prototype property is ignored", () => {
  const result = parseDeadlines(
    "## Case\n- Due: 2028-01-31\n- Constructor: x\n- __proto__: y\n- toString: z\n",
  );
  assertEquals(result.malformed, []);
  assertEquals(result.entries.length, 1);
  assertEquals(Object.keys(result.entries[0]).sort(), [
    "amount",
    "confirmation",
    "dueDate",
    "item",
    "lastPaidDate",
    "paidThrough",
    "warnDays",
    "wherePaid",
  ]);
});
