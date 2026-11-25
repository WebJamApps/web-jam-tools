// src/accounting/types.ts
// Data structures for Web Jam LLC's books (web-jam-tools#1764), kept in rustledger's Beancount
// books (web-jam-tools#1865, web-jam-tools#1866). The import and month-close options live beside
// their commands in import.ts and close_month.ts.

export interface Posting {
  account: string;
  amount: number;
  commodity?: string;
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

/**
 * What `rledger check` decided about the books: `pass` when it finds them valid, `fail` when it
 * reports an error (the diagnostic is in `message`), and `refuse` when the check could not run —
 * `rledger` missing or not runnable, or the books unreadable. A refusal never reports the books valid.
 */
export interface BooksCheckResult {
  outcome: "pass" | "fail" | "refuse";
  message: string;
}
