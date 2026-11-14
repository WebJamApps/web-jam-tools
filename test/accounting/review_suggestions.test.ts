import { assertEquals, assertRejects } from "@std/assert";
import { runCli } from "../../src/accounting/cli.ts";
import { closeMonth } from "../../src/accounting/close_month.ts";
import { parseCsvRows, parseStatementCsv } from "../../src/accounting/import.ts";
import { verifyJournalBalances } from "../../src/accounting/verify.ts";

Deno.test("CSV handles quoted line breaks, escaped quotes, and CRLF", () => {
  const csv =
    'date,description,amount,memo\r\n2026-01-01,"Shop\r\n""North""",-5,"first\nsecond"\r\n';
  assertEquals(parseCsvRows(csv)[1], ["2026-01-01", 'Shop\r\n"North"', "-5", "first\nsecond"]);
  const tx = parseStatementCsv(csv)[0];
  assertEquals([tx.payee, tx.memo], ['Shop "North"', "first second"]);
  assertEquals(parseCsvRows("a,b\n1,2").length, 2);
  try {
    parseCsvRows('a,"unterminated');
    throw new Error("expected rejection");
  } catch (error) {
    assertEquals((error as Error).message, "CSV contains an unterminated quoted field");
  }
});

Deno.test("numeric flags reject invalid values without writing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const journal = `${dir}/journal`;
    for (const amount of ["abc", "NaN", "Infinity", "12junk", "  "]) {
      assertEquals(
        await runCli([
          "entry",
          "--desc",
          "Example",
          "--amount",
          amount,
          "--category",
          "Expenses:Meals",
          "--journal",
          journal,
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
          `Assets:Cash=${amount}`,
          "--journal",
          journal,
        ]),
        1,
      );
    }
    await assertRejects(() => Deno.stat(journal), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("month close verifies assertions in date order and agrees with hledger when installed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const journal = `${dir}/journal`;
    await Deno.writeTextFile(
      journal,
      `2026-01-10 Opening\n    Assets:Cash  $100\n    Equity:Opening  $-100\n\n2026-02-01 Later\n    Assets:Cash  $20\n    Equity:Opening  $-20\n`,
    );
    await closeMonth({
      year: 2026,
      month: 1,
      balances: { "Assets:Cash": 100 },
      journalPath: journal,
      booksDir: dir,
    });
    const content = await Deno.readTextFile(journal);
    assertEquals(verifyJournalBalances(content).valid, true);
    assertEquals(verifyJournalBalances(content.replace("$100\n", "$101\n")).valid, false);
    try {
      const result = await new Deno.Command("hledger", {
        args: ["-f", journal, "check"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
