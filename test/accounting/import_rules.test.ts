import { assertEquals } from "@std/assert";
import {
  categorizeTransaction,
  importStatement,
  loadAccountRules,
} from "../../src/accounting/import.ts";

Deno.test("account rules match literal payees in both layouts, in file order", () => {
  const rules = loadAccountRules(`
# rules for a made-up business
; another comment
if %description Example Store account2 Expenses:Supplies
if %description Example
  account2 Expenses:Other
if Second Store
\taccount2 Expenses:Equipment
`);
  assertEquals(rules.length, 3);
  assertEquals(categorizeTransaction("CARD EXAMPLE STORE SALE", -10, rules), "Expenses:Supplies");
  assertEquals(categorizeTransaction("example merchant", -10, rules), "Expenses:Other");
  assertEquals(categorizeTransaction("second store", -10, rules), "Expenses:Equipment");
  assertEquals(categorizeTransaction("Unknown", -10, rules), "Expenses:Uncategorized");
  assertEquals(loadAccountRules(), []);
  assertEquals(loadAccountRules(""), []);
});

Deno.test("account rules treat regex syntax and invalid regexes as literal text", () => {
  for (const text of ["A+B.Store", "(a+)+$", "[", "a|b", ".*"]) {
    for (
      const ruleText of [
        `if ${text} account2 Expenses:Supplies`,
        `if ${text}\n  account2 Expenses:Supplies`,
      ]
    ) {
      const rules = loadAccountRules(ruleText);
      assertEquals(categorizeTransaction(`CARD ${text} SALE`, -10, rules), "Expenses:Supplies");
      assertEquals(
        categorizeTransaction("a".repeat(100_000) + "!", -10, rules),
        "Expenses:Uncategorized",
      );
    }
  }
  assertEquals(
    categorizeTransaction("Example", -1, [{ pattern: "", category: "Expenses:Other" }]),
    "Expenses:Uncategorized",
  );
});

Deno.test("statement import applies literal rules and remains idempotent", async () => {
  const dir = await Deno.makeTempDir({ prefix: "accounting-rule-test-" });
  try {
    const statementPath = `${dir}/statement.csv`;
    const rulesPath = `${dir}/account.rules`;
    const journalPath = `${dir}/journal`;
    await Deno.writeTextFile(
      statementPath,
      "date,description,amount,id\n2026-01-10,A+B.Store,-10,fixture-1\n",
    );
    await Deno.writeTextFile(rulesPath, "if A+B.Store account2 Expenses:Supplies\n");
    const options = { statementPath, rulesPath, journalPath };
    const first = await importStatement(options);
    assertEquals(first.importedCount, 1);
    assertEquals(first.transactions[0].postings[0].account, "Expenses:Supplies");
    const second = await importStatement(options);
    assertEquals(second.importedCount, 0);
    assertEquals(second.skippedCount, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
