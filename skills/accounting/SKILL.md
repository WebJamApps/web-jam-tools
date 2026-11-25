---
name: accounting
description: Keep Web Jam LLC's books in rustledger under ~/Dropbox/web-jam-llms/financial/books/. Record plain-text entries, file receipt scans, check the books with rledger, import the clean statement CSVs with rledger extract, and run the month-end close. No personal lines or amounts go to GitHub.
---

# /accounting — Web Jam LLC Double-Entry Bookkeeping in rustledger

This skill manages Web Jam LLC's books in rustledger, which reads Beancount's plain-text format
through its `rledger` command. It runs across Claude Code, Antigravity (agy), and Codex. Josh or
Maria communicates transactions in plain language at the laptop (e.g. "penn station, 22.86"), and
the agent writes the corresponding entries, files receipts, checks the books, imports the month's
clean statement files, or runs the month-end close.

Every command works on the year's Beancount books (`<year>.beancount`) and refuses any other file.

No bookkeeping is performed on a phone.

## Code and Data Separation

The skill text, its commands, and automated test suite live in this public repository
(`web-jam-tools`). All actual financial data, journals, statements, receipts, and reports
live exclusively in the private Dropbox folder:

```
~/Dropbox/web-jam-llms/financial/books/
```

**Hard Rule:** Never commit real books, balances, account numbers, or financial statements
to GitHub or include them in issue descriptions, commit messages, or PR bodies.

## Folder Layout

All accounting files reside in `~/Dropbox/web-jam-llms/financial/books/`:

- `<year>.beancount` — the year's books (e.g. `2026.beancount`)
- `importers.toml` — the import profile for each account, read by `rledger extract`
- `inbox/` — scanned receipts waiting to be filed
- `receipts/<year>/` — filed receipt PDFs organized by year (e.g. `receipts/2026/2026-11-10-penn-station.pdf`)
- `statements/<year>/` — downloaded bank and card statement files (e.g. `statements/2026/`)
- `sweep/` — personal account statements placed temporarily during quarterly sweeps
- `closed/<year>-<month>/` — the dated copy of the books and the month's reports, saved by the close
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

## Entry Conventions

Record an entry with `deno task accounting:entry`, which appends it to `<year>.beancount` (or the
file named with `--books`, which must end in `.beancount`):

```sh
deno task accounting:entry --date 2026-11-10 --desc "Penn Station" --amount 22.86 \
  --category Expenses:Meals --from Liabilities:CreditCard --purpose "Lunch meeting" \
  --attendees "Josh, Maria" --receipt receipts/2026/2026-11-10-penn-station.pdf
```

Every entry records:
- Date (`YYYY-MM-DD`)
- Payee / Place / Payer
- Amount, in `USD`
- Category account (e.g. `Expenses:Meals`, `Expenses:Software`, `Income:Performance`)
- Payment source account (e.g. `Liabilities:CreditCard`, `Assets:Checking:Truist`)
- Business purpose metadata (`purpose: "..."`)
- Receipt metadata when a receipt exists (`receipt: "receipts/<year>/..."`)
- Meal attendees metadata when recording dining expenses (`attendees: "..."`)
- Owner metadata when paid or received personally (`owner: "Josh"` or `owner: "Maria"`)

In the books an entry reads:

```
2026-11-10 * "Penn Station"
  purpose: "Lunch meeting"
  attendees: "Josh, Maria"
  receipt: "receipts/2026/2026-11-10-penn-station.pdf"
  Expenses:Meals                           22.86 USD
  Liabilities:CreditCard                  -22.86 USD
```

Account names follow Beancount's rule: they start with `Assets`, `Liabilities`, `Equity`, `Income`
or `Expenses`, and each part after a `:` starts with a capital letter or digit, with no spaces.
The entry command opens, on January 1 of the entry's year, any account the books do not open yet.

## Checking the Books

