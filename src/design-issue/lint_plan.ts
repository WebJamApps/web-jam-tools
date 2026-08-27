// src/design-issue/lint_plan.ts
// Cell validation for `deno task design:lint-plan` (web-jam-tools#796).
//
// Consumes the Gate 2 plan-table parser (`./plan_table.ts`, web-jam-tools#795) and validates the
// value in each cell: missing values, unknown model tiers, unknown repos, personal-name title
// prefixes, out-of-range priorities, unpaired/composite `Josh` manual rows, uncited cross-repo
// children, and unproven `Tests` cells. Report-only -- writes nothing, makes no GitHub call.
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

import { parseArgs } from "@std/cli/parse-args";
import {
  computeModelLabels,
  DEFAULT_SCHEMA_PATH,
  loadSchema,
  type Schema,
} from "../fix-labels/diff.ts";
import { ACTIVE_REPOS } from "../flash-issues/types.ts";
import {
  type MalformedPlanTableRow,
  type ParsedPlanTable,
  parsePlanTableFromFile,
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

export interface LintPlanResult {
  docPath: string;
  valid: boolean;
  violations: PlanTableViolation[];
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
}

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

/** Reads a design document from disk, parses its Gate 2 plan table, and validates every cell. */
export async function lintPlanTableFile(
  filePath: string,
  options?: LintPlanOptions,
): Promise<LintPlanResult> {
  const parsed = await parsePlanTableFromFile(filePath);
  if (parsed === null) {
    throw new Error(`No Gate 2 plan table found in ${filePath}`);
  }

  const schema = options?.schema ?? await loadCanonicalSchema();
  const violations = validatePlanTable(parsed, { schema, activeRepos: options?.activeRepos });

  return {
    docPath: filePath,
    valid: violations.length === 0,
    violations,
  };
}

/**
 * CLI runner for `deno task design:lint-plan <plan.md>`.
 */
export async function runLintPlanCli(args: string[]): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["help", "json"],
    string: ["doc"],
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
    console.log(`Usage: deno task design:lint-plan <plan.md> [options]

Validates the Gate 2 plan table's cell values in a design document:
  - missing values (empty, whitespace-only, "-"/"—"/"N/A")
  - unknown model tiers (against skills/fix-labels/labels.yaml)
  - unknown repos (against ACTIVE_REPOS in src/flash-issues/types.ts)
  - personal-name title prefixes ("Josh:", "Josh -", ...)
  - out-of-range priorities (Urgent/High/Medium/Low only)
  - a Josh-labeled manual row with no paired agent row
  - a composite Josh-labeled manual row (doc review + live walkthrough)
  - a cross-repo child not cited as repo#number "title"
  - a Tests cell with no statement of what proves the issue

Report-only. Writes nothing, makes no GitHub call.

Arguments:
  <plan.md>       Path to design document markdown file containing the plan table

Options:
  --doc <path>    Explicit design document path
  -j, --json      Output result as JSON
  -h, --help      Show this help message
`);
    return 0;
  }

  const docPath = flags.doc || (flags._.length > 0 ? String(flags._[0]) : "");
  if (!docPath) {
    console.error("Error: Missing required plan document path.");
    console.error("Usage: deno task design:lint-plan <plan.md>");
    return 1;
  }

  try {
    const result = await lintPlanTableFile(docPath);

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.valid) {
      console.log(`[design:lint-plan] PASS: ${result.docPath}'s plan table has no violations.`);
    } else {
      console.error(
        `[design:lint-plan] FAIL: ${result.docPath} has ${result.violations.length} violation(s):`,
      );
      for (const v of result.violations) {
        const column = v.column ? ` [${v.column}]` : "";
        console.error(`  - line ${v.line}${column} (${v.rule}): ${v.message}`);
      }
    }

    return result.valid ? 0 : 1;
  } catch (err) {
    console.error(`[design:lint-plan] Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
