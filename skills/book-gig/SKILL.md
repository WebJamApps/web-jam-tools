---
name: book-gig
description: Identify eligible venues for target performance weekends, filter by +- 2 months gig spacing, trigger venue-mining when density is sparse, generate voice-rule-compliant pitches, record Gate 1 venue-set approval, dispatch approved batches (--send --confirm-drafts), and track venue replies (--replies). Triggered by /book-gig <weekend> [location], "book gig", or "book gigs".
---

# book-gig — Target Performance Weekend Booking Outreach

Automate identifying eligible live-music venues, filtering them against Josh & Maria's performance history (+- 2 months gig-spacing), triggering `venue-mining` when target density is low, generating personalized booking pitches that adhere to `docs/cross-ai-rules.md` voice rules, recording Gate 1 venue-set approval (`POST /outreach/approval/venue-set` via `--record-gate1`), dispatching approved batches via `POST /outreach/batch` (`--send --confirm-drafts`), and tracking live venue responses and AI suggestions (`--replies` / `--check-replies`).

## Invocation

- `/book-gig <weekend> [location]` — Discovery & preview mode (drafts pitches, logs candidate table, outputs clickable HTML artifact link, and automatically opens it in Chrome).
- `/book-gig --record-gate1 "<weekend>" [location] [--venues "id1,id2"] [--skip "id3"] [--approver "Josh"]` — Gate 1 venue-set approval mode (records server-side approval of the target venue set via `POST /outreach/approval/venue-set` once Josh approves the candidate table; authorizes ONLY the venue set and nothing else).
- `/book-gig --send "<weekend>" [location] --confirm-drafts [--venues "id1,id2" | --venue "id1"] [--skip "id3"]` — Batch dispatch mode (calls `POST /outreach/batch` to send pitches to approved venues, outputs HTML artifact link, and opens in Chrome; requires `--confirm-drafts` after explicit draft review; `--venue <name|id>` acts as an alias for a single target venue in `--send` mode).
- `/book-gig --replies [weekend]` — Response tracking mode (scans Gmail for replies via `POST /outreach/check-replies`, displays live campaign status table, outputs HTML artifact link, and opens in Chrome).
- `/book-gig --link-gig <venue-name>` — Gig linking mode (resolves single venue by exact normalized name, matches unlinked gig, and writes `venueId` via `PATCH /gig/:id` to correct a wrong new-versus-returning badge per D-26).
- `/book-gig --hold "<venueId|venueName>" --until <YYYY-MM-DD>` — Contact hold mode (sets `resumeBooking` to resume date at UTC midnight via `PATCH /venue/:id`; also accepts `--resume`).
- `/book-gig --booked-through <YYYY-MM-DD> --venue "<venueId|venueName>"` — Booked-through availability mode (sets `bookedThrough` to target date at UTC 23:59:59.999Z via `PATCH /venue/:id`; accepts `--venue` or `--hold`).
- **Location Syntax & Flags:**
  - Multi-city compound list: `deno task book-gig "Oct 16-18 and Lynchburg, Blacksburg, Martinsville, Salem, Roanoke, and surrounding areas"`
  - Explicit flag: `deno task book-gig "Oct 16-18 2026" --cities "Lynchburg, Blacksburg, Martinsville, Salem, Roanoke"`
  - Supports `--cities`, `--locations`, or `--location`.
