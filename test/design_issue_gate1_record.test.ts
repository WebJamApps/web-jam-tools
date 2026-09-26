// test/design_issue_gate1_record.test.ts — web-jam-tools#1155
//
// Unit tests for Gate 1 disk record helper (gate1_record.ts) and CLI commands
// (design:gate1-approve and design:gate1-status).

import { assertEquals, assertRejects } from "@std/assert";
import * as path from "@std/path";
import {
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
} from "../src/design-issue/gate1_record.ts";
import { runGate1ApproveCli, runGate1StatusCli } from "../src/design-issue/cli.ts";

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

    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runGate1ApproveCli(
      [docPath, "--reply", "Approved from CLI", "--state-dir", stateDir],
      {
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

    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runGate1ApproveCli(
      [docPath, "--reply-file", replyFilePath, "--state-dir", stateDir],
      {
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
