// test/accounting/return_figures.test.ts
// Tests for the return-figure finder (web-jam-tools#1864).
//
// The fixtures are rows of `pdftotext -layout` output from the public blank 2025 Form 1040 and
// 2025 Virginia Form 760. Every figure written into them here is made up.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  extractPdfText,
  FIGURES,
  findFigure,
  findFigures,
  renderFiguresMarkdown,
  ReturnFiguresRefusal,
  runReturnFigures,
} from "../../src/accounting/return_figures.ts";

const FIXTURES_DIR = path.resolve(new URL("./fixtures", import.meta.url).pathname);
const REPO_ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

const BLANK_1040 = await Deno.readTextFile(path.join(FIXTURES_DIR, "form-1040-2025-blank.txt"));
const BLANK_760 = await Deno.readTextFile(path.join(FIXTURES_DIR, "form-760-2025-blank.txt"));

const [AGI, TOTAL_TAX, VA_TAX] = FIGURES;

/** Writes `amount` into the row that holds `words`, where a return prints it. */
function fill(text: string, words: string, amount: string): string {
  const rows = text.split("\n");
  const i = rows.findIndex((r) => r.includes(words));
  if (i === -1) throw new Error(`fixture has no row with "${words}"`);
  rows[i] = rows[i].includes(". 00")
    ? rows[i].replace(/\s*\. 00\s*$/, `      ${amount} . 00`)
    : `${rows[i].trimEnd()}        ${amount}`;
  return rows.join("\n");
}

/** The blank 2025 Form 1040 rows filled with made-up figures on several lines. */
function filled1040(): string {
  let t = BLANK_1040;
  t = fill(t, "This is your total income", "91,111.");
  t = fill(t, "Adjustments to income from Schedule 1", "2,468.");
  t = fill(t, "This is your adjusted gross income", "85,432.");
  t = fill(t, "Amount from line 11a", "85,432.");
  t = fill(t, "Subtract line 21 from line 18", "7,777.");
  t = fill(t, "Other taxes, including self-employment tax", "1,357.");
  t = fill(t, "This is your total tax", "9,876.");
  t = fill(t, "Form(s) W-2", "8,642.");
  return "Jane Q Madeup   Example Lane, Sampletown\n" + t;
}

/** The blank 2025 Form 760 rows filled with made-up figures on several lines. */
function filled760(): string {
  let t = BLANK_760;
  t = fill(t, "Virginia Taxable Income", "73,210");
  t = fill(t, "Amount of Tax from Tax Table", "5,555");
  t = fill(t, "Net Amount of Tax", "4,321");
  t = fill(t, "Your Virginia withholding", "6,666");
  return t;
}

Deno.test("the blank forms print the three lines' words once each and no amount", () => {
  const results = findFigures(BLANK_1040, BLANK_760);
  assertEquals(results.map((r) => r.found), [false, false, false]);
  for (const r of results) {
    if (!r.found) assertEquals(r.reason, "no amount is printed on its line");
  }
});

Deno.test("line 11a, line 24 and line 18 are found by their printed words", () => {
  const results = findFigures(filled1040(), filled760());
  assertEquals(
    results.map((r) => (r.found ? [r.spec.line, r.amount] : [r.spec.line, "missing"])),
    [["11a", "85432"], ["24", "9876"], ["18", "4321"]],
  );
});

Deno.test("nothing else from the forms reaches the .md", () => {
  const md = renderFiguresMarkdown("2025", findFigures(filled1040(), filled760()));
  assertEquals(
    md,
    [
      "# 2025 return figures",
      "",
      "Written by `deno task accounting:return-figures` from the filed 2025 federal and Virginia returns.",
      "It holds these three figures and nothing else from the returns.",
      "",
      "| Figure | Form and line | Amount |",
      "| --- | --- | --- |",
      "| Federal adjusted gross income | Form 1040, line 11a | 85432 |",
      "| Federal total tax | Form 1040, line 24 | 9876 |",
      "| Virginia tax | Form 760, line 18 | 4321 |",
      "",
    ].join("\n"),
  );
  for (const other of ["91", "2468", "7777", "1357", "8642", "73210", "5555", "6666", "Madeup"]) {
    assert(!md.includes(other), `the .md holds "${other}" from another line of the form`);
  }
});

Deno.test("a form with a figure's line missing names that figure as missing", () => {
  const federal = filled1040().split("\n").filter((r) => !r.includes("This is your total tax"))
    .join("\n");
  const results = findFigures(federal, filled760());
  assertEquals(results.map((r) => r.found), [true, false, true]);
  const md = renderFiguresMarkdown("2025", results);
  assertStringIncludes(md, "| Federal total tax | Form 1040, line 24 | missing |");
  assertStringIncludes(
    md,
    "- Federal total tax (Form 1040, line 24): its printed words were not found.",
  );
  assert(!md.includes("9876"));
});

