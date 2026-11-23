// src/accounting/entry.ts
// Create entries, write and read them in the Beancount books rustledger keeps (web-jam-tools#1865),
// and keep the journal reader and writer that import and month close use until web-jam-tools#1866.

import * as path from "@std/path";
import { Posting, Transaction } from "./types.ts";

// ---- File-format boundary ----

/** Entries and the check write and read only Beancount books. */
export function assertBeancountTarget(target: string, command: string): void {
  if (path.extname(target) !== ".beancount") {
    throw new Error(
      `${command} works on the year's Beancount books; '${target}' is not a .beancount file.`,
    );
  }
}

/** Import and month close keep the journal format until web-jam-tools#1866 moves them. */
export function assertJournalTarget(target: string, command: string): void {
  if (path.extname(target) === ".beancount") {
    throw new Error(
      `${command} still writes the year's .journal file; it refuses the Beancount books '${target}' and wrote nothing.`,
    );
  }
}

// ---- Beancount books ----

export const BOOKS_COMMODITY = "USD";

/** A real calendar date written YYYY-MM-DD. Anything else is refused before any books are chosen. */
export function assertCalendarDate(date: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [year, month, day] = match ? match.slice(1).map(Number) : [];
  const parsed = match ? new Date(Date.UTC(year, month - 1, day)) : null;
  if (
    !parsed || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(
      `'${date}' is not a real calendar date in YYYY-MM-DD form; nothing was written.`,
    );
  }
}

const ACCOUNT_ROOTS = new Set(["Assets", "Liabilities", "Equity", "Income", "Expenses"]);

/** A Beancount account: a root type, then parts that start with a capital letter or digit. */
export function assertBeancountAccount(account: string): void {
  const parts = account.split(":");
  const valid = parts.length >= 2 && ACCOUNT_ROOTS.has(parts[0]) &&
    parts.slice(1).every((part) => /^[A-Z0-9][A-Za-z0-9-]*$/.test(part));
  if (!valid) {
    throw new Error(
      `'${account}' is not a Beancount account name: it must start with Assets, Liabilities, Equity, Income or Expenses, and each part after a ':' must start with a capital letter or digit, with no spaces.`,
    );
  }
}

