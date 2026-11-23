// test/accounting/accounting.test.ts
// Tests for Web Jam LLC's books (web-jam-tools#1764): entries, receipts and the check in rustledger's
// Beancount books (web-jam-tools#1865), and import and month close on the journal file until
// web-jam-tools#1866. Every figure here is made up.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import * as path from "@std/path";
import { getDefaultBooksPath, getDefaultJournalPath, runCli } from "../../src/accounting/cli.ts";
import { closeMonth } from "../../src/accounting/close_month.ts";
import {
  convertBankFile,
  detectBankFormat,
  normalizeOfxDate,
  normalizeQifDate,
  parseOfx,
  parseQif,
} from "../../src/accounting/convert.ts";
import {
  appendEntryToBooks,
  assertBeancountAccount,
  assertCalendarDate,
  createEntry,
  formatBeancountTransaction,
  formatTransaction,
  parseBeancount,
} from "../../src/accounting/entry.ts";
import { importStatement } from "../../src/accounting/import.ts";
import { fileReceipt, receiptMetadataLine } from "../../src/accounting/receipt.ts";
import { checkBooks, verifyJournalBalances } from "../../src/accounting/verify.ts";
import { installSkills } from "../../src/install-skills/lib.ts";

const FIXTURES_DIR = path.resolve(
  new URL("./fixtures", import.meta.url).pathname,
);

const INSTALL_RUSTLEDGER = path.resolve(
  new URL("../../scripts/install-rustledger.sh", import.meta.url).pathname,
);

let rustledgerDir: Promise<string> | undefined;

/**
 * The directory holding `rledger`, unpacked once per test run into a temporary directory by
 * `scripts/install-rustledger.sh` after it checks the release's published SHA-256 checksum —
 * the same release CircleCI installs — and removed when the test process ends.
 */
function rledgerDir(): Promise<string> {
  rustledgerDir ??= (async () => {
    const dir = await Deno.makeTempDir({ prefix: "rustledger-test-" });
    globalThis.addEventListener("unload", () => {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch {
        // already gone
      }
    });
    const out = await new Deno.Command("bash", {
      args: [INSTALL_RUSTLEDGER, dir],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.code !== 0) {
      throw new Error(`install-rustledger.sh failed: ${new TextDecoder().decode(out.stderr)}`);
    }
    return dir;
  })();
  return rustledgerDir;
}

async function rledgerPath(): Promise<string> {
  return path.join(await rledgerDir(), "rledger");
}

/** Runs `fn` with HOME and PATH set for the CLI, restoring both afterwards. */
async function withEnv<T>(
  vars: { HOME?: string; PATH?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const saved = { HOME: Deno.env.get("HOME"), PATH: Deno.env.get("PATH") };
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value !== undefined) Deno.env.set(key, value);
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

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
    const booksPath = path.join(tempDir, "2026.beancount");
    const rledger = await rledgerDir();

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
      "--books",
      booksPath,
    ]);
    assertEquals(entryExit, 0);

    const booksContent = await Deno.readTextFile(booksPath);
    assertStringIncludes(booksContent, '2026-01-15 * "Penn Station"');
    assertStringIncludes(booksContent, "Expenses:Meals");

    // 4. verify subcommand runs rledger check from PATH
    const verifyExit = await withEnv(
      { PATH: `${rledger}:${Deno.env.get("PATH") ?? ""}` },
      () => runCli(["verify", "--books", booksPath]),
    );
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

// ---- Beancount books in rustledger (web-jam-tools#1865) ----

