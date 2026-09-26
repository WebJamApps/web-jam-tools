// src/design-issue/lint_plan.ts
// Cell validation for `deno task design:lint-plan` (web-jam-tools#796).
//
// Consumes the Gate 2 plan-table parser (`./plan_table.ts`, web-jam-tools#795) and validates the
// value in each cell: missing values, unknown model tiers, unknown repos, personal-name title
// prefixes, out-of-range priorities, unpaired/composite `Josh` manual rows, uncited cross-repo
// children, and unproven `Tests` cells. Report-only -- writes nothing.
//
// It also checks the plan's `## Needs Design label removals` list (web-jam-tools#1131 "skills/design-issue: a target issue's requirement can be narrowed and parked as not resolved at Gate 2 instead of designed before Gate 1"): a removal
// whose "Not resolved" part quotes or narrows a directive line of the same issue's body fails,
// because that requirement was cut down instead of designed. That check reads each cited issue's
// body with a read-only `gh issue view`, and fails closed when a body cannot be read.
//
// Canonical vocabularies are read from source at runtime, never hardcoded:
//   - Model tiers: `skills/fix-labels/labels.yaml`, via the existing loader in
//     `../fix-labels/diff.ts` (`loadSchema` + `computeModelLabels`) -- read-only, that module is
//     never modified here. The `Josh` label (used as the Model tier value for manual rows per
//     `skills/design-issue/SKILL.md` "Manual Steps & Verification Pairs") is not `modelTier: true`
//     in the schema, so it is looked up by name and added to the allowed tier set only when it is
//     actually present in `labels.yaml`.
//   - Repos: `ACTIVE_REPOS` in `../flash-issues/types.ts` -- read-only, that module is never
//     modified here.

import * as path from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import {
  computeModelLabels,
  DEFAULT_SCHEMA_PATH,
  loadSchema,
  type Schema,
} from "../fix-labels/diff.ts";
import { ACTIVE_REPOS } from "../flash-issues/types.ts";
import { expandHome } from "./gate1.ts";
import { type Gate1StatusResult, type Gate1StatusType, getGate1Status } from "./gate1_record.ts";
import {
  type MalformedPlanTableRow,
  type ParsedPlanTable,
  parsePlanTable,
  PLAN_TABLE_HEADER,
  type PlanTableRow,
} from "./plan_table.ts";

/** A single cell-validation finding against the Gate 2 plan table. Report-only. */
export interface PlanTableViolation {
  /** Machine-readable rule identifier. */
  rule: string;
  /** 1-based source line number of the offending row. */
  line: number;
  /** Plan table column name the violation was found in, when applicable. */
  column?: string;
  /** Human-readable explanation. */
  message: string;
}

export interface Gate1VerificationResult {
  valid: boolean;
  status?: Gate1StatusType;
  approvalLine?: string;
  error?: string;
  reply?: string;
  approvedAt?: string;
}

export interface LintPlanResult {
  docPath: string;
  valid: boolean;
  violations: PlanTableViolation[];
  gate1Approval?: {
    approvedAt: string;
    reply: string;
    approvalLine: string;
  };
}

export interface LintPlanOptions {
  /** Canonical model-tier vocabulary source. `lintPlanTableFile` defaults this to loading
   * `labels.yaml` when omitted; `validatePlanTable` instead treats an omitted schema as an
   * explicit opt-out that skips tier validation entirely. A schema that IS provided but yields
   * an empty vocabulary is treated as a degraded `labels.yaml` and throws (see
   * `resolveTierVocabulary`), rather than silently passing every tier. */
  schema?: Schema;
  /** Canonical active-repo vocabulary. Defaults to `ACTIVE_REPOS`. */
  activeRepos?: readonly string[];
  /** Reads an issue's body for the `Needs Design` removal check. Defaults to a read-only
   * `gh issue view`; tests inject a stub. Throws when the body cannot be read. */
  fetchIssueBody?: IssueBodyFetcher;
  /** Canonical design document path to check Gate 1 approval against. */
  designDocPath?: string;
  /** Gate 1 state directory override (for testing). */
  stateDir?: string;
}

