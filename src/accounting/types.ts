// src/accounting/types.ts
// Data structures and interfaces for Web Jam LLC double-entry accounting in hledger (web-jam-tools#1764).

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

export interface VerificationResult {
  valid: boolean;
  errors: string[];
  assertionsChecked: number;
}