Check the year's books with `deno task accounting:verify`, which runs `rledger check` on
`<year>.beancount` (or the file named with `--books`). `rledger` must be on PATH.

- The books are valid: it prints PASS and exits 0.
- `rledger check` reports an error: it prints FAILED with rustledger's diagnostic and exits 1.
- It cannot tell — `rledger` is not installed or cannot be run, or the books cannot be read: it
  prints REFUSED with the reason and exits 2. It never reports the books valid.

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
3. The relative receipt path is tied to the entry by passing it to `accounting:entry` as
   `--receipt receipts/<year>/<filename>`, which writes the metadata line
   `receipt: "receipts/<year>/<filename>"`.
4. Where no receipt exists, the entry itself (with date, place, amount, and purpose) serves as the record.

## Monthly Routine: Bank Import & Close

1. **Clean downloads (Josh, in his own terminal)**: Josh downloads the month's file for each of the
   two business accounts into the private downloads folder named in the design's "What never
   reaches an agent", and runs `deno task accounting:clean-download <file>` on each, outside every
   agent and never through Claude Code's `!`. It writes the clean CSV
   (`date,description,amount,id`) into `statements/<year>/`. An agent never opens a download as it
   was produced. Where an account offers neither CSV nor the Quicken or QuickBooks format, Josh
   types its lines from the statement.
2. **Import**: Import each clean file into the year's books with its account's profile from
   `importers.toml`:
   ```sh
   deno task accounting:import --statement statements/<year>/<file>.csv --importer <profile>
   ```
   It runs `rledger extract`, naming the books' own `importers.toml` with `--config` (or the file
   named with `--config`), the profile with `--importer`, and the year's books with `--existing`,
   so a line already in the books is skipped and the same file run again adds nothing. Without
   `--config`, an `importers.toml` in whatever folder the command runs from would be read instead,
   which is why the command always names the books' own file.
   - The profile's `mappings` give each line its category, matched on the description; a line no
     mapping places lands in its `default_expense` or `default_income` account. Ask Josh about
     any line the profile cannot place.
   - The extracted lines are staged with the books, and any account they use that the books do
     not open yet is opened on January 1. The staged books must pass `rledger check` before they
     replace the books.
   - It refuses, and leaves the books exactly as they were, when `rledger` cannot run,
     `importers.toml` cannot be read, the profile is not found, the books cannot be read, or the
     staged books fail `rledger check`. `--dry-run` shows what it would import.
3. **Month-End Close**: Once the month's lines are in and match the statement:
   ```sh
   deno task accounting:close-month --year <year> --month <month> --balance <account>=<amount>
   ```
   Give one `--balance` for each account, with the statement's ending balance. The close:
   - Writes each balance as a `balance` line dated the first day of the following month (e.g.
     `2026-04-01 balance Assets:Checking:Truist 5420.50 USD` for March), so a purchase on the
     statement's last day is counted.
   - Checks the books with those lines with `rledger check` first. A balance that does not match
     the books is refused with rustledger's diagnostic, and nothing is written.
   - Saves a dated copy of the books, a balance sheet and the month's income statement under
     `closed/<year>-<month>/`, then writes the books. A month already closed is refused.
   - From then on, any edit that changes that month's totals fails `rledger check`.

## Tasks Reference

All accounting operations run via registered `deno task` commands in `deno.json`:

- `deno task accounting:entry` — Record a new entry in the year's Beancount books.
- `deno task accounting:receipt` — File a receipt PDF from `inbox/` to `receipts/<year>/`.
- `deno task accounting:import` — Import a clean statement CSV through `rledger extract`.
- `deno task accounting:close-month` — Write the statement balances, check the books, and save the dated copy and reports.
- `deno task accounting:verify` — Check the year's Beancount books with `rledger check`.
- `deno task accounting:cli init-books` — Create the books directory structure.

The tasks can read and write within the repository and the default books folder. Place statements
and receipts in the books folder before using them; custom paths outside these locations require an
explicit `deno run` invocation with permissions for those paths.