/** Returns the body of `repo#number`, or throws when it cannot be read. `repo` is either a bare
 * WebJamApps repo name or an `owner/repo` slug, exactly as cited in the plan. */
export type IssueBodyFetcher = (repo: string, number: number) => Promise<string>;

// Column indices resolved from PLAN_TABLE_HEADER (never hardcoded against reordering).
const COL_TITLE = PLAN_TABLE_HEADER.indexOf("Proposed title");
const COL_EPIC = PLAN_TABLE_HEADER.indexOf("Epic / child of");
const COL_TIER = PLAN_TABLE_HEADER.indexOf("Model tier");
const COL_PRIORITY = PLAN_TABLE_HEADER.indexOf("Priority");
const COL_REPO = PLAN_TABLE_HEADER.indexOf("Repo");
const COL_TESTS = PLAN_TABLE_HEADER.indexOf("Tests");
const COL_CLOSES = PLAN_TABLE_HEADER.indexOf("Closes when");

/** The native GitHub Priority field's four levels (`src/flash-issues/types.ts`'s `Priority` type,
 * `PRIORITY_MAP` in `src/create-issue/lib.ts`). Not read from a config file at runtime -- there is
 * none -- but pinned to the same four literal values used everywhere else a Priority is set. */
const NATIVE_PRIORITY_LEVELS = ["Urgent", "High", "Medium", "Low"] as const;

/** Strings that mean "no value was given" in a plan-table cell. */
function isMissingValue(cell: string): boolean {
  const v = cell.trim();
  if (v === "") return true;
  if (v === "—") return true;
  if (v === "-") return true;
  if (v.toLowerCase() === "n/a") return true;
  return false;
}

/** Strips markdown emphasis/code markers (`` ` ``, `*`, `_`) so a value wrapped in backticks or
 * bold (or both) still compares equal to its plain form, and a prefix hidden inside emphasis
 * markers is still detected. Plan-table cell values never legitimately contain these characters
 * as content, so a blanket strip is safe here (unlike prose linting elsewhere in this package). */
