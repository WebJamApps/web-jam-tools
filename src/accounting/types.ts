// src/accounting/types.ts
// Data structures for Web Jam LLC's books (web-jam-tools#1764). Entries, receipts and the check
// use rustledger's Beancount books; import and month close still read and write the journal
// format until web-jam-tools#1866 moves them (web-jam-tools#1865).

export interface Posting {
  account: string;
  amount: number;
  commodity?: string;
  balanceAssertion?: number;
}

export interface Transaction {
  date: string; // YYYY-MM-DD
  status?: "*" | "!";
  code?: string;
  description: string;
  postings: Posting[];
  tags: Record<string, string>;
  comment?: string;
}

export interface BankTransaction {
  date: string; // YYYY-MM-DD
  amount: number;
  payee: string;
  memo?: string;
  id: string; // FITID / unique transaction identifier
  type?: string;
}

export interface AccountRule {
  /** Literal payee substring, matched case-insensitively; never evaluated as a regex. */
  pattern: string;
  category: string;
  purpose?: string;
}

export interface ConvertOptions {
  inputPath: string;
  outputPath?: string;
  format?: "qfx" | "ofx" | "qbo" | "qif" | "auto";
}

export interface ConvertResult {
  csv: string;
  count: number;
  outputPath?: string;
}

export interface ImportOptions {
  statementPath: string;
  journalPath: string;
  rulesPath?: string;
  account?: string;
  dryRun?: boolean;
}

export interface ImportResult {
  importedCount: number;
  skippedCount: number;
  transactions: Transaction[];
}

export interface CloseMonthOptions {
  year: number;
  month: number; // 1-12
  balances: Record<string, number>; // account -> statement balance
  journalPath: string;
  booksDir?: string;
  dryRun?: boolean;
}

export interface MonthCloseResult {
  year: number;
  month: number;
  closeDate: string;
  balances: Record<string, number>;
  snapshotPath: string;
  reportPaths: string[];
}

/**
 * What `rledger check` decided about the books: `pass` when it finds them valid, `fail` when it
 * reports an error (the diagnostic is in `message`), and `refuse` when the check could not run —
 * `rledger` missing or not runnable, or the books unreadable. A refusal never reports the books valid.
 */
export interface BooksCheckResult {
  outcome: "pass" | "fail" | "refuse";
  message: string;
}

export interface VerificationResult {
  valid: boolean;
  errors: string[];
  assertionsChecked: number;
}
