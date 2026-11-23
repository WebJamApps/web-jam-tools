// src/accounting/cli.ts
// Command-line interface for Web Jam LLC's books (web-jam-tools#1764). Entries, receipts and the
// check use rustledger's Beancount books (web-jam-tools#1865); import and month close keep the
// journal file until web-jam-tools#1866.

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import { expandHome } from "../design-issue/gate1.ts";
import { closeMonth } from "./close_month.ts";
import { convertBankFile } from "./convert.ts";
import {
  appendEntryToBooks,
  assertBeancountTarget,
  assertCalendarDate,
  createEntry,
} from "./entry.ts";
import { importStatement } from "./import.ts";
import { fileReceipt } from "./receipt.ts";
import { checkBooks } from "./verify.ts";

export function getDefaultBooksDir(): string {
  const home = Deno.env.get("HOME") || "/home/joshua";
  return path.join(home, "Dropbox", "web-jam-llms", "financial", "books");
}

/** The year's Beancount books, which entry and verify use. */
export function getDefaultBooksPath(year?: number): string {
  const yr = year || new Date().getFullYear();
  return path.join(getDefaultBooksDir(), `${yr}.beancount`);
}

/** The year's journal file, which import and month close use until web-jam-tools#1866. */
export function getDefaultJournalPath(year?: number): string {
  const yr = year || new Date().getFullYear();
  return path.join(getDefaultBooksDir(), `${yr}.journal`);
}

