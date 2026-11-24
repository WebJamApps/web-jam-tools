// Tests for the download cleaner (web-jam-tools#1863). Every value here is made up.
// Design: ~/Dropbox/web-jam-llms/songwriting/web-jam-music-media-design.md, "The accounting
// skill", "The download cleaner".

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  cleanDownload,
  CleanRefusal,
  main,
  normalizeAmount,
  normalizeDate,
  parseCsvLines,
  parseOfxLines,
} from "../../src/accounting/clean_download.ts";

const REPO_ROOT = path.fromFileUrl(new URL("../../", import.meta.url));
const HEADER = "date,description,amount,id";

async function fixture(name: string, content: string) {
  const root = await Deno.makeTempDir({ prefix: "clean-download-" });
  const downloads = path.join(root, "downloads");
  const booksDir = path.join(root, "books");
  await Deno.mkdir(downloads);
  const input = path.join(downloads, name);
  await Deno.writeTextFile(input, content);
  return { root, booksDir, input, cleanup: () => Deno.remove(root, { recursive: true }) };
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Every file under a folder, relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  if (!(await exists(dir))) return out;
  for await (const e of Deno.readDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory) out.push(...(await filesUnder(p)).map((f) => path.join(e.name, f)));
    else out.push(e.name);
  }
  return out;
}

function ofx(transactions: string[]): string {
  return [
    "OFXHEADER:100",
    "DATA:OFXSGML",
    "",
    "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
    "<BANKACCTFROM><BANKID>021000021<ACCTID>1234567890<ACCTTYPE>CHECKING</BANKACCTFROM>",
    "<BANKTRANLIST>",
    ...transactions,
    "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
    "",
  ].join("\n");
}