- **Examples:**
  - `deno task book-gig "Oct 16-18 2026"` — sweep all venues across the regional driving radius (~3.5h from Salem, VA) and automatically open the Dark Mode HTML artifact in Chrome.
  - `deno task book-gig "Oct 16-18 and Lynchburg, Blacksburg, Martinsville, Salem, Roanoke, and surrounding areas"` — focus on target cities and their surrounding regional communities, excluding non-target metros.
  - `deno task book-gig "Oct 16-18 2026" --no-open` — generate pitches and logs without automatically opening Chrome.
  - `deno task book-gig "Oct 16-18 2026" "Lynchburg, VA"` — focus on Lynchburg, VA and surrounding area.
  - `deno task book-gig --record-gate1 "Oct 16-18 2026" "Lynchburg, VA" --venues "id1,id2"` — record Gate 1 target venue-set approval for specific approved candidate venues.
  - `deno task book-gig --record-gate1 "Oct 16-18 2026"` — record Gate 1 target venue-set approval for all eligible candidate venues.
  - `deno task book-gig --send "Oct 16-18 2026" "Lynchburg, VA" --confirm-drafts` — dispatch outreach batch to all eligible Lynchburg venues after reviewing and confirming drafts.
  - `deno task book-gig --send "Oct 16-18 2026" "Lynchburg, VA" --confirm-drafts --venues "id1,id2"` — dispatch only to specific approved candidate venues after reviewing and confirming drafts.
  - `deno task book-gig --send "Oct 16-18 2026" "Lynchburg, VA" --confirm-drafts --venue "Twin Creeks"` — dispatch outreach to a single candidate venue (convenient alias for `--venues`).
  - `deno task book-gig --send "Oct 16-18 2026" "Lynchburg, VA" --confirm-drafts --skip "id3"` — dispatch batch while excluding specific venues.
  - `deno task book-gig --replies "Oct 16-18 2026"` — check replies and campaign status for target weekend.
  - `deno task book-gig --replies` — check all active outreach campaigns across all target dates.
  - `deno task book-gig --link-gig "Olde Salem Brewing"` — link matching gig to venue by exact normalized name.
  - `deno task book-gig --hold "Tequila's" --until 2027-01-01` — place contact hold on venue until Jan 1, 2027 (`resumeBooking`).
  - `deno task book-gig --venue "Olde Salem Brewing" --booked-through 2026-12-31` — record calendar booked solid through Dec 31, 2026 (`bookedThrough`).
  - `deno task book-gig --hold "Olde Salem Brewing" --until 2027-01-01 --booked-through 2026-12-31` — record both contact hold and booked-through date simultaneously.
- **Interactive Fallback:** If invoked without arguments (`/book-gig`), prompt Josh interactively for the target weekend and optional location.

## Workflow

```mermaid
graph TD
    A["Invoke /book-gig <weekend> [location]"] --> B["Fetch Candidates from Backend (GET /outreach/candidates)"]
    B --> C["Apply +- 2 Month Gig-Spacing & Eligibility Filter"]
    C --> D{"Candidate Density Assessment"}
    D -- "Sparse (< 3-5 venues)" --> E["Recommend /venue-mining for Metro"]
    E --> B
    D -- "Sufficient Candidates" --> F["Phase 2A: Propose Candidate Table & Target Selection"]
    F --> G["Josh Reviews & Approves Target Candidates"]
    G --> G1["GATE 1: Record Target Venue Set Server-Side (POST /outreach/approval/venue-set)"]
    G1 --> H["Phase 2B: Pitch Draft Preview & Dark HTML Artifact Review"]
    H --> I["Josh Explicitly Reviews & Approves Draft Content (GATE 2)"]
    I --> J["Dispatch Outreach Batch (deno task book-gig --send ... --confirm-drafts)"]
    J --> K["Calls POST /outreach/batch, CCs Josh+Maria, Logs Touches"]
    K --> L["Track Responses (deno task book-gig --replies)"]
    L --> M["Calls POST /outreach/check-replies & Renders Status Table"]
```

### 1. Resolve Target Weekend & Location
- Parse natural date ranges (`Oct 16-18 2026`) or ISO strings (`2026-10-16`).
- Parse optional location (City/State e.g. `Lynchburg, VA`, Zipcode e.g. `24502`, or metro slug).

