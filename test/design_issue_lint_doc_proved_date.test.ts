// test/design_issue_lint_doc_proved_date.test.ts — web-jam-tools#1025
//
// The '## Load-bearing premises' table's 'Proved' column records when the proof was last run.
// Earlier dates pass only on an exact stored-row match; new or changed earlier rows fail.
// Same-day and future dates retain their existing behavior. The column is
// located by header name, never by position. "Today" is injectable via lintDesignDoc's `nowImpl`
// option (this repo's existing `xImpl` dependency-injection convention) so these tests are
// deterministic regardless of wall-clock time; production uses the real clock — the last test
// below proves that directly.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { lintDesignDoc, lintDesignDocFile, runLintDocCli } from "../src/design-issue/lint_doc.ts";
import { getGate1RecordPath, type PremiseRow } from "../src/design-issue/gate1_record.ts";

const FIXED_TODAY = "2026-09-16";
const FIXED_NOW = () => new Date(`${FIXED_TODAY}T12:00:00Z`);

function docWithPremisesTable(tableBlock: string): string {
  return `# Title

## What it is
A description of the feature.

## Both surfaces
Parity details across Claude Code, agy, and Codex.

## Load-bearing premises
${tableBlock}
`;
}

function lineNumOf(doc: string, needle: string): number {
  return doc.split("\n").findIndex((l) => l.includes(needle)) + 1;
}

const CARRIED_NOW = () => new Date("2026-10-10T12:00:00Z");
const STORED_P1: PremiseRow = { premise: "P1", proof: "proof one", proved: "2026-10-03" };

async function withPremiseRecord(
  rows: string[],
  record: Record<string, unknown> | null,
  run: (docPath: string, stateDir: string, recordPath: string) => Promise<void>,
): Promise<void> {
  const temp = await Deno.makeTempDir({ prefix: "carried-premises-" });
  const docPath = join(temp, "fixture.md");
  const stateDir = join(temp, "state");
  const recordPath = getGate1RecordPath(docPath, stateDir);
  try {
    await Deno.mkdir(stateDir);
    await Deno.writeTextFile(
      docPath,
      docWithPremisesTable(
        ["| Premise | Proof | Proved |", "|---|---|---|", ...rows].join("\n"),
      ),
    );
    if (record !== null) {
      await Deno.writeTextFile(
        recordPath,
        JSON.stringify({
          docPath,
          presentedFingerprint: "fixture",
          presentedAt: "2026-10-03T12:00:00Z",
          approvedAt: "2026-10-03T12:00:00Z",
          approvedFingerprint: "fixture",
          premiseRowsSource: "approval",
          premiseRowsStoredAt: "2026-10-03T12:00:00Z",
          ...record,
        }),
      );
    }
    await run(docPath, stateDir, recordPath);
  } finally {
    if (record !== null) await Deno.chmod(recordPath, 0o600);
    await Deno.remove(temp, { recursive: true });
  }
}

const carriedCases: {
  name: string;
  rows: string[];
  record: Record<string, unknown> | null;
  valid: boolean;
  reason?: string;
}[] = [
  {
    name: "a: today with no record passes",
    rows: ["| P1 | proof one | 2026-10-10 |"],
    record: null,
    valid: true,
  },
  {
    name: "b: unchanged earlier row passes",
    rows: ["| P1 | proof one | 2026-10-03 |"],
    record: { premiseRows: [STORED_P1] },
    valid: true,
  },
  {
    name: "c: changed stored date fails",
    rows: ["| P1 | proof one | 2026-10-03 |"],
    record: { premiseRows: [{ ...STORED_P1, proved: "2026-10-02" }] },
    valid: false,
    reason: "differs from the stored rows",
  },
  {
    name: "d: proof case differs and fails",
    rows: ["| P1 | proof ONE | 2026-10-03 |"],
    record: { premiseRows: [STORED_P1] },
    valid: false,
    reason: "differs from the stored rows",
  },
  {
    name: "e: changed premise fails",
    rows: ["| P1 changed | proof one | 2026-10-03 |"],
    record: { premiseRows: [STORED_P1] },
    valid: false,
    reason: "differs from the stored rows",
  },
  {
    name: "f: outer cell whitespace is trimmed",
    rows: ["|   P1   |   proof one   | 2026-10-03 |"],
    record: { premiseRows: [STORED_P1] },
    valid: true,
  },
  {
    name: "g: internal proof whitespace differs and fails",
    rows: ["| P1 | proof  one | 2026-10-03 |"],
    record: { premiseRows: [STORED_P1] },
    valid: false,
    reason: "differs from the stored rows",
  },
  {
    name: "h: row order does not matter",
    rows: ["| P2 | proof two | 2026-10-03 |", "| P1 | proof one | 2026-10-03 |"],
    record: {
      premiseRows: [STORED_P1, { premise: "P2", proof: "proof two", proved: "2026-10-03" }],
    },
    valid: true,
  },
  {
    name: "i: earlier row without a record fails",
    rows: ["| P1 | proof one | 2026-10-03 |"],
    record: null,
    valid: false,
    reason: "no premise rows are stored",
  },
  {
    name: "j: legacy approval without rows fails",
    rows: ["| P1 | proof one | 2026-10-03 |"],
    record: {},
    valid: false,
    reason: "no premise rows are stored",
  },
  {
    name: "k: empty stored rows fails",
    rows: ["| P1 | proof one | 2026-10-03 |"],
    record: { premiseRows: [] },
    valid: false,
    reason: "no premise rows are stored",
  },
  {
    name: "n: unused stored rows cause no violation",
    rows: ["| P1 | proof one | 2026-10-10 |"],
    record: { premiseRows: [{ premise: "P9", proof: "proof nine", proved: "2026-09-01" }] },
    valid: true,
  },
  {
    name: "o: empty and malformed dates still fail",
    rows: ["| P1 | proof one | |", "| P2 | proof two | 2026-13-40 |"],
    record: { premiseRows: [STORED_P1] },
    valid: false,
    reason: "missing or malformed Proved date",
  },
  {
    name: "p: future date without a record still passes",
    rows: ["| P1 | proof one | 2026-10-11 |"],
    record: null,
    valid: true,
  },
];

