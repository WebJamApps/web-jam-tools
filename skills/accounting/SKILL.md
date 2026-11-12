---
name: accounting
description: Keep Web Jam LLC's books in hledger under ~/Dropbox/web-jam-llms/financial/books/. Record plain-text entries, file receipt scans, convert Quicken/QuickBooks bank files to CSV, import statements, and run the month-end close. No personal lines or amounts go to GitHub.
---

# /accounting — Web Jam LLC Double-Entry Bookkeeping in hledger

This skill manages Web Jam LLC's books using `hledger` plain-text accounting. It runs across
Claude Code, Antigravity (agy), and Codex. Josh or Maria communicates transactions in plain
language at the laptop (e.g. "penn station, 22.86"), and the agent writes the corresponding
journal entries, files receipts, converts bank files, or runs the month-end close.

No bookkeeping is performed on a phone.

## Code and Data Separation

The skill text, conversion tooling, and automated test suite live in this public repository
(`web-jam-tools`). All actual financial data, journals, statements, receipts, and reports
live exclusively in the private Dropbox folder:

```
~/Dropbox/web-jam-llms/financial/books/
```

**Hard Rule:** Never commit real books, balances, account numbers, or financial statements
to GitHub or include them in issue descriptions, commit messages, or PR bodies.

## Folder Layout

All accounting files reside in `~/Dropbox/web-jam-llms/financial/books/`:

- `<year>.journal` — the active year's books (e.g. `2026.journal`)
- `rules/` — account import mapping rules (e.g. `truist-checking.rules`, `credit-card.rules`)
- `inbox/` — scanned receipts waiting to be filed
- `receipts/<year>/` — filed receipt PDFs organized by year (e.g. `receipts/2026/2026-11-10-penn-station.pdf`)
- `statements/<year>/` — downloaded bank and card statement files (e.g. `statements/2026/`)
- `sweep/` — personal account statements placed temporarily during quarterly sweeps
- `closed/<year>-<month>/` — closed month journal snapshots and verification reports
- `reports/<year>/` — year-to-date and annual balance sheets and profit & loss reports
- `tax/<year>/` — quarterly penalty worksheets and the annual tax package
- `mileage-<year>.csv` — gig and business travel mileage log
- `repeating-charges.md` — inventory of known recurring business subscriptions

The skill never deletes an accounting record.

## Accounts Brought In

Only two business accounts are imported:
1. Truist business checking (`Assets:Checking:Truist`)
2. Business credit card (`Liabilities:CreditCard`)

Personal bank or credit card accounts are **never** imported into the books.

## Journal Entry Conventions

Every journal entry records:
- Date (`YYYY-MM-DD`)
- Payee / Place / Payer
- Amount
- Category account (e.g. `Expenses:Meals`, `Expenses:Software`, `Income:Performance`)
- Payment source account (e.g. `Liabilities:CreditCard`, `Assets:Checking:Truist`)
- Business purpose tag (`; purpose: ...`)
- Receipt link tag when a receipt exists (`; receipt: receipts/<year>/...`)
- Meal attendees tag when recording dining expenses (`; attendees: ...`)
- Owner tag when paid or received personally (`; owner: Josh` or `; owner: Maria`)

### Money Crossing Between Personal and Business

- **Business expense paid personally**: Recorded as a business expense offset by owner contribution:
  `Equity:OwnerContributions:Josh` or `Equity:OwnerContributions:Maria`.
- **Personal purchase on business account**: Recorded as money an owner withdrew:
  `Equity:OwnerDraws:Josh` or `Equity:OwnerDraws:Maria`. Never recorded as a business expense.

### Special Categories

- **AI Spending**: Every AI subscription and API charge is a business expense of Web Jam LLC
  (`Expenses:Software` or `Expenses:Subscriptions`), regardless of which account pays it.
- **Gear & Instruments**: Recorded as business equipment (`Assets:Equipment`) and added to the
  gear list. Tax depreciation is determined at year-end with the accountant.
- **Gig Income**: Income is recognized on the date of the performance (`Income:Performance`).
  Cash held personally is tracked under `Assets:CashOnHand:<Owner>`. When deposited into the
  business account, a transfer moves funds from `Assets:CashOnHand:<Owner>` to `Assets:Checking:Truist`.

## Receipt Filing

1. Scanned receipts land in `inbox/` as PDFs from the Dropbox mobile scanner or printer.
2. The agent moves the receipt from `inbox/` to `receipts/<year>/<date>-<place-slug>.pdf`
   using `deno task accounting:receipt`.
3. The relative receipt path is tied to the journal entry tag `; receipt: receipts/<year>/<filename>`.
4. Where no receipt exists, the entry itself (with date, place, amount, and purpose) serves as the record.

## Monthly Routine: Bank Import & Close

Each month, downloaded statements are processed and closed:

1. **Download Statements**: Place checking and credit card statement files in `statements/<year>/`.
2. **Convert Quicken / QuickBooks Format**: If downloaded in QFX, OFX, QBO, or QIF format, convert
   to CSV:
   ```sh
   deno task accounting:convert --input <statement-file> --output <csv-file>
   ```
3. **Import Transactions**: Import the CSV statement into the journal:
   ```sh
   deno task accounting:import --statement <csv-file> --account <account-name> --journal <journal-file>
   ```
   The importer enforces duplicate prevention: lines previously imported are skipped.
4. **Categorize**: Review uncategorized transactions and apply mapping rules from `rules/`.
5. **Month-End Close**: Once all transactions are entered and reconciled to the statement balance:
   ```sh
   deno task accounting:close-month --year <year> --month <month> --balance <account>=<amount>
   ```
   The close operation:
   - Appends a balance assertion to `<year>.journal` (e.g. `Assets:Checking:Truist 0 = $5420.50`).
   - Copies the journal to `closed/<year>-<month>/<year>.journal`.
   - Generates month-end balance sheet and income statement reports under `closed/<year>-<month>/`.
   - Ensures any future edit that alters the closed period's balance triggers an assertion failure.

## Tasks Reference

All accounting operations run via registered `deno task` commands in `deno.json`:

- `deno task accounting:entry` — Format and record a new transaction in the journal.
- `deno task accounting:receipt` — File a receipt PDF from `inbox/` to `receipts/<year>/`.
- `deno task accounting:convert` — Convert QFX, OFX, QBO, or QIF bank statements to CSV.
- `deno task accounting:import` — Import and reconcile statement transactions into the journal.
- `deno task accounting:close-month` — Assert statement balances, snapshot the journal, and produce close reports.