Deno.test("a return's amount forms are read, and anything else is named missing, never guessed", () => {
  const row = (tail: string) =>
    `24     Add lines 22 and 23. This is your total tax . . . .  24  ${tail}`;
  const amount = (tail: string) => {
    const r = findFigure(row(tail), TOTAL_TAX);
    return r.found ? r.amount : `missing: ${r.reason}`;
  };
  assertEquals(amount("9,876."), "9876");
  assertEquals(amount("9876"), "9876");
  assertEquals(amount("$9,876.00"), "9876");
  assertEquals(amount("9,876 . 00"), "9876");
  assertEquals(amount("9,876.54"), "9876.54");
  assertEquals(amount("-0-"), "0");
  assertEquals(amount("0"), "0");
  assertEquals(amount("(1,234)"), "-1234");
  assertEquals(amount("-1,234"), "-1234");
  assertEquals(amount(""), "missing: no amount is printed on its line");
  assertEquals(amount("1,234 5,678"), "missing: the amount on its line could not be read");
  assertEquals(amount("(1,234"), "missing: the amount on its line could not be read");
  assertEquals(amount("see statement"), "missing: the amount on its line could not be read");
});

Deno.test("words found on more than one row, or with no line number, name the figure as missing", () => {
  const twice = filled760() + "\n" + "18. Net Amount of Tax ........ 18     1,000 . 00\n";
  const r1 = findFigure(twice, VA_TAX);
  assertEquals(r1.found ? r1.amount : r1.reason, "its printed words appear on more than one row");
  const r2 = findFigure(
    "Subtract line 10 from line 9. This is your adjusted gross income 85,432",
    AGI,
  );
  assertEquals(r2.found ? r2.amount : r2.reason, "its line number was not found beside its words");
});

async function makeDirs() {
  const root = await Deno.makeTempDir({ prefix: "return-figures-" });
  const privateTaxDir = path.join(root, "financial-private", "tax");
  const booksDir = path.join(root, "books");
  await Deno.mkdir(path.join(privateTaxDir, "2025"), { recursive: true });
  const federalPdf = path.join(privateTaxDir, "2025", "federal-2025.pdf");
  const virginiaPdf = path.join(privateTaxDir, "2025", "virginia-2025.pdf");
  await Deno.writeTextFile(federalPdf, "federal");
  await Deno.writeTextFile(virginiaPdf, "virginia");
  return { root, privateTaxDir, booksDir, federalPdf, virginiaPdf };
}

const fakeExtract = (texts: Record<string, string>) => (p: string) =>
  Promise.resolve(texts[path.basename(p)] ?? "");

Deno.test("runReturnFigures writes tax/2025/return-figures.md in the books folder", async () => {
  const d = await makeDirs();
  try {
    const { outputPath, results } = await runReturnFigures({
      ...d,
      year: "2025",
      extractText: fakeExtract({
        "federal-2025.pdf": filled1040(),
        "virginia-2025.pdf": filled760(),
      }),
    });
    assertEquals(outputPath, path.join(d.booksDir, "tax", "2025", "return-figures.md"));
    assertEquals(results.filter((r) => r.found).length, 3);
    assertEquals(
      await Deno.readTextFile(outputPath),
      renderFiguresMarkdown("2025", results),
    );
  } finally {
    await Deno.remove(d.root, { recursive: true });
  }
});

Deno.test("runReturnFigures never replaces an existing return-figures.md", async () => {
  const d = await makeDirs();
  try {
    const out = path.join(d.booksDir, "tax", "2025", "return-figures.md");
    await Deno.mkdir(path.dirname(out), { recursive: true });
    await Deno.writeTextFile(out, "kept\n");
    await assertRejects(
      () =>
        runReturnFigures({
          ...d,
          year: "2025",
          extractText: fakeExtract({
            "federal-2025.pdf": filled1040(),
            "virginia-2025.pdf": filled760(),
          }),
        }),
      ReturnFiguresRefusal,
      "already exists",
    );
    assertEquals(await Deno.readTextFile(out), "kept\n");
  } finally {
    await Deno.remove(d.root, { recursive: true });
  }
});

Deno.test("runReturnFigures refuses, writing nothing, when it cannot tell", async (t) => {
  const d = await makeDirs();
  const out = path.join(d.booksDir, "tax", "2025", "return-figures.md");
  const texts = { "federal-2025.pdf": filled1040(), "virginia-2025.pdf": filled760() };
  const refuses = async (
    opts: Partial<Parameters<typeof runReturnFigures>[0]>,
    message: string,
  ) => {
    await assertRejects(
      () => runReturnFigures({ ...d, year: "2025", extractText: fakeExtract(texts), ...opts }),
      ReturnFiguresRefusal,
      message,
    );
    await assertRejects(() => Deno.stat(out), Deno.errors.NotFound);
  };
  try {
    await t.step(
      "a return that cannot be read",
      () =>
        refuses({ federalPdf: path.join(d.privateTaxDir, "2025", "absent.pdf") }, "cannot be read"),
    );
    await t.step("a return saved outside tax/2025", async () => {
      const outside = path.join(d.root, "federal-2025.pdf");
      await Deno.writeTextFile(outside, "federal");
      await refuses({ federalPdf: outside }, "must be saved in");
    });
    await t.step("a return saved in another year's folder", async () => {
      await Deno.mkdir(path.join(d.privateTaxDir, "2024"), { recursive: true });
      const other = path.join(d.privateTaxDir, "2024", "federal-2025.pdf");
      await Deno.writeTextFile(other, "federal");
      await refuses({ federalPdf: other }, "must be saved in");
    });
    await t.step("a malformed year", () => refuses({ year: "25" }, "four-digit year"));
    await t.step(
      "a return with no text",
      () =>
        refuses(
          { extractText: fakeExtract({ "federal-2025.pdf": filled1040() }) },
          "no readable text",
        ),
    );
    await t.step("pdftotext cannot read a return", () =>
      refuses({
        extractText: () =>
          Promise.reject(new ReturnFiguresRefusal("pdftotext could not read x.pdf.")),
      }, "pdftotext could not read"));
    await t.step(
      "the checker finds a protected number in what would be written",
      () =>
        refuses(
          { detect: () => [{ kind: "ssn", line: 1, column: 1 }] },
          "a Social Security number",
        ),
    );
  } finally {
    await Deno.remove(d.root, { recursive: true });
  }
});

