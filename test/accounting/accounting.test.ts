// test/accounting/accounting.test.ts
// Tests for Web Jam LLC's books (web-jam-tools#1764), all in rustledger's Beancount books: entries,
// receipts and the check (web-jam-tools#1865), and the import of clean CSVs and the month close
// (web-jam-tools#1866). Every figure here is made up.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import * as path from "@std/path";
import { getDefaultBooksPath, runCli } from "../../src/accounting/cli.ts";
import { closeMonth } from "../../src/accounting/close_month.ts";
import {
  appendEntryToBooks,
  assertBeancountAccount,
  assertCalendarDate,
  createEntry,
  formatBeancountTransaction,
  parseBeancount,
} from "../../src/accounting/entry.ts";
import { importStatement } from "../../src/accounting/import.ts";
import { fileReceipt, receiptMetadataLine } from "../../src/accounting/receipt.ts";
import { checkBooks } from "../../src/accounting/verify.ts";
import { installSkills } from "../../src/install-skills/lib.ts";

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

  const formattedMeal = formatBeancountTransaction(mealTx);
  assertStringIncludes(formattedMeal, '2026-11-10 * "Penn Station"');
  assertStringIncludes(formattedMeal, 'purpose: "Lunch meeting"');
  assertStringIncludes(formattedMeal, 'attendees: "Josh, Maria"');
  assertStringIncludes(formattedMeal, 'receipt: "receipts/2026/2026-11-10-penn-station.pdf"');
  assertStringIncludes(formattedMeal, "Expenses:Meals");
  assertStringIncludes(formattedMeal, " 22.86 USD");
  assertStringIncludes(formattedMeal, "Liabilities:CreditCard");
  assertStringIncludes(formattedMeal, "-22.86 USD");

  // 2. Business expense paid personally by owner -> Owner contribution
  const contribTx = createEntry({
    date: "2026-11-12",
    description: "Office Depot",
    amount: 15.00,
    category: "Expenses:Supplies",
    owner: "Josh",
    purpose: "Printer paper",
  });
  const formattedContrib = formatBeancountTransaction(contribTx);
  assertStringIncludes(formattedContrib, 'owner: "Josh"');
  assertStringIncludes(formattedContrib, "Expenses:Supplies");
  assertStringIncludes(formattedContrib, " 15.00 USD");
  assertStringIncludes(formattedContrib, "Equity:OwnerContributions:Josh");
  assertStringIncludes(formattedContrib, "-15.00 USD");

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
  const formattedDraw = formatBeancountTransaction(drawTx);
  assertStringIncludes(formattedDraw, "Equity:OwnerDraws:Maria");
  assertStringIncludes(formattedDraw, " 40.00 USD");
  assertStringIncludes(formattedDraw, "Assets:Checking:Truist");
  assertStringIncludes(formattedDraw, "-40.00 USD");
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

// ---- Import of clean CSVs and the month close in rustledger (web-jam-tools#1866) ----

const IMPORTERS_TOML = `[[importers]]
name = "truist-checking"
account = "Assets:Checking:Truist"
date_column = "date"
narration_column = "description"
amount_column = "amount"
default_expense = "Expenses:Uncategorized"
default_income = "Income:Uncategorized"
mappings = { "PENN STATION" = "Expenses:Meals" }
`;

const BASE_BOOKS = `option "operating_currency" "USD"

2026-01-01 open Assets:Checking:Truist USD
`;

/** The download cleaner's clean CSV: date, description, amount and the bank's line id. */
function cleanCsv(lines: string[]): string {
  return ["date,description,amount,id", ...lines].join("\n") + "\n";
}

const MARCH = [
  "2026-03-04,PENN STATION 123,-22.86,T1",
  "2026-03-05,MADE-UP CLIENT PAYMENT,200.00,T2",
  "2026-03-31,GITHUB,-4.00,T3",
];