### 2. Candidate Discovery & Gig-Spacing Exclusion
- Calls `web-jam-back` `GET /outreach/candidates?targetDates=...`:
  - Automatically filters to `outreachEligible !== false` venues with valid contact email.
  - Excludes venues that already have active outreach campaigns for the requested weekend.
  - Enforces the **+- 2 month gig-spacing rule** (`excludeUpcomingGigVenues`): excludes any venue where Josh & Maria are performing within 60 days of the target weekend.
  - Sorts and prioritizes venues matching the requested City, State, or Zipcode.

### 3. Density Check & Venue Mining Trigger
- If candidate coverage in the target area is sparse (< 3–5 venues), the skill offers to run `/venue-mining metro <slug>` to harvest net-new venues first.
- New venues are added to MongoDB with verified street addresses and booking emails via `POST /venue`.

### 4. Two-Stage Approval Gate: Candidate Targets (Phase 2A / GATE 1) & Pitch Drafts (Phase 2B / GATE 2)

Batch outreach dispatch is protected by two mandatory, independent hard gates (D-39, D-40, D-41). AI assistants must strictly distinguish between target venue selection and draft content approval:

#### Phase 2A: Target Venue Approval & GATE 1 Recording
- Present candidate proposal table to Josh in chat:
  `| # | Venue Name | City, State | Booking Email | Spacing Reason |`
- Josh reviews candidate eligibility and approves or refines the target venue list (e.g. approving specific IDs with `--venues` or skipping with `--skip`, or approving all proposed candidates).
- **GATE 1 RECORDING:** Immediately upon receiving Josh's approval of the target candidate list, the AI assistant MUST record Gate 1 approval server-side:
  - CLI: `deno task book-gig --record-gate1 "<weekend>" [location] [--venues "id1,id2"] [--skip "id3"] [--approver "Josh"]`
  - Client API: `recordGate1Approval({ weekend, venueIds, approver: "Josh" })` calling `POST /outreach/approval/venue-set` on `web-jam-back`.
  - Payload: `{ batchId, weekend, targetWeekend, venueIds, approver, notes, metadata }`.
- **STRICT HARD GATE INVARIANTS (D-39 / D-41):**
  - **Gate 1 authorizes ONLY the target venue set and NOTHING else.**
  - Recording Gate 1 approval does **NOT** authorize draft pitch copy and does **NOT** authorize email dispatch.
  - Approval of draft copy or permission to send must **NEVER** be inferred from candidate list approval or Gate 1 recording.
  - **No Silent Re-Recording:** The backend upserts Gate 1 approval records on batchId/weekend, so recording Gate 1 approval refuses outright when an approval already exists for the same batch with a *different* venue set — it never silently replaces a prior approval with a new one. A re-run with the identical venue set is a harmless no-op.
  - **FORBIDDEN ACTION:** AI assistants are **STRICTLY FORBIDDEN** from executing `deno task book-gig --send` when the user approves target candidates or when Gate 1 is recorded. Gate 1 satisfies only the venue-set check; dispatch requires both Gate 1 and an independent Gate 2 draft copy approval record.

#### Phase 2B: Draft Content Review & Approval (GATE 2)
- Provide the generated pitch previews and clickable Dark Mode HTML review artifact link (automatically opened in Chrome) so Josh can inspect the exact rendered pitch emails:
  - Subject lines, salutations, body copy, and venue contact details.
  - Verification that email drafts strictly conform to `docs/cross-ai-rules.md` **Voice Rules**:
    - First-person singular ("I", "my wife Maria", "my wife and I play as Josh and Maria, an acoustic duo out of Salem, VA").
    - Salutation: `Hi,` or `Hi [Name],` (never "Dear [Title]").
    - Zero banned marketing hype words (`exciting`, `opportunity`, `passionate`, `thrilled`, `reach out`, `circle back`, `truly admire`, `deep connection`, `great addition`, `perfect fit`, `your spot`).
    - Warm coffee-shop conversational tone.
    - Preserves personal hooks (e.g. "son lives in Rustburg" or past performance note).