Deno.test("a CSV line keeps only its date, description, amount and line id", async () => {
  const f = await fixture("march.csv", "2026-03-14,PENN STATION,22.86,202603140001\n");
  try {
    const result = await cleanDownload({ input: f.input, booksDir: f.booksDir });
    assertEquals(result.count, 1);
    assertEquals(result.outputPath, path.join(f.booksDir, "statements", "2026", "march.csv"));
    assertEquals(
      await Deno.readTextFile(result.outputPath),
      `${HEADER}\n2026-03-14,PENN STATION,22.86,202603140001\n`,
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("a CSV with a header drops every column but the four kept", async () => {
  const f = await fixture(
    "checking.csv",
    [
      "Account Number,Posting Date,Description,Amount,Transaction ID,Balance",
      '1234567890,03/14/2026,"PENN STATION, NY",-22.86,TX-0001,"1,000.00"',
      '1234567890,03/15/2026,CLIENT PAYMENT,"$1,250.00",TX-0002,"2,250.00"',
    ].join("\n"),
  );
  try {
    const result = await cleanDownload({ input: f.input, booksDir: f.booksDir });
    const text = await Deno.readTextFile(result.outputPath);
    assertEquals(
      text,
      `${HEADER}\n2026-03-14,"PENN STATION, NY",-22.86,TX-0001\n2026-03-15,CLIENT PAYMENT,1250.00,TX-0002\n`,
    );
    assertEquals(text.includes("1234567890"), false);
  } finally {
    await f.cleanup();
  }
});

Deno.test("an OFX download keeps the four fields and drops the account and routing numbers", async () => {
  const f = await fixture(
    "card.ofx",
    ofx([
      "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260314120000[-5:EST]<TRNAMT>-22.86<FITID>202603140001<NAME>PENN STATION<MEMO>TRAIN TICKET</STMTTRN>",
      "<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260315<TRNAMT>1250.00<FITID>202603150002<NAME>CLIENT &amp; CO</STMTTRN>",
    ]),
  );
  try {
    const result = await cleanDownload({ input: f.input, booksDir: f.booksDir });
    assertEquals(result.count, 2);
    const text = await Deno.readTextFile(result.outputPath);
    assertEquals(
      text,
      `${HEADER}\n2026-03-14,PENN STATION TRAIN TICKET,-22.86,202603140001\n2026-03-15,CLIENT & CO,1250.00,202603150002\n`,
    );
    assertEquals(text.includes("1234567890"), false);
    assertEquals(text.includes("021000021"), false);
  } finally {
    await f.cleanup();
  }
});

Deno.test("an account number left in an OFX description refuses the whole file and writes nothing", async () => {
  const f = await fixture(
    "transfer.ofx",
    ofx([
      "<STMTTRN><DTPOSTED>20260314<TRNAMT>-22.86<FITID>1<NAME>PENN STATION</STMTTRN>",
      "<STMTTRN><DTPOSTED>20260315<TRNAMT>-500.00<FITID>2<NAME>TRANSFER &lt;ACCTID&gt;1234567890</STMTTRN>",
    ]),
  );
  try {
    const error = await assertRejects(
      () => cleanDownload({ input: f.input, booksDir: f.booksDir }),
      CleanRefusal,
    );
    assertStringIncludes(error.message, "a bank account number");
    assertEquals(error.message.includes("1234567890"), false);
    assertEquals(await exists(f.booksDir), false);
  } finally {
    await f.cleanup();
  }
});

for (
  const [label, description, kind] of [
    ["a card number", "VISA 4539 1488 0343 6467 REFUND", "a card number"],
    ["a routing number", "WIRE ROUTING 021000021", "a routing number"],
    ["an account number", "XFER ACCOUNT NUMBER 9876543210", "a bank account number"],
  ]
) {
  Deno.test(`${label} left in a CSV description refuses the whole file and writes nothing`, async () => {
    const f = await fixture(
      "march.csv",
      `2026-03-14,PENN STATION,22.86,1\n2026-03-15,${description},-10.00,2\n`,
    );
    try {
      const error = await assertRejects(
        () => cleanDownload({ input: f.input, booksDir: f.booksDir }),
        CleanRefusal,
      );
      assertStringIncludes(error.message, kind);
      assertEquals(/\d{9}/.test(error.message), false, error.message);
      assertEquals(await filesUnder(f.booksDir), []);
    } finally {
      await f.cleanup();
    }
  });
}

Deno.test("--sweep writes into sweep/ instead of statements/", async () => {
  const f = await fixture("personal-card.csv", "2026-03-14,GUITAR STRINGS,-12.99,77\n");
  try {
    const result = await cleanDownload({ input: f.input, booksDir: f.booksDir, sweep: true });
    assertEquals(result.outputPath, path.join(f.booksDir, "sweep", "personal-card.csv"));
    assertEquals(await filesUnder(f.booksDir), [path.join("sweep", "personal-card.csv")]);
  } finally {
    await f.cleanup();
  }
});

Deno.test("the program prints a line count and no line content", async () => {
  const f = await fixture(
    "march.csv",
    "2026-03-14,PENN STATION,22.86,202603140001\n2026-03-20,STRINGS,-9.50,2\n",
  );
  const printed: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => printed.push(a.join(" "));
  console.error = (...a: unknown[]) => printed.push(a.join(" "));
  try {
    const code = await main([f.input, "--books-dir", f.booksDir]);
    assertEquals(code, 0);
    assertEquals(printed, [
      `Wrote 2 lines to ${path.join(f.booksDir, "statements", "2026", "march.csv")}`,
    ]);
    for (const content of ["PENN", "STRINGS", "22.86", "202603140001"]) {
      assertEquals(printed.join("\n").includes(content), false, content);
    }
  } finally {
    console.log = log;
    console.error = err;
    await f.cleanup();
  }
});

Deno.test("a refusal names a line number and never that line's content", async () => {
  const f = await fixture(
    "march.csv",
    "2026-03-14,PENN STATION,22.86,1\n2026-03-15,STRINGS,twelve,2\n",
  );
  const printed: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => printed.push(a.join(" "));
  try {
    assertEquals(await main([f.input, "--books-dir", f.booksDir]), 1);
    assertStringIncludes(printed.join("\n"), "line 2 has an amount the cleaner cannot read");
    assertStringIncludes(printed.join("\n"), "Nothing was written.");
    assertEquals(printed.join("\n").includes("twelve"), false);
    assertEquals(printed.join("\n").includes("STRINGS"), false);
    assertEquals(await exists(f.booksDir), false);
  } finally {
    console.error = err;
    await f.cleanup();
  }
});

Deno.test("cannot tell: an unreadable, unparseable or empty file refuses and writes nothing", async () => {
  const f = await fixture("bad.csv", "not,a,bank,file\nhello,world,1,2\n");
  try {
    await assertRejects(
      () =>
        cleanDownload({
          input: path.join(f.root, "downloads", "missing.csv"),
          booksDir: f.booksDir,
        }),
      CleanRefusal,
      "could not read the file",
    );
    await assertRejects(
      () => cleanDownload({ input: f.input, booksDir: f.booksDir }),
      CleanRefusal,
      "cannot tell which columns",
    );
    await Deno.writeTextFile(f.input, "Date,Description,Amount\n");
    await assertRejects(
      () => cleanDownload({ input: f.input, booksDir: f.booksDir }),
      CleanRefusal,
      "holds no lines",
    );
    await Deno.writeTextFile(f.input, "!Type:Bank\nD03/14/2026\nT-22.86\nPPENN STATION\n^\n");
    await assertRejects(
      () => cleanDownload({ input: f.input, booksDir: f.booksDir }),
      CleanRefusal,
      "QIF",
    );
    await Deno.writeTextFile(f.input, "Date,Description,Amount\n14 March,PENN,1.00\n");
    await assertRejects(
      () => cleanDownload({ input: f.input, booksDir: f.booksDir }),
      CleanRefusal,
      "line 2 has a date the cleaner cannot read",
    );
    assertEquals(await exists(f.booksDir), false);
  } finally {
    await f.cleanup();
  }
});

Deno.test("the cleaner never overwrites a clean file already in the books", async () => {
  const f = await fixture("march.csv", "2026-03-14,PENN STATION,22.86,1\n");
  try {
    const first = await cleanDownload({ input: f.input, booksDir: f.booksDir });
    await Deno.writeTextFile(f.input, "2026-03-14,SOMETHING ELSE,1.00,9\n");
    await assertRejects(
      () => cleanDownload({ input: f.input, booksDir: f.booksDir }),
      CleanRefusal,
      "never overwrites a record",
    );
    assertEquals(
      await Deno.readTextFile(first.outputPath),
      `${HEADER}\n2026-03-14,PENN STATION,22.86,1\n`,
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("a Wave-style export and a debit and credit pair become signed amounts", () => {
  assertEquals(
    parseCsvLines(
      "Transaction ID,Transaction Date,Account Name,Transaction Description,Amount (One column)\nW-1,2026-01-05,Business Checking,GIG PAYMENT,300.00\n",
    ),
    [{ date: "2026-01-05", description: "GIG PAYMENT", amount: "300.00", id: "W-1" }],
  );
  assertEquals(
    parseCsvLines("Date,Description,Debit,Credit\n1/5/26,STRINGS,12.99,\n1/6/26,GIG,,300\n"),
    [
      { date: "2026-01-05", description: "STRINGS", amount: "-12.99", id: "" },
      { date: "2026-01-06", description: "GIG", amount: "300.00", id: "" },
    ],
  );
});

Deno.test("dates and amounts normalise, and anything else is refused as unreadable", () => {
  assertEquals(normalizeDate("2026-03-14"), "2026-03-14");
  assertEquals(normalizeDate("20260314120000[-5:EST]"), "2026-03-14");
  assertEquals(normalizeDate("3/14/2026"), "2026-03-14");
  assertEquals(normalizeDate("13/14/2026"), null);
  assertEquals(normalizeDate("March 14"), null);
  assertEquals(normalizeAmount("(22.86)"), "-22.86");
  assertEquals(normalizeAmount("$1,022.8"), "1022.80");
  assertEquals(normalizeAmount("-.5"), "-0.50");
  assertEquals(normalizeAmount("12.99 USD"), null);
});

Deno.test("deno.json's task reads only the downloads folder and writes only the books folder", async () => {
  const config = JSON.parse(await Deno.readTextFile(path.join(REPO_ROOT, "deno.json")));
  assertEquals(
    config.tasks["accounting:clean-download"],
    "deno run --allow-env=HOME --allow-read=$HOME/Dropbox/financial-private/downloads --allow-write=$HOME/Dropbox/web-jam-llms/financial/books src/accounting/clean_download.ts",
  );
});

const canRun = Deno.permissions.querySync({ name: "run" }).state === "granted";

async function denoDir(): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), { args: ["info", "--json"], stdout: "piped" })
    .output();
  return JSON.parse(new TextDecoder().decode(out.stdout)).denoDir;
}

Deno.test({
  name: "the task cleans a file in the downloads folder and cannot read one outside it",
  ignore: !canRun,
  fn: async () => {
    const home = await Deno.makeTempDir({ prefix: "clean-download-home-" });
    try {
      const downloads = path.join(home, "Dropbox", "financial-private", "downloads");
      const books = path.join(home, "Dropbox", "web-jam-llms", "financial", "books");
      await Deno.mkdir(downloads, { recursive: true });
      await Deno.writeTextFile(
        path.join(downloads, "march.csv"),
        "2026-03-14,PENN STATION,22.86,1\n",
      );
      await Deno.writeTextFile(path.join(home, "outside.csv"), "2026-03-14,PENN STATION,22.86,1\n");
      const env = {
        HOME: home,
        DENO_DIR: await denoDir(),
        PATH: Deno.env.get("PATH") ?? "",
        NO_COLOR: "1",
      };
      const run = (file: string) =>
        new Deno.Command(Deno.execPath(), {
          args: [
            "task",
            "--config",
            path.join(REPO_ROOT, "deno.json"),
            "-q",
            "accounting:clean-download",
            file,
          ],
          env,
          clearEnv: true,
          stdout: "piped",
          stderr: "piped",
        }).output();
      const ok = await run(path.join(downloads, "march.csv"));
      const out = new TextDecoder().decode(ok.stdout);
      assertEquals(ok.code, 0, new TextDecoder().decode(ok.stderr));
      assertEquals(
        out.trim(),
        `Wrote 1 line to ${path.join(books, "statements", "2026", "march.csv")}`,
      );
      const outside = await run(path.join(home, "outside.csv"));
      assertEquals(outside.code, 1);
      assertStringIncludes(new TextDecoder().decode(outside.stderr), "could not read the file");
      assertEquals(await filesUnder(books), [path.join("statements", "2026", "march.csv")]);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  },
});

// ---- Review fixes: malformed rows, incomplete OFX, invalid dates and amounts, failed writes ----

Deno.test("a CSV row whose fields do not line up with the header is refused, never shifted", () => {
  const header = "Date,Description,Amount,Transaction ID";
  // An unquoted comma in the amount splits it, which would push the id out of its column.
  assertThrowsRefusal(
    () => parseCsvLines(`${header}\n2026-03-14,PENN STATION,1,022.86,T-1\n`),
    "line 2 has 5 fields where the header has 4",
  );
  assertThrowsRefusal(
    () => parseCsvLines(`${header}\n2026-03-14,PENN STATION,22.86\n`),
    "line 2 has 3 fields where the header has 4",
  );
  // With no header, every row must match the first row's width.
  assertThrowsRefusal(
    () => parseCsvLines("2026-03-14,PENN STATION,22.86,1\n2026-03-15,GIG,1,250.00,2\n"),
    "line 2 has 5 fields where the first line has 4",
  );
});

Deno.test("a CSV with no header must have 3 or 4 fields, so a split amount is never read", async () => {
  // An unquoted comma splits 1,023.45 into 1 and 023.45, making a five-field first row that would
  // otherwise read as an amount of 1.00 and an id of 023.45, dropping the real id.
  assertThrowsRefusal(
    () => parseCsvLines("2026-03-14,PENN STATION,1,023.45,T-1\n2026-03-15,GIG,1,250.00,T-2\n"),
    "line 1 has 5 fields; a download with no header must have 3",
  );
  assertThrowsRefusal(
    () => parseCsvLines("2026-03-14,PENN STATION\n"),
    "line 1 has 2 fields; a download with no header must have 3",
  );
  assertEquals(parseCsvLines("2026-03-14,PENN STATION,22.86\n"), [
    { date: "2026-03-14", description: "PENN STATION", amount: "22.86", id: "" },
  ]);
  const f = await fixture("march.csv", "2026-03-14,PENN STATION,1,023.45,T-1\n");
  try {
    await assertRejects(
      () => cleanDownload({ input: f.input, booksDir: f.booksDir }),
      CleanRefusal,
      "line 1 has 5 fields",
    );
    assertEquals(await exists(f.booksDir), false);
  } finally {
    await f.cleanup();
  }
});

Deno.test("a CSV quote that is not a whole field is refused, never joined to the field", () => {
  assertThrowsRefusal(
    () => parseCsvLines('Date,Description,Amount\n2026-03-14,"PENN" STATION,22.86\n'),
    "line 2 has text after a closing quote",
  );
  assertThrowsRefusal(
    () => parseCsvLines('Date,Description,Amount\n2026-03-14,PENN "STATION",22.86\n'),
    "line 2 has a quote inside an unquoted field",
  );
  // A properly quoted field, with spaces after its closing quote, still reads.
  assertEquals(
    parseCsvLines('Date,Description,Amount\n2026-03-14,"PENN, STATION" ,"1,022.86"\n'),
    [{ date: "2026-03-14", description: "PENN, STATION", amount: "1022.86", id: "" }],
  );
});

function assertThrowsRefusal(fn: () => unknown, message: string) {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof CleanRefusal)) throw error;
    assertStringIncludes(error.message, message);
    return;
  }
  throw new Error(`expected a refusal naming "${message}"`);
}

Deno.test("an OFX file cut off or missing its structure is refused, in SGML and XML alike", () => {
  const trn = "<STMTTRN><DTPOSTED>20260314<TRNAMT>-22.86<FITID>1<NAME>PENN STATION</STMTTRN>";
  // Cut off inside a transaction.
  assertThrowsRefusal(
    () => parseOfxLines(ofx([trn]).replace("</STMTTRN>\n</BANKTRANLIST>", "\n")),
    "transaction 1 is cut off",
  );
  assertThrowsRefusal(
    () => parseOfxLines(ofx([trn]).slice(0, ofx([trn]).indexOf("<NAME>"))),
    "transaction 1 is cut off",
  );
  // The list or the statement never closes.
  assertThrowsRefusal(
    () => parseOfxLines(ofx([trn]).replace("</BANKTRANLIST>", "")),
    "the OFX file's <BANKTRANLIST> never closes",
  );
  assertThrowsRefusal(
    () => parseOfxLines(ofx([trn]).replace("</OFX>", "")),
    "the OFX file's <OFX> never closes",
  );
  // A transaction with no id.
  assertThrowsRefusal(
    () =>
      parseOfxLines(
        ofx(["<STMTTRN><DTPOSTED>20260314<TRNAMT>-22.86<NAME>PENN STATION</STMTTRN>"]),
      ),
    "transaction 1 has no transaction id",
  );
  // The XML form, where every value has its closing tag, still reads.
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?OFX OFXHEADER="200" VERSION="220"?>',
    "<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>",
    "<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260314</DTPOSTED><TRNAMT>-22.86</TRNAMT>",
    "<FITID>X-1</FITID><NAME>PENN STATION</NAME></STMTTRN>",
    "</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>",
  ].join("\n");
  assertEquals(parseOfxLines(xml), [
    { date: "2026-03-14", description: "PENN STATION", amount: "-22.86", id: "X-1" },
  ]);
});

Deno.test("an OFX file is read as its structure: comments hold no transactions, and every statement element must close", async () => {
  const trn = "<STMTTRN><DTPOSTED>20260314<TRNAMT>-22.86<FITID>1<NAME>PENN STATION</STMTTRN>";
  const xmlTrn =
    "<STMTTRN><DTPOSTED>20260314</DTPOSTED><TRNAMT>-22.86</TRNAMT><FITID>X-1</FITID><NAME>PENN STATION</NAME></STMTTRN>";
  const xml = (body: string) =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<?OFX OFXHEADER="200" VERSION="220"?>',
      body,
    ].join("\n");

  // A transaction that appears only inside a comment is no transaction.
  assertThrowsRefusal(
    () =>
      parseOfxLines(
        xml(
          `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><!-- <BANKTRANLIST>${xmlTrn}</BANKTRANLIST> --></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`,
        ),
      ),
    "the OFX file has no transaction list",
  );
  // A commented-out transaction beside a real one is skipped; only the real one is read.
  assertEquals(
    parseOfxLines(
      ofx([`<!-- ${trn.replace("PENN STATION", "MADE-UP COMMENT")} -->`, trn]),
    ).map((l) => l.description),
    ["PENN STATION"],
  );
  assertThrowsRefusal(
    () => parseOfxLines(ofx([trn, "<!-- never closed"])),
    "comment that never closes",
  );

  // XML whose outer statement elements are left unclosed.
  assertThrowsRefusal(
    () =>
      parseOfxLines(
        xml(
          `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>${xmlTrn}</BANKTRANLIST></OFX>`,
        ),
      ),
    "not well-formed XML: <CCSTMTRS> is closed by </OFX>",
  );
  // A transaction list outside any statement, or a statement outside its message set.
  assertThrowsRefusal(
    () => parseOfxLines(xml(`<OFX><BANKTRANLIST>${xmlTrn}</BANKTRANLIST></OFX>`)),
    "opens <BANKTRANLIST> outside <STMTRS> or <CCSTMTRS>",
  );
  assertThrowsRefusal(
    () =>
      parseOfxLines(
        xml(
          `<OFX><STMTRS><BANKTRANLIST>${xmlTrn}</BANKTRANLIST></STMTRS></OFX>`,
        ),
      ),
    "opens <STMTRS> outside <STMTTRNRS>",
  );
  // Content after the closing </OFX>.
  assertThrowsRefusal(
    () => parseOfxLines(ofx([trn]) + "<STMTTRN>"),
    "opens <STMTTRN> outside",
  );

  // The cleaner writes nothing for a file whose only transaction is in a comment.
  const f = await fixture(
    "march.qfx",
    xml(
      `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><!-- <BANKTRANLIST>${xmlTrn}</BANKTRANLIST> --></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`,
    ),
  );
  try {
    await assertRejects(
      () => cleanDownload({ input: f.input, booksDir: f.booksDir }),
      CleanRefusal,
      "no transaction list",
    );
    assertEquals(await exists(f.booksDir), false);
  } finally {
    await f.cleanup();
  }
});

Deno.test("dates that are not on the calendar and ambiguous amounts are refused", () => {
  for (const bad of ["2026-02-30", "2/30/2026", "20260230", "2026-04-31", "0000-01-01"]) {
    assertEquals(normalizeDate(bad), null, bad);
  }
  assertEquals(normalizeDate("2024-02-29"), "2024-02-29");
  assertEquals(normalizeDate("2026-02-29"), null);
  for (const bad of ["12,34", "1,2345.00", "22.865", "(-5.00)", "--5", "-$-5", "1 022.86", "$"]) {
    assertEquals(normalizeAmount(bad), null, bad);
  }
  assertEquals(normalizeAmount("1,022.86"), "1022.86");
  assertEquals(normalizeAmount("$-22.86"), "-22.86");
  assertEquals(normalizeAmount("-$22.86"), "-22.86");
  assertEquals(normalizeAmount("22.8600"), "22.86");
});

Deno.test("a download holding an invalid date or an ambiguous amount writes nothing", async () => {
  for (
    const [content, message] of [
      ["Date,Description,Amount\n2026-02-30,PENN STATION,22.86\n", "line 2 has a date"],
      ['Date,Description,Amount\n2026-03-14,PENN STATION,"12,34"\n', "line 2 has an amount"],
    ]
  ) {
    const f = await fixture("march.csv", content);
    try {
      await assertRejects(
        () => cleanDownload({ input: f.input, booksDir: f.booksDir }),
        CleanRefusal,
        message,
      );
      assertEquals(await exists(f.booksDir), false);
    } finally {
      await f.cleanup();
    }
  }
});

Deno.test({
  name: "a write that fails leaves no file, so the next run writes it, and keeps an existing one",
  ignore: !canRun,
  fn: async () => {
    const f = await fixture("march.csv", "2026-03-14,PENN STATION,22.86,1\n");
    try {
      const out = path.join(f.booksDir, "statements", "2026", "march.csv");
      // The cleaner runs in a child process whose file-size limit is 0 bytes, with the limit's
      // signal ignored, so writing the file fails with an error the way a full disk would.
      const module = new URL("../../src/accounting/clean_download.ts", import.meta.url).href;
      const script = path.join(f.root, "clean-under-limit.ts");
      await Deno.writeTextFile(
        script,
        `import { main } from ${JSON.stringify(module)};\n` +
          "Deno.exit(await main(Deno.args));\n",
      );
      const underLimit = async () => {
        const r = await new Deno.Command("sh", {
          args: [
            "-c",
            // The child drops DENO_COVERAGE_DIR: under the 0-byte limit, its own coverage profile
            // would be left empty and break the coverage gate.
            `trap '' XFSZ; ulimit -f 0 && exec env -u DENO_COVERAGE_DIR "$@"`,
            "sh",
            Deno.execPath(),
            "run",
            "--config",
            path.join(REPO_ROOT, "deno.json"),
            `--allow-read=${f.root}`,
            `--allow-write=${f.booksDir}`,
            "--allow-env=HOME",
            script,
            f.input,
            "--books-dir",
            f.booksDir,
          ],
          stdout: "piped",
          stderr: "piped",
        }).output();
        return { code: r.code, stderr: new TextDecoder().decode(r.stderr) };
      };

      const failed = await underLimit();
      assertEquals(failed.code, 1, failed.stderr);
      assertStringIncludes(failed.stderr, "could not write");
      assertStringIncludes(failed.stderr, "Nothing was written.");
      assertEquals(await exists(out), false, "a failed write left a file at the output path");

      const retried = await cleanDownload({ input: f.input, booksDir: f.booksDir });
      assertEquals(retried.outputPath, out);
      assertEquals(await Deno.readTextFile(out), `${HEADER}\n2026-03-14,PENN STATION,22.86,1\n`);

      await Deno.writeTextFile(out, "kept\n");
      const again = await underLimit();
      assertEquals(again.code, 1, again.stderr);
      assertStringIncludes(again.stderr, "never overwrites a record");
      assertEquals(await Deno.readTextFile(out), "kept\n");
    } finally {
      await f.cleanup();
    }
  },
});

Deno.test("an XML OFX file is parsed as XML: CDATA and references are text, and a missing end tag is refused", async () => {
  const doc = (transaction: string, extra = "") =>
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
      '<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>',
      "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>",
      transaction,
      `</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>${extra}`,
    ].join("\n");
  const trn = (memo: string) =>
    `<STMTTRN><DTPOSTED>20260314</DTPOSTED><TRNAMT>-22.86</TRNAMT><FITID>X-1</FITID><NAME>PENN STATION</NAME>${memo}</STMTTRN>`;

  // A memo inside CDATA is the memo's text.
  assertEquals(
    parseOfxLines(doc(trn("<MEMO><![CDATA[TRAIN <TICKET> & SEAT]]></MEMO>")))[0].description,
    "PENN STATION TRAIN <TICKET> & SEAT",
  );
  // Character references decode.
  assertEquals(
    parseOfxLines(doc(trn("<MEMO>CAF&#xC9; &amp; CO &#8212; A&lt;B</MEMO>")))[0].description,
    "PENN STATION CAFÉ & CO — A<B",
  );
  // A self-closed or empty memo is an empty value.
  assertEquals(parseOfxLines(doc(trn("<MEMO/>")))[0].description, "PENN STATION");

  for (
    const [label, text, message] of [
      ["a missing memo end tag", doc(trn("<MEMO>TRAIN TICKET")), "<MEMO> is closed by </STMTTRN>"],
      ["a mismatched end tag", doc(trn("<MEMO>TRAIN</NAME>")), "<MEMO> is closed by </NAME>"],
      ["a stray ampersand", doc(trn("<MEMO>A & B</MEMO>")), "does not start a character reference"],
      ["an unclosed CDATA", doc(trn("<MEMO><![CDATA[TRAIN</MEMO>")), "CDATA section never closes"],
      ["an attribute", doc(trn('<MEMO lang="en">TRAIN</MEMO>')), "carries attributes"],
      ["a document type", doc(trn("")).replace("<OFX>", "<!DOCTYPE OFX><OFX>"), "document type"],
      ["text after the root", doc(trn(""), "TRAILING"), "text outside the root element"],
      ["a second root", doc(trn(""), "<OFX></OFX>"), "more than one root element"],
      ["a cut-off file", doc(trn("")).slice(0, -12), "never closes"],
      [
        "a value holding an element",
        doc(trn("<MEMO><B>TRAIN</B></MEMO>")),
        "<MEMO> holds elements instead of a value",
      ],
      [
        "a repeated value",
        doc(trn("<MEMO>A</MEMO><MEMO>B</MEMO>")),
        "transaction 1 has more than one <MEMO>",
      ],
    ]
  ) {
    assertThrowsRefusal(() => parseOfxLines(text), message);
    const f = await fixture("march.qfx", text);
    try {
      await assertRejects(
        () => cleanDownload({ input: f.input, booksDir: f.booksDir }),
        CleanRefusal,
        message,
        label,
      );
      assertEquals(await exists(f.booksDir), false, label);
    } finally {
      await f.cleanup();
    }
  }

  // A legacy SGML export, where single values go unclosed, still reads through its own reader.
  assertEquals(
    parseOfxLines(
      ofx(["<STMTTRN><DTPOSTED>20260314<TRNAMT>-22.86<FITID>1<NAME>PENN STATION</STMTTRN>"]),
    ),
    [{ date: "2026-03-14", description: "PENN STATION", amount: "-22.86", id: "1" }],
  );
});