for (const fixture of carriedCases) {
  Deno.test(`stored premise case ${fixture.name}`, async () => {
    await withPremiseRecord(fixture.rows, fixture.record, async (docPath, stateDir) => {
      const result = await lintDesignDocFile(docPath, { stateDir, nowImpl: CARRIED_NOW });
      assertEquals(result.valid, fixture.valid, JSON.stringify(result.violations));
      if (!fixture.valid) {
        assertEquals(result.violations.length, fixture.name.startsWith("o:") ? 2 : 1);
        for (const violation of result.violations) {
          assertEquals(violation.rule, "load-bearing-premises-stale-proof");
          assertStringIncludes(violation.message, fixture.reason!);
        }
      }
    });
  });
}

for (const problem of ["l: malformed JSON", "m: record mode 000"]) {
  Deno.test(`stored premise case ${problem} refuses and names the record in the CLI`, async () => {
    await withPremiseRecord(
      ["| P1 | proof one | 2026-10-03 |"],
      { premiseRows: [STORED_P1] },
      async (docPath, stateDir, recordPath) => {
        if (problem.startsWith("l:")) await Deno.writeTextFile(recordPath, "{not json");
        else await Deno.chmod(recordPath, 0o000);
        await assertRejects(
          () => lintDesignDocFile(docPath, { stateDir, nowImpl: CARRIED_NOW }),
          Error,
          recordPath,
        );
        const errors: string[] = [];
        const original = console.error;
        console.error = (...args: unknown[]) => errors.push(args.join(" "));
        try {
          assertEquals(
            await runLintDocCli([docPath, "--state-dir", stateDir], { nowImpl: CARRIED_NOW }),
            1,
          );
        } finally {
          console.error = original;
        }
        assertStringIncludes(errors.join("\n"), recordPath);
        assertEquals(errors.join("\n").includes("no premise rows are stored"), false);
        const content = await Deno.readTextFile(docPath);
        await assertRejects(
          () =>
            import("../src/design-issue/gate1.ts").then(({ runGate1 }) =>
              runGate1({
                docPath,
                stateDir,
                nowImpl: CARRIED_NOW,
                screenshotImpl: () => {
                  throw new Error("must refuse before screenshot");
                },
                openBrowserImpl: () => {
                  throw new Error("must refuse before opening");
                },
              })
            ),
          Error,
          recordPath,
        );
        assertEquals(await Deno.readTextFile(docPath), content);
      },
    );
  });
}

Deno.test("stored premises: CLI and environment override load the same record without writing", async () => {
  await withPremiseRecord(
    ["| P1 | proof one | 2026-10-03 |"],
    { premiseRows: [STORED_P1] },
    async (docPath, stateDir, recordPath) => {
      const recordBefore = await Deno.readTextFile(recordPath);
      const previous = Deno.env.get("DESIGN_GATE1_STATE_DIR");
      const original = console.log;
      const logs: string[] = [];
      console.log = (...args: unknown[]) => logs.push(args.join(" "));
      Deno.env.set("DESIGN_GATE1_STATE_DIR", stateDir);
      try {
        assertEquals((await lintDesignDocFile(docPath, { nowImpl: CARRIED_NOW })).valid, true);
        assertEquals(
          await runLintDocCli([docPath, "--state-dir", stateDir], { nowImpl: CARRIED_NOW }),
          0,
        );
        assertStringIncludes(logs.join("\n"), "[design:lint-doc] PASS:");
      } finally {
        console.log = original;
        if (previous === undefined) Deno.env.delete("DESIGN_GATE1_STATE_DIR");
        else Deno.env.set("DESIGN_GATE1_STATE_DIR", previous);
      }
      assertEquals(await Deno.readTextFile(recordPath), recordBefore);
    },
  );
});