Deno.test("Beancount entries carry date, place, amount, category, purpose, receipt, attendees and owner", () => {
  const meal = createEntry({
    date: "2026-11-10",
    description: 'Penn "Station" \\ Deli',
    amount: 22.86,
    category: "Expenses:Meals",
    fromAccount: "Liabilities:CreditCard",
    purpose: "Lunch meeting",
    attendees: "Josh, Maria",
    receipt: "receipts/2026/2026-11-10-penn-station.pdf",
  });
  const text = formatBeancountTransaction(meal);
  assertStringIncludes(text, '2026-11-10 * "Penn \\"Station\\" \\\\ Deli"');
  assertStringIncludes(text, '  purpose: "Lunch meeting"');
  assertStringIncludes(text, '  attendees: "Josh, Maria"');
  assertStringIncludes(text, '  receipt: "receipts/2026/2026-11-10-penn-station.pdf"');
  assert(/\n {2}Expenses:Meals\s+22\.86 USD\n/.test(text), text);
  assert(/\n {2}Liabilities:CreditCard\s+-22\.86 USD\n/.test(text), text);

  const [parsed] = parseBeancount(text);
  assertEquals(parsed.date, "2026-11-10");
  assertEquals(parsed.description, 'Penn "Station" \\ Deli');
  assertEquals(parsed.tags, {
    purpose: "Lunch meeting",
    attendees: "Josh, Maria",
    receipt: "receipts/2026/2026-11-10-penn-station.pdf",
  });
  assertEquals(parsed.postings.map((p) => [p.account, p.amount, p.commodity]), [
    ["Expenses:Meals", 22.86, "USD"],
    ["Liabilities:CreditCard", -22.86, "USD"],
  ]);

  const owner = formatBeancountTransaction(
    createEntry({
      date: "2026-11-12",
      description: "Office Depot",
      amount: 15,
      category: "Expenses:Supplies",
      owner: "Josh",
    }),
  );
  assertStringIncludes(owner, '  owner: "Josh"');
  assert(/Equity:OwnerContributions:Josh\s+-15\.00 USD/.test(owner), owner);

  assertEquals(
    receiptMetadataLine("receipts/2026/2026-11-10-penn-station.pdf"),
    'receipt: "receipts/2026/2026-11-10-penn-station.pdf"',
  );
});

Deno.test("Beancount account names are checked before anything is written", () => {
  for (const good of ["Expenses:Meals", "Equity:OwnerDraws:Maria", "Assets:Checking:Truist"]) {
    assertBeancountAccount(good);
  }
  for (const bad of ["Meals", "Expenses:meals", "Expenses:Office Supplies", "Costs:Meals"]) {
    assertThrows(() => assertBeancountAccount(bad), Error, "is not a Beancount account name");
  }
});

Deno.test("entries and filed receipts written to Beancount books pass rledger check", async () => {
  const booksDir = await Deno.makeTempDir({ prefix: "accounting-test-books-" });
  try {
    const rledger = await rledgerPath();
    const booksPath = path.join(booksDir, "2026.beancount");
    await Deno.mkdir(path.join(booksDir, "inbox"));
    await Deno.writeTextFile(path.join(booksDir, "inbox", "scan.pdf"), "%PDF-1.4 made-up scan");

    const filed = await fileReceipt({
      booksDir,
      year: 2026,
      date: "2026-11-10",
      place: "Penn Station",
      sourceFile: "scan.pdf",
    });
    assertEquals(filed.relativePath, "receipts/2026/2026-11-10-penn-station.pdf");
    assertStringIncludes(filed.message, receiptMetadataLine(filed.relativePath!));

    await appendEntryToBooks(
      booksPath,
      createEntry({
        date: "2026-11-10",
        description: "Penn Station",
        amount: 22.86,
        category: "Expenses:Meals",
        fromAccount: "Liabilities:CreditCard",
        purpose: "Lunch meeting",
        attendees: "Josh, Maria",
        receipt: filed.relativePath,
      }),
    );
    await appendEntryToBooks(
      booksPath,
      createEntry({
        date: "2026-11-12",
        description: "Office Depot",
        amount: 15,
        category: "Expenses:Supplies",
        owner: "Josh",
      }),
    );
    await appendEntryToBooks(
      booksPath,
      createEntry({
        date: "2026-11-15",
        description: "Supermarket",
        amount: 40,
        category: "Equity:OwnerDraws:Maria",
        fromAccount: "Liabilities:CreditCard",
        owner: "Maria",
        isDraw: true,
      }),
    );

    const books = await Deno.readTextFile(booksPath);
    // Each account is opened once, on January 1 of the entries' year.
    assertEquals(books.match(/^2026-01-01 open Liabilities:CreditCard USD$/gm)?.length, 1);
    assertStringIncludes(books, "2026-01-01 open Equity:OwnerContributions:Josh USD");
    assertEquals(parseBeancount(books).length, 3);

    const result = await checkBooks(booksPath, { rledger });
    assertEquals(result.outcome, "pass", result.message);
    // --no-cache: nothing but the books is written beside them.
    const names: string[] = [];
    for await (const entry of Deno.readDir(booksDir)) names.push(entry.name);
    assertEquals(names.sort(), ["2026.beancount", "inbox", "receipts"]);
  } finally {
    await Deno.remove(booksDir, { recursive: true });
  }
});