/** A books folder holding the year's books and importers.toml, removed after `fn`. */
async function withBooksFolder(
  fn: (dir: string, books: string, config: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "accounting-test-import-" });
  try {
    const books = path.join(dir, "2026.beancount");
    const config = path.join(dir, "importers.toml");
    await Deno.writeTextFile(books, BASE_BOOKS);
    await Deno.writeTextFile(config, IMPORTERS_TOML);
    await fn(dir, books, config);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Candidate books are always removed: none is left beside the books. */
async function assertNoCandidates(dir: string): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    assert(!entry.name.includes(".candidate."), `left behind: ${entry.name}`);
    assert(!entry.name.endsWith(".tmp"), `left behind: ${entry.name}`);
  }
}

Deno.test("a clean CSV imports through its importers.toml profile, and the same file again adds nothing", async () => {
  await withBooksFolder(async (dir, books, config) => {
    const rledger = await rledgerPath();
    const csv = path.join(dir, "march.csv");
    await Deno.writeTextFile(csv, cleanCsv(MARCH));
    const options = {
      csvPath: csv,
      booksPath: books,
      configPath: config,
      importer: "truist-checking",
      rledger,
    };

    const first = await importStatement(options);
    assertEquals(first.importedCount, 3);
    assertEquals(first.openedAccounts.sort(), [
      "Expenses:Meals",
      "Expenses:Uncategorized",
      "Income:Uncategorized",
    ]);
    const afterFirst = await Deno.readTextFile(books);
    assert(afterFirst.startsWith(BASE_BOOKS), "the import only appends");
    assertStringIncludes(afterFirst, '2026-03-04 * "PENN STATION 123"');
    assertStringIncludes(afterFirst, "Expenses:Meals");
    assertStringIncludes(afterFirst, "2026-01-01 open Expenses:Meals USD");
    assertEquals((await checkBooks(books, { rledger })).outcome, "pass");

    // The same file again: every line is already in the books, so nothing is written.
    const repeat = await importStatement(options);
    assertEquals(repeat.importedCount, 0);
    assertEquals(await Deno.readTextFile(books), afterFirst);

    // A later download with one new line imports that line alone.
    await Deno.writeTextFile(csv, cleanCsv([...MARCH, "2026-04-02,OFFICE DEPOT,-9.10,T4"]));
    const later = await importStatement(options);
    assertEquals(later.importedCount, 1);
    assertStringIncludes(later.extracted, "OFFICE DEPOT");
    assertEquals((await checkBooks(books, { rledger })).outcome, "pass");

    // A dry run reports and writes nothing.
    await Deno.writeTextFile(csv, cleanCsv(["2026-04-03,STAPLES,-1.00,T5"]));
    const beforeDry = await Deno.readTextFile(books);
    assertEquals((await importStatement({ ...options, dryRun: true })).importedCount, 1);
    assertEquals(await Deno.readTextFile(books), beforeDry);
    await assertNoCandidates(dir);
  });
});

Deno.test("the import refuses a missing rledger, an unreadable importers.toml or an unknown profile, leaving the books intact", async () => {
  await withBooksFolder(async (dir, books, config) => {
    const rledger = await rledgerPath();
    const csv = path.join(dir, "march.csv");
    await Deno.writeTextFile(csv, cleanCsv(MARCH));
    const base = {
      csvPath: csv,
      booksPath: books,
      configPath: config,
      importer: "truist-checking",
      rledger,
    };

    await assertRejects(
      () => importStatement({ ...base, rledger: path.join(dir, "no-such-rledger") }),
      Error,
      "not installed or not on PATH",
    );
    await assertRejects(
      () => importStatement({ ...base, configPath: path.join(dir, "missing.toml") }),
      Error,
      "rledger extract refused",
    );
    await assertRejects(
      () => importStatement({ ...base, importer: "no-such-profile" }),
      Error,
      "no-such-profile",
    );
    // Books that cannot be read: the import cannot tell what is already in them.
    await assertRejects(
      () => importStatement({ ...base, booksPath: path.join(dir, "2027.beancount") }),
      Error,
      "Cannot read the books",
    );
    // A .journal target is refused before anything runs.
    await assertRejects(
      () => importStatement({ ...base, booksPath: path.join(dir, "2026.journal") }),
      Error,
      "is not a .beancount file",
    );

    assertEquals(await Deno.readTextFile(books), BASE_BOOKS);
    await assertRejects(() => Deno.stat(path.join(dir, "2027.beancount")), Deno.errors.NotFound);
    await assertNoCandidates(dir);
  });
});

