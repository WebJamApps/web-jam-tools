// test/accounting/accounting.test.ts
// Unit tests for Web Jam LLC double-entry accounting in hledger (web-jam-tools#1764).

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { runCli } from "../../src/accounting/cli.ts";
import { closeMonth } from "../../src/accounting/close_month.ts";
import {
  convertBankFile,
  detectBankFormat,
  normalizeOfxDate,
  normalizeQifDate,
  parseOfx,
  parseQif,
} from "../../src/accounting/convert.ts";
import { createEntry, formatTransaction } from "../../src/accounting/entry.ts";
import { importStatement } from "../../src/accounting/import.ts";
import { fileReceipt } from "../../src/accounting/receipt.ts";
import { verifyJournalBalances } from "../../src/accounting/verify.ts";
import { installSkills } from "../../src/install-skills/lib.ts";

const FIXTURES_DIR = path.resolve(
  new URL("./fixtures", import.meta.url).pathname,
);

Deno.test("detectBankFormat identifies OFX, QIF, and CSV correctly", () => {
  assertEquals(detectBankFormat("<OFX><STMTTRN></STMTTRN></OFX>"), "ofx");
  assertEquals(detectBankFormat("OFXHEADER:100\nDATA:OFXSGML\n"), "ofx");
  assertEquals(detectBankFormat("!Type:Bank\nD01/10/2026\nT100.00\n^\n"), "qif");
  assertEquals(detectBankFormat("date,description,amount,id\n2026-01-10,Test,10.00,1\n"), "csv");
  assertEquals(detectBankFormat("just some random text"), "unknown");
});

Deno.test("normalizeOfxDate and normalizeQifDate handle various date formats", () => {
  assertEquals(normalizeOfxDate("20260110120000[-5:EST]"), "2026-01-10");
  assertEquals(normalizeOfxDate("20261125"), "2026-11-25");

  assertEquals(normalizeQifDate("01/10/2026"), "2026-01-10");
  assertEquals(normalizeQifDate("1/5/2026"), "2026-01-05");
  assertEquals(normalizeQifDate("11/10'26"), "2026-11-10");
  assertEquals(normalizeQifDate("2026-01-10"), "2026-01-10");
});

Deno.test("parseOfx extracts transactions from QFX/OFX fixture", async () => {
  const content = await Deno.readTextFile(path.join(FIXTURES_DIR, "sample-bank.qfx"));
  const txs = parseOfx(content);

  assertEquals(txs.length, 3);
  assertEquals(txs[0].date, "2026-01-10");
  assertEquals(txs[0].amount, 250.00);
  assertEquals(txs[0].payee, "Floyd Country Store");
  assertEquals(txs[0].id, "TXN20260110001");
  assertEquals(txs[0].memo, "Performance Pay");

  assertEquals(txs[1].date, "2026-01-15");
  assertEquals(txs[1].amount, -22.86);
  assertEquals(txs[1].payee, "Penn Station");
  assertEquals(txs[1].id, "TXN20260115002");

  assertEquals(txs[2].date, "2026-01-20");
  assertEquals(txs[2].amount, -50.00);
  assertEquals(txs[2].payee, "State Corporation Commission");
  assertEquals(txs[2].id, "TXN20260120003");
});

Deno.test("parseQif extracts transactions from QIF fixture", async () => {
  const content = await Deno.readTextFile(path.join(FIXTURES_DIR, "sample-card.qif"));
  const txs = parseQif(content);

  assertEquals(txs.length, 2);
  assertEquals(txs[0].date, "2026-01-18");
  assertEquals(txs[0].amount, -29.00);
  assertEquals(txs[0].payee, "OpenAI");
  assertEquals(txs[0].id, "TXN20260118001");

  assertEquals(txs[1].date, "2026-01-25");
  assertEquals(txs[1].amount, -15.50);
  assertEquals(txs[1].payee, "Office Depot");
  assertEquals(txs[1].id, "TXN20260125002");
});