Deno.test("rledger check fails invalid books and prints its diagnostic", async () => {
  const dir = await Deno.makeTempDir({ prefix: "accounting-test-invalid-" });
  try {
    const rledger = await rledgerDir();
    const booksPath = path.join(dir, "2026.beancount");
    await Deno.writeTextFile(
      booksPath,
      [
        "2026-01-01 open Expenses:Meals USD",
        "2026-01-01 open Liabilities:CreditCard USD",
        "",
        '2026-03-14 * "Penn Station"',
        "  Expenses:Meals            22.86 USD",
        "  Liabilities:CreditCard   -20.00 USD",
        "",
      ].join("\n"),
    );
    const before = await Deno.readTextFile(booksPath);

    const result = await checkBooks(booksPath, { rledger: path.join(rledger, "rledger") });
    assertEquals(result.outcome, "fail");
    assertStringIncludes(result.message, "does not balance");

    const exit = await withEnv(
      { PATH: `${rledger}:${Deno.env.get("PATH") ?? ""}` },
      () => runCli(["verify", "--books", booksPath]),
    );
    assertEquals(exit, 1);
    assertEquals(await Deno.readTextFile(booksPath), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the check refuses when rledger is missing and never reports the books valid", async () => {
  const dir = await Deno.makeTempDir({ prefix: "accounting-test-no-rledger-" });
  try {
    const booksPath = path.join(dir, "2026.beancount");
    await Deno.writeTextFile(booksPath, "2026-01-01 open Expenses:Meals USD\n");

    const result = await checkBooks(booksPath, { rledger: path.join(dir, "no-such-rledger") });
    assertEquals(result.outcome, "refuse");
    assertStringIncludes(result.message, "is not installed or not on PATH");

    // An empty PATH directory: the CLI finds no rledger and refuses with exit 2.
    const emptyBin = path.join(dir, "bin");
    await Deno.mkdir(emptyBin);
    const exit = await withEnv({ PATH: emptyBin }, () => runCli(["verify", "--books", booksPath]));
    assertEquals(exit, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the check refuses books it cannot read", async () => {
  const dir = await Deno.makeTempDir({ prefix: "accounting-test-unreadable-" });
  try {
    const rledger = await rledgerPath();

    const missing = await checkBooks(path.join(dir, "2026.beancount"), { rledger });
    assertEquals(missing.outcome, "refuse");
    assertStringIncludes(missing.message, "Cannot read the books");

    const folder = path.join(dir, "folder.beancount");
    await Deno.mkdir(folder);
    const notAFile = await checkBooks(folder, { rledger });
    assertEquals(notAFile.outcome, "refuse");
    assertStringIncludes(notAFile.message, "is not a file");

    const locked = path.join(dir, "locked.beancount");
    await Deno.writeTextFile(locked, "2026-01-01 open Expenses:Meals USD\n");
    await Deno.chmod(locked, 0o000);
    // Only where the lock takes effect: a root user still reads a file with no read bit.
    const lockHolds = await Deno.readTextFile(locked).then(() => false, () => true);
    if (lockHolds) {
      const unreadable = await checkBooks(locked, { rledger });
      assertEquals(unreadable.outcome, "refuse");
      assertStringIncludes(unreadable.message, "Cannot read the books");
    }
    await Deno.chmod(locked, 0o600);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entry and verify use the year's .beancount books and refuse any other file", async () => {
  const home = await Deno.makeTempDir({ prefix: "accounting-test-home-" });
  try {
    await withEnv({ HOME: home }, async () => {
      assertEquals(
        getDefaultBooksPath(2026),
        path.join(home, "Dropbox", "web-jam-llms", "financial", "books", "2026.beancount"),
      );
      const entry = [
        "entry",
        "--date",
        "2026-02-03",
        "--desc",
        "Guitar Center",
        "--amount",
        "12.50",
        "--category",
        "Expenses:Supplies",
        "--from",
        "Liabilities:CreditCard",
      ];
      assertEquals(await runCli(entry), 0);
      assertStringIncludes(await Deno.readTextFile(getDefaultBooksPath(2026)), "Guitar Center");

      const journal = path.join(home, "other.journal");
      assertEquals(await runCli([...entry, "--books", journal]), 1);
      assertEquals(await runCli([...entry, "--journal", journal]), 1);
      await assertRejects(() => Deno.stat(journal), Deno.errors.NotFound);
      assertEquals(await runCli(["verify", "--books", journal]), 1);
    });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("import and month close keep their .journal defaults and refuse explicit Beancount books, leaving them intact", async () => {
  const home = await Deno.makeTempDir({ prefix: "accounting-test-legacy-" });
  try {
    await withEnv({ HOME: home }, async () => {
      const statement = path.join(home, "statement.csv");
      await Deno.writeTextFile(
        statement,
        "Date,Description,Amount,Id\n2026-01-10,Made-up Deposit,100.00,T1\n",
      );

      // Import with no --journal writes the year's .journal file.
      const journal = getDefaultJournalPath();
      assertEquals(path.extname(journal), ".journal");
      assertEquals(
        await runCli(["import", "--statement", statement, "--account", "Assets:Checking:Truist"]),
        0,
      );
      assertStringIncludes(await Deno.readTextFile(journal), "Made-up Deposit");

      // Month close with no --journal works on the same year's .journal file.
      const year = String(new Date().getFullYear());
      const closeArgs = ["close-month", "--year", year, "--month", "1"];
      const journalBeforeClose = await Deno.readTextFile(journal);
      assertEquals(
        await runCli([...closeArgs, "--balance", "Assets:Checking:Truist=100.00"]),
        0,
      );
      assert((await Deno.readTextFile(journal)).length > journalBeforeClose.length);

      // An explicit Beancount target is refused before anything is written.
      const books = path.join(home, "2026.beancount");
      const original = "2026-01-01 open Expenses:Meals USD\n";
      await Deno.writeTextFile(books, original);
      assertEquals(
        await runCli(["import", "--statement", statement, "--journal", books]),
        1,
      );
      assertEquals(
        await runCli([
          ...closeArgs,
          "--balance",
          "Assets:Checking:Truist=100.00",
          "--journal",
          books,
        ]),
        1,
      );
      assertEquals(await Deno.readTextFile(books), original);
      await assertRejects(
        () => importStatement({ statementPath: statement, journalPath: books }),
        Error,
        "refuses the Beancount books",
      );
      await assertRejects(
        () =>
          closeMonth({ year: 2026, month: 1, balances: { "Assets:Cash": 1 }, journalPath: books }),
        Error,
        "refuses the Beancount books",
      );
      assertEquals(await Deno.readTextFile(books), original);
    });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

const ACCOUNTING_CLI = path.resolve(
  new URL("../../src/accounting/cli.ts", import.meta.url).pathname,
);

Deno.test("entry commands running at once each keep their transaction and open a shared new account once", async () => {
  const dir = await Deno.makeTempDir({ prefix: "accounting-test-writers-" });
  try {
    const books = path.join(dir, "2026.beancount");
    const original = "2026-01-01 open Liabilities:CreditCard USD\n";
    await Deno.writeTextFile(books, original);
    const writers = ["Made-up Store A", "Made-up Store B", "Made-up Store C", "Made-up Store D"];
    const results = await Promise.all(writers.map((desc) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-env=HOME",
          `--allow-read=${dir}`,
          `--allow-write=${dir}`,
          ACCOUNTING_CLI,
          "entry",
          "--books",
          books,
          "--date",
          "2026-03-04",
          "--desc",
          desc,
          "--amount",
          "9.99",
          "--category",
          "Expenses:NewSupplies",
          "--from",
          "Liabilities:CreditCard",
        ],
        stdout: "piped",
        stderr: "piped",
      }).output()
    ));
    for (const out of results) {
      assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    }
    const content = await Deno.readTextFile(books);
    assert(content.startsWith(original), "the books lost their earlier lines");
    for (const desc of writers) assertStringIncludes(content, `"${desc}"`);
    assertEquals(parseBeancount(content).length, writers.length);
    assertEquals(
      content.split("\n").filter((l) => l.includes("open Expenses:NewSupplies")).length,
      1,
    );
    const leftovers = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name.endsWith(".tmp")) leftovers.push(entry.name);
    }
    assertEquals(leftovers, [], "a temporary write file was left beside the books");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function madeUpEntry(description: string) {
  return createEntry({
    date: "2026-03-04",
    description,
    amount: 9.99,
    category: "Expenses:Supplies",
    fromAccount: "Liabilities:CreditCard",
  });
}

Deno.test("an entry keeps the books owner-only under a permissive umask and keeps stricter books stricter", async () => {
  const dir = await Deno.makeTempDir({ prefix: "accounting-test-mode-" });
  try {
    const original = "2026-01-01 open Liabilities:CreditCard USD\n";

    // The entry command runs under umask 002, which would leave a new file group-writable.
    const privateBooks = path.join(dir, "private.beancount");
    await Deno.writeTextFile(privateBooks, original);
    await Deno.chmod(privateBooks, 0o600);
    const out = await new Deno.Command("sh", {
      args: [
        "-c",
        'umask 002 && exec "$@"',
        "sh",
        Deno.execPath(),
        "run",
        "--allow-env=HOME",
        `--allow-read=${dir}`,
        `--allow-write=${dir}`,
        ACCOUNTING_CLI,
        "entry",
        "--books",
        privateBooks,
        "--date",
        "2026-03-04",
        "--desc",
        "Made-up Store A",
        "--amount",
        "9.99",
        "--category",
        "Expenses:Supplies",
        "--from",
        "Liabilities:CreditCard",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    assertEquals((await Deno.stat(privateBooks)).mode! & 0o777, 0o600);
    assertStringIncludes(await Deno.readTextFile(privateBooks), `"Made-up Store A"`);

    const sharedBooks = path.join(dir, "shared.beancount");
    await Deno.writeTextFile(sharedBooks, original);
    await Deno.chmod(sharedBooks, 0o664);
    await appendEntryToBooks(sharedBooks, madeUpEntry("Made-up Store B"));
    assertEquals((await Deno.stat(sharedBooks)).mode! & 0o777, 0o600);

    const readOnlyBooks = path.join(dir, "read-only.beancount");
    await Deno.writeTextFile(readOnlyBooks, original);
    await Deno.chmod(readOnlyBooks, 0o400);
    await appendEntryToBooks(readOnlyBooks, madeUpEntry("Made-up Store C"));
    assertEquals((await Deno.stat(readOnlyBooks)).mode! & 0o777, 0o400);

    const newBooks = path.join(dir, "new.beancount");
    await appendEntryToBooks(newBooks, madeUpEntry("Made-up Store D"));
    assertEquals((await Deno.stat(newBooks)).mode! & 0o777, 0o600);

    const leftovers = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name.endsWith(".tmp")) leftovers.push(entry.name);
    }
    assertEquals(leftovers, [], "a temporary write file was left beside the books");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an entry through a linked books path reaches the linked ledger and leaves the link in place", async () => {
  const dir = await Deno.makeTempDir({ prefix: "accounting-test-link-" });
  try {
    const original = "2026-01-01 open Liabilities:CreditCard USD\n";
    const ledgerDir = path.join(dir, "ledger");
    await Deno.mkdir(ledgerDir);
    const ledger = path.join(ledgerDir, "2026.beancount");
    await Deno.writeTextFile(ledger, original);
    const alias = path.join(dir, "alias.beancount");
    await Deno.symlink(ledger, alias);

    await appendEntryToBooks(alias, madeUpEntry("Made-up Store A"));
    assert((await Deno.lstat(alias)).isSymlink, "the link was replaced by a separate file");
    assertEquals(await Deno.readLink(alias), ledger);
    const content = await Deno.readTextFile(ledger);
    assert(content.startsWith(original), "the linked ledger lost its earlier lines");
    assertStringIncludes(content, `"Made-up Store A"`);

    const notes = path.join(dir, "notes.txt");
    await Deno.writeTextFile(notes, "made-up notes\n");
    const wrongAlias = path.join(dir, "wrong.beancount");
    await Deno.symlink(notes, wrongAlias);
    await assertRejects(
      () => appendEntryToBooks(wrongAlias, madeUpEntry("Made-up Store B")),
      Error,
      "is not a .beancount file",
    );
    assertEquals(await Deno.readTextFile(notes), "made-up notes\n");
    assert((await Deno.lstat(wrongAlias)).isSymlink);

    const dangling = path.join(dir, "dangling.beancount");
    const missing = path.join(dir, "missing.beancount");
    await Deno.symlink(missing, dangling);
    await assertRejects(
      () => appendEntryToBooks(dangling, madeUpEntry("Made-up Store C")),
      Error,
      "a link to a ledger that does not exist",
    );
    assert((await Deno.lstat(dangling)).isSymlink);
    await assertRejects(() => Deno.lstat(missing), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an entry with a date that is not a real calendar date is refused and leaves the books untouched", async () => {
  const home = await Deno.makeTempDir({ prefix: "accounting-test-dates-" });
  try {
    await withEnv({ HOME: home }, async () => {
      const books = path.join(home, "2026.beancount");
      const original = "2026-01-01 open Expenses:Supplies USD\n";
      await Deno.writeTextFile(books, original);
      for (
        const date of [
          "2026-02-30",
          "2026-13-01",
          "2026-04-31",
          "2026-2-3",
          "20260203",
          "2026-02-03x",
          "0000-01-01",
        ]
      ) {
        const entry = [
          "entry",
          "--date",
          date,
          "--desc",
          "Made-up Store",
          "--amount",
          "1.00",
          "--category",
          "Expenses:Supplies",
          "--from",
          "Liabilities:CreditCard",
        ];
        assertEquals(await runCli([...entry, "--books", books]), 1, date);
        assertEquals(await runCli(entry), 1, `${date} with the default books`);
        assertThrows(() => assertCalendarDate(date), Error, "not a real calendar date", date);
      }
      assertEquals(await Deno.readTextFile(books), original);
      await assertRejects(
        () => Deno.stat(path.dirname(getDefaultBooksPath(2026))),
        Deno.errors.NotFound,
      );
      const tx = createEntry({
        date: "2026-02-30",
        description: "Made-up Store",
        amount: 1,
        category: "Expenses:Supplies",
        fromAccount: "Liabilities:CreditCard",
      });
      await assertRejects(() => appendEntryToBooks(books, tx), Error, "not a real calendar date");
      assertEquals(await Deno.readTextFile(books), original);
      assertCalendarDate("2024-02-29");
      assertThrows(() => assertCalendarDate("2026-02-29"), Error, "not a real calendar date");
    });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("import and month close refuse --books, write nothing, and leave the default journal uncreated", async () => {
  const home = await Deno.makeTempDir({ prefix: "accounting-test-books-flag-" });
  try {
    await withEnv({ HOME: home }, async () => {
      const statement = path.join(home, "statement.csv");
      await Deno.writeTextFile(
        statement,
        "Date,Description,Amount,Id\n2026-01-10,Made-up Deposit,100.00,T1\n",
      );
      const books = path.join(home, "2026.beancount");
      const original = "2026-01-01 open Assets:Checking:Truist USD\n";
      await Deno.writeTextFile(books, original);

      assertEquals(
        await runCli([
          "import",
          "--statement",
          statement,
          "--account",
          "Assets:Checking:Truist",
          "--books",
          books,
        ]),
        1,
      );
      assertEquals(
        await runCli([
          "close-month",
          "--year",
          "2026",
          "--month",
          "1",
          "--balance",
          "Assets:Checking:Truist=100.00",
          "--books",
          books,
        ]),
        1,
      );
      assertEquals(await Deno.readTextFile(books), original);
      await assertRejects(() => Deno.stat(getDefaultJournalPath()), Deno.errors.NotFound);
      await assertRejects(() => Deno.stat(getDefaultJournalPath(2026)), Deno.errors.NotFound);
    });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