Deno.test("the import refuses lines that would leave the books failing rledger check", async () => {
  await withBooksFolder(async (dir, books, config) => {
    const rledger = await rledgerPath();
    // The checking account closes before the statement's lines, so the check would fail.
    const closed = BASE_BOOKS + "\n2026-02-01 close Assets:Checking:Truist\n";
    await Deno.writeTextFile(books, closed);
    const csv = path.join(dir, "march.csv");
    await Deno.writeTextFile(csv, cleanCsv(MARCH));
    await assertRejects(
      () =>
        importStatement({
          csvPath: csv,
          booksPath: books,
          configPath: config,
          importer: "truist-checking",
          rledger,
        }),
      Error,
      "rledger check found errors",
    );
    assertEquals(await Deno.readTextFile(books), closed);
    await assertNoCandidates(dir);
  });
});

Deno.test("the month close counts a last-day posting, publishes a dated copy and reports, and a later edit fails the check", async () => {
  await withBooksFolder(async (dir, books, config) => {
    const rledger = await rledgerPath();
    const csv = path.join(dir, "march.csv");
    // An April line is in the books too; the March close must not count it.
    await Deno.writeTextFile(csv, cleanCsv([...MARCH, "2026-04-02,OFFICE DEPOT,-9.10,T4"]));
    await importStatement({
      csvPath: csv,
      booksPath: books,
      configPath: config,
      importer: "truist-checking",
      rledger,
    });
    const imported = await Deno.readTextFile(books);
    const closedDir = path.join(dir, "closed", "2026-03");

    // A statement balance that leaves out the March 31 purchase does not match: refused, nothing written.
    await assertRejects(
      () =>
        closeMonth({
          year: 2026,
          month: 3,
          balances: { "Assets:Checking:Truist": 177.14 },
          booksPath: books,
          rledger,
        }),
      Error,
      "rledger check found errors",
    );
    assertEquals(await Deno.readTextFile(books), imported);
    await assertRejects(() => Deno.stat(closedDir), Deno.errors.NotFound);

    // The real statement balance counts the last-day posting: 200.00 - 22.86 - 4.00.
    const result = await closeMonth({
      year: 2026,
      month: 3,
      balances: { "Assets:Checking:Truist": 173.14 },
      booksPath: books,
      rledger,
    });
    assertEquals(result.balanceDate, "2026-04-01");
    const closedBooks = await Deno.readTextFile(books);
    assertStringIncludes(closedBooks, "2026-04-01 balance Assets:Checking:Truist 173.14 USD");
    assertEquals((await checkBooks(books, { rledger })).outcome, "pass");

    // The dated copy is the closed books; the reports cover March only.
    assertEquals(result.snapshotPath, path.join(closedDir, "2026.beancount"));
    assertEquals(await Deno.readTextFile(result.snapshotPath), closedBooks);
    const [balanceSheet, incomeStatement] = await Promise.all(
      result.reportPaths.map((p) => Deno.readTextFile(p)),
    );
    assertStringIncludes(balanceSheet, "Assets:Checking:Truist");
    assertStringIncludes(balanceSheet, "173.14 USD");
    assertStringIncludes(incomeStatement, "Expenses:Meals");
    assertStringIncludes(incomeStatement, "22.86 USD");
    assert(!incomeStatement.includes("9.10"), "the April purchase is outside the March statement");

    // An earlier edit that changes March's totals now fails rledger check.
    await Deno.writeTextFile(books, closedBooks.replace("-22.86 USD", "-21.86 USD"));
    const afterEdit = await checkBooks(books, { rledger });
    assertEquals(afterEdit.outcome, "fail");
    assertStringIncludes(afterEdit.message, "Balance failed for Assets:Checking:Truist");

    // Closing the same month again is refused.
    await Deno.writeTextFile(books, closedBooks);
    await assertRejects(
      () =>
        closeMonth({
          year: 2026,
          month: 3,
          balances: { "Assets:Checking:Truist": 173.14 },
          booksPath: books,
          rledger,
        }),
      Error,
      "already closed",
    );
    assertEquals(await Deno.readTextFile(books), closedBooks);
    await assertNoCandidates(dir);
  });
});

