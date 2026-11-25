import { assertEquals, assertRejects } from "@std/assert";
import { runCli } from "../../src/accounting/cli.ts";
import { parseCsvRows } from "../../src/accounting/import.ts";

Deno.test("CSV handles quoted line breaks, escaped quotes, and CRLF", () => {
  const csv =
    'date,description,amount,memo\r\n2026-01-01,"Shop\r\n""North""",-5,"first\nsecond"\r\n';
  assertEquals(parseCsvRows(csv)[1], ["2026-01-01", 'Shop\r\n"North"', "-5", "first\nsecond"]);
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
    const books = `${dir}/2026.beancount`;
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
          `Assets:Cash=${amount}`,
          "--books",
          books,
        ]),
        1,
      );
    }
    await assertRejects(() => Deno.stat(books), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
