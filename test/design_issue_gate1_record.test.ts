// test/design_issue_gate1_record.test.ts — web-jam-tools#1155
//
// Unit tests for Gate 1 disk record helper (gate1_record.ts) and CLI commands
// (design:gate1-approve and design:gate1-status).

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import * as path from "@std/path";
import {
  adoptGate1Record,
  approveGate1Record,
  computeFingerprint,
  formatGate1Status,
  Gate1RecordError,
  getGate1RecordPath,
  getGate1StateDir,
  getGate1Status,
  hashDocPath,
  loadGate1Record,
  openGate1Record,
  recordSweepNote,
  withGate1RecordLock,
} from "../src/design-issue/gate1_record.ts";
import { lintDesignDoc, toLocalIsoDate } from "../src/design-issue/lint_doc.ts";
import {
  runCli,
  runGate1AdoptCli,
  runGate1ApproveCli,
  runGate1StatusCli,
  runSweepNoteCli,
  sessionIdFor,
} from "../src/design-issue/cli.ts";
import {
  agyUserRequestText,
  isCodexInjectedText,
  verifyReplyTypedByJosh,
} from "../src/design-issue/gate1_reply.ts";
import {
  agyFixture,
  agySubagentEnv,
  claudeCodeFixture,
  codexFixture,
  FIXTURES,
  type FixtureTurn,
} from "./gate1_reply_fixtures.ts";

const MINIMAL_DESIGN_DOC = `# Test Design

## Section
Some content.
`;

Deno.test("computeFingerprint and hashDocPath return consistent sha256 hex", () => {
  const fp1 = computeFingerprint("hello world");
  const fp2 = computeFingerprint("hello world");
  const fp3 = computeFingerprint("different");
  assertEquals(fp1, fp2);
  assertEquals(fp1.length, 64);
  assertEquals(fp1 !== fp3, true);

  const hash1 = hashDocPath("/home/joshua/doc.md");
  const hash2 = hashDocPath("/home/joshua/doc.md");
  assertEquals(hash1, hash2);
  assertEquals(hash1.length, 64);
});

Deno.test("getGate1StateDir honors explicit argument, DESIGN_GATE1_STATE_DIR, and HOME fallback", () => {
  // Explicit argument
  assertEquals(getGate1StateDir("/custom/state/dir"), "/custom/state/dir");

  // Env override
  const prevEnv = Deno.env.get("DESIGN_GATE1_STATE_DIR");
  try {
    Deno.env.set("DESIGN_GATE1_STATE_DIR", "/env/state/dir");
    assertEquals(getGate1StateDir(), "/env/state/dir");
  } finally {
    if (prevEnv !== undefined) {
      Deno.env.set("DESIGN_GATE1_STATE_DIR", prevEnv);
    } else {
      Deno.env.delete("DESIGN_GATE1_STATE_DIR");
    }
  }

  // Home fallback
  const home = Deno.env.get("HOME") || "/home/joshua";
  assertEquals(getGate1StateDir(), path.join(home, ".claude", "state", "design-gate1"));
});

Deno.test("getGate1RecordPath returns expected path with sha256 hash of absolute doc path", () => {
  const docPath = "/some/absolute/doc.md";
  const stateDir = "/tmp/test-state";
  const expectedHash = hashDocPath(docPath);
  const expectedPath = path.join(stateDir, `${expectedHash}.json`);
  assertEquals(getGate1RecordPath(docPath, stateDir), expectedPath);
});