Deno.test("the month close refuses a missing rledger and invalid input, leaving the books and closed/ untouched", async () => {
  await withBooksFolder(async (dir, books) => {
    const rledger = await rledgerPath();
    const base = {
      year: 2026,
      month: 3,
      balances: { "Assets:Checking:Truist": 0 },
      booksPath: books,
      rledger,
    };
    await assertRejects(
      () => closeMonth({ ...base, rledger: path.join(dir, "no-such-rledger") }),
      Error,
      "not installed or not on PATH",
    );
    await assertRejects(() => closeMonth({ ...base, month: 13 }), Error, "not a month");
    await assertRejects(
      () => closeMonth({ ...base, balances: { "assets:checking": 1 } }),
      Error,
      "not a Beancount account name",
    );
    await assertRejects(() => closeMonth({ ...base, balances: {} }), Error, "No statement balance");
    await assertRejects(
      () => closeMonth({ ...base, booksPath: path.join(dir, "2026.journal") }),
      Error,
      "is not a .beancount file",
    );
    assertEquals(await Deno.readTextFile(books), BASE_BOOKS);
    await assertRejects(() => Deno.stat(path.join(dir, "closed")), Deno.errors.NotFound);

    // A December close dates its balance lines January 1 of the next year.
    const december = await closeMonth({ ...base, month: 12, dryRun: true });
    assertEquals(december.balanceDate, "2027-01-01");
    assertEquals(await Deno.readTextFile(books), BASE_BOOKS);
    await assertNoCandidates(dir);
  });
});

Deno.test("the import and close-month commands read importers.toml beside the books and run rledger from PATH", async () => {
  await withBooksFolder(async (dir, books) => {
    const rledger = await rledgerDir();
    const csv = path.join(dir, "march.csv");
    await Deno.writeTextFile(csv, cleanCsv(MARCH));
    await withEnv({ PATH: `${rledger}:${Deno.env.get("PATH") ?? ""}` }, async () => {
      // Run from a folder holding a different importers.toml: the books' own one is used.
      const elsewhere = await Deno.makeTempDir({ prefix: "accounting-test-cwd-" });
      const cwd = Deno.cwd();
      try {
        await Deno.writeTextFile(path.join(elsewhere, "importers.toml"), "not toml [[[");
        Deno.chdir(elsewhere);
        assertEquals(
          await runCli([
            "import",
            "--statement",
            csv,
            "--importer",
            "truist-checking",
            "--books",
            books,
          ]),
          0,
        );
      } finally {
        Deno.chdir(cwd);
        await Deno.remove(elsewhere, { recursive: true });
      }
      assertStringIncludes(await Deno.readTextFile(books), "PENN STATION 123");

      assertEquals(await runCli(["import", "--statement", csv, "--books", books]), 1);
      assertEquals(
        await runCli([
          "import",
          "--statement",
          csv,
          "--importer",
          "truist-checking",
          "--journal",
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
          "3",
          "--balance",
          "Assets:Checking:Truist=173.14",
          "--books",
          books,
        ]),
        0,
      );
      assertStringIncludes(
        await Deno.readTextFile(books),
        "2026-04-01 balance Assets:Checking:Truist 173.14 USD",
      );
    });
  });
});