Deno.test("stored premises: malformed stored-row shapes and non-object JSON refuse", async () => {
  for (
    const contents of ['{"premiseRows":{}}', '{"premiseRows":[{"premise":"P1"}]}', "null", "[]"]
  ) {
    await withPremiseRecord(
      ["| P1 | proof one | 2026-10-10 |"],
      {},
      async (docPath, stateDir, recordPath) => {
        await Deno.writeTextFile(recordPath, contents);
        await assertRejects(
          () => lintDesignDocFile(docPath, { stateDir, nowImpl: CARRIED_NOW }),
          Error,
          recordPath,
        );
      },
    );
  }
});

Deno.test("lintDesignDoc: a premises table with a valid same-day Proved date on every row passes", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P1 | Proof one | ${FIXED_TODAY} |
| P2 | Proof two | ${FIXED_TODAY} |`,
  );

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, true, JSON.stringify(result.violations));
  assertEquals(result.violations.length, 0);
});

Deno.test("lintDesignDoc: a missing Proved column fails", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof |
|---|---|
| P1 | Proof one |`,
  );

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, false);

  const violation = result.violations.find((v) =>
    v.rule === "load-bearing-premises-missing-proved-column"
  );
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
  assertEquals(violation?.message.includes("no 'Proved' column"), true);
});

Deno.test("lintDesignDoc: an empty Proved cell fails, naming the line and the premise text", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P1 needs a real date | Proof one |  |`,
  );
  const rowLineNum = lineNumOf(doc, "P1 needs a real date");

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, false);

  const violation = result.violations.find((v) =>
    v.rule === "load-bearing-premises-stale-proof" && v.line === rowLineNum
  );
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
  assertEquals(violation?.message.includes("P1 needs a real date"), true);
  assertEquals(violation?.message.includes(String(rowLineNum)), true);
});

Deno.test("lintDesignDoc: a malformed Proved cell fails, naming the line and the premise text", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P2 has a bad date | Proof two | not-a-date |`,
  );
  const rowLineNum = lineNumOf(doc, "P2 has a bad date");

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, false);

  const violation = result.violations.find((v) =>
    v.rule === "load-bearing-premises-stale-proof" && v.line === rowLineNum
  );
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
  assertEquals(violation?.message.includes("P2 has a bad date"), true);
  assertEquals(violation?.message.includes("not-a-date"), true);
});

Deno.test("lintDesignDoc: an impossible calendar date (e.g. Feb 30) is treated as malformed", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P2b has an impossible date | Proof two-b | 2026-02-30 |`,
  );
  const rowLineNum = lineNumOf(doc, "P2b has an impossible date");

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, false);

  const violation = result.violations.find((v) =>
    v.rule === "load-bearing-premises-stale-proof" && v.line === rowLineNum
  );
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
});

Deno.test("lintDesignDoc: an earlier-dated Proved cell fails, naming the line, the premise text, the recorded date, and today's date", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P3 was proved yesterday | Proof three | 2026-09-15 |`,
  );
  const rowLineNum = lineNumOf(doc, "P3 was proved yesterday");

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, false);

  const violation = result.violations.find((v) =>
    v.rule === "load-bearing-premises-stale-proof" && v.line === rowLineNum
  );
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
  assertEquals(violation?.message.includes("P3 was proved yesterday"), true);
  assertEquals(violation?.message.includes("2026-09-15"), true);
  assertEquals(violation?.message.includes(FIXED_TODAY), true);
});

Deno.test("lintDesignDoc: a Proved date matching today passes (same-day is the pass condition)", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P4 was proved today | Proof four | ${FIXED_TODAY} |`,
  );

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, true, JSON.stringify(result.violations));
});

Deno.test("lintDesignDoc: the Proved column is located by header name, not by position", () => {
  const doc = docWithPremisesTable(
    `| Proved | Premise | Proof |
|---|---|---|
| ${FIXED_TODAY} | P5 | Proof five |`,
  );

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, true, JSON.stringify(result.violations));
});

Deno.test("lintDesignDoc: without an nowImpl override, the production path uses the real current date", () => {
  const today = new Date().toISOString().slice(0, 10);
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P6 | Proof six | ${today} |`,
  );

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true, JSON.stringify(result.violations));

  const staleDoc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P7 was proved on a fixed past date | Proof seven | 2020-01-01 |`,
  );
  const staleResult = lintDesignDoc(staleDoc, "test.md");
  assertEquals(staleResult.valid, false);
  const violation = staleResult.violations.find((v) =>
    v.rule === "load-bearing-premises-stale-proof"
  );
  assertEquals(Boolean(violation), true, JSON.stringify(staleResult.violations));
});

Deno.test("lintDesignDoc: today's local calendar date always passes without timezone false positives", () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const localToday = `${y}-${m}-${d}`;

  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P8 proved today locally | Proof eight | ${localToday} |`,
  );

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true, JSON.stringify(result.violations));
});