Deno.test("extractPdfText refuses when pdftotext is not installed", async () => {
  await assertRejects(
    () => extractPdfText("/nonexistent.pdf", "no-such-pdftotext-binary"),
    ReturnFiguresRefusal,
    "pdftotext is not installed",
  );
});

const HAS_PDFTOTEXT = await new Deno.Command("pdftotext", { args: ["-v"], stderr: "null" })
  .output().then((o) => o.success).catch(() => false);

Deno.test({
  name: "extractPdfText refuses a file pdftotext cannot read",
  ignore: !HAS_PDFTOTEXT,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      const notPdf = path.join(dir, "not-a-return.pdf");
      await Deno.writeTextFile(notPdf, "this is not a PDF\n");
      await assertRejects(() => extractPdfText(notPdf), ReturnFiguresRefusal, "could not read");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/** A one-page PDF drawing each row's pieces at their x positions, one row per text line. */
function makePdf(rows: Array<Array<[number, string]>>): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const ops = rows.flatMap((pieces, i) =>
    pieces.map(([x, s]) => `BT /F1 9 Tf ${x} ${740 - i * 14} Td (${esc(s)}) Tj ET`)
  ).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

Deno.test({
  name:
    "deno task accounting:return-figures runs under its scoped permissions and prints no amount",
  ignore: !HAS_PDFTOTEXT,
  fn: async () => {
    const home = await Deno.makeTempDir({ prefix: "return-figures-home-" });
    try {
      const yearDir = path.join(home, "Dropbox", "financial-private", "tax", "2025");
      await Deno.mkdir(yearDir, { recursive: true });
      await Deno.writeFile(
        path.join(yearDir, "federal-2025.pdf"),
        makePdf([
          [[40, "9 Add lines 1z, 2b, 3b, 4b, 5b, 6b, 7a, and 8. This is your total income"], [
            450,
            "9",
          ], [
            500,
            "91,111.",
          ]],
          [[40, "11a Subtract line 10 from line 9. This is your adjusted gross income"], [
            450,
            "11a",
          ], [
            500,
            "85,432.",
          ]],
          [[40, "24 Add lines 22 and 23. This is your total tax"], [450, "24"], [500, "9,876."]],
        ]),
      );
      await Deno.writeFile(
        path.join(yearDir, "virginia-2025.pdf"),
        makePdf([
          [[40, "18. Net Amount of Tax - Subtract Line 17 from Line 16"], [450, "18"], [
            500,
            "4,321 . 00",
          ]],
        ]),
      );
      const homeCache = path.join(Deno.env.get("HOME") ?? "", ".cache", "deno");
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "task",
          "--config",
          path.join(REPO_ROOT, "deno.json"),
          "accounting:return-figures",
          path.join(yearDir, "federal-2025.pdf"),
          path.join(yearDir, "virginia-2025.pdf"),
          "--year",
          "2025",
        ],
        cwd: REPO_ROOT,
        env: { HOME: home, DENO_DIR: Deno.env.get("DENO_DIR") ?? homeCache, NO_COLOR: "1" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(out.stdout);
      const stderr = new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, stderr);
      const written = await Deno.readTextFile(
        path.join(
          home,
          "Dropbox",
          "web-jam-llms",
          "financial",
          "books",
          "tax",
          "2025",
          "return-figures.md",
        ),
      );
      assertStringIncludes(
        written,
        "| Federal adjusted gross income | Form 1040, line 11a | 85432 |",
      );
      assertStringIncludes(written, "| Federal total tax | Form 1040, line 24 | 9876 |");
      assertStringIncludes(written, "| Virginia tax | Form 760, line 18 | 4321 |");
      assert(!written.includes("91111") && !written.includes("91,111"));
      // The temporary path is random and may hold digits; the rest of stdout must hold no amount.
      const printed = stdout.replaceAll(home, "<home>");
      for (const figure of ["85", "9876", "9,876", "4321", "4,321", "91"]) {
        assert(!printed.includes(figure), `stdout prints "${figure}"`);
      }
      assertStringIncludes(stdout, "found:   Virginia tax (Form 760, line 18)");
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  },
});