export async function runCli(args: string[]): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["help", "dry-run", "draw"],
    string: [
      "date",
      "desc",
      "description",
      "amount",
      "category",
      "from",
      "purpose",
      "attendees",
      "owner",
      "receipt",
      "source",
      "place",
      "input",
      "output",
      "format",
      "statement",
      "account",
      "rules",
      "journal",
      "books",
      "books-dir",
      "year",
      "month",
    ],
    collect: ["balance"],
    alias: {
      h: "help",
      d: "date",
      a: "amount",
      c: "category",
      j: "journal",
      i: "input",
      o: "output",
      s: "statement",
      y: "year",
      m: "month",
    },
    default: {
      help: false,
      "dry-run": false,
      draw: false,
    },
  });

  const command = flags._.length > 0 ? String(flags._[0]) : "";

  // Import and month close still write the year's .journal file (until web-jam-tools#1866), so a
  // caller naming Beancount books with --books is refused before either picks a destination.
  if ((command === "import" || command === "close-month") && flags.books !== undefined) {
    console.error(
      `Error: ${command} still writes the year's .journal file; it refuses --books, which names Beancount books, and wrote nothing.`,
    );
    return 1;
  }

  if (flags.help || !command || command === "help") {
    console.log(`Web Jam LLC Accounting CLI (rustledger)

Usage:
  deno task accounting:entry [options]
  deno task accounting:receipt [options]
  deno task accounting:convert [options]
  deno task accounting:import [options]
  deno task accounting:close-month [options]
  deno task accounting:verify [options]

Commands:
  entry         Add an entry to the year's Beancount books (--books, default <year>.beancount)
  receipt       File a receipt PDF from inbox/ to receipts/<year>/
  convert       Convert Quicken/QuickBooks (QFX, OFX, QBO, QIF) to CSV
  import        Import a CSV statement into the year's .journal file with duplicate prevention
  close-month   Assert statement balances in the .journal file, snapshot it, and generate reports
  verify        Check the year's Beancount books with rledger check (--books)
  init-books    Scaffold the private books directory hierarchy
`);
    return 0;
  }

  const booksDir = flags["books-dir"]
    ? path.resolve(expandHome(flags["books-dir"]))
    : getDefaultBooksDir();

  try {
    switch (command) {
      case "entry": {
        const desc = flags.desc || flags.description;
        if (!desc || !flags.amount || !flags.category) {
          console.error("Error: --desc, --amount, and --category are required for entry.");
          return 1;
        }

        const date = flags.date || new Date().toISOString().slice(0, 10);
        assertCalendarDate(date);
        const year = parseInt(date.slice(0, 4), 10);
        if (flags.journal) {
          console.error("Error: entry writes the Beancount books; name them with --books.");
          return 1;
        }
        const booksPath = flags.books
          ? path.resolve(expandHome(flags.books))
          : getDefaultBooksPath(year);
        assertBeancountTarget(booksPath, "accounting:entry");

        const amount = Number(flags.amount);
        if (!flags.amount.trim() || !Number.isFinite(amount)) {
          console.error("Error: --amount must be a finite number.");
          return 1;
        }

        const tx = createEntry({
          date,
          description: desc,
          amount,
          category: flags.category,
          fromAccount: flags.from,
          purpose: flags.purpose,
          attendees: flags.attendees,
          owner: flags.owner,
          receipt: flags.receipt,
          isDraw: flags.draw,
        });

        await appendEntryToBooks(booksPath, tx);
        console.log(`[accounting:entry] Entry added to ${booksPath}`);
        return 0;
      }

      case "receipt": {
        const place = flags.place || flags.desc || flags.description;
        if (!place) {
          console.error("Error: --place is required for receipt.");
          return 1;
        }

        const date = flags.date || new Date().toISOString().slice(0, 10);
        const year = flags.year ? parseInt(flags.year, 10) : parseInt(date.slice(0, 4), 10);

        const result = await fileReceipt({
          booksDir,
          year,
          date,
          place,
          sourceFile: flags.source,
        });

        console.log(`[accounting:receipt] ${result.message}`);
        return result.filed ? 0 : 1;
      }

      case "convert": {
        const inputPath = flags.input;
        if (!inputPath) {
          console.error("Error: --input <path> is required for convert.");
          return 1;
        }

        const result = await convertBankFile({
          inputPath: path.resolve(expandHome(inputPath)),
          outputPath: flags.output ? path.resolve(expandHome(flags.output)) : undefined,
          format: flags.format as "qfx" | "ofx" | "qbo" | "qif" | "auto" | undefined,
        });

        if (flags.output) {
          console.log(
            `[accounting:convert] Converted ${result.count} transaction(s) to ${flags.output}`,
          );
        } else {
          console.log(result.csv);
        }
        return 0;
      }

      case "import": {
        const statementPath = flags.statement || flags.input;
        if (!statementPath) {
          console.error("Error: --statement <path> is required for import.");
          return 1;
        }

        const journalPath = flags.journal
          ? path.resolve(expandHome(flags.journal))
          : getDefaultJournalPath();

        const result = await importStatement({
          statementPath: path.resolve(expandHome(statementPath)),
          journalPath,
          account: flags.account,
          rulesPath: flags.rules ? path.resolve(expandHome(flags.rules)) : undefined,
          dryRun: flags["dry-run"],
        });

        console.log(
          `[accounting:import] Imported ${result.importedCount} transaction(s), skipped ${result.skippedCount} duplicate(s).`,
        );
        return 0;
      }

      case "close-month": {
        if (!flags.year || !flags.month) {
          console.error("Error: --year and --month are required for close-month.");
          return 1;
        }

        const year = parseInt(flags.year, 10);
        const month = parseInt(flags.month, 10);
        const journalPath = flags.journal
          ? path.resolve(expandHome(flags.journal))
          : getDefaultJournalPath(year);

        const rawBalances = (flags.balance || []).map(String);
        const balances: Record<string, number> = {};

        for (const b of rawBalances) {
          const eqIdx = b.indexOf("=");
          if (eqIdx !== -1) {
            const acc = b.slice(0, eqIdx).trim();
            const raw = b.slice(eqIdx + 1).replace(/[$,]/g, "").trim();
            const val = Number(raw);
            if (!acc || !raw || !Number.isFinite(val)) {
              console.error("Error: --balance must have an account and a finite amount.");
              return 1;
            }
            balances[acc] = val;
          } else {
            console.error("Error: --balance must have an account and a finite amount.");
            return 1;
          }
        }

        if (Object.keys(balances).length === 0) {
          console.error("Error: At least one --balance <account>=<amount> is required.");
          return 1;
        }

        const result = await closeMonth({
          year,
          month,
          balances,
          journalPath,
          booksDir,
          dryRun: flags["dry-run"],
        });

        console.log(
          `[accounting:close-month] Month ${result.year}-${result.month} closed as of ${result.closeDate}.`,
        );
        console.log(`Snapshot: ${result.snapshotPath}`);
        for (const r of result.reportPaths) {
          console.log(`Report: ${r}`);
        }
        return 0;
      }

      case "verify": {
        if (flags.journal) {
          console.error("Error: verify checks the Beancount books; name them with --books.");
          return 1;
        }
        const booksPath = flags.books
          ? path.resolve(expandHome(flags.books))
          : getDefaultBooksPath(flags.year ? parseInt(flags.year, 10) : undefined);

        const result = await checkBooks(booksPath);
        if (result.outcome === "pass") {
          console.log(`[accounting:verify] PASS: rledger check finds ${booksPath} valid.`);
          return 0;
        }
        if (result.outcome === "fail") {
          console.error(`[accounting:verify] FAILED: rledger check found errors in ${booksPath}:`);
          console.error(result.message);
          return 1;
        }
        console.error(`[accounting:verify] REFUSED: ${result.message}`);
        return 2;
      }

      case "init-books": {
        const dirs = [
          path.join(booksDir, "rules"),
          path.join(booksDir, "inbox"),
          path.join(booksDir, "receipts"),
          path.join(booksDir, "statements"),
          path.join(booksDir, "sweep"),
          path.join(booksDir, "closed"),
          path.join(booksDir, "reports"),
          path.join(booksDir, "tax"),
        ];

        for (const d of dirs) {
          await Deno.mkdir(d, { recursive: true });
        }

        console.log(`[accounting:init-books] Initialized books structure at ${booksDir}`);
        return 0;
      }

      default:
        console.error(`Unknown accounting command: ${command}`);
        return 1;
    }
  } catch (err) {
    console.error(`[accounting] Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await runCli(Deno.args);
  Deno.exit(exitCode);
}
