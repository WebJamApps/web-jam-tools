// src/accounting/cli.ts
// Command-line interface for Web Jam LLC's books (web-jam-tools#1764), all kept in rustledger's
// Beancount books: entries, receipts and the check (web-jam-tools#1865), and the import of clean
// CSVs and the month close (web-jam-tools#1866).

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import { expandHome } from "../design-issue/gate1.ts";
import { closeMonth } from "./close_month.ts";
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

/** A `--year` value: exactly four digits, nothing else. */
export function parseYearFlag(raw: string): number {
  const value = String(raw).trim();
  if (!/^\d{4}$/.test(value)) throw new Error(`--year must be a four-digit year; '${raw}' is not.`);
  return Number(value);
}

/** A `--month` value: one or two digits for a month from 1 to 12, nothing else. */
export function parseMonthFlag(raw: string): number {
  const value = String(raw).trim();
  const month = /^\d{1,2}$/.test(value) ? Number(value) : NaN;
  if (!(month >= 1 && month <= 12)) {
    throw new Error(`--month must be a month from 1 to 12; '${raw}' is not.`);
  }
  return month;
}

/** The year's Beancount books, which entry and verify use. */
export function getDefaultBooksPath(year?: number): string {
  const yr = year || new Date().getFullYear();
  return path.join(getDefaultBooksDir(), `${yr}.beancount`);
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
      "statement",
      "importer",
      "config",
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

  if (flags.help || !command || command === "help") {
    console.log(`Web Jam LLC Accounting CLI (rustledger)

Usage:
  deno task accounting:entry [options]
  deno task accounting:receipt [options]
  deno task accounting:import [options]
  deno task accounting:close-month [options]
  deno task accounting:verify [options]

Commands:
  entry         Add an entry to the year's Beancount books (--books, default <year>.beancount)
  receipt       File a receipt PDF from inbox/ to receipts/<year>/
  import        Import a clean CSV through rledger extract (--statement, --importer, --config,
                --books); a line already in the books is skipped
  close-month   Write each statement balance as a balance line dated the next month's first day,
                check the books, and save a dated copy and reports under closed/<year>-<month>/
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
        const year = flags.year ? parseYearFlag(flags.year) : parseInt(date.slice(0, 4), 10);

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

      case "import": {
        const statementPath = flags.statement || flags.input;
        if (!statementPath || !flags.importer) {
          console.error(
            "Error: --statement <clean CSV> and --importer <profile> are required for import.",
          );
          return 1;
        }
        if (flags.journal) {
          console.error("Error: import writes the Beancount books; name them with --books.");
          return 1;
        }
        const booksPath = flags.books
          ? path.resolve(expandHome(flags.books))
          : getDefaultBooksPath(flags.year ? parseYearFlag(flags.year) : undefined);
        assertBeancountTarget(booksPath, "accounting:import");
        const configPath = flags.config
          ? path.resolve(expandHome(flags.config))
          : path.join(flags["books-dir"] ? booksDir : path.dirname(booksPath), "importers.toml");

        const result = await importStatement({
          csvPath: path.resolve(expandHome(statementPath)),
          booksPath,
          configPath,
          importer: flags.importer,
          dryRun: flags["dry-run"],
        });

        const verb = flags["dry-run"] ? "Would import" : "Imported";
        console.log(
          `[accounting:import] ${verb} ${result.importedCount} transaction(s) into ${booksPath}; lines already in the books were skipped.`,
        );
        if (result.openedAccounts.length > 0) {
          console.log(`Opened: ${result.openedAccounts.join(", ")}`);
        }
        if (result.extracted) console.log(result.extracted.trimEnd());
        return 0;
      }

      case "close-month": {
        if (!flags.year || !flags.month) {
          console.error("Error: --year and --month are required for close-month.");
          return 1;
        }
        if (flags.journal) {
          console.error("Error: close-month writes the Beancount books; name them with --books.");
          return 1;
        }

        const year = parseYearFlag(flags.year);
        const month = parseMonthFlag(flags.month);
        const booksPath = flags.books
          ? path.resolve(expandHome(flags.books))
          : getDefaultBooksPath(year);

        const balances: Record<string, number> = {};
        for (const b of (flags.balance || []).map(String)) {
          const eqIdx = b.indexOf("=");
          const acc = eqIdx === -1 ? "" : b.slice(0, eqIdx).trim();
          const raw = eqIdx === -1 ? "" : b.slice(eqIdx + 1).replace(/[$,]/g, "").trim();
          const val = Number(raw);
          if (!acc || !raw || !Number.isFinite(val)) {
            console.error("Error: --balance must have an account and a finite amount.");
            return 1;
          }
          balances[acc] = val;
        }
        if (Object.keys(balances).length === 0) {
          console.error("Error: At least one --balance <account>=<amount> is required.");
          return 1;
        }

        const result = await closeMonth({
          year,
          month,
          balances,
          booksPath,
          booksDir: flags["books-dir"] ? booksDir : undefined,
          dryRun: flags["dry-run"],
        });

        const verb = flags["dry-run"] ? "would close" : "closed";
        console.log(
          `[accounting:close-month] ${result.year}-${
            String(result.month).padStart(2, "0")
          } ${verb}: balance lines dated ${result.balanceDate}.`,
        );
        console.log(`Snapshot: ${result.snapshotPath}`);
        for (const r of result.reportPaths) console.log(`Report: ${r}`);
        return 0;
      }

      case "verify": {
        if (flags.journal) {
          console.error("Error: verify checks the Beancount books; name them with --books.");
          return 1;
        }
        const booksPath = flags.books
          ? path.resolve(expandHome(flags.books))
          : getDefaultBooksPath(flags.year ? parseYearFlag(flags.year) : undefined);

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