- The AI assistant must explicitly present the drafts and pause for separate, explicit approval of the pitch copy from Josh.
- Batch dispatch may ONLY proceed when Josh provides distinct, explicit approval of the drafts (e.g. "Drafts look good, send them", "Approved to send", or signoff on the rendered email content).

### 5. Approved Batch Outreach Dispatch (`--send --confirm-drafts`)
- Once BOTH Phase 2A (Target Selection / Gate 1) and Phase 2B (Draft Content Review & Approval / Gate 2) have been explicitly approved by Josh, execute batch outreach dispatch:
  - **All eligible candidates:** `deno task book-gig --send "<weekend>" [location] --confirm-drafts`
  - **Specific approved subset:** `deno task book-gig --send "<weekend>" [location] --confirm-drafts --venues "id1,id2"` (or `--include`)
  - **Single approved target venue alias:** `deno task book-gig --send "<weekend>" [location] --confirm-drafts --venue "<name|id>"` (populates `includeVenues` for a single target, e.g. `--venue "Twin Creeks"`)
  - **Excluding specific candidates:** `deno task book-gig --send "<weekend>" [location] --confirm-drafts --skip "id3"` (or `--exclude`)
- **Fail-Closed Confirmation Guard:** The `--send` command strictly requires the `--confirm-drafts` flag. If `--confirm-drafts` is missing, `src/book-gig/cli.ts` immediately fails closed with an error and will NOT call `POST /outreach/batch`.
- Calls `POST /outreach/batch` on `web-jam-back` with `{ venueIds, targetDates, targetWeekend }`.
- Dispatches pitch emails to candidate booking contacts, CCs Josh and Maria (`joshua.v.sherman@gmail.com`, `chemmariasherman@gmail.com`), initializes active campaigns in MongoDB (`status: 'sent'`), and logs email touches on venue timelines.

### 6. Live Response Tracking (`--replies` / `--check-replies`)
- Track replies and campaign progression:
  `deno task book-gig --replies [target-weekend]`
- Calls `POST /outreach/check-replies` on `web-jam-back` to perform Gmail IMAP reply detection.
- Fetches pending replies (`GET /outreach/replies/pending`) and active campaigns (`GET /outreach`), rendering a status table with live lifecycle badges (`sent`, `replied`, `interested`, `booked`, `not-interested`, `no-response`, `target-filled`), sent dates, and response snippets.
- Highlights pending AI suggestions for review (`intent`, `confidence`, `suggestedAction`).
- **Responsive Dark Mode HTML Artifact & First-Party URLs:** Automatically generates and updates standalone Dark Mode `.html` review artifacts in `~/Dropbox/web-jam-llms/gig-outreach/`, publishes to `web-jam-back` via `POST /outreach/report` to serve from first-party `https://www.web-jam.com/outreach/report/<weekend>` URLs, outputs both the live web-jam.com URL and direct clickable `file://` link in chat / terminal logs, and automatically launches Google Chrome in the background to display the artifact immediately on completion (with `--no-open` supported for headless/CI runs).

## What It Refuses to Do

| It refuses to | Because |
|---|---|
| Auto-send outreach without explicit draft approval and `--confirm-drafts`, or dispatch based on venue target approval alone (Gate 1) | Two-stage approval gate requires distinct signoff (D-39): Gate 1 authorizes ONLY the target venue set (recorded server-side via `POST /outreach/approval/venue-set`), while Gate 2 authorizes rendered draft copy. Dispatch requires `--send --confirm-drafts` and fails closed if either gate or `--confirm-drafts` is missing. AI assistants are strictly forbidden from executing `--send` when candidates or venue lists alone are approved. |
| Pitch venues within +- 2 months of a booked gig | Preserves local audience draw and venue spacing commitments. |
| Pitch venues with active outreach campaigns for that weekend | Prevents embarrassing duplicate outreach to venue managers. |
| Use corporate marketing copy or banned hype words | Violates cross-AI voice rules. Tone must remain genuine and personal. |
| Invent unverified claims or musical genres | Anti-hallucination rule: only state facts given by Josh. |