/** Quote text as a Beancount string, on one line. */
export function quoteBeancount(text: string): string {
  const oneLine = text.replace(/\r?\n/g, " ").trim();
  return `"${oneLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatBeancountAmount(amount: number): string {
  return `${amount.toFixed(2)} ${BOOKS_COMMODITY}`;
}

/**
 * One entry in Beancount: the date, the place or payer, a metadata line for each of purpose,
 * attendees, owner and receipt that is set, and the two postings.
 */
export function formatBeancountTransaction(tx: Transaction): string {
  const lines = [`${tx.date} ${tx.status ?? "*"} ${quoteBeancount(tx.description)}`];
  for (const [key, value] of Object.entries(tx.tags ?? {})) {
    if (!value || !value.trim()) continue;
    if (!/^[a-z][A-Za-z0-9_-]*$/.test(key)) {
      throw new Error(`'${key}' is not a Beancount metadata key.`);
    }
    lines.push(`  ${key}: ${quoteBeancount(value)}`);
  }
  if (tx.comment && tx.comment.trim()) {
    lines.push(`  ; ${tx.comment.replace(/\r?\n/g, " ").trim()}`);
  }
  for (const p of tx.postings) {
    assertBeancountAccount(p.account);
    lines.push(`  ${p.account.padEnd(34)}  ${formatBeancountAmount(p.amount).padStart(14)}`);
  }
  return lines.join("\n") + "\n";
}

/** The accounts the books open with an `open` directive. */
export function openedAccounts(content: string): Set<string> {
  const opened = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\d{4}-\d{2}-\d{2}\s+open\s+(\S+)/);
    if (match) opened.add(match[1]);
  }
  return opened;
}

function unquoteBeancount(text: string): string {
  return text.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

/** Reads the transactions the entry writer produces back out of Beancount books. */
export function parseBeancount(content: string): Transaction[] {
  const transactions: Transaction[] = [];
  let current: Transaction | null = null;
  const header =
    /^(\d{4}-\d{2}-\d{2})\s+([*!]|txn)\s+("(?:[^"\\]|\\.)*")(?:\s+("(?:[^"\\]|\\.)*"))?/;

  const finish = () => {
    if (current && current.postings.length > 0) transactions.push(current);
    current = null;
  };

  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      finish();
      const match = line.match(header);
      if (match) {
        const first = unquoteBeancount(match[3]);
        const second = match[4] ? unquoteBeancount(match[4]) : undefined;
        current = {
          date: match[1],
          status: match[2] === "!" ? "!" : "*",
          description: second === undefined ? first : `${first} ${second}`.trim(),
          postings: [],
          tags: {},
        };
      }
      continue;
    }
    if (!current) continue;
    const tx: Transaction = current;
    const trimmed = line.trim();
    const meta = trimmed.match(/^([a-z][A-Za-z0-9_-]*):\s+("(?:[^"\\]|\\.)*")$/);
    if (meta) {
      tx.tags[meta[1]] = unquoteBeancount(meta[2]);
      continue;
    }
    if (trimmed.startsWith(";")) {
      const body = trimmed.slice(1).trim();
      tx.comment = tx.comment ? `${tx.comment}; ${body}` : body;
      continue;
    }
    const posting = trimmed.match(
      /^([A-Z][A-Za-z0-9:-]*)\s+([-+]?[0-9,]*\.?[0-9]+)\s+([A-Z][A-Z0-9'._-]*)$/,
    );
    if (posting) {
      tx.postings.push({
        account: posting[1],
        amount: Number(posting[2].replace(/,/g, "")),
        commodity: posting[3],
      });
    }
  }
  finish();
  return transactions;
}

async function readBooksOrEmpty(booksPath: string): Promise<string> {
  try {
    return await Deno.readTextFile(booksPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return "";
    throw new Error(
      `Cannot read the books at ${booksPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The books hold private figures: only their owner may read or write them. */
const BOOKS_MODE = 0o600;

/**
 * Replaces `target` by writing a temporary file beside it and renaming it into place, so a write
 * cut short leaves the previous books whole.
 *
 * The temporary file is created owner-only, whatever the umask, and is given the existing books'
 * permissions with every group and other bit removed before the rename. New books are owner-only,
 * and books already stricter than that, such as read-only ones, keep their stricter permissions.
 */
async function replaceFileAtomically(target: string, content: string): Promise<void> {
  let mode = BOOKS_MODE;
  try {
    const current = await Deno.stat(target);
    if (current.mode !== null) mode = current.mode & BOOKS_MODE;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await Deno.writeTextFile(temp, content, { createNew: true, mode: BOOKS_MODE });
    await Deno.chmod(temp, mode);
    await Deno.rename(temp, target);
  } catch (err) {
    await Deno.remove(temp).catch(() => {});
    throw err;
  }
}

/**
 * The ledger an entry is written to. When `booksPath` is a symbolic link, the entry goes to the
 * ledger the link names and the link stays in place, so the read, the lock and the replacement all
 * act on that one ledger. The ledger the link names must itself be a .beancount file, and a link
 * to a ledger that does not exist is refused.
 */
async function resolveBooksTarget(booksPath: string): Promise<string> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(booksPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return booksPath;
    throw err;
  }
  if (!info.isSymlink) return booksPath;
  let resolved: string;
  try {
    resolved = await Deno.realPath(booksPath);
  } catch {
    throw new Error(
      `The books at ${booksPath} are a link to a ledger that does not exist; nothing was written.`,
    );
  }
  assertBeancountTarget(resolved, "accounting:entry");
  return resolved;
}

/**
 * Appends one entry to the year's Beancount books, first opening, on January 1 of the entry's
 * year, any account the books do not open yet, so `rledger check` accepts the entry.
 *
 * Reading the books, choosing which accounts to open and writing the result happen under an
 * exclusive lock on the books' directory, so two entry commands running at once each keep their
 * transaction and open a shared new account once. Locking the directory leaves no lock file
 * beside the books. The operating system releases the lock when the process ends, so a crashed
 * writer never leaves the books locked.
 */
export async function appendEntryToBooks(booksPath: string, tx: Transaction): Promise<void> {
  assertBeancountTarget(booksPath, "accounting:entry");
  assertCalendarDate(tx.date);
  const formatted = formatBeancountTransaction(tx);

  const target = await resolveBooksTarget(booksPath);
  const booksDir = path.dirname(target);
  await Deno.mkdir(booksDir, { recursive: true });
  const lock = await Deno.open(booksDir, { read: true });
  try {
    await lock.lock(true);
    const existing = await readBooksOrEmpty(target);
    const opened = openedAccounts(existing);
    const openLines = [...new Set(tx.postings.map((p) => p.account))]
      .filter((account) => !opened.has(account))
      .map((account) => `${tx.date.slice(0, 4)}-01-01 open ${account} ${BOOKS_COMMODITY}`);

    const block = (openLines.length > 0 ? openLines.join("\n") + "\n\n" : "") + formatted;
    const prefix = existing.length === 0
      ? ""
      : existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
      ? "\n"
      : "\n\n";

    await replaceFileAtomically(target, existing + prefix + block);
  } finally {
    lock.close();
  }
}

// ---- Journal (import and month close, until web-jam-tools#1866) ----

export function formatAmount(amount: number, commodity = "$"): string {
  const sign = amount < 0 ? "-" : "";
  const absVal = Math.abs(amount).toFixed(2);
  return `${commodity}${sign}${absVal}`;
}

export function formatPosting(p: Posting): string {
  const commodity = p.commodity || "$";
  const amountStr = `${commodity}${p.amount.toFixed(2)}`;
  if (p.balanceAssertion !== undefined) {
    const assertStr = `${commodity}${p.balanceAssertion.toFixed(2)}`;
    return `    ${p.account.padEnd(34)}  ${amountStr} = ${assertStr}`;
  }
  return `    ${p.account.padEnd(34)}  ${amountStr}`;
}

export function formatTransaction(tx: Transaction): string {
  const parts: string[] = [];
  const statusStr = tx.status ? ` ${tx.status}` : "";
  const codeStr = tx.code ? ` (${tx.code})` : "";
  parts.push(`${tx.date}${statusStr}${codeStr} ${tx.description}`);

  // Format metadata tags as comments
  if (tx.tags) {
    for (const [key, val] of Object.entries(tx.tags)) {
      if (val && val.trim() !== "") {
        parts.push(`    ; ${key}: ${val.trim()}`);
      }
    }
  }

  if (tx.comment && tx.comment.trim() !== "") {
    parts.push(`    ; ${tx.comment.trim()}`);
  }

  for (const p of tx.postings) {
    parts.push(formatPosting(p));
  }

  return parts.join("\n") + "\n";
}

export interface CreateEntryParams {
  date: string;
  description: string;
  amount: number;
  category: string;
  fromAccount?: string;
  purpose?: string;
  attendees?: string;
  owner?: string;
  receipt?: string;
  code?: string;
  isDraw?: boolean;
}

export function createEntry(params: CreateEntryParams): Transaction {
  const {
    date,
    description,
    amount,
    category,
    purpose,
    attendees,
    owner,
    receipt,
    code,
    isDraw,
  } = params;

  let fromAccount = params.fromAccount;
  const tags: Record<string, string> = {};

  if (purpose) tags["purpose"] = purpose;
  if (attendees) tags["attendees"] = attendees;
  if (owner) tags["owner"] = owner;
  if (receipt) tags["receipt"] = receipt;
  if (code) tags["id"] = code;

  // Determine source account if crossing between personal and business
  if (!fromAccount) {
    if (owner && isDraw) {
      // Personal purchase on business account: money owner withdrew
      fromAccount = `Equity:OwnerDraws:${owner}`;
    } else if (owner) {
      // Business expense paid personally: owner contribution
      fromAccount = `Equity:OwnerContributions:${owner}`;
    } else {
      fromAccount = "Liabilities:CreditCard";
    }
  }

  const postings: Posting[] = [
    { account: category, amount },
    { account: fromAccount, amount: -amount },
  ];

  return {
    date,
    code,
    description,
    postings,
    tags,
  };
}

export async function appendEntryToJournal(journalPath: string, tx: Transaction): Promise<void> {
  const formatted = formatTransaction(tx);
  const dir = path.dirname(journalPath);
  await Deno.mkdir(dir, { recursive: true });

  let existing = "";
  try {
    existing = await Deno.readTextFile(journalPath);
  } catch (_err) {
    // File may not exist yet
    existing = "";
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n\n")
    ? (existing.endsWith("\n") ? "\n" : "\n\n")
    : "";

  await Deno.writeTextFile(journalPath, existing + prefix + formatted);
}

export function parseJournal(content: string): Transaction[] {
  const transactions: Transaction[] = [];
  const lines = content.split(/\r?\n/);

  let currentTx: Partial<Transaction> | null = null;
  const dateRegex = /^(\d{4}-\d{2}-\d{2})(?:\s+([*!]))?(?:\s+\(([^)]+)\))?\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const headerMatch = line.match(dateRegex);
    if (headerMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      if (currentTx && currentTx.date && currentTx.postings && currentTx.postings.length > 0) {
        transactions.push(currentTx as Transaction);
      }
      currentTx = {
        date: headerMatch[1],
        status: (headerMatch[2] as "*" | "!") || undefined,
        code: headerMatch[3] || undefined,
        description: headerMatch[4].trim(),
        postings: [],
        tags: {},
      };
      continue;
    }

    if (currentTx && (line.startsWith(" ") || line.startsWith("\t"))) {
      // Metadata comment or tag
      if (trimmed.startsWith(";")) {
        const commentBody = trimmed.slice(1).trim();
        const tagMatch = commentBody.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
        if (tagMatch) {
          currentTx.tags = currentTx.tags || {};
          currentTx.tags[tagMatch[1]] = tagMatch[2].trim();
        } else {
          currentTx.comment = (currentTx.comment ? currentTx.comment + "; " : "") + commentBody;
        }
        continue;
      }

      // Posting line
      // Matches: Account:Name    [$]Amount [= [$]Assertion]
      const postingMatch = trimmed.match(
        /^([a-zA-Z0-9:_ -]+?)\s{2,}([-+]?\$?[-+]?[0-9,]+(?:\.[0-9]+)?)(?:\s*=\s*([\$]?[-+]?[0-9,]+(?:\.[0-9]+)?))?$/,
      );
      if (postingMatch) {
        const account = postingMatch[1].trim();
        const rawAmount = postingMatch[2].replace(/[$,]/g, "");
        const amount = parseFloat(rawAmount);

        let balanceAssertion: number | undefined;
        if (postingMatch[3]) {
          const rawAssertion = postingMatch[3].replace(/[$,]/g, "");
          balanceAssertion = parseFloat(rawAssertion);
        }

        currentTx.postings = currentTx.postings || [];
        currentTx.postings.push({
          account,
          amount,
          balanceAssertion,
        });
      }
    }
  }

  if (currentTx && currentTx.date && currentTx.postings && currentTx.postings.length > 0) {
    transactions.push(currentTx as Transaction);
  }

  return transactions;
}
