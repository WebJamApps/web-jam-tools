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