Deno.test("convertBankFile translates QFX to CSV correctly", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "accounting-test-convert-" });
  try {
    const qfxPath = path.join(FIXTURES_DIR, "sample-bank.qfx");
    const outCsvPath = path.join(tempDir, "converted.csv");

    const result = await convertBankFile({
      inputPath: qfxPath,
      outputPath: outCsvPath,
    });

    assertEquals(result.count, 3);
    const written = await Deno.readTextFile(outCsvPath);
    assertStringIncludes(written, "date,description,amount,id,memo");
    assertStringIncludes(written, "2026-01-10,Floyd Country Store,250.00,TXN20260110001");
    assertStringIncludes(written, "2026-01-15,Penn Station,-22.86,TXN20260115002");
    assertStringIncludes(written, "2026-01-20,State Corporation Commission,-50.00,TXN20260120003");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("convertBankFile throws on unsupported file format", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "accounting-test-unsupported-" });
  try {
    const invalidPath = path.join(tempDir, "bad.txt");
    await Deno.writeTextFile(invalidPath, "completely unknown file content");

    await assertRejects(
      async () => {
        await convertBankFile({ inputPath: invalidPath });
      },
      Error,
      "Unsupported bank file format",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("The tests prove that a converted file imports, and a second import adds nothing", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "accounting-test-import-" });
  try {
    const qfxPath = path.join(FIXTURES_DIR, "sample-bank.qfx");
    const rulesPath = path.join(FIXTURES_DIR, "sample-rules.rules");
    const csvPath = path.join(tempDir, "statement.csv");
    const journalPath = path.join(tempDir, "2026.journal");

    // 1. Convert QFX bank file to CSV
    const convertRes = await convertBankFile({
      inputPath: qfxPath,
      outputPath: csvPath,
    });
    assertEquals(convertRes.count, 3);

    // 2. First import of converted file into the journal
    const importRes1 = await importStatement({
      statementPath: csvPath,
      journalPath,
      rulesPath,
      account: "Assets:Checking:Truist",
    });

    assertEquals(importRes1.importedCount, 3);
    assertEquals(importRes1.skippedCount, 0);

    const journalAfterImport1 = await Deno.readTextFile(journalPath);
    assertStringIncludes(journalAfterImport1, "2026-01-10 (TXN20260110001) Floyd Country Store");
    assertStringIncludes(journalAfterImport1, "Income:Performance");
    assertStringIncludes(journalAfterImport1, "Assets:Checking:Truist");
    assertStringIncludes(journalAfterImport1, "2026-01-15 (TXN20260115002) Penn Station");
    assertStringIncludes(journalAfterImport1, "Expenses:Meals");
    assertStringIncludes(
      journalAfterImport1,
      "2026-01-20 (TXN20260120003) State Corporation Commission",
    );
    assertStringIncludes(journalAfterImport1, "Expenses:RegistrationFees");

    // 3. Second import of the identical statement file adds NOTHING (idempotent / duplicate prevention)
    const importRes2 = await importStatement({
      statementPath: csvPath,
      journalPath,
      rulesPath,
      account: "Assets:Checking:Truist",
    });

    assertEquals(importRes2.importedCount, 0);
    assertEquals(importRes2.skippedCount, 3);

    const journalAfterImport2 = await Deno.readTextFile(journalPath);
    assertEquals(
      journalAfterImport2,
      journalAfterImport1,
      "Second import must leave journal completely unmodified",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("The tests prove that a closed month stops a later edit that changes its balance", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "accounting-test-close-" });
  try {
    const journalPath = path.join(tempDir, "2026.journal");

    // Seed an initial opening balance and transactions in January 2026
    // Starting balance: $1000.00
    // Income: +$250.00
    // Meals: -$22.86
    // Registration: -$50.00
    // Expected checking balance at month-end: 1000 + 250 - 22.86 - 50 = $1177.14
    const initialJournal = `2026-01-01 * Opening Balance
    Assets:Checking:Truist               $1000.00
    Equity:OpeningBalances              $-1000.00

2026-01-10 (TXN001) Floyd Country Store
    ; id: TXN001
    Income:Performance                   $-250.00
    Assets:Checking:Truist                $250.00

2026-01-15 (TXN002) Penn Station
    ; id: TXN002
    Expenses:Meals                        $22.86
    Assets:Checking:Truist               $-22.86

2026-01-20 (TXN003) State Corporation Commission
    ; id: TXN003
    Expenses:RegistrationFees             $50.00
    Assets:Checking:Truist               $-50.00
`;

    await Deno.writeTextFile(journalPath, initialJournal);

    // Initial journal is valid
    const preVerify = verifyJournalBalances(initialJournal);
    assertEquals(preVerify.valid, true);
    assertEquals(preVerify.errors.length, 0);

    // Close month 2026-01 asserting bank statement balance of $1177.14
    const closeRes = await closeMonth({
      year: 2026,
      month: 1,
      balances: {
        "Assets:Checking:Truist": 1177.14,
      },
      journalPath,
      booksDir: tempDir,
    });

    assertEquals(closeRes.closeDate, "2026-01-31");
    assertEquals(closeRes.balances["Assets:Checking:Truist"], 1177.14);

    // Verify snapshot and reports exist
    const snapshotContent = await Deno.readTextFile(closeRes.snapshotPath);
    assertStringIncludes(snapshotContent, "Close Month 2026-01");
    assertStringIncludes(snapshotContent, "Assets:Checking:Truist");
    assertStringIncludes(snapshotContent, "$0.00 = $1177.14");

    const bsReport = await Deno.readTextFile(
      path.join(tempDir, "closed", "2026-01", "balance-sheet.txt"),
    );
    assertStringIncludes(bsReport, "Assets:Checking:Truist");
    assertStringIncludes(bsReport, "$1177.14");

    const isReport = await Deno.readTextFile(
      path.join(tempDir, "closed", "2026-01", "income-statement.txt"),
    );
    assertStringIncludes(isReport, "Income:Performance");
    assertStringIncludes(isReport, "$250.00");

    // Closed journal verifies cleanly
    const closedJournal = await Deno.readTextFile(journalPath);
    const postCloseVerify = verifyJournalBalances(closedJournal);
    assertEquals(postCloseVerify.valid, true);
    assertEquals(postCloseVerify.assertionsChecked, 1);

    // NOW TEST THE TAMPER / LATER EDIT BEHAVIOR:
    // A later edit alters an earlier transaction in the closed month (e.g. changing -$22.86 to -$50.00)
    const tamperedJournal = closedJournal.replace("$-22.86", "$-50.00").replace("$22.86", "$50.00");
    const tamperedVerify = verifyJournalBalances(tamperedJournal);

    assertEquals(
      tamperedVerify.valid,
      false,
      "Verification must FAIL when a closed month's transaction is edited",
    );
    assertEquals(tamperedVerify.errors.length > 0, true);
    assertStringIncludes(
      tamperedVerify.errors[0],
      "Balance assertion failed for 'Assets:Checking:Truist'",
    );
    assertStringIncludes(tamperedVerify.errors[0], "expected $1177.14");

    // Also verify inserting a new transaction in the closed month fails assertion
    const insertedTxJournal = closedJournal.replace(
      "2026-01-31 * Close Month",
      `2026-01-28 Sneaky Charge\n    Expenses:Supplies                     $30.00\n    Assets:Checking:Truist               $-30.00\n\n2026-01-31 * Close Month`,
    );
    const insertedVerify = verifyJournalBalances(insertedTxJournal);
    assertEquals(insertedVerify.valid, false);
    assertStringIncludes(insertedVerify.errors[0], "Balance assertion failed");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("createEntry handles personal crossing (contributions & draws) and tags", () => {
  // 1. Standard meal expense with attendees
  const mealTx = createEntry({
    date: "2026-11-10",
    description: "Penn Station",
    amount: 22.86,
    category: "Expenses:Meals",
    fromAccount: "Liabilities:CreditCard",
    purpose: "Lunch meeting",
    attendees: "Josh, Maria",
    receipt: "receipts/2026/2026-11-10-penn-station.pdf",
  });

  const formattedMeal = formatTransaction(mealTx);
  assertStringIncludes(formattedMeal, "2026-11-10 Penn Station");
  assertStringIncludes(formattedMeal, "; purpose: Lunch meeting");
  assertStringIncludes(formattedMeal, "; attendees: Josh, Maria");
  assertStringIncludes(formattedMeal, "; receipt: receipts/2026/2026-11-10-penn-station.pdf");
  assertStringIncludes(formattedMeal, "Expenses:Meals");
  assertStringIncludes(formattedMeal, "$22.86");
  assertStringIncludes(formattedMeal, "Liabilities:CreditCard");
  assertStringIncludes(formattedMeal, "$-22.86");

  // 2. Business expense paid personally by owner -> Owner contribution
  const contribTx = createEntry({
    date: "2026-11-12",
    description: "Office Depot",
    amount: 15.00,
    category: "Expenses:Supplies",
    owner: "Josh",
    purpose: "Printer paper",
  });
  const formattedContrib = formatTransaction(contribTx);
  assertStringIncludes(formattedContrib, "; owner: Josh");
  assertStringIncludes(formattedContrib, "Expenses:Supplies");
  assertStringIncludes(formattedContrib, "$15.00");
  assertStringIncludes(formattedContrib, "Equity:OwnerContributions:Josh");
  assertStringIncludes(formattedContrib, "$-15.00");

  // 3. Personal purchase paid from business account -> Owner draw (never expense)
  const drawTx = createEntry({
    date: "2026-11-15",
    description: "Supermarket",
    amount: 40.00,
    category: "Equity:OwnerDraws:Maria",
    fromAccount: "Assets:Checking:Truist",
    owner: "Maria",
    isDraw: true,
  });
  const formattedDraw = formatTransaction(drawTx);
  assertStringIncludes(formattedDraw, "Equity:OwnerDraws:Maria");
  assertStringIncludes(formattedDraw, "$40.00");
  assertStringIncludes(formattedDraw, "Assets:Checking:Truist");
  assertStringIncludes(formattedDraw, "$-40.00");
});

Deno.test("fileReceipt files PDF from inbox/ into receipts/<year>/", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "accounting-test-receipt-" });
  try {
    const inboxDir = path.join(tempDir, "inbox");
    await Deno.mkdir(inboxDir, { recursive: true });

    // Place a scan in inbox
    const scanPath = path.join(inboxDir, "scan_20261110.pdf");
    await Deno.writeTextFile(scanPath, "%PDF-1.4 mock scan content");

    const result = await fileReceipt({
      booksDir: tempDir,
      year: 2026,
      date: "2026-11-10",
      place: "Penn Station",
      sourceFile: "scan_20261110.pdf",
    });

    assertEquals(result.filed, true);
    assertEquals(result.relativePath, "receipts/2026/2026-11-10-penn-station.pdf");

    // File moved to destination
    const targetFile = path.join(tempDir, "receipts", "2026", "2026-11-10-penn-station.pdf");
    const stat = await Deno.stat(targetFile);
    assertEquals(stat.isFile, true);

    // Inbox file was moved, not duplicated
    await assertRejects(async () => await Deno.stat(scanPath));

    // When inbox is empty, reports that entry itself is the record
    const emptyResult = await fileReceipt({
      booksDir: tempDir,
      year: 2026,
      date: "2026-11-11",
      place: "Cash Gig",
    });
    assertEquals(emptyResult.filed, false);
    assertStringIncludes(emptyResult.message, "entry itself serves as the record");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("accounting CLI runs subcommands cleanly", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "accounting-test-cli-" });
  try {
    const journalPath = path.join(tempDir, "2026.journal");

    // 1. Help flag
    const helpExit = await runCli(["--help"]);
    assertEquals(helpExit, 0);

    // 2. init-books
    const initExit = await runCli(["init-books", "--books-dir", tempDir]);
    assertEquals(initExit, 0);

    // 3. entry subcommand
    const entryExit = await runCli([
      "entry",
      "--date",
      "2026-01-15",
      "--desc",
      "Penn Station",
      "--amount",
      "22.86",
      "--category",
      "Expenses:Meals",
      "--from",
      "Liabilities:CreditCard",
      "--purpose",
      "Lunch Meeting",
      "--attendees",
      "Josh, Maria",
      "--journal",
      journalPath,
    ]);
    assertEquals(entryExit, 0);

    const journalContent = await Deno.readTextFile(journalPath);
    assertStringIncludes(journalContent, "2026-01-15 Penn Station");
    assertStringIncludes(journalContent, "Expenses:Meals");

    // 4. verify subcommand
    const verifyExit = await runCli(["verify", "--journal", journalPath]);
    assertEquals(verifyExit, 0);

    // 5. convert subcommand
    const qfxPath = path.join(FIXTURES_DIR, "sample-bank.qfx");
    const outCsv = path.join(tempDir, "converted.csv");
    const convertExit = await runCli([
      "convert",
      "--input",
      qfxPath,
      "--output",
      outCsv,
    ]);
    assertEquals(convertExit, 0);
    const convertedContent = await Deno.readTextFile(outCsv);
    assertStringIncludes(convertedContent, "TXN20260110001");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("installSkills installs accounting skill into Claude Code and agy destinations", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "accounting-test-install-" });
  try {
    const claudeDest = path.join(tempDir, "claude-skills");
    const agyDest = path.join(tempDir, "agy-skills");

    // Install using current worktree repoDir
    const repoDir = path.resolve(new URL("../..", import.meta.url).pathname);

    const res = await installSkills({
      allowUnsafeForTesting: true,
      repoDir,
      claudeDest,
      agyDest,
      quiet: true,
    });

    assertEquals(res.success, true);

    // Verify ~/.claude/skills/accounting symlink
    const claudeLink = path.join(claudeDest, "accounting");
    const claudeStat = await Deno.lstat(claudeLink);
    assertEquals(claudeStat.isSymlink, true);
    const claudeTarget = await Deno.readLink(claudeLink);
    assertStringIncludes(claudeTarget, "skills/accounting");

    // Verify agy symlink
    const agyLink = path.join(agyDest, "accounting");
    const agyStat = await Deno.lstat(agyLink);
    assertEquals(agyStat.isSymlink, true);
    const agyTarget = await Deno.readLink(agyLink);
    assertStringIncludes(agyTarget, "skills/accounting");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