function stripMdMarkers(cell: string): string {
  return cell.replace(/[`*_]/g, "").trim();
}

/** Exact (post-trim, post-lowercase) `Tests` cell values that name a testing *kind* rather than
 * saying what proves the issue -- e.g. "unit tests" restates the acceptance criterion's own
 * wording without saying what those tests assert. Substring matching is deliberately avoided so
 * a genuine sentence containing one of these words (e.g. "Unit tests assert each validator rule
 * fires on its fixture") is not falsely flagged. */
const TESTS_INSUFFICIENT_VALUES = new Set([
  "yes",
  "tests",
  "y",
  "test",
  "unit tests",
  "unit test",
  "covered",
]);

const PERSONAL_NAME_PREFIX = /^josh\s*[-:—]\s?/i;

const REVIEW_KEYWORDS = [
  /\bchrome\b/i,
  /\breview\b/i,
  /\binspect/i,
  /\bdocument/i,
  /\bmarkdown\b/i,
  /\bhtml\b/i,
  /\bartifact/i,
];

const WALKTHROUGH_KEYWORDS = [
  /\bwalkthrough\b/i,
  /\bdemonstrat/i,
  /\bteach/i,
  /\blearner\b/i,
  /\blive\s+procedure\b/i,
  /\bshoelace\b/i,
  /\bexternal\s+part(y|ies)\b/i,
];

/** A cross-repo child's `Epic / child of` cell must cite its parent as `repo#number "title"`
 * (the same citation shape the standing hard rule requires everywhere else) so it is unambiguous
 * which repo's epic it belongs to. */
const REPO_NUMBER_TITLE_CITATION = /[\w.\-/]+#\d+\s+"[^"]+"/;

/** Finds the plan table's own epic row: the one row whose `Epic / child of` cell is a "missing"
 * value (`-`, blank, etc.) meaning "this row has no parent". Returns `undefined` when zero or more
 * than one such row exists, since the epic cannot be unambiguously identified either way -- a flat
 * set of standalone issues legitimately has several "no parent" rows, and cross-repo-child
 * citation checking (the one check that needs "the epic's repo") is skipped rather than guessed. */
function findEpicRow(rows: PlanTableRow[]): PlanTableRow | undefined {
  const candidates = rows.filter((r) => isMissingValue(stripMdMarkers(r.cells[COL_EPIC])));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function normalizeRepoCell(cell: string): string {
  return stripMdMarkers(cell).replace(/^WebJamApps\//i, "").trim();
}

/** Validates every well-formed row of a parsed Gate 2 plan table. Parser-level malformed rows
 * (cell count didn't match the header -- `web-jam-tools#795`) are passed through as their own
 * violation rather than silently dropped. */
export function validatePlanTable(
  parsed: ParsedPlanTable,
  options: LintPlanOptions,
): PlanTableViolation[] {
  const violations: PlanTableViolation[] = [];
  const { rows, malformedRows } = parsed;

  for (const bad of malformedRows) {
    violations.push(malformedRowViolation(bad));
  }

  const canonicalTiers = resolveTierVocabulary(options.schema);
  const activeRepos = options.activeRepos ?? ACTIVE_REPOS;
  const epicRow = findEpicRow(rows);
  const epicRepo = epicRow ? normalizeRepoCell(epicRow.cells[COL_REPO]) : undefined;

  for (const row of rows) {
    checkMissingAndTier(row, canonicalTiers, violations);
    checkPriority(row, violations);
    checkRepo(row, activeRepos, violations);
    checkTests(row, violations);
    checkTitlePersonalName(row, violations);
  }

  checkJoshPairingAndComposite(rows, violations);

  if (epicRow && epicRepo) {
    checkCrossRepoChildren(rows, epicRow, epicRepo, violations);
  }

  return violations;
}

function malformedRowViolation(bad: MalformedPlanTableRow): PlanTableViolation {
  return {
    rule: "malformed-row",
    line: bad.line,
    message: `Row has ${bad.actualCellCount} cell(s), expected ${bad.expectedCellCount} ` +
      `matching the plan table header`,
  };
}

function resolveTierVocabulary(schema: Schema | undefined): string[] {
  if (!schema) return [];
  const tiers = computeModelLabels(schema);
  const joshLabel = schema.labels.find((l) => l.name === "Josh");
  const vocabulary = joshLabel ? [...tiers, joshLabel.name] : tiers;
  if (vocabulary.length === 0) {
    throw new Error(
      "resolveTierVocabulary: schema was provided but produced an empty model-tier " +
        'vocabulary -- labels.yaml is degraded (no modelTier entries and no "Josh" label). ' +
        "Refusing to silently skip tier validation.",
    );
  }
  return vocabulary;
}

function checkMissingAndTier(
  row: PlanTableRow,
  canonicalTiers: string[],
  violations: PlanTableViolation[],
): void {
  const raw = row.cells[COL_TIER];
  if (isMissingValue(raw)) {
    violations.push({
      rule: "cell-missing",
      line: row.line,
      column: "Model tier",
      message: `Model tier is missing ("${raw}")`,
    });
    return;
  }
  const tier = stripMdMarkers(raw);
  if (canonicalTiers.length > 0 && !canonicalTiers.includes(tier)) {
    violations.push({
      rule: "tier-unknown",
      line: row.line,
      column: "Model tier",
      message: `Model tier "${tier}" is not in labels.yaml's canonical model-tier vocabulary`,
    });
  }
}

function checkPriority(row: PlanTableRow, violations: PlanTableViolation[]): void {
  const raw = row.cells[COL_PRIORITY];
  if (isMissingValue(raw)) {
    violations.push({
      rule: "cell-missing",
      line: row.line,
      column: "Priority",
      message: `Priority is missing ("${raw}")`,
    });
    return;
  }
  const priority = stripMdMarkers(raw);
  if (!(NATIVE_PRIORITY_LEVELS as readonly string[]).includes(priority)) {
    violations.push({
      rule: "priority-invalid",
      line: row.line,
      column: "Priority",
      message: `Priority "${priority}" is not one of the native Priority levels (` +
        `${NATIVE_PRIORITY_LEVELS.join(", ")})`,
    });
  }
}

function checkRepo(
  row: PlanTableRow,
  activeRepos: readonly string[],
  violations: PlanTableViolation[],
): void {
  const raw = row.cells[COL_REPO];
  if (isMissingValue(raw)) {
    violations.push({
      rule: "cell-missing",
      line: row.line,
      column: "Repo",
      message: `Repo is missing ("${raw}")`,
    });
    return;
  }
  const repo = normalizeRepoCell(raw);
  if (!activeRepos.includes(repo)) {
    violations.push({
      rule: "repo-unknown",
      line: row.line,
      column: "Repo",
      message: `Repo "${repo}" is not in ACTIVE_REPOS`,
    });
  }
}

function checkTests(row: PlanTableRow, violations: PlanTableViolation[]): void {
  const raw = row.cells[COL_TESTS];
  if (isMissingValue(raw)) {
    violations.push({
      rule: "cell-missing",
      line: row.line,
      column: "Tests",
      message: `Tests is missing ("${raw}")`,
    });
    return;
  }
  const tests = stripMdMarkers(raw).toLowerCase();
  if (TESTS_INSUFFICIENT_VALUES.has(tests)) {
    violations.push({
      rule: "tests-insufficient",
      line: row.line,
      column: "Tests",
      message: `Tests cell "${raw.trim()}" states no proof -- say what proves the issue`,
    });
  }
}

function checkTitlePersonalName(row: PlanTableRow, violations: PlanTableViolation[]): void {
  const title = stripMdMarkers(row.cells[COL_TITLE]);
  if (PERSONAL_NAME_PREFIX.test(title)) {
    violations.push({
      rule: "title-personal-name-prefix",
      line: row.line,
      column: "Proposed title",
      message: `Proposed title "${row.cells[COL_TITLE]}" is prefixed with a personal name -- ` +
        `ownership belongs to the Josh label, not the title`,
    });
  }
}

/** A row is "paired" when another row sharing the same `Epic / child of` value (i.e. the same
 * parent -- siblings under one epic, per the Manual Steps & Verification Pairs table in
 * `skills/design-issue/SKILL.md`) carries a valid, non-`Josh` model tier. */
function checkJoshPairingAndComposite(
  rows: PlanTableRow[],
  violations: PlanTableViolation[],
): void {
  for (const row of rows) {
    const tier = stripMdMarkers(row.cells[COL_TIER]);
    if (tier !== "Josh") continue;

    const parentKey = stripMdMarkers(row.cells[COL_EPIC]);
    const hasAgentSibling = rows.some((other) => {
      if (other === row) return false;
      if (stripMdMarkers(other.cells[COL_EPIC]) !== parentKey) return false;
      return stripMdMarkers(other.cells[COL_TIER]) !== "Josh";
    });
    if (!hasAgentSibling) {
      violations.push({
        rule: "josh-row-unpaired",
        line: row.line,
        column: "Model tier",
        message: `Josh-labeled manual row has no sibling agent row sharing the same ` +
          `"Epic / child of" parent`,
      });
    }

    const combinedText = `${row.cells[COL_TITLE]} ${row.cells[COL_CLOSES]}`;
    const hasReview = REVIEW_KEYWORDS.some((re) => re.test(combinedText));
    const hasWalkthrough = WALKTHROUGH_KEYWORDS.some((re) => re.test(combinedText));
    if (hasReview && hasWalkthrough) {
      violations.push({
        rule: "josh-row-composite",
        line: row.line,
        column: "Proposed title",
        message: `Josh-labeled manual row combines artifact/doc review with a live walkthrough` +
          ` -- these are distinct verification surfaces and must be separate rows/issues`,
      });
    }
  }
}

/** A child row whose own Repo differs from the epic's Repo must cite its parent as
 * `repo#number "title"` in its `Epic / child of` cell -- an unqualified reference like "Epic #1"
 * is ambiguous once the child is filed in a different repository than the epic. */
function checkCrossRepoChildren(
  rows: PlanTableRow[],
  epicRow: PlanTableRow,
  epicRepo: string,
  violations: PlanTableViolation[],
): void {
  for (const row of rows) {
    if (row === epicRow) continue;
    const epicChildCell = row.cells[COL_EPIC];
    if (isMissingValue(stripMdMarkers(epicChildCell))) continue; // not a child of anything

    const childRepo = normalizeRepoCell(row.cells[COL_REPO]);
    if (!childRepo || childRepo === epicRepo) continue;

    if (!REPO_NUMBER_TITLE_CITATION.test(epicChildCell)) {
      violations.push({
        rule: "cross-repo-child-uncited",
        line: row.line,
        column: "Epic / child of",
        message: `Child row's repo ("${childRepo}") differs from the epic's ("${epicRepo}") ` +
          `but "Epic / child of" ("${epicChildCell}") is not cited as repo#number "title"`,
      });
    }
  }
}

/** Loads the canonical model-tier schema from `labels.yaml`, via `../fix-labels/diff.ts`'s
 * existing loader (read-only -- this module never edits that file or its schema). */
export async function loadCanonicalSchema(
  schemaPath: string = DEFAULT_SCHEMA_PATH,
): Promise<Schema> {
  return await loadSchema(schemaPath);
}

/**
 * Verifies Gate 1 disk record for a design document before Gate 2 can pass.
 * - Passes when Gate 1 record shows approval and document content matches approved fingerprint,
 *   returning the quoted `Gate 1 approval recorded <date>: "<reply>"` line.
 * - Refuses when designDocPath is omitted.
 * - Refuses when no Gate 1 record exists.
 * - Refuses when record is open but never approved.
 * - Refuses when document changed since approval (fingerprint mismatch).
 * - Refuses when record file or design document cannot be read.
 */
export async function checkGate1ApprovalRecord(
  designDocPath?: string,
  options?: { stateDir?: string },
): Promise<Gate1VerificationResult> {
  if (!designDocPath || designDocPath.trim() === "") {
    return {
      valid: false,
      error:
        "Missing required --design-doc argument. Gate 2 requires verified Gate 1 approval of the design document.",
    };
  }

  const absDocPath = path.resolve(expandHome(designDocPath.trim()));

  try {
    await Deno.readTextFile(absDocPath);
  } catch (err) {
    return {
      valid: false,
      error: `Cannot read design document at ${absDocPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let statusResult: Gate1StatusResult;
  try {
    statusResult = await getGate1Status(absDocPath, { stateDir: options?.stateDir });
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (statusResult.status === "not presented") {
    return {
      valid: false,
      status: "not presented",
      error:
        `No Gate 1 record exists for ${absDocPath}. Present the design document with deno task design:gate1 first.`,
    };
  }

  if (statusResult.status === "open") {
    return {
      valid: false,
      status: "open",
      error:
        `Gate 1 record for ${absDocPath} is open but has not been approved yet. Obtain Josh's explicit approval and record it with deno task design:gate1-approve first.`,
    };
  }

  if (statusResult.status === "changed since approval") {
    return {
      valid: false,
      status: "changed since approval",
      error:
        `Design document ${absDocPath} has changed since Gate 1 approval. Re-present the document with deno task design:gate1 and obtain fresh approval before Gate 2.`,
    };
  }

  if (statusResult.status === "approved") {
    const approvalLine = `Gate 1 approval recorded ${statusResult.approvedAt ?? ""}: "${
      statusResult.reply ?? ""
    }"`;
    return {
      valid: true,
      status: "approved",
      approvalLine,
      reply: statusResult.reply,
      approvedAt: statusResult.approvedAt,
    };
  }

  return {
    valid: false,
    error: `Unexpected Gate 1 status '${statusResult.status}' for ${absDocPath}`,
  };
}

/** Reads a design document from disk, parses its Gate 2 plan table, validates every cell, and
 * checks its `Needs Design` label removals against the removed issues' own bodies. Also verifies
 * Gate 1 disk record when `options.designDocPath` is provided. */
export async function lintPlanTableFile(
  filePath: string,
  options?: LintPlanOptions,
): Promise<LintPlanResult> {
  const markdown = await Deno.readTextFile(filePath);
  const parsed = parsePlanTable(markdown);
  if (parsed === null) {
    throw new Error(`No Gate 2 plan table found in ${filePath}`);
  }

  const schema = options?.schema ?? await loadCanonicalSchema();
  const violations = validatePlanTable(parsed, { schema, activeRepos: options?.activeRepos });
  violations.push(
    ...await checkNeedsDesignRemovals(markdown, options?.fetchIssueBody ?? ghIssueBody),
  );

  let gate1Approval: LintPlanResult["gate1Approval"];
  if (options?.designDocPath !== undefined) {
    const gate1 = await checkGate1ApprovalRecord(options.designDocPath, {
      stateDir: options.stateDir,
    });
    if (!gate1.valid) {
      violations.push({
        rule: "gate1-approval-missing",
        line: 1,
        message: gate1.error ?? "Gate 1 approval check failed",
      });
    } else {
      gate1Approval = {
        approvedAt: gate1.approvedAt!,
        reply: gate1.reply!,
        approvalLine: gate1.approvalLine!,
      };
    }
  }

  return {
    docPath: filePath,
    valid: violations.length === 0,
    violations,
    gate1Approval,
  };
}

// --- Needs Design removals: "Not resolved" must never narrow the issue's own directive ---
// (web-jam-tools#1131). Real shape, from the Gate 2 plan that caused it:
//   ## Needs Design label removals
//   2. web-jam-tools#485 "new skill record-song" — ... Not resolved: "setup things based on
//      previous recordings" is limited to the know-how list the design names (...). Remove the label?

/** One item of the plan's `Needs Design label removals` list. */
export interface NeedsDesignRemoval {
  /** 1-based source line of the item's first line. */
  line: number;
  /** Repo as cited: a bare WebJamApps repo name or an `owner/repo` slug. */
  repo: string;
  number: number;
  /** The text after "Not resolved:", up to "Remove the label?"; `null` when the item has none. */
  notResolved: string | null;
}

const REMOVALS_HEADING = /^(#{1,6})\s+Needs Design label removals?\b/i;
const ANY_HEADING = /^(#{1,6})\s/;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*])\s+/;
const ISSUE_CITATION = /([\w.-]+(?:\/[\w.-]+)?)#(\d+)/;
const NOT_RESOLVED = /\bNot resolved:\s*([\s\S]*?)\s*(?:Remove the label\?|$)/i;

/** A "Not resolved" part that resolves nothing is the only kind that can never narrow anything. */
const NOTHING_VALUES = new Set(["nothing", "none", "n/a"]);

/** A quoted fragment this many words long or longer that appears in a directive line is a quote
 * of that line. Shorter quotes ("the", "setup") are too common to attribute. */
const MIN_QUOTE_WORDS = 3;
/** An unquoted run of this many consecutive words shared with a directive line is a paraphrase
 * that narrows it. Four words keeps ordinary shared phrases from matching while still catching a
 * requirement restated with a qualifier bolted on. */
const MIN_SHARED_RUN_WORDS = 4;

/** Parses the `Needs Design label removals` section's list items. Returns `[]` when the plan has
 * no such section. A list item continues onto following lines until the next item or heading. */
export function parseNeedsDesignRemovals(markdown: string): NeedsDesignRemoval[] {
  const lines = markdown.split(/\r?\n/);
  const items: { line: number; text: string }[] = [];
  let sectionLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const heading = raw.match(ANY_HEADING);
    if (heading) {
      if (REMOVALS_HEADING.test(raw)) sectionLevel = heading[1].length;
      else if (sectionLevel && heading[1].length <= sectionLevel) sectionLevel = 0;
      continue;
    }
    if (!sectionLevel) continue;
    if (LIST_ITEM.test(raw)) {
      items.push({ line: i + 1, text: raw.replace(LIST_ITEM, "") });
    } else if (items.length > 0 && raw.trim() !== "") {
      items[items.length - 1].text += ` ${raw.trim()}`;
    }
  }

  const removals: NeedsDesignRemoval[] = [];
  for (const item of items) {
    const citation = item.text.match(ISSUE_CITATION);
    if (!citation) continue;
    const notResolved = item.text.match(NOT_RESOLVED);
    removals.push({
      line: item.line,
      repo: citation[1],
      number: Number(citation[2]),
      notResolved: notResolved ? notResolved[1].trim() : null,
    });
  }
  return removals;
}

/** Lowercased words with markdown and punctuation stripped, so quoting style never hides a match. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

function containsRun(haystack: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  }
  return false;
}

function sharesRun(a: string[], b: string[], runLength: number): boolean {
  for (let i = 0; i + runLength <= a.length; i++) {
    if (containsRun(b, a.slice(i, i + runLength))) return true;
  }
  return false;
}

/** Returns the directive line of `issueBody` that `notResolved` quotes or narrows, or `null`.
 * Every non-blank body line is a directive line: the issue body is the requirement, so no line of
 * it may be cut down in a "Not resolved" part instead of being designed. */
export function findNarrowedDirective(notResolved: string, issueBody: string): string | null {
  const directives = issueBody.split(/\r?\n/).map((l) => l.trim()).filter((l) => words(l).length);
  const quotes = [...notResolved.matchAll(/["“]([^"”]+)["”]/g)]
    .map((m) => words(m[1]))
    .filter((q) => q.length >= MIN_QUOTE_WORDS);
  const text = words(notResolved);
  for (const directive of directives) {
    const directiveWords = words(directive);
    if (quotes.some((q) => containsRun(directiveWords, q))) return directive;
    if (sharesRun(text, directiveWords, MIN_SHARED_RUN_WORDS)) return directive;
  }
  return null;
}

function isNothing(notResolved: string): boolean {
  return NOTHING_VALUES.has(notResolved.toLowerCase().replace(/[.\s`*_]/g, ""));
}

/** Checks every `Needs Design` removal in the plan: a "Not resolved" part that quotes or narrows a
 * directive line of that issue's own body fails, and a body that cannot be read fails closed. */
export async function checkNeedsDesignRemovals(
  markdown: string,
  fetchIssueBody: IssueBodyFetcher,
): Promise<PlanTableViolation[]> {
  const violations: PlanTableViolation[] = [];
  for (const removal of parseNeedsDesignRemovals(markdown)) {
    if (removal.notResolved === null || isNothing(removal.notResolved)) continue;
    const cited = `${removal.repo}#${removal.number}`;
    let body: string;
    try {
      body = await fetchIssueBody(removal.repo, removal.number);
    } catch (err) {
      violations.push({
        rule: "needs-design-issue-unreadable",
        line: removal.line,
        message: `Could not read ${cited}'s body to check its "Not resolved" part (` +
          `${err instanceof Error ? err.message : String(err)}) -- refusing rather than passing`,
      });
      continue;
    }
    const directive = findNarrowedDirective(removal.notResolved, body);
    if (directive) {
      violations.push({
        rule: "needs-design-directive-narrowed",
        line: removal.line,
        message: `${cited}'s "Not resolved" part quotes or narrows its own directive line ` +
          `"${directive}" -- design that directive before Gate 1, or put the narrowing to Josh ` +
          `by name, instead of parking it at Gate 2`,
      });
    }
  }
  return violations;
}

/** Default `IssueBodyFetcher`: a read-only `gh issue view`. Throws on any non-zero exit. */
export async function ghIssueBody(repo: string, number: number): Promise<string> {
  const slug = repo.includes("/") ? repo : `WebJamApps/${repo}`;
  const { code, stdout, stderr } = await new Deno.Command("gh", {
    args: ["issue", "view", String(number), "--repo", slug, "--json", "body", "-q", ".body"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(new TextDecoder().decode(stderr).trim() || `gh exited ${code}`);
  }
  return new TextDecoder().decode(stdout);
}

export interface LintPlanCliOptions {
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
  schema?: Schema;
  fetchIssueBody?: IssueBodyFetcher;
  activeRepos?: string[];
  stateDir?: string;
  designDoc?: string;
}

/**
 * CLI runner for `deno task design:lint-plan <plan.md> --design-doc <doc.md>`.
 */
export async function runLintPlanCli(
  args: string[],
  options?: LintPlanCliOptions,
): Promise<number> {
  const log = options?.log ?? console.log;
  const errorLog = options?.errorLog ?? console.error;

  const flags = parseArgs(args, {
    boolean: ["help", "json"],
    string: ["doc", "design-doc", "design_doc", "state-dir", "state_dir"],
    alias: {
      h: "help",
      j: "json",
    },
    default: {
      help: false,
      json: false,
    },
  });

  if (flags.help) {
    log(`Usage: deno task design:lint-plan <plan.md> --design-doc <doc.md> [options]

Validates the Gate 2 plan table's cell values in a design document:
  - verifies Gate 1 approval record on disk for --design-doc <doc.md>
  - missing values (empty, whitespace-only, "-"/"—"/"N/A")
  - unknown model tiers (against skills/fix-labels/labels.yaml)
  - unknown repos (against ACTIVE_REPOS in src/flash-issues/types.ts)
  - personal-name title prefixes ("Josh:", "Josh -", ...)
  - out-of-range priorities (Urgent/High/Medium/Low only)
  - a Josh-labeled manual row with no paired agent row
  - a composite Josh-labeled manual row (doc review + live walkthrough)
  - a cross-repo child not cited as repo#number "title"
  - a Tests cell with no statement of what proves the issue
  - a "Needs Design label removals" item whose "Not resolved" part quotes or
    narrows a directive line of that issue's own body (read with gh; a body
    that cannot be read fails the check)

Report-only. Writes nothing; its only GitHub call is a read-only gh issue view.

Arguments:
  <plan.md>               Path to markdown file containing the plan table

Options:
  --design-doc <path>     Canonical design document path to verify Gate 1 approval
  --doc <path>            Explicit plan document path
  -j, --json              Output result as JSON
  -h, --help              Show this help message
`);
    return 0;
  }

  const docPath = flags.doc || (flags._.length > 0 ? String(flags._[0]) : "");
  if (!docPath) {
    errorLog("Error: Missing required plan document path.");
    errorLog("Usage: deno task design:lint-plan <plan.md> --design-doc <doc.md>");
    return 1;
  }

  const designDocRaw = flags["design-doc"] ??
    flags.design_doc ??
    options?.designDoc;
  const designDocPath = typeof designDocRaw === "string" ? designDocRaw.trim() : "";

  if (!designDocPath) {
    errorLog("Error: Missing required --design-doc argument.");
    errorLog("Usage: deno task design:lint-plan <plan.md> --design-doc <doc.md>");
    return 1;
  }

  const stateDirRaw = flags["state-dir"] ??
    flags.state_dir ??
    options?.stateDir;
  const stateDir = typeof stateDirRaw === "string" ? stateDirRaw.trim() : options?.stateDir;

  try {
    const result = await lintPlanTableFile(docPath, {
      schema: options?.schema,
      fetchIssueBody: options?.fetchIssueBody,
      activeRepos: options?.activeRepos,
      designDocPath,
      stateDir,
    });

    if (flags.json) {
      log(JSON.stringify(result, null, 2));
    } else if (result.valid) {
      if (result.gate1Approval) {
        log(result.gate1Approval.approvalLine);
      }
      log(`[design:lint-plan] PASS: ${result.docPath}'s plan table has no violations.`);
    } else {
      errorLog(
        `[design:lint-plan] FAIL: ${result.docPath} has ${result.violations.length} violation(s):`,
      );
      for (const v of result.violations) {
        const column = v.column ? ` [${v.column}]` : "";
        errorLog(`  - line ${v.line}${column} (${v.rule}): ${v.message}`);
      }
    }

    return result.valid ? 0 : 1;
  } catch (err) {
    errorLog(`[design:lint-plan] Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