Deno.test("openGate1Record creates open record and clears any earlier approval", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-open-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);

    const stateDir = path.join(tempDir, "state");

    // Open the record
    const { record, recordPath } = await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    assertEquals(typeof recordPath, "string");
    assertEquals(record.docPath, docPath);
    assertEquals(record.presentedFingerprint, computeFingerprint(MINIMAL_DESIGN_DOC));
    assertEquals(typeof record.presentedAt, "string");
    assertEquals(record.approvedAt, undefined);
    assertEquals(record.reply, undefined);
    assertEquals(record.approvedFingerprint, undefined);

    // Status should be "open"
    const statusBeforeApprove = await getGate1Status(docPath, { stateDir });
    assertEquals(statusBeforeApprove.status, "open");

    // Approve it
    await approveGate1Record(docPath, "Approved!", { stateDir });
    const statusAfterApprove = await getGate1Status(docPath, { stateDir });
    assertEquals(statusAfterApprove.status, "approved");
    assertEquals(statusAfterApprove.reply, "Approved!");

    // Re-open record (simulating re-running design:gate1)
    const { record: reopened } = await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    assertEquals(reopened.approvedAt, undefined);
    assertEquals(reopened.reply, undefined);
    assertEquals(reopened.approvedFingerprint, undefined);

    // Status must be reset to "open", clearing earlier approval
    const statusAfterReopen = await getGate1Status(docPath, { stateDir });
    assertEquals(statusAfterReopen.status, "open");
    assertEquals(statusAfterReopen.reply, undefined);

    // Verify file on disk
    const loaded = await loadGate1Record(docPath, { stateDir });
    assertEquals(loaded?.approvedAt, undefined);
    assertEquals(loaded?.reply, undefined);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("approveGate1Record records verbatim reply and document fingerprint", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-approve-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");

    await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });

    const replyText = "Approved, ship it with 2 PRs!\nLooks great.";
    const { record } = await approveGate1Record(docPath, replyText, { stateDir });

    assertEquals(record.reply, replyText);
    assertEquals(record.approvedFingerprint, computeFingerprint(MINIMAL_DESIGN_DOC));
    assertEquals(typeof record.approvedAt, "string");

    const status = await getGate1Status(docPath, { stateDir });
    assertEquals(status.status, "approved");
    assertEquals(status.reply, replyText);
    assertEquals(status.approvedFingerprint, computeFingerprint(MINIMAL_DESIGN_DOC));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("approveGate1Record refuses when no record exists for the document", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-norecord-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");

    await assertRejects(
      async () => {
        await approveGate1Record(docPath, "Approved", { stateDir });
      },
      Gate1RecordError,
      "No Gate 1 record exists",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("approveGate1Record refuses when document fingerprint changed since presentation", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-changed-pre-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");

    await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });

    // Modify document before approving
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC + "\n## Extra line added");

    await assertRejects(
      async () => {
        await approveGate1Record(docPath, "Approved", { stateDir });
      },
      Gate1RecordError,
      "Document fingerprint",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("approveGate1Record refuses when reply is empty or whitespace", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-empty-reply-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");

    await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });

    await assertRejects(
      async () => {
        await approveGate1Record(docPath, "", { stateDir });
      },
      Gate1RecordError,
      "Reply is empty",
    );

    await assertRejects(
      async () => {
        await approveGate1Record(docPath, "   \n\t  ", { stateDir });
      },
      Gate1RecordError,
      "Reply is empty",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("approveGate1Record refuses when record is already approved", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-already-approved-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");

    await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    await approveGate1Record(docPath, "Approved once", { stateDir });

    await assertRejects(
      async () => {
        await approveGate1Record(docPath, "Approved again", { stateDir });
      },
      Gate1RecordError,
      "is not open (already approved",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("approveGate1Record refuses when record file cannot be parsed", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-bad-json-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");
    await Deno.mkdir(stateDir, { recursive: true });

    const recordPath = getGate1RecordPath(docPath, stateDir);
    await Deno.writeTextFile(recordPath, "not valid json {{{");

    await assertRejects(
      async () => {
        await approveGate1Record(docPath, "Approved", { stateDir });
      },
      Gate1RecordError,
      "Cannot parse Gate 1 record",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("approveGate1Record refuses when design document cannot be read", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-unread-doc-" });
  try {
    const docPath = path.join(tempDir, "nonexistent.md");
    const stateDir = path.join(tempDir, "state");

    await assertRejects(
      async () => {
        await approveGate1Record(docPath, "Approved", { stateDir });
      },
      Gate1RecordError,
      "Cannot read design document",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("getGate1Status reports each of the four states accurately", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-4states-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");

    // State 1: not presented
    const status1 = await getGate1Status(docPath, { stateDir });
    assertEquals(status1.status, "not presented");
    assertEquals(formatGate1Status(status1).some((l) => l.includes("not presented")), true);

    // State 2: open
    await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    const status2 = await getGate1Status(docPath, { stateDir });
    assertEquals(status2.status, "open");
    assertEquals(formatGate1Status(status2).some((l) => l.includes("open")), true);

    // State 3: approved (quoting the reply)
    await approveGate1Record(docPath, "Ship it, LGTM", { stateDir });
    const status3 = await getGate1Status(docPath, { stateDir });
    assertEquals(status3.status, "approved");
    assertEquals(status3.reply, "Ship it, LGTM");
    const formatted3 = formatGate1Status(status3);
    assertEquals(formatted3.some((l) => l.includes('approved: "Ship it, LGTM"')), true);
    assertEquals(formatted3.some((l) => l.includes("Gate 1 approval recorded")), true);

    // State 4: changed since approval
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC + "\n## Revision after approval");
    const status4 = await getGate1Status(docPath, { stateDir });
    assertEquals(status4.status, "changed since approval");
    assertEquals(
      formatGate1Status(status4).some((l) => l.includes("changed since approval")),
      true,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runGate1ApproveCli approves with --reply flag and logs success", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-cli-approve-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");

    await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    const session = await claudeCodeFixture(path.join(tempDir, "home"), [
      { kind: "josh", text: "Approved from CLI", at: new Date(Date.now() + 60_000) },
    ]);

    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runGate1ApproveCli(
      [
        docPath,
        "--reply",
        "Approved from CLI",
        "--state-dir",
        stateDir,
        "--session-id",
        session.sessionId,
      ],
      {
        env: session.env,
        log: (msg) => logs.push(msg),
        errorLog: (msg) => errors.push(msg),
      },
    );

    assertEquals(code, 0);
    assertEquals(errors.length, 0);
    assertEquals(logs.some((l) => l.includes("Gate 1 approved")), true);
    assertEquals(logs.some((l) => l.includes('Recorded reply: "Approved from CLI"')), true);

    const status = await getGate1Status(docPath, { stateDir });
    assertEquals(status.status, "approved");
    assertEquals(status.reply, "Approved from CLI");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runGate1ApproveCli approves with --reply-file flag", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-cli-replyfile-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");

    const replyFilePath = path.join(tempDir, "reply.txt");
    const replyContent = "Approval from multi-line file\nLooks fantastic.";
    await Deno.writeTextFile(replyFilePath, replyContent);

    await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    const session = await claudeCodeFixture(path.join(tempDir, "home"), [
      { kind: "josh", text: replyContent, at: new Date(Date.now() + 60_000) },
    ]);

    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runGate1ApproveCli(
      [
        docPath,
        "--reply-file",
        replyFilePath,
        "--state-dir",
        stateDir,
        "--session-id",
        session.sessionId,
      ],
      {
        env: session.env,
        log: (msg) => logs.push(msg),
        errorLog: (msg) => errors.push(msg),
      },
    );

    assertEquals(code, 0);
    assertEquals(errors.length, 0);
    const status = await getGate1Status(docPath, { stateDir });
    assertEquals(status.status, "approved");
    assertEquals(status.reply, replyContent);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runGate1ApproveCli fails on missing arguments or unreadable reply file", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-cli-errors-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");

    // Missing docPath
    const err1: string[] = [];
    assertEquals(
      await runGate1ApproveCli([], { errorLog: (m) => err1.push(m) }),
      1,
    );
    assertEquals(err1.some((l) => l.includes("Missing required design document path")), true);

    // Missing reply
    const err2: string[] = [];
    assertEquals(
      await runGate1ApproveCli([docPath, "--state-dir", stateDir], {
        errorLog: (m) => err2.push(m),
      }),
      1,
    );
    assertEquals(err2.some((l) => l.includes("Missing required --reply or --reply-file")), true);

    // Unreadable reply file
    const err3: string[] = [];
    assertEquals(
      await runGate1ApproveCli(
        [docPath, "--reply-file", "/nonexistent/reply.txt", "--state-dir", stateDir],
        { errorLog: (m) => err3.push(m) },
      ),
      1,
    );
    assertEquals(err3.some((l) => l.includes("Cannot read reply file")), true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runGate1StatusCli logs status and supports --json flag", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-cli-status-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");

    // Not presented
    const logs1: string[] = [];
    assertEquals(
      await runGate1StatusCli([docPath, "--state-dir", stateDir], {
        log: (m) => logs1.push(m),
      }),
      0,
    );
    assertEquals(logs1.some((l) => l.includes("not presented")), true);

    // Open
    await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    const logs2: string[] = [];
    assertEquals(
      await runGate1StatusCli([docPath, "--state-dir", stateDir], {
        log: (m) => logs2.push(m),
      }),
      0,
    );
    assertEquals(logs2.some((l) => l.includes("open")), true);

    // JSON format
    const jsonLogs: string[] = [];
    assertEquals(
      await runGate1StatusCli([docPath, "--state-dir", stateDir, "--json"], {
        log: (m) => jsonLogs.push(m),
      }),
      0,
    );
    const parsed = JSON.parse(jsonLogs.join("\n"));
    assertEquals(parsed.status, "open");
    assertEquals(parsed.docPath, docPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// web-jam-tools#1229: premise rows kept in the Gate 1 record, design:gate1-adopt.
// Cases a to n of the issue, each over a temporary state directory.
// ---------------------------------------------------------------------------

function premisesDoc(rows: string[], header = "| Premise | Proof | Proved |"): string {
  const sep = header.replace(/[^|]+/g, "---");
  return `# Test Design\n\n## Load-bearing premises\n\n${header}\n${sep}\n${
    rows.join("\n")
  }\n\n## After\nText.\n`;
}

const TWO_ROWS = ["| P1 | proof one | 2026-09-24 |", "| P2 | proof two | 2026-10-02 |"];
const NOW = new Date(2026, 9, 4, 12, 0, 0); // 2026-10-04 local

async function adoptFixture(
  docText: string,
  seedRecord?: string,
): Promise<{ tempDir: string; docPath: string; stateDir: string; recordPath: string }> {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-adopt-" });
  const docPath = path.join(tempDir, "doc.md");
  await Deno.writeTextFile(docPath, docText);
  const stateDir = path.join(tempDir, "state");
  const recordPath = getGate1RecordPath(docPath, stateDir);
  if (seedRecord !== undefined) {
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(recordPath, seedRecord);
  }
  return { tempDir, docPath, stateDir, recordPath };
}

Deno.test("case a: adopt with no record creates one holding exactly the two rows, the reply and the adoption time", async () => {
  const f = await adoptFixture(premisesDoc(TWO_ROWS));
  try {
    const { record } = await adoptGate1Record(f.docPath, "adopt it", {
      stateDir: f.stateDir,
      now: NOW,
    });
    assertEquals(record.premiseRows, [
      { premise: "P1", proof: "proof one", proved: "2026-09-24" },
      { premise: "P2", proof: "proof two", proved: "2026-10-02" },
    ]);
    assertEquals(record.premiseRowsSource, "adoption");
    assertEquals(record.premiseRowsAdoptionReply, "adopt it");
    assertEquals(record.premiseRowsStoredAt, NOW.toISOString());
    assertEquals(record.approvedAt, undefined);
    assertEquals(record.reply, undefined);
    assertEquals(record.approvedFingerprint, undefined);
    const onDisk = JSON.parse(await Deno.readTextFile(f.recordPath));
    assertEquals(onDisk.premiseRows.length, 2);
    assertEquals("approvedAt" in onDisk, false);
    // The adopted record is not an approval: approve still refuses until presented.
    await assertRejects(
      () => approveGate1Record(f.docPath, "yes", { stateDir: f.stateDir }),
      Gate1RecordError,
      "never presented",
    );
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("case b: adopt on an approved record without rows stores rows and leaves the approval fields unchanged", async () => {
  const seed = JSON.stringify(
    {
      docPath: "/x/doc.md",
      presentedFingerprint: "pf",
      presentedAt: "2026-09-01T00:00:00.000Z",
      approvedAt: "2026-09-02T00:00:00.000Z",
      reply: "approved, go",
      approvedFingerprint: "af",
    },
    null,
    2,
  ) + "\n";
  const f = await adoptFixture(premisesDoc(TWO_ROWS), seed);
  try {
    const { record } = await adoptGate1Record(f.docPath, "adopt it", {
      stateDir: f.stateDir,
      now: NOW,
    });
    assertEquals(record.premiseRows?.length, 2);
    const onDisk = JSON.parse(await Deno.readTextFile(f.recordPath));
    assertEquals(onDisk.approvedAt, "2026-09-02T00:00:00.000Z");
    assertEquals(onDisk.reply, "approved, go");
    assertEquals(onDisk.approvedFingerprint, "af");
    assertEquals(onDisk.presentedFingerprint, "pf");
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("case c: adopt on a record already holding a stored row is refused and the file is byte-identical", async () => {
  const seed = JSON.stringify({
    docPath: "/x/doc.md",
    presentedFingerprint: "pf",
    presentedAt: "t",
    premiseRows: [{ premise: "P1", proof: "proof one", proved: "2026-09-24" }],
    premiseRowsSource: "approval",
    premiseRowsStoredAt: "2026-09-02T00:00:00.000Z",
  });
  const f = await adoptFixture(premisesDoc(TWO_ROWS), seed);
  try {
    await assertRejects(
      () => adoptGate1Record(f.docPath, "adopt it", { stateDir: f.stateDir, now: NOW }),
      Gate1RecordError,
      "already holds",
    );
    assertEquals(await Deno.readTextFile(f.recordPath), seed);
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("case d: an empty or blank reply is refused", async () => {
  const f = await adoptFixture(premisesDoc(TWO_ROWS));
  try {
    for (const reply of ["", "   "]) {
      await assertRejects(
        () => adoptGate1Record(f.docPath, reply, { stateDir: f.stateDir, now: NOW }),
        Gate1RecordError,
        "Reply is empty",
      );
    }
    await assertRejects(() => Deno.stat(f.recordPath), Deno.errors.NotFound);
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("case e: a document with no Load-bearing premises heading is refused", async () => {
  const f = await adoptFixture(MINIMAL_DESIGN_DOC);
  try {
    await assertRejects(
      () => adoptGate1Record(f.docPath, "adopt it", { stateDir: f.stateDir, now: NOW }),
      Gate1RecordError,
      "no '## Load-bearing premises' heading",
    );
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("case f: a premises table with no Proved column is refused", async () => {
  const f = await adoptFixture(
    premisesDoc(["| P1 | proof one |"], "| Premise | Proof |"),
  );
  try {
    await assertRejects(
      () => adoptGate1Record(f.docPath, "adopt it", { stateDir: f.stateDir, now: NOW }),
      Gate1RecordError,
      "'Proved' column",
    );
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("case g: a Proved cell that is invalid, empty, text, or a day in the future is refused naming the row", async () => {
  for (const cell of ["2026-13-40", "", "tomorrow", "2026-10-05"]) {
    const f = await adoptFixture(
      premisesDoc(["| P1 | proof one | 2026-09-24 |", `| P9 | proof nine | ${cell} |`]),
    );
    try {
      await assertRejects(
        () => adoptGate1Record(f.docPath, "adopt it", { stateDir: f.stateDir, now: NOW }),
        Gate1RecordError,
        'Premise row "P9"',
      );
      await assertRejects(() => Deno.stat(f.recordPath), Deno.errors.NotFound);
    } finally {
      await Deno.remove(f.tempDir, { recursive: true });
    }
  }
});

Deno.test("case g: today's date is accepted", async () => {
  const f = await adoptFixture(premisesDoc(["| P1 | proof one | 2026-10-04 |"]));
  try {
    const { record } = await adoptGate1Record(f.docPath, "adopt it", {
      stateDir: f.stateDir,
      now: NOW,
    });
    assertEquals(record.premiseRows?.length, 1);
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("adopt refuses a table with no header, no Premise or Proof column, or no data rows", async () => {
  const docs: Array<[string, string]> = [
    ["## Load-bearing premises\n\nNo table here.\n", "has no table"],
    [premisesDoc(["| P1 | 2026-09-24 |"], "| Premise | Proved |"), "'Proof' column"],
    [premisesDoc(["| P1 | 2026-09-24 |"], "| Proof | Proved |"), "'Premise' column"],
    [premisesDoc([]), "no data rows"],
  ];
  for (const [doc, message] of docs) {
    const f = await adoptFixture(doc);
    try {
      await assertRejects(
        () => adoptGate1Record(f.docPath, "adopt it", { stateDir: f.stateDir, now: NOW }),
        Gate1RecordError,
        message,
      );
    } finally {
      await Deno.remove(f.tempDir, { recursive: true });
    }
  }
});

Deno.test("case h: adopt on a record file whose content is {not json is refused and the file is byte-identical", async () => {
  const f = await adoptFixture(premisesDoc(TWO_ROWS), "{not json");
  try {
    await assertRejects(
      () => adoptGate1Record(f.docPath, "adopt it", { stateDir: f.stateDir, now: NOW }),
      Gate1RecordError,
      "Cannot parse Gate 1 record",
    );
    assertEquals(await Deno.readTextFile(f.recordPath), "{not json");
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("a record that is valid JSON but not an object is refused", async () => {
  for (const seed of ["null", "[1]", '"text"']) {
    const f = await adoptFixture(premisesDoc(TWO_ROWS), seed);
    try {
      await assertRejects(
        () => adoptGate1Record(f.docPath, "adopt it", { stateDir: f.stateDir, now: NOW }),
        Gate1RecordError,
        "not a JSON object",
      );
      assertEquals(await Deno.readTextFile(f.recordPath), seed);
    } finally {
      await Deno.remove(f.tempDir, { recursive: true });
    }
  }
});

Deno.test("an unreadable record path (a directory) is refused", async () => {
  const f = await adoptFixture(premisesDoc(TWO_ROWS));
  try {
    await Deno.mkdir(f.recordPath, { recursive: true });
    await assertRejects(
      () => adoptGate1Record(f.docPath, "adopt it", { stateDir: f.stateDir, now: NOW }),
      Gate1RecordError,
      "Cannot read Gate 1 record",
    );
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("case i: adopt on a document path that does not exist is refused", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-adopt-missing-" });
  try {
    await assertRejects(
      () =>
        adoptGate1Record(path.join(tempDir, "nope.md"), "adopt it", {
          stateDir: path.join(tempDir, "state"),
          now: NOW,
        }),
      Gate1RecordError,
      "Cannot read design document",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("case j: approve on an open record stores every premise row of the document", async () => {
  const doc = premisesDoc(TWO_ROWS);
  const f = await adoptFixture(doc);
  try {
    await openGate1Record(f.docPath, doc, { stateDir: f.stateDir });
    const { record } = await approveGate1Record(f.docPath, "approved", { stateDir: f.stateDir });
    assertEquals(record.premiseRows, [
      { premise: "P1", proof: "proof one", proved: "2026-09-24" },
      { premise: "P2", proof: "proof two", proved: "2026-10-02" },
    ]);
    assertEquals(record.premiseRowsSource, "approval");
    assertEquals(record.premiseRowsStoredAt, record.approvedAt);
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("case k: present, approve, present again clears approval and keeps the stored rows unchanged", async () => {
  const doc = premisesDoc(TWO_ROWS);
  const f = await adoptFixture(doc);
  try {
    await openGate1Record(f.docPath, doc, { stateDir: f.stateDir });
    const { record: approved } = await approveGate1Record(f.docPath, "approved", {
      stateDir: f.stateDir,
    });
    const { record: reopened } = await openGate1Record(f.docPath, doc, {
      stateDir: f.stateDir,
    });
    assertEquals(reopened.approvedAt, undefined);
    assertEquals(reopened.reply, undefined);
    assertEquals(reopened.approvedFingerprint, undefined);
    assertEquals(reopened.premiseRows, approved.premiseRows);
    assertEquals(reopened.premiseRowsSource, "approval");
    assertEquals(reopened.premiseRowsStoredAt, approved.premiseRowsStoredAt);
    const onDisk = await loadGate1Record(f.docPath, { stateDir: f.stateDir });
    assertEquals(onDisk?.premiseRows, approved.premiseRows);
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("re-presenting keeps adopted rows with their source fields and reply", async () => {
  const doc = premisesDoc(TWO_ROWS);
  const f = await adoptFixture(doc);
  try {
    const { record: adopted } = await adoptGate1Record(f.docPath, "adopt it", {
      stateDir: f.stateDir,
      now: NOW,
    });
    const { record } = await openGate1Record(f.docPath, doc, { stateDir: f.stateDir });
    assertEquals(record.premiseRows, adopted.premiseRows);
    assertEquals(record.premiseRowsSource, "adoption");
    assertEquals(record.premiseRowsStoredAt, adopted.premiseRowsStoredAt);
    assertEquals(record.premiseRowsAdoptionReply, "adopt it");
    // Approving afterwards replaces the adoption source with the approval.
    const { record: approved } = await approveGate1Record(f.docPath, "ok", {
      stateDir: f.stateDir,
    });
    assertEquals(approved.premiseRowsSource, "approval");
    assertEquals(approved.premiseRowsAdoptionReply, undefined);
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("case l: a second approval after a proof text changed stores the document's current rows", async () => {
  const doc1 = premisesDoc(TWO_ROWS);
  const doc2 = premisesDoc(["| P1 | proof one, rerun | 2026-10-04 |", TWO_ROWS[1]]);
  const f = await adoptFixture(doc1);
  try {
    await openGate1Record(f.docPath, doc1, { stateDir: f.stateDir });
    await approveGate1Record(f.docPath, "approved", { stateDir: f.stateDir });
    await Deno.writeTextFile(f.docPath, doc2);
    await openGate1Record(f.docPath, doc2, { stateDir: f.stateDir });
    const { record } = await approveGate1Record(f.docPath, "approved again", {
      stateDir: f.stateDir,
    });
    assertEquals(record.premiseRows, [
      { premise: "P1", proof: "proof one, rerun", proved: "2026-10-04" },
      { premise: "P2", proof: "proof two", proved: "2026-10-02" },
    ]);
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("case m: openGate1Record on a record whose content is {not json refuses and the file is byte-identical", async () => {
  const f = await adoptFixture(premisesDoc(TWO_ROWS), "{not json");
  try {
    await assertRejects(
      () => openGate1Record(f.docPath, premisesDoc(TWO_ROWS), { stateDir: f.stateDir }),
      Gate1RecordError,
      "Cannot parse Gate 1 record",
    );
    assertEquals(await Deno.readTextFile(f.recordPath), "{not json");
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("case n: design:gate1-status on case a's record prints the count 2, the word adoption and its date", async () => {
  const f = await adoptFixture(premisesDoc(TWO_ROWS));
  try {
    await adoptGate1Record(f.docPath, "adopt it", { stateDir: f.stateDir });
    const lines: string[] = [];
    const code = await runGate1StatusCli([f.docPath, "--state-dir", f.stateDir], {
      log: (m) => lines.push(m),
      errorLog: () => {},
    });
    assertEquals(code, 0);
    const line = lines.find((l) => l.includes("Stored premise rows"));
    const today = toLocalIsoDate(new Date());
    assertEquals(line, `  Stored premise rows: 2 (source: adoption, ${today})`);
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("status shows no stored-rows line for a record with no rows, and 'unknown' for a missing source", () => {
  const base = { status: "open" as const, docPath: "/d", recordPath: "/r" };
  const none = formatGate1Status({
    ...base,
    record: { docPath: "/d", presentedFingerprint: "f", presentedAt: "t" },
  });
  assertEquals(none.some((l) => l.includes("Stored premise rows")), false);
  const odd = formatGate1Status({
    ...base,
    record: {
      docPath: "/d",
      presentedFingerprint: "f",
      presentedAt: "t",
      premiseRows: [],
    },
  });
  assertEquals(odd.at(-1), "  Stored premise rows: 0 (source: unknown, )");
});

Deno.test("runGate1AdoptCli adopts from --reply, --reply-file, and refuses on bad usage", async () => {
  const f = await adoptFixture(premisesDoc(TWO_ROWS));
  const out: string[] = [];
  const err: string[] = [];
  const session = await claudeCodeFixture(path.join(f.tempDir, "home"), [
    { kind: "josh", text: "adopt it", at: new Date() },
  ]);
  const io = {
    env: session.env,
    log: (m: string) => out.push(m),
    errorLog: (m: string) => err.push(m),
  };
  const sid = ["--session-id", session.sessionId];
  try {
    assertEquals(await runGate1AdoptCli(["--help"], io), 0);
    assertEquals(await runGate1AdoptCli(["--reply", "x"], io), 1); // no doc
    assertEquals(await runGate1AdoptCli([f.docPath], io), 1); // no reply
    assertEquals(
      await runGate1AdoptCli(
        [f.docPath, "--reply-file", path.join(f.tempDir, "nope.txt"), "--state-dir", f.stateDir],
        io,
      ),
      1,
    );
    assertEquals(
      await runGate1AdoptCli([f.docPath, "--reply", "  ", "--state-dir", f.stateDir], io),
      1,
    );
    const replyFile = path.join(f.tempDir, "reply.txt");
    await Deno.writeTextFile(replyFile, "adopt it\n");
    assertEquals(
      await runGate1AdoptCli(
        [f.docPath, "--reply-file", replyFile, "--state-dir", f.stateDir, ...sid],
        io,
      ),
      0,
    );
    assertEquals(out.some((l) => l.includes("Adopted 2 premise row(s)")), true);
    // The reply file's trailing newline is trimmed once, so the text stored is the text verified.
    assertEquals(
      (await loadGate1Record(f.docPath, { stateDir: f.stateDir }))?.premiseRowsAdoptionReply,
      "adopt it",
    );
    // Case c through the CLI: the second run exits non-zero.
    assertEquals(
      await runGate1AdoptCli(
        [f.docPath, "--reply", "adopt it", "--state-dir", f.stateDir, ...sid],
        io,
      ),
      1,
    );
    assertEquals(err.some((l) => l.includes("already holds")), true);
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("runCli routes gate1-adopt", async () => {
  const f = await adoptFixture(premisesDoc(TWO_ROWS));
  try {
    assertEquals(await runCli(["gate1-adopt", "--help"]), 0);
    assertEquals(await runCli(["gate1_adopt", "--help"]), 0);
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The stored rows are the rows design:lint-doc judges: both read the table through
// readLoadBearingPremisesTable, which skips fenced code blocks.
// ---------------------------------------------------------------------------

const FENCE = "```";
const BOTH_ROWS = [
  { premise: "P1", proof: "proof one", proved: "2026-09-24" },
  { premise: "P2", proof: "proof two", proved: "2026-10-02" },
];

/** The premises the checker reports on, read from its stale-date messages on a later day. */
function premisesLintJudged(doc: string): string[] {
  return lintDesignDoc(doc, "/x/doc.md", { nowImpl: () => new Date(2026, 9, 20, 12) }).violations
    .filter((v) => v.rule === "load-bearing-premises-stale-proof")
    .map((v) => v.message.match(/\("([^"]+)"\)/)?.[1] ?? "");
}

Deno.test("a fenced block inside the premises section does not end it: adopt and approve store every row the checker judges", async () => {
  const doc = [
    "# Test Design",
    "",
    "## Load-bearing premises",
    "",
    "| Premise | Proof | Proved |",
    "|---|---|---|",
    TWO_ROWS[0],
    "",
    `${FENCE}sh`,
    "# how P2 was checked",
    "deno --version",
    FENCE,
    "",
    TWO_ROWS[1],
    "",
    "## After",
    "Text.",
    "",
  ].join("\n");
  assertEquals(premisesLintJudged(doc), ["P1", "P2"]);
  const adopted = await adoptFixture(doc);
  const approved = await adoptFixture(doc);
  try {
    const { record: a } = await adoptGate1Record(adopted.docPath, "adopt it", {
      stateDir: adopted.stateDir,
      now: NOW,
    });
    assertEquals(a.premiseRows, BOTH_ROWS);
    await openGate1Record(approved.docPath, doc, { stateDir: approved.stateDir });
    const { record: b } = await approveGate1Record(approved.docPath, "approved", {
      stateDir: approved.stateDir,
    });
    assertEquals(b.premiseRows, BOTH_ROWS);
  } finally {
    await Deno.remove(adopted.tempDir, { recursive: true });
    await Deno.remove(approved.tempDir, { recursive: true });
  }
});

Deno.test("a fenced example table elsewhere in the document is not stored by adopt or approve", async () => {
  const doc = [
    "# Test Design",
    "",
    "## Format",
    "",
    `${FENCE}md`,
    "## Load-bearing premises",
    "| Premise | Proof | Proved |",
    "|---|---|---|",
    "| EXAMPLE | example proof | 2026-01-01 |",
    FENCE,
    "",
    "## Load-bearing premises",
    "",
    "| Premise | Proof | Proved |",
    "|---|---|---|",
    TWO_ROWS[0],
    "",
    "## After",
    "Text.",
    "",
  ].join("\n");
  const realRow = [BOTH_ROWS[0]];
  assertEquals(premisesLintJudged(doc), ["P1"]);
  const adopted = await adoptFixture(doc);
  const approved = await adoptFixture(doc);
  try {
    const { record: a } = await adoptGate1Record(adopted.docPath, "adopt it", {
      stateDir: adopted.stateDir,
      now: NOW,
    });
    assertEquals(a.premiseRows, realRow);
    await openGate1Record(approved.docPath, doc, { stateDir: approved.stateDir });
    const { record: b } = await approveGate1Record(approved.docPath, "approved", {
      stateDir: approved.stateDir,
    });
    assertEquals(b.premiseRows, realRow);
  } finally {
    await Deno.remove(adopted.tempDir, { recursive: true });
    await Deno.remove(approved.tempDir, { recursive: true });
  }
});

Deno.test("adopt refuses a table design:lint-doc calls malformed: an uneven row, duplicate rows, a separator out of place", async () => {
  const tables: Array<[string[], string]> = [
    [[TWO_ROWS[0], "| P2 | proof two | 2026-10-02 | extra |"], "has 4 cell(s), expected 3"],
    [[TWO_ROWS[0], TWO_ROWS[0]], "duplicate rows"],
    [[TWO_ROWS[0], "|---|---|---|", TWO_ROWS[1]], "not immediately after the header"],
  ];
  for (const [rows, message] of tables) {
    const f = await adoptFixture(premisesDoc(rows));
    try {
      const err = await assertRejects(
        () => adoptGate1Record(f.docPath, "adopt it", { stateDir: f.stateDir, now: NOW }),
        Gate1RecordError,
        "The premises table is malformed",
      );
      assertEquals(err.message.includes(message), true);
      await assertRejects(() => Deno.stat(f.recordPath), Deno.errors.NotFound);
    } finally {
      await Deno.remove(f.tempDir, { recursive: true });
    }
  }
});

Deno.test("status is 'not presented' for a record created by adoption, and 'open' once the document is presented", async () => {
  const doc = premisesDoc(TWO_ROWS);
  const f = await adoptFixture(doc);
  try {
    await adoptGate1Record(f.docPath, "adopt it", { stateDir: f.stateDir, now: NOW });
    const adopted = await getGate1Status(f.docPath, { stateDir: f.stateDir });
    assertEquals(adopted.status, "not presented");
    const lines = formatGate1Status(adopted);
    assertEquals(lines[0], "[design:gate1-status] not presented");
    assertEquals(lines.some((l) => l.includes("the document has not been presented")), true);
    assertEquals(lines.some((l) => l.includes("No Gate 1 record exists")), false);
    assertEquals(lines.at(-1), "  Stored premise rows: 2 (source: adoption, 2026-10-04)");

    await openGate1Record(f.docPath, doc, { stateDir: f.stateDir });
    const presented = await getGate1Status(f.docPath, { stateDir: f.stateDir });
    assertEquals(presented.status, "open");
    assertEquals(
      formatGate1Status(presented).at(-1),
      "  Stored premise rows: 2 (source: adoption, 2026-10-04)",
    );
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("the stored-rows line prints the local calendar day the rows were stored", () => {
  const lateEvening = new Date(2026, 9, 4, 23, 30, 0); // 2026-10-04 local, any time zone
  const lines = formatGate1Status({
    status: "open",
    docPath: "/d",
    recordPath: "/r",
    record: {
      docPath: "/d",
      presentedFingerprint: "f",
      presentedAt: "t",
      premiseRows: [],
      premiseRowsSource: "approval",
      premiseRowsStoredAt: lateEvening.toISOString(),
    },
  });
  assertEquals(lines.at(-1), "  Stored premise rows: 0 (source: approval, 2026-10-04)");
});

Deno.test("recordSweepNote records and updates sweepNotes without approving Gate 1, and refuses invalid inputs", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-sweep-note-" });
  try {
    const docPath = path.join(tempDir, "owner-design.md");
    const otherPath = path.join(tempDir, "other-design.md");
    const stateDir = path.join(tempDir, "state");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    await Deno.writeTextFile(otherPath, MINIMAL_DESIGN_DOC);

    await assertRejects(
      () => recordSweepNote("", otherPath, "why", { stateDir }),
      Gate1RecordError,
      "Design document path is required",
    );
    await assertRejects(
      () => recordSweepNote(docPath, "", "why", { stateDir }),
      Gate1RecordError,
      "Other design document path is required",
    );
    await assertRejects(
      () => recordSweepNote(docPath, otherPath, "   ", { stateDir }),
      Gate1RecordError,
      "Reason is empty",
    );
    await assertRejects(
      () => recordSweepNote(docPath, docPath, "self", { stateDir }),
      Gate1RecordError,
      "Cannot record a sweep note for the presented document itself",
    );

    const { record: first } = await recordSweepNote(docPath, otherPath, "Initial reason", {
      stateDir,
      nowImpl: () => new Date("2026-11-21T10:00:00Z"),
    });
    assertEquals(first.sweepNotes?.length, 1);
    assertEquals(first.sweepNotes?.[0].reason, "Initial reason");
    assertEquals((await getGate1Status(docPath, { stateDir })).status, "not presented");

    // Re-recording for the same otherPath replaces the previous note instead of duplicating.
    const { record: updated } = await recordSweepNote(docPath, otherPath, "Updated reason", {
      stateDir,
      nowImpl: () => new Date("2026-11-21T11:00:00Z"),
    });
    assertEquals(updated.sweepNotes?.length, 1);
    assertEquals(updated.sweepNotes?.[0].reason, "Updated reason");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("openGate1Record preserves sweepNotes and stores otherDesignSweep; approveGate1Record keeps otherDesignSweep and clears active sweepNotes", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-sweep-lifecycle-" });
  try {
    const docPath = path.join(tempDir, "owner-design.md");
    const otherPath = path.join(tempDir, "other-design.md");
    const stateDir = path.join(tempDir, "state");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    await Deno.writeTextFile(otherPath, MINIMAL_DESIGN_DOC);

    await recordSweepNote(docPath, otherPath, "Local workflow unaffected", { stateDir });

    const sweepSnapshot = {
      terms: ["Hydrogen"],
      checkedAt: "2026-11-21T12:00:00Z",
      presentingDay: "2026-11-21",
      entries: [
        {
          otherPath,
          lines: [7],
          terms: ["Hydrogen"],
          status: "noted" as const,
          reason: "Local workflow unaffected",
        },
      ],
    };

    const { record: opened } = await openGate1Record(docPath, MINIMAL_DESIGN_DOC, {
      stateDir,
      otherDesignSweep: sweepSnapshot,
    });
    assertEquals(opened.sweepNotes?.length, 1);
    assertEquals(opened.otherDesignSweep, sweepSnapshot);

    const statusOpen = await getGate1Status(docPath, { stateDir });
    assertEquals(
      formatGate1Status(statusOpen).some((l) =>
        l.includes('Other designs sweep: 1 hit(s)/note(s) for "Hydrogen" (2026-11-21)')
      ),
      true,
    );

    const { record: approved } = await approveGate1Record(docPath, "Approved", { stateDir });
    assertEquals(approved.otherDesignSweep, sweepSnapshot);
    assertEquals(approved.sweepNotes, undefined);

    const reloaded = await loadGate1Record(docPath, { stateDir });
    assertEquals(reloaded?.otherDesignSweep, sweepSnapshot);
    assertEquals(reloaded?.sweepNotes, undefined);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadGate1Record refuses malformed sweepNotes or otherDesignSweep", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-sweep-corrupt-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    const stateDir = path.join(tempDir, "state");
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const recordPath = getGate1RecordPath(docPath, stateDir);

    await Deno.writeTextFile(
      recordPath,
      JSON.stringify({
        docPath,
        presentedFingerprint: "abc",
        presentedAt: "2026-11-21T00:00:00Z",
        sweepNotes: [{ otherPath: 123 }],
      }),
    );
    await assertRejects(
      () => loadGate1Record(docPath, { stateDir }),
      Gate1RecordError,
      "malformed sweepNotes",
    );

    await Deno.writeTextFile(
      recordPath,
      JSON.stringify({
        docPath,
        presentedFingerprint: "abc",
        presentedAt: "2026-11-21T00:00:00Z",
        otherDesignSweep: { terms: ["Hydrogen"], entries: "bad" },
      }),
    );
    await assertRejects(
      () => loadGate1Record(docPath, { stateDir }),
      Gate1RecordError,
      "malformed otherDesignSweep",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runSweepNoteCli and runCli route sweep-note and validate arguments", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-sweep-cli-rec-" });
  const out: string[] = [];
  const err: string[] = [];
  const io = { log: (m: string) => out.push(m), errorLog: (m: string) => err.push(m) };

  try {
    const docPath = path.join(tempDir, "owner.md");
    const otherPath = path.join(tempDir, "other.md");
    const stateDir = path.join(tempDir, "state");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    await Deno.writeTextFile(otherPath, MINIMAL_DESIGN_DOC);

    assertEquals(await runSweepNoteCli(["--help"], io), 0);
    assertEquals(await runSweepNoteCli([], io), 1);
    assertEquals(await runSweepNoteCli([docPath], io), 1);
    assertEquals(await runSweepNoteCli([docPath, otherPath], io), 1);
    assertEquals(
      await runSweepNoteCli(
        [docPath, otherPath, "--reason", "Unaffected workflow", "--state-dir", stateDir],
        io,
      ),
      0,
    );
    assertEquals(out.some((l) => l.includes("[design:sweep-note] Recorded note")), true);

    assertEquals(await runCli(["sweep-note", "--help"]), 0);
    assertEquals(await runCli(["sweep_note", "--help"]), 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------------------------
// web-jam-tools#1412 — a Gate 1 reply is text Josh typed. Appendix D "A Gate 1 reply is text Josh
// typed": each case against a Claude Code, an agy and a Codex session fixture. In every fixture
// design:gate1 presented the document once, and Josh's turn after it reads "i approve document 2".

for (const fx of FIXTURES) {
  const presentedSetup = async (extra: FixtureTurn[] = []) => {
    const tempDir = await Deno.makeTempDir({ prefix: `gate1-reply-${fx.name.replace(" ", "")}-` });
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");
    const opened = await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    const presented = Date.parse(opened.record.presentedAt);
    const before = new Date(presented - 60_000);
    const after = new Date(presented + 60_000);
    const turns: FixtureTurn[] = [
      { kind: "josh", text: "i approve document 1", at: before },
      {
        kind: "agent",
        text: "Here is document 2 for your review.",
        at: new Date(presented + 1_000),
      },
      { kind: "josh", text: "i approve document 2", at: after },
      ...extra.map((t) => ({ ...t, at: t.at ?? after })),
    ];
    const session = await fx.build(path.join(tempDir, "home"), turns);
    return { tempDir, docPath, stateDir, session };
  };

  const approve = (
    s: Awaited<ReturnType<typeof presentedSetup>>,
    reply: string,
    sessionId = s.session.sessionId,
    env = s.session.env,
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    return runGate1ApproveCli(
      [s.docPath, "--reply", reply, "--session-id", sessionId, "--state-dir", s.stateDir],
      { env, log: (m) => out.push(m), errorLog: (m) => err.push(m) },
    ).then((code) => ({ code, out, err: err.join("\n") }));
  };

  Deno.test(`${fx.name}: a reply Josh typed after the presentation is recorded and status prints it`, async () => {
    const s = await presentedSetup();
    try {
      const r = await approve(s, "i approve document 2");
      assertEquals(r.code, 0, r.err);
      const status = await getGate1Status(s.docPath, { stateDir: s.stateDir });
      assertEquals(status.status, "approved");
      assertEquals(status.reply, "i approve document 2");
      const lines: string[] = [];
      assertEquals(
        await runGate1StatusCli([s.docPath, "--state-dir", s.stateDir], {
          log: (m) => lines.push(m),
        }),
        0,
      );
      assertEquals(lines.some((l) => l.includes("i approve document 2")), true);
    } finally {
      await Deno.remove(s.tempDir, { recursive: true });
    }
  });

  Deno.test(`${fx.name}: a reply Josh never typed is refused and nothing is recorded`, async () => {
    const s = await presentedSetup();
    try {
      const r = await approve(s, "Approved by Josh on 2026-10-14");
      assertEquals(r.code, 1);
      assertEquals(r.err.includes("does not appear word for word"), true, r.err);
      assertEquals(r.err.includes(s.session.transcriptPath), true, r.err);
      assertEquals((await getGate1Status(s.docPath, { stateDir: s.stateDir })).status, "open");
    } finally {
      await Deno.remove(s.tempDir, { recursive: true });
    }
  });

  Deno.test(`${fx.name}: a Josh turn from before the presentation is refused`, async () => {
    const s = await presentedSetup();
    try {
      const r = await approve(s, "i approve document 1");
      assertEquals(r.code, 1);
      assertEquals(r.err.includes("only before the document was last presented"), true, r.err);
      assertEquals((await getGate1Status(s.docPath, { stateDir: s.stateDir })).status, "open");
    } finally {
      await Deno.remove(s.tempDir, { recursive: true });
    }
  });

  for (const kind of ["agent", "subagent", "tool"] as const) {
    Deno.test(`${fx.name}: a reply found only in ${kind === "agent" ? "an agent turn" : kind === "subagent" ? "a subagent's or sidechain's prompt" : "a tool result"} is refused`, async () => {
      const text = "i approve document 3";
      const s = await presentedSetup([{ kind, text, at: new Date(Date.now() + 120_000) }]);
      try {
        const r = await approve(s, text);
        assertEquals(r.code, 1);
        assertEquals(r.err.includes("does not appear word for word"), true, r.err);
        assertEquals((await getGate1Status(s.docPath, { stateDir: s.stateDir })).status, "open");
      } finally {
        await Deno.remove(s.tempDir, { recursive: true });
      }
    });
  }

  Deno.test(`${fx.name}: a session id naming no transcript is refused, naming the path looked for`, async () => {
    const s = await presentedSetup();
    try {
      const missing = "00000000-0000-4000-8000-000000000000";
      const env = (name: string) =>
        name === "CODEX_THREAD_ID" && s.session.env(name)
          ? missing
          : name === "AGY_CONVERSATION_ID" && s.session.env(name)
          ? missing
          : name === "AGY_TRANSCRIPT_PATH" && s.session.env(name)
          ? s.session.env(name)!.replace(s.session.sessionId, missing)
          : s.session.env(name);
      const r = await approve(s, "i approve document 2", missing, env);
      assertEquals(r.code, 1);
      assertEquals(r.err.includes(missing), true, r.err);
      assertEquals(/looked for|Cannot read the session transcript/.test(r.err), true, r.err);
      assertEquals((await getGate1Status(s.docPath, { stateDir: s.stateDir })).status, "open");
    } finally {
      await Deno.remove(s.tempDir, { recursive: true });
    }
  });

  Deno.test(`${fx.name}: a transcript that cannot be parsed is refused, naming its path`, async () => {
    const s = await presentedSetup();
    try {
      await Deno.writeTextFile(s.session.transcriptPath, "{not json\n", { append: true });
      const r = await approve(s, "i approve document 2");
      assertEquals(r.code, 1);
      assertEquals(
        r.err.includes(`Cannot parse the session transcript at ${s.session.transcriptPath}`),
        true,
        r.err,
      );
      assertEquals((await getGate1Status(s.docPath, { stateDir: s.stateDir })).status, "open");
    } finally {
      await Deno.remove(s.tempDir, { recursive: true });
    }
  });

  Deno.test(`${fx.name}: gate1-adopt stores rows only for a reply Josh typed`, async () => {
    const f = await adoptFixture(premisesDoc(TWO_ROWS));
    try {
      const now = new Date();
      const session = await fx.build(path.join(f.tempDir, "home"), [
        { kind: "agent", text: "Shall I adopt document 2?", at: new Date(now.getTime() - 2_000) },
        { kind: "josh", text: "adopt document 2", at: new Date(now.getTime() - 1_000) },
      ]);
      const err: string[] = [];
      const io = { env: session.env, log: () => {}, errorLog: (m: string) => err.push(m) };
      const args = (reply: string) => [
        f.docPath,
        "--reply",
        reply,
        "--session-id",
        session.sessionId,
        "--state-dir",
        f.stateDir,
      ];
      assertEquals(await runGate1AdoptCli(args("adopt document 3"), io), 1);
      assertEquals(err.join("\n").includes("does not appear word for word"), true, err.join("\n"));
      assertEquals(await loadGate1Record(f.docPath, { stateDir: f.stateDir }), null);
      assertEquals(await runGate1AdoptCli(args("adopt document 2"), io), 0, err.join("\n"));
      const record = await loadGate1Record(f.docPath, { stateDir: f.stateDir });
      assertEquals(record?.premiseRows?.length, 2);
      assertEquals(record?.premiseRowsAdoptionReply, "adopt document 2");
    } finally {
      await Deno.remove(f.tempDir, { recursive: true });
    }
  });
}

Deno.test("agy: a subagent's own conversation is refused — its prompts were written by its parent", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-reply-agy-sub-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");
    const opened = await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    const after = new Date(Date.parse(opened.record.presentedAt) + 60_000);
    const home = path.join(tempDir, "home");
    await agyFixture(home, [{ kind: "subagent", text: "i approve document 2", at: after }]);
    const sub = agySubagentEnv(home);
    const err: string[] = [];
    const code = await runGate1ApproveCli(
      [
        docPath,
        "--reply",
        "i approve document 2",
        "--session-id",
        sub.sessionId,
        "--state-dir",
        stateDir,
      ],
      { env: sub.env, log: () => {}, errorLog: (m) => err.push(m) },
    );
    assertEquals(code, 1);
    assertEquals(err.join("\n").includes("is a subagent's"), true, err.join("\n"));
    assertEquals((await getGate1Status(docPath, { stateDir })).status, "open");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Codex: a helper session Josh did not start is refused", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-reply-codex-sub-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");
    const opened = await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    const after = new Date(Date.parse(opened.record.presentedAt) + 60_000);
    const session = await codexFixture(
      path.join(tempDir, "home"),
      [{ kind: "josh", text: "i approve document 2", at: after }],
      undefined,
      { source: "cli", originator: "codex-tui", thread_source: "subagent" },
    );
    const err: string[] = [];
    const code = await runGate1ApproveCli(
      [
        docPath,
        "--reply",
        "i approve document 2",
        "--session-id",
        session.sessionId,
        "--state-dir",
        stateDir,
      ],
      { env: session.env, log: () => {}, errorLog: (m) => err.push(m) },
    );
    assertEquals(code, 1);
    assertEquals(err.join("\n").includes("is not one Josh started"), true, err.join("\n"));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("gate1-approve refuses with no session id, and a session id that does not match this agy or Codex session", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-reply-ids-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");
    await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    const run = async (extra: string[], env: (n: string) => string | undefined) => {
      const err: string[] = [];
      const code = await runGate1ApproveCli(
        [docPath, "--reply", "ok", "--state-dir", stateDir, ...extra],
        { env, log: () => {}, errorLog: (m) => err.push(m) },
      );
      return { code, err: err.join("\n") };
    };
    const none = await run([], () => undefined);
    assertEquals(none.code, 1);
    assertEquals(none.err.includes("No session id"), true, none.err);
    const unsafe = await run(["--session-id", "../x"], () => undefined);
    assertEquals(unsafe.err.includes("is not a session id"), true, unsafe.err);
    const codex = await run(
      ["--session-id", "other"],
      (n) => n === "CODEX_THREAD_ID" ? "mine" : undefined,
    );
    assertEquals(codex.err.includes("is not this Codex session"), true, codex.err);
    const agy = await run(
      ["--session-id", "other"],
      (n) => n === "AGY_CONVERSATION_ID" ? "mine" : undefined,
    );
    assertEquals(agy.err.includes("is not this agy conversation"), true, agy.err);
    const agyNoPath = await run(
      ["--session-id", "mine"],
      (n) => n === "AGY_CONVERSATION_ID" ? "mine" : undefined,
    );
    assertEquals(agyNoPath.err.includes("AGY_TRANSCRIPT_PATH is unset"), true, agyNoPath.err);
    assertEquals((await getGate1Status(docPath, { stateDir })).status, "open");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("sessionIdFor prefers --session-id, then the running tool's own session id", () => {
  const env = (vars: Record<string, string>) => (n: string) => vars[n];
  assertEquals(sessionIdFor(" given ", env({ CLAUDE_CODE_SESSION_ID: "c" })), "given");
  assertEquals(
    sessionIdFor(undefined, env({ CODEX_THREAD_ID: "x", CLAUDE_CODE_SESSION_ID: "c" })),
    "x",
  );
  assertEquals(sessionIdFor("", env({ AGY_CONVERSATION_ID: "a" })), "a");
  assertEquals(sessionIdFor(undefined, env({ CLAUDE_CODE_SESSION_ID: "c" })), "c");
  assertEquals(sessionIdFor(undefined, env({})), "");
});

Deno.test("reply-check helpers: agy USER_REQUEST text and Codex injected blocks", () => {
  assertEquals(
    agyUserRequestText(
      "<USER_REQUEST>\nyes go\n</USER_REQUEST>\n<ADDITIONAL_METADATA>i approve</ADDITIONAL_METADATA>",
    ),
    "yes go",
  );
  assertEquals(agyUserRequestText("no wrapper"), "");
  assertEquals(isCodexInjectedText("# AGENTS.md instructions for /x"), true);
  assertEquals(
    isCodexInjectedText("<environment_context>\n<cwd>/x</cwd>\n</environment_context>"),
    true,
  );
  assertEquals(isCodexInjectedText("<skill>\n<name>a</name>\n</skill>"), true);
  assertEquals(isCodexInjectedText("i approve <b>this</b>"), false);
  assertEquals(isCodexInjectedText("<b>yes</b> and more"), false);
});

Deno.test("approveGate1Record refuses a record with a missing or invalid presentation time, before checking the reply", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-presented-at-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");
    const { recordPath } = await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    for (const presentedAt of [undefined, "", "not a date"]) {
      const record = JSON.parse(await Deno.readTextFile(recordPath));
      if (presentedAt === undefined) delete record.presentedAt;
      else record.presentedAt = presentedAt;
      await Deno.writeTextFile(recordPath, JSON.stringify(record));
      let checked = false;
      await assertRejects(
        () =>
          approveGate1Record(docPath, "yes", {
            stateDir,
            verifyReply: () => {
              checked = true;
              return Promise.resolve();
            },
          }),
        Gate1RecordError,
        "holds no usable presentation time",
      );
      assertEquals(checked, false);
      assertEquals((await getGate1Status(docPath, { stateDir })).status, "open");
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("verifyReplyTypedByJosh refuses an approval cutoff that is missing or unparseable", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-cutoff-" });
  try {
    const session = await claudeCodeFixture(path.join(tempDir, "home"), [
      { kind: "josh", text: "i approve", at: new Date() },
    ]);
    for (const after of [undefined, "", "not a date"]) {
      await assertRejects(
        () =>
          verifyReplyTypedByJosh({
            sessionId: session.sessionId,
            reply: "i approve",
            after,
            env: session.env,
          }),
        Error,
        "holds no usable presentation time",
      );
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("approval refuses, and keeps the newer presentation, when the document is presented again during the reply check", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-represent-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");
    const first = await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    let newer = "";
    await assertRejects(
      () =>
        approveGate1Record(docPath, "yes", {
          stateDir,
          verifyReply: async () => {
            await new Promise((r) => setTimeout(r, 5));
            newer = (await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir })).record
              .presentedAt;
          },
        }),
      Gate1RecordError,
      "presented again while the reply was being checked",
    );
    const record = await loadGate1Record(docPath, { stateDir });
    assertEquals(record?.presentedAt, newer);
    assertEquals(record?.presentedAt !== first.record.presentedAt, true);
    assertEquals(record?.approvedAt, undefined);
    assertEquals((await getGate1Status(docPath, { stateDir })).status, "open");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("a record update waits for the lock another command holds, then keeps that command's write", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-lock-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    const otherPath = path.join(tempDir, "other.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");
    const { recordPath } = await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    const holder = await Deno.open(`${recordPath}.lock`, { create: true, write: true });
    try {
      assertEquals(await holder.tryLock(true), true);
      const noting = recordSweepNote(docPath, otherPath, "unaffected", { stateDir });
      await new Promise((r) => setTimeout(r, 100));
      // Still waiting: nothing written while the lock is held.
      assertEquals((await loadGate1Record(docPath, { stateDir }))?.sweepNotes, undefined);
      await holder.unlock();
      await noting;
    } finally {
      holder.close();
    }
    assertEquals((await loadGate1Record(docPath, { stateDir }))?.sweepNotes?.length, 1);
    // The lock file stays; only the lock on it is released.
    assertEquals((await Deno.stat(`${recordPath}.lock`)).isFile, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("withGate1RecordLock refuses once the wait runs out, and refuses at once when it cannot lock", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-lock-refuse-" });
  try {
    const recordPath = path.join(tempDir, "record.json");
    let ran = false;
    const run = () => {
      ran = true;
      return Promise.resolve();
    };
    const holder = await Deno.open(`${recordPath}.lock`, { create: true, write: true });
    try {
      assertEquals(await holder.tryLock(true), true);
      await assertRejects(
        () => withGate1RecordLock(recordPath, run, 50),
        Gate1RecordError,
        "is locked by another command",
      );
    } finally {
      holder.close();
    }
    assertEquals(ran, false);

    const blocked = path.join(tempDir, "blocked.json");
    await Deno.mkdir(`${blocked}.lock`);
    const started = Date.now();
    await assertRejects(
      () => withGate1RecordLock(blocked, run, 5_000),
      Gate1RecordError,
      "Cannot lock Gate 1 record",
    );
    assertEquals(Date.now() - started < 1_000, true);
    assertEquals(ran, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("a lock held by another process stays exclusive until that process exits", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-lock-proc-" });
  try {
    const recordPath = path.join(tempDir, "record.json");
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `const f = await Deno.open(${
          JSON.stringify(`${recordPath}.lock`)
        }, { create: true, write: true });
         await f.lock(true);
         console.log("locked");
         await new Promise(() => setInterval(() => {}, 1000));`,
      ],
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const reader = child.stdout.getReader();
    try {
      const { value } = await reader.read();
      assertEquals(new TextDecoder().decode(value).trim(), "locked");
      await assertRejects(
        () => withGate1RecordLock(recordPath, () => Promise.resolve(), 200),
        Gate1RecordError,
        "is locked by another command",
      );
    } finally {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        assertInstanceOf(error, Deno.errors.NotFound);
      }
      await child.status;
      reader.releaseLock();
      await child.stdout.cancel();
    }
    assertEquals(await withGate1RecordLock(recordPath, () => Promise.resolve("ran"), 2_000), "ran");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("adoption refuses, storing no rows, when the document changes during the reply check", async () => {
  const f = await adoptFixture(premisesDoc(TWO_ROWS));
  try {
    await assertRejects(
      () =>
        adoptGate1Record(f.docPath, "adopt it", {
          stateDir: f.stateDir,
          verifyReply: async () => {
            await Deno.writeTextFile(f.docPath, premisesDoc(TWO_ROWS) + "\nEdited meanwhile.\n");
          },
        }),
      Gate1RecordError,
      "Document changed while the reply was being checked",
    );
    assertEquals(await loadGate1Record(f.docPath, { stateDir: f.stateDir }), null);
  } finally {
    await Deno.remove(f.tempDir, { recursive: true });
  }
});

Deno.test("agy: a reply in a turn the transcript attributes to another conversation is refused", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-reply-agy-other-" });
  try {
    const docPath = path.join(tempDir, "doc.md");
    await Deno.writeTextFile(docPath, MINIMAL_DESIGN_DOC);
    const stateDir = path.join(tempDir, "state");
    const opened = await openGate1Record(docPath, MINIMAL_DESIGN_DOC, { stateDir });
    const after = new Date(Date.parse(opened.record.presentedAt) + 60_000);
    const session = await agyFixture(path.join(tempDir, "home"), [
      { kind: "josh", text: "looks close", at: after },
    ]);
    const createdAt = after.toISOString().replace(/\.\d{3}Z$/, "Z");
    await Deno.writeTextFile(
      session.transcriptPath,
      JSON.stringify({
        step_index: 9,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: createdAt,
        conversationId: "11111111-2222-4333-8444-555555555555",
        content: "<USER_REQUEST>\ni approve document 2\n</USER_REQUEST>",
      }) + "\n",
      { append: true },
    );
    const err: string[] = [];
    const code = await runGate1ApproveCli(
      [
        docPath,
        "--reply",
        "i approve document 2",
        "--session-id",
        session.sessionId,
        "--state-dir",
        stateDir,
      ],
      { env: session.env, log: () => {}, errorLog: (m) => err.push(m) },
    );
    assertEquals(code, 1);
    assertEquals(err.join("\n").includes("does not appear word for word"), true, err.join("\n"));
    assertEquals((await getGate1Status(docPath, { stateDir })).status, "open");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("verifyReplyTypedByJosh matches the reply exactly as it will be stored", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-exact-" });
  try {
    const session = await claudeCodeFixture(path.join(tempDir, "home"), [
      { kind: "josh", text: "adopt it", at: new Date() },
    ]);
    const check = (reply: string) =>
      verifyReplyTypedByJosh({ sessionId: session.sessionId, reply, env: session.env });
    assertEquals((await check("adopt it")).transcriptPath, session.transcriptPath);
    await assertRejects(() => check("adopt it\n"), Error, "does not appear word for word");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
