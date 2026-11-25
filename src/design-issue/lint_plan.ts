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
//   - Model tiers: `skills/fix-labels/model-labels.json`, through the shared label rule.
//     Tests may inject a labels.yaml-shaped schema; Josh denotes a manual row.
//   - Repos: `ACTIVE_REPOS` in `../shared/repos.ts` -- read-only, that module is never
//     modified here.

import * as path from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import {
  computeModelLabels,
  DEFAULT_SCHEMA_PATH,
  loadSchema,
  type Schema,
} from "../fix-labels/diff.ts";
import { ACTIVE_REPOS } from "../shared/repos.ts";
import {
  loadModelLabels,
  modelLabelViolation,
  readPlanModelLabels,
} from "../shared/model_label_rule.ts";
import {
  type CommandRunner,
  DUPLICATE_MIN_SHARED_TOKENS,
  fetchOpenIssueTitles,
  findSimilarOpenIssues,
  formatCandidates,
  type OpenIssueSummary,
  runGhCommand,
  tokenizeTitle,
} from "../../hooks/lib/detect_duplicate_issue.ts";
import {
  checkStepAfterMergeCriterion,
  type IssueBodyCheckOptions,
  resolveStepAfterMergeLabelFlags,
} from "../../hooks/lib/check_model_label_on_issue_create.ts";
import { defaultOpenBrowserImpl, expandHome, resolveHtmlPath } from "./gate1.ts";
import {
  renderDesignDocFile,
  type RenderDesignDocOptions,
} from "../../scripts/render_design_doc.ts";
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
  gate1Approvals?: Array<{
    docPath: string;
    approvedAt: string;
    reply: string;
    approvalLine: string;
  }>;
}

export interface LintPlanOptions {
  /** Test model-tier vocabulary source. `lintPlanTableFile` defaults to the generated
   * model-label sidecar when omitted; `validatePlanTable` treats an omitted vocabulary as an
   * explicit opt-out that skips tier validation entirely. A schema that IS provided but yields
   * an empty vocabulary is treated as a degraded `labels.yaml` and throws (see
   * `resolveTierVocabulary`), rather than silently passing every tier. */
  schema?: Schema;
  /** Explicit vocabulary for tests; production reads the generated model-label sidecar. */
  modelLabels?: ReadonlySet<string>;
  /** Canonical active-repo vocabulary. Defaults to `ACTIVE_REPOS`. */
  activeRepos?: readonly string[];
  /** Reads an issue's body for the `Needs Design` removal check. Defaults to a read-only
   * `gh issue view`; tests inject a stub. Throws when the body cannot be read. */
  fetchIssueBody?: IssueBodyFetcher;
  /** Read-only gh runner for the shared open-issue title listing; tests inject a stub. */
  runGh?: CommandRunner;
  /** Canonical design document path to check Gate 1 approval against. */
  designDocPath?: string;
  /** One or more canonical design document paths passed via `--design-doc`. */
  designDocPaths?: readonly string[];
  /** In-memory design document markdown for checking Closes when headings without disk reads. */
  designDocMarkdown?: string;
  /** Explicit design document headings set for checking Closes when headings. */
  designHeadings?: ReadonlySet<string>;
  /** Headings per resolved design document path for multi-design plan validation. */
  designHeadingsByDoc?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Full plan markdown content, used to validate `## Steps after the merge`. */
  markdown?: string;
  /** Gate 1 state directory override (for testing). */
  stateDir?: string;
}

/** Returns the body of `repo#number`, or throws when it cannot be read. `repo` is either a bare
 * WebJamApps repo name or an `owner/repo` slug, exactly as cited in the plan. */
export type IssueBodyFetcher = (repo: string, number: number) => Promise<string>;

// Column indices resolved from PLAN_TABLE_HEADER (never hardcoded against reordering).
const COL_NUM = PLAN_TABLE_HEADER.indexOf("#");
const COL_TITLE = PLAN_TABLE_HEADER.indexOf("Proposed title");
const COL_EPIC = PLAN_TABLE_HEADER.indexOf("Epic / child of");
const COL_TIER = PLAN_TABLE_HEADER.indexOf("Model tier");
const COL_PRIORITY = PLAN_TABLE_HEADER.indexOf("Priority");
const COL_REPO = PLAN_TABLE_HEADER.indexOf("Repo");
const COL_DESIGN = PLAN_TABLE_HEADER.indexOf("Design");
const COL_TESTS = PLAN_TABLE_HEADER.indexOf("Tests");
const COL_CLOSES = PLAN_TABLE_HEADER.indexOf("Closes when");

/** The native GitHub Priority field's four levels (`PRIORITY_MAP` in `src/create-issue/lib.ts`).
 * Not read from a config file at runtime -- there is none -- but pinned to the same four literal
 * values used everywhere else a Priority is set. */
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

const RETIRING_TITLE_VERB =
  /(?<![a-zA-Z-])(?:retire[sd]?|retiring|remove[sd]?|removing|delete[sd]?|deleting|drop(?:s|ped|ping)?)(?![\w-])/i;

const CLAUSE_REMOVAL_VERB =
  /(?<![a-zA-Z-])(?:retire[sd]?|retiring|remove[sd]?|removing|delete[sd]?|deleting|drop(?:s|ped|ping)?|uninstall(?:s|ed|ing)?|unset(?:s|ting)?|prune[sd]?|pruning|strip(?:s|ped|ping)?|revoke[sd]?|revoking|gone)(?![\w-])/i;

const NOTHING_ELSE_TO_REMOVE = /\bnothing\s+else\s+to\s+remove\b/i;

const UPPER_SNAKE_KEY = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

const IGNORED_BACKTICK_TOKENS = new Set([
  "deno",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "node",
  "git",
  "gh",
  "bash",
  "sh",
  "zsh",
  "curl",
  "docker",
  "heroku",
  "atlas",
  "gcloud",
  "make",
  "pytest",
  "vitest",
  "jest",
  "eslint",
  "prettier",
  "tsc",
  "rledger",
  "semgrep",
  "trivy",
  "gitleaks",
  "shellcheck",
  "package.json",
  "deno.json",
  "package-lock.json",
  "deno.lock",
  "test",
  "tests",
  "unit",
  "pass",
  "passes",
  "passed",
  "fail",
  "fails",
  "failed",
  "remove",
  "removes",
  "removed",
  "removing",
  "retire",
  "retires",
  "retired",
  "retiring",
  "delete",
  "deletes",
  "deleted",
  "deleting",
  "drop",
  "drops",
  "dropped",
  "dropping",
  "gone",
  "absent",
  "none",
  "nothing",
  "n/a",
  "true",
  "false",
  "null",
  "undefined",
  "dev",
  "main",
  "settings",
  "setting",
  "keys",
  "key",
  "index",
  "indexes",
  "packages",
  "package",
  "callers",
  "caller",
  "collection",
  "collections",
  "hook",
  "hooks",
  "script",
  "scripts",
  "page",
  "pages",
  "cron",
  "crons",
]);

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

function normalizeRepoCell(cell: string): string {
  return stripMdMarkers(cell).replace(/^WebJamApps\//i, "").trim();
}

/** Determines if a child row cites or belongs to a potential parent/epic row. */
function isChildOfRow(
  child: PlanTableRow,
  parent: PlanTableRow,
  allRows: PlanTableRow[],
): boolean {
  if (child === parent) return false;
  const childEpicCell = stripMdMarkers(child.cells[COL_EPIC]).trim();
  if (
    isMissingValue(childEpicCell) ||
    childEpicCell.toLowerCase() === "none" ||
    childEpicCell.toLowerCase() === "epic"
  ) {
    return false;
  }

  const parentNum = stripMdMarkers(parent.cells[COL_NUM]).trim();
  const parentPos = String(allRows.indexOf(parent) + 1);
  const targetNums = new Set([parentNum, parentPos].filter(Boolean));

  const numMatch = childEpicCell.match(/^(?:row|epic)\s*#?\s*(\d+)\b/i) ??
    childEpicCell.match(/^#?(\d+)$/);
  if (numMatch && targetNums.has(numMatch[1])) {
    return true;
  }

  const parentTitle = stripMdMarkers(parent.cells[COL_TITLE]).trim().toLowerCase();
  if (parentTitle && childEpicCell.toLowerCase() === parentTitle) {
    return true;
  }

  // An external issue number is not a plan position. Match a qualified citation
  // by its repository and quoted title instead of comparing its number to COL_NUM.
  const citation = childEpicCell.match(
    /^(?:epic\s+)?((?:[a-z0-9_.-]+\/)?[a-z0-9_.-]+)#\d+\s+"([^"]+)"$/i,
  );
  if (citation) {
    return normalizeRepoCell(citation[1]).toLowerCase() ===
        normalizeRepoCell(parent.cells[COL_REPO]).toLowerCase() &&
      citation[2].trim().toLowerCase() === parentTitle;
  }

  return false;
}

/** Determines if a row represents an Epic row: its own `Epic / child of` cell says `Epic`, or
 * another row names it as its parent. A word in the title or any other cell never makes a row an
 * epic ("Epics, repositories and sub-issues", web-jam-tools#1455). */
function isEpicRow(row: PlanTableRow, allRows: PlanTableRow[]): boolean {
  const epicCell = stripMdMarkers(row.cells[COL_EPIC]).trim().toLowerCase();
  if (epicCell === "epic") return true;

  if (allRows.some((other) => isChildOfRow(other, row, allRows))) {
    return true;
  }

  return false;
}

function checkEpicBelonging(
  rows: PlanTableRow[],
  violations: PlanTableViolation[],
): void {
  for (const row of rows) {
    if (isEpicRow(row, rows)) continue;
    const raw = row.cells[COL_EPIC];
    const stripped = stripMdMarkers(raw).trim();
    const lower = stripped.toLowerCase();
    if (
      isMissingValue(stripped) ||
      lower === "none" ||
      lower === "standalone issue"
    ) {
      violations.push({
        rule: "row-missing-epic",
        line: row.line,
        column: "Epic / child of",
        message:
          `The plan needs an epic for this row: the row names no epic ("${raw}") -- every non-epic plan row must name its epic`,
      });
    }
  }
}

function checkCrossRepoEpic(
  rows: PlanTableRow[],
  violations: PlanTableViolation[],
): void {
  for (const row of rows) {
    if (!isEpicRow(row, rows)) continue;
    const children = rows.filter((r) => isChildOfRow(r, row, rows));
    const epicRepo = normalizeRepoCell(row.cells[COL_REPO]);
    const childRepos = new Set(
      children.map((c) => normalizeRepoCell(c.cells[COL_REPO])).filter(Boolean),
    );
    // A child in a repository other than the epic's own makes the work cross-repository, so the
    // epic's repository counts with its children's.
    const spanned = new Set([
      ...childRepos,
      ...(children.length > 0 && epicRepo ? [epicRepo] : []),
    ]);
    if (spanned.size > 1) {
      if (epicRepo !== "web-jam-tools") {
        violations.push({
          rule: "cross-repo-epic-not-in-web-jam-tools",
          line: row.line,
          column: "Repo",
          message:
            `Cross-repository work lives in web-jam-tools: this epic row and its children span more than one repository (${
              Array.from(spanned).join(", ")
            }), so its Repo must be "web-jam-tools" (found "${epicRepo}")`,
        });
      }
    }
  }
}

/** Validates every well-formed row of a parsed Gate 2 plan table. Parser-level malformed rows
 * (cell count didn't match the header -- `web-jam-tools#795`) are passed through as their own
 * violation rather than silently dropped. */
interface ResolvedDesignDocArg {
  rawPath: string;
  absPath: string;
}

function resolveDesignDocArgs(options: LintPlanOptions): ResolvedDesignDocArg[] {
  const rawList: string[] = [];
  if (options.designDocPaths) {
    for (const p of options.designDocPaths) {
      if (p.trim() !== "") rawList.push(p.trim());
    }
  }
  if (options.designDocPath && options.designDocPath.trim() !== "") {
    rawList.push(options.designDocPath.trim());
  }
  const seen = new Set<string>();
  const resolved: ResolvedDesignDocArg[] = [];
  for (const rawPath of rawList) {
    const absPath = path.resolve(expandHome(rawPath));
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    resolved.push({ rawPath, absPath });
  }
  return resolved;
}

function stripDesignCellMarkers(cell: string): string {
  return cell.trim().replace(/[`*]/g, "").replace(/^_+/, "").replace(/_+$/, "").trim();
}

function splitDesignCellEntries(raw: string): string[] {
  const cleaned = stripDesignCellMarkers(raw);
  const delimited = cleaned
    .split(/[,;\n]+|\s+(?:\/|&|and)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (delimited.length > 1) return delimited;
  const mdTokens = cleaned.match(/[^\s,;]+\.md\b/gi);
  if (mdTokens && mdTokens.length > 1) return mdTokens;
  return cleaned ? [cleaned] : [];
}

function normalizeForDesignMatch(raw: string): string {
  const expanded = raw.startsWith("$HOME/")
    ? expandHome(`~/${raw.slice("$HOME/".length)}`)
    : expandHome(raw);
  return expanded.replace(/\\/g, "/");
}

function matchDesignCellToArgs(
  cellValue: string,
  docs: readonly ResolvedDesignDocArg[],
): ResolvedDesignDocArg[] {
  const normalizedCell = normalizeForDesignMatch(cellValue).replace(/^\.\//, "");
  const isHomeOrAbs = cellValue.startsWith("/") || cellValue.startsWith("~/") ||
    cellValue.startsWith("$HOME/");
  const resolvedCell = path.resolve(expandHome(
    cellValue.startsWith("$HOME/") ? `~/${cellValue.slice("$HOME/".length)}` : cellValue,
  ));

  const exact = docs.filter((d) =>
    (isHomeOrAbs && d.absPath === resolvedCell) || d.rawPath === cellValue
  );
  if (exact.length > 0) return exact;

  if (normalizedCell.includes("/")) {
    return docs.filter((d) => {
      const absSlash = d.absPath.replace(/\\/g, "/");
      const rawSlash = d.rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
      return absSlash.endsWith(`/${normalizedCell}`) || rawSlash === normalizedCell;
    });
  }

  return docs.filter((d) => path.basename(d.absPath) === normalizedCell);
}

function checkRowDesignCell(
  row: PlanTableRow,
  allRows: PlanTableRow[],
  docs: readonly ResolvedDesignDocArg[],
  usedDocs: Set<string>,
  violations: PlanTableViolation[],
): ResolvedDesignDocArg | undefined {
  const raw = row.cells[COL_DESIGN];
  const rowNum = stripMdMarkers(row.cells[COL_NUM]).trim() || String(allRows.indexOf(row) + 1);
  if (isMissingValue(stripDesignCellMarkers(raw))) {
    violations.push({
      rule: "cell-missing",
      line: row.line,
      column: "Design",
      message: `Row ${rowNum}: Design cell is missing ("${raw}")`,
    });
    return undefined;
  }

  const entries = splitDesignCellEntries(raw);
  if (entries.length > 1) {
    violations.push({
      rule: "design-multiple",
      line: row.line,
      column: "Design",
      message: `Row ${rowNum}: Design cell "${
        stripDesignCellMarkers(raw)
      }" lists multiple designs — one design per row only`,
    });
    return undefined;
  }

  const entry = entries[0];
  if (docs.length === 0) return undefined;

  const matches = matchDesignCellToArgs(entry, docs);
  if (matches.length === 0) {
    violations.push({
      rule: "design-not-provided",
      line: row.line,
      column: "Design",
      message: `Row ${rowNum}: Design cell "${entry}" was not passed with --design-doc`,
    });
    return undefined;
  }
  if (matches.length > 1) {
    violations.push({
      rule: "design-ambiguous",
      line: row.line,
      column: "Design",
      message: `Row ${rowNum}: Design cell "${entry}" matches multiple --design-doc paths: ${
        matches.map((m) => m.rawPath).join(", ")
      }`,
    });
    return undefined;
  }

  usedDocs.add(matches[0].absPath);
  return matches[0];
}

export function validatePlanTable(
  parsed: ParsedPlanTable,
  options: LintPlanOptions,
): PlanTableViolation[] {
  const violations: PlanTableViolation[] = [];
  const { rows, malformedRows } = parsed;

  for (const bad of malformedRows) {
    violations.push(malformedRowViolation(bad));
  }

  const canonicalTiers = options.modelLabels
    ? [...options.modelLabels]
    : resolveTierVocabulary(options.schema);
  const activeRepos = options.activeRepos ?? ACTIVE_REPOS;
  const resolvedDesignDocs = resolveDesignDocArgs(options);
  const usedDesignDocs = new Set<string>();
  const designHeadings = options.designHeadings ??
    (options.designDocMarkdown !== undefined
      ? extractDesignHeadings(options.designDocMarkdown)
      : undefined);

  for (const row of rows) {
    checkMissingAndTier(row, canonicalTiers, violations);
    checkPriority(row, violations);
    checkRepo(row, activeRepos, violations);
    const matchedDoc = checkRowDesignCell(
      row,
      rows,
      resolvedDesignDocs,
      usedDesignDocs,
      violations,
    );
    checkTests(row, violations);
    checkTitlePersonalName(row, violations);
    checkRetiringCodeRow(row, rows, violations);
    const rowHeadings = matchedDoc && options.designHeadingsByDoc
      ? options.designHeadingsByDoc.get(matchedDoc.absPath)
      : resolvedDesignDocs.length > 0 && !matchedDoc
      ? undefined
      : designHeadings;
    checkClosesWhen(row, rows, rowHeadings, violations, matchedDoc?.rawPath);
  }

  for (const doc of resolvedDesignDocs) {
    if (!usedDesignDocs.has(doc.absPath)) {
      violations.push({
        rule: "unused-design-doc",
        line: 1,
        column: "Design",
        message: `--design-doc "${doc.rawPath}" is not named in any row's Design cell`,
      });
    }
  }

  checkJoshPairingAndComposite(rows, violations);
  checkEpicBelonging(rows, violations);
  checkCrossRepoEpic(rows, violations);
  if (options.markdown !== undefined) {
    violations.push(...checkStepsAfterMerge(options.markdown, rows, canonicalTiers));
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
  if (canonicalTiers.length === 0) return;
  try {
    const vocabulary = new Set(canonicalTiers.filter((name) => name !== "Josh"));
    const labels = readPlanModelLabels(raw, vocabulary);
    const violation = modelLabelViolation(labels, vocabulary, undefined, false);
    if (violation) throw new Error(violation);
  } catch (error) {
    violations.push({
      rule: "tier-unknown",
      line: row.line,
      column: "Model tier",
      message: `Model tier "${stripMdMarkers(raw)}": ${
        error instanceof Error ? error.message : error
      }`,
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

function isNamedCleanupToken(rawToken: string): boolean {
  const token = rawToken.trim();
  if (!token || /\s/.test(token)) return false;
  if (token.startsWith("-")) return false;
  if (IGNORED_BACKTICK_TOKENS.has(token.toLowerCase())) return false;
  return /[a-zA-Z]/.test(token) && /^[a-zA-Z0-9_@./:+-]+$/.test(token);
}

function clauseNamesRemovedItem(clause: string): boolean {
  // Strip backticked spans, double-quoted heading names (e.g. `"Retiring code"`), and
  // `package.json`/`deno.json` references so both the removal word and any plain UPPER_SNAKE
  // key must appear in the clause prose itself rather than inside quotes or commands.
  const plain = clause
    .replace(/`[^`]*`/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/\b(?:package|deno)\.json\b/gi, " ")
    .replace(/\*/g, "");

  if (!CLAUSE_REMOVAL_VERB.test(plain)) return false;
  if (UPPER_SNAKE_KEY.test(plain)) return true;

  for (const match of clause.matchAll(/`([^`]+)`/g)) {
    if (isNamedCleanupToken(match[1])) return true;
  }
  return false;
}

function hasNamedRetiringCleanup(rawCells: readonly string[]): boolean {
  for (const cell of rawCells) {
    const trimmed = cell.trim();
    if (!trimmed) continue;

    // Allow `"nothing else to remove"` even when wrapped in backticks or emphasis markers.
    if (NOTHING_ELSE_TO_REMOVE.test(stripMdMarkers(trimmed))) return true;

    // Split each cell independently on `;`, newlines, or sentence ends so a named token
    // (e.g. a test file or task) passes only when the same clause says it is removed.
    for (const clause of trimmed.split(/(?:;|\n|\.(?=\s|$)|[!?]+(?=\s|$))+/)) {
      if (clauseNamesRemovedItem(clause)) return true;
    }
  }
  return false;
}

/**
 * Checks whether a retiring plan row (whose title says retire, remove, delete, or drop) names the
 * settings, keys, packages, jobs, callers, or indexes it removes, or explicitly reads
 * "nothing else to remove" (`"Retiring code"`, web-jam-tools#1526).
 */
export function checkRetiringCodeRow(
  row: PlanTableRow,
  allRows: readonly PlanTableRow[],
  violations: PlanTableViolation[],
): void {
  if (isEpicRow(row, allRows as PlanTableRow[])) return;

  const title = stripMdMarkers(row.cells[COL_TITLE]);
  if (!RETIRING_TITLE_VERB.test(title)) return;

  const rawScopeCells = [row.cells[COL_TESTS], row.cells[COL_CLOSES]]
    .filter((c) => !isMissingValue(c));
  if (hasNamedRetiringCleanup(rawScopeCells)) return;

  const rowNum = stripMdMarkers(row.cells[COL_NUM]).trim() || String(allRows.indexOf(row) + 1);
  violations.push({
    rule: "retiring-row-missing-cleanup",
    line: row.line,
    column: "Closes when",
    message:
      `Row ${rowNum} ("${title}") retires code without naming the settings, keys, packages, or ` +
      `cleanup it removes (or reading "nothing else to remove")`,
  });
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

/**
 * Extracts headings from Markdown text (ignoring fenced code blocks).
 * Headings match as written, ignoring case and leading '#' marks.
 */
export function extractDesignHeadings(markdown: string): Set<string> {
  const headings = new Set<string>();
  let inFence = false;
  let fenceMarker = "";
  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;
    const match = rawLine.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    if (match) {
      const text = match[1].replace(/\s+#+\s*$/, "").trim().toLowerCase();
      if (text.length > 0) {
        headings.add(text);
      }
    }
  }
  return headings;
}

export interface CriterionHeadingCheckResult {
  valid: boolean;
  reason?:
    | "unknown-heading"
    | "neither-heading-nor-command"
    | "step-after-merge-missing-command"
    | "step-after-merge-missing-josh"
    | "outcome-wording";
  unknownHeading?: string;
  outcomeWord?: string;
}

export interface CriterionCheckOptions extends IssueBodyCheckOptions {
  /** Defaults to true. Set to false when designHeadings was not provided to validatePlanTable. */
  checkHeadingAndCommand?: boolean;
  /** Defaults to false. Set to true when checking issue bodies against a design document (create-issue & design:file-plan). */
  checkOutcomeWording?: boolean;
}

const OUTCOME_WORDING_REGEX =
  /\b(?:outcome|refuse|proceed|fails\s+closed|fails\s+open|cannot\s+tell|cannot\s+be\s+read|unable\s+to\s+determine)[a-z]*/i;

/**
 * Strips double-quoted spans and backtick spans from a criterion line and returns the first
 * outcome-wording match in what remains, or null when clean or exempt (web-jam-tools#1775).
 */
export function findOutcomeWordingViolation(
  text: string,
  options?: IssueBodyCheckOptions,
): string | null {
  const { hasModelLabel } = resolveStepAfterMergeLabelFlags(options);
  if (!hasModelLabel) return null;
  const stripped = text.replace(/`([^`\n]*)`|"([^"\n]*)"/g, " ");
  const match = stripped.match(OUTCOME_WORDING_REGEX);
  return match ? match[0] : null;
}

/**
 * Validates a Closes when cell or an issue body acceptance criterion against design headings,
 * the step-after-merge rule (web-jam-tools#1724), and outcome wording when enabled
 * (web-jam-tools#1775).
 * Each criterion/cell must name a design heading in double quotes or carry a backtick-quoted command.
 * Any double-quoted heading must exist in designHeadings (matched case-insensitively).
 * Any criterion describing a step after the merge must carry the command that starts it, and
 * its row/issue must also carry the `Josh` label alongside a model label.
 */
export function checkCriterionOrClosesCell(
  text: string,
  designHeadings: ReadonlySet<string>,
  options?: CriterionCheckOptions,
): CriterionHeadingCheckResult {
  const checkHeadingAndCommand = options?.checkHeadingAndCommand !== false;
  const quotedHeadings: string[] = [];
  let hasCommand = false;

  const tokenRegex = /`([^`\n]+)`|"([^"\n]*)"/g;
  for (const match of text.matchAll(tokenRegex)) {
    if (match[1] !== undefined) {
      if (match[1].trim().length > 0) {
        hasCommand = true;
      }
    } else if (match[2] !== undefined) {
      quotedHeadings.push(match[2].trim());
    }
  }

  if (checkHeadingAndCommand) {
    for (const heading of quotedHeadings) {
      if (heading === "" || !designHeadings.has(heading.toLowerCase())) {
        return {
          valid: false,
          reason: "unknown-heading",
          unknownHeading: heading,
        };
      }
    }
  }

  const stepViolation = checkStepAfterMergeCriterion(text, options);
  if (stepViolation !== null) {
    return {
      valid: false,
      reason: stepViolation,
    };
  }

  if (options?.checkOutcomeWording) {
    const outcomeWord = findOutcomeWordingViolation(text, options);
    if (outcomeWord !== null) {
      return {
        valid: false,
        reason: "outcome-wording",
        outcomeWord,
      };
    }
  }

  if (checkHeadingAndCommand && quotedHeadings.length === 0 && !hasCommand) {
    return {
      valid: false,
      reason: "neither-heading-nor-command",
    };
  }

  return { valid: true };
}

export interface IssueBodyCriteriaOptions extends CriterionCheckOptions {
  /** Defaults to "Refused to file plan". */
  commandPrefix?: string;
  /** Defaults to true (design:file-plan requires ## Acceptance criteria). */
  requireAcceptanceCriteriaSection?: boolean;
  /** Design document path or label cited in error messages when headings do not match. */
  designDocLabel?: string;
}

/**
 * Validates every acceptance criterion in an issue body against design headings,
 * the step-after-merge rule, and outcome wording when enabled (web-jam-tools#1775).
 * Shared by `design:file-plan` and `create-issue`.
 */
export function validateIssueBodyCriteria(
  title: string,
  body: string,
  designHeadings: ReadonlySet<string>,
  options?: IssueBodyCriteriaOptions,
): void {
  const prefix = options?.commandPrefix ?? "Refused to file plan";
  const requireSection = options?.requireAcceptanceCriteriaSection !== false;
  const checkOptions: CriterionCheckOptions = {
    ...options,
    checkOutcomeWording: options?.checkOutcomeWording ?? true,
  };
  const { hasModelLabel, hasJoshLabel } = resolveStepAfterMergeLabelFlags(checkOptions);
  if (!hasModelLabel && hasJoshLabel) {
    return;
  }
  const lines = body.split(/\r?\n/);
  let inCriteria = false;
  let foundCriteriaSection = false;
  let criteriaLevel = 2;
  const sectionCriteria: { text: string; lineNum: number }[] = [];
  const checkboxCriteria: { text: string; lineNum: number }[] = [];
  let currentCriterion: { text: string; lineNum: number } | null = null;
  let currentCheckbox: { text: string; lineNum: number } | null = null;

  const flushSection = () => {
    if (currentCriterion !== null) {
      const trimmedText = currentCriterion.text.trim();
      if (trimmedText.length > 0) {
        sectionCriteria.push({ text: trimmedText, lineNum: currentCriterion.lineNum });
      }
      currentCriterion = null;
    }
  };

  const flushCheckbox = () => {
    if (currentCheckbox !== null) {
      const trimmedText = currentCheckbox.text.trim();
      if (trimmedText.length > 0) {
        checkboxCriteria.push({ text: trimmedText, lineNum: currentCheckbox.lineNum });
      }
      currentCheckbox = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!inCriteria) {
      const criteriaHeaderMatch = trimmed.match(/^(#{1,6})\s+Acceptance\s+criteria\b/i);
      if (criteriaHeaderMatch) {
        flushCheckbox();
        inCriteria = true;
        foundCriteriaSection = true;
        criteriaLevel = criteriaHeaderMatch[1].length;
        continue;
      }
      if (!requireSection && !foundCriteriaSection) {
        if (trimmed === "" || trimmed.startsWith("<!--") || trimmed.startsWith("🤖 Authored by ")) {
          flushCheckbox();
          continue;
        }
        if (/^(#{1,6})\s+/.test(trimmed)) {
          flushCheckbox();
          continue;
        }
        const isCheckbox = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/.test(rawLine);
        const isListItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(rawLine);
        if (isCheckbox) {
          flushCheckbox();
          currentCheckbox = { text: trimmed, lineNum: i + 1 };
        } else if (currentCheckbox !== null && !isListItem) {
          currentCheckbox.text += " " + trimmed;
        } else {
          flushCheckbox();
        }
      }
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      if (level <= criteriaLevel) {
        flushSection();
        inCriteria = false;
        continue;
      } else {
        // Nested subsection within Acceptance criteria (e.g. ### Behavior)
        flushSection();
        continue;
      }
    }

    if (trimmed === "" || trimmed.startsWith("<!--") || trimmed.startsWith("🤖 Authored by ")) {
      flushSection();
      continue;
    }

    const isListItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(rawLine);
    if (isListItem) {
      flushSection();
      currentCriterion = { text: trimmed, lineNum: i + 1 };
    } else if (currentCriterion !== null) {
      currentCriterion.text += " " + trimmed;
    } else {
      currentCriterion = { text: trimmed, lineNum: i + 1 };
    }
  }

  flushSection();
  flushCheckbox();

  if (requireSection && (!foundCriteriaSection || sectionCriteria.length === 0)) {
    throw new Error(
      `${prefix} — issue "${title}" body has no "## Acceptance criteria" section.`,
    );
  }

  const criteria = foundCriteriaSection ? sectionCriteria : checkboxCriteria;
  for (const { text, lineNum } of criteria) {
    const check = checkCriterionOrClosesCell(text, designHeadings, checkOptions);
    if (!check.valid) {
      if (check.reason === "unknown-heading") {
        const docPhrase = options?.designDocLabel
          ? `design document "${options.designDocLabel}"`
          : "the design document";
        throw new Error(
          `${prefix} — issue "${title}" criterion line ${lineNum} ("${text}"): names heading "${check.unknownHeading}", which does not exist in ${docPhrase}.`,
        );
      } else if (check.reason === "step-after-merge-missing-command") {
        throw new Error(
          `${prefix} — issue "${title}" criterion line ${lineNum} ("${text}"): describes a step after the merge, but the command that starts the step is missing.`,
        );
      } else if (check.reason === "step-after-merge-missing-josh") {
        throw new Error(
          `${prefix} — issue "${title}" criterion line ${lineNum} ("${text}"): describes a step after the merge, but the issue is missing the "Josh" label.`,
        );
      } else if (check.reason === "outcome-wording") {
        throw new Error(
          `${prefix} — issue "${title}" criterion line ${lineNum} ("${text}"): contains outcome wording ("${check.outcomeWord}"); point to a design heading in quotation marks or a backtick-quoted command instead.`,
        );
      } else {
        throw new Error(
          `${prefix} — issue "${title}" criterion line ${lineNum} ("${text}"): neither a heading nor a command.`,
        );
      }
    }
  }
}

function checkClosesWhen(
  row: PlanTableRow,
  allRows: PlanTableRow[],
  designHeadings: ReadonlySet<string> | undefined,
  violations: PlanTableViolation[],
  designDocLabel?: string,
): void {
  // Case 5: an epic closes when its children close
  if (isEpicRow(row, allRows)) return;
  // Case 6: a manual step (Josh alone)
  const tier = stripMdMarkers(row.cells[COL_TIER]).trim();
  const tierParts = tier.split("/").map((p) => p.trim()).filter(Boolean);
  if (tierParts.length > 0 && tierParts.every((p) => p.toLowerCase() === "josh")) return;

  const raw = row.cells[COL_CLOSES];
  const rowNum = stripMdMarkers(row.cells[COL_NUM]).trim() || String(allRows.indexOf(row) + 1);

  if (isMissingValue(raw)) {
    if (designHeadings !== undefined) {
      violations.push({
        rule: "closes-when-missing",
        line: row.line,
        column: "Closes when",
        message: `Row ${rowNum}: Closes when cell is missing ("${raw}")`,
      });
    }
    return;
  }

  const hasJoshLabel = tierParts.some((p) => p.toLowerCase() === "josh");
  const check = checkCriterionOrClosesCell(raw, designHeadings ?? new Set(), {
    hasModelLabel: true,
    hasJoshLabel,
    checkHeadingAndCommand: designHeadings !== undefined,
  });
  if (!check.valid) {
    if (check.reason === "unknown-heading") {
      const targetDoc = designDocLabel ?? "the design document";
      violations.push({
        rule: "closes-when-unknown-heading",
        line: row.line,
        column: "Closes when",
        message:
          `Row ${rowNum}: Closes when cell names heading "${check.unknownHeading}", which ${targetDoc} does not have`,
      });
    } else if (check.reason === "step-after-merge-missing-command") {
      violations.push({
        rule: "closes-when-step-after-merge-missing-command",
        line: row.line,
        column: "Closes when",
        message:
          `Row ${rowNum}: Closes when cell "${raw.trim()}" describes a step after the merge, but the command that starts the step is missing`,
      });
    } else if (check.reason === "step-after-merge-missing-josh") {
      violations.push({
        rule: "closes-when-step-after-merge-missing-josh",
        line: row.line,
        column: "Closes when",
        message:
          `Row ${rowNum}: Closes when cell "${raw.trim()}" describes a step after the merge, but the row is missing the "Josh" label`,
      });
    } else if (check.reason === "neither-heading-nor-command") {
      violations.push({
        rule: "closes-when-neither-heading-nor-command",
        line: row.line,
        column: "Closes when",
        message:
          `Row ${rowNum}: Closes when cell "${raw.trim()}" names neither a heading nor a command`,
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
 * Gate 1 disk record when `options.designDocPath` is provided.
 *
 * Checks each new plan title against open issues and the plan's other new titles. */
export async function lintPlanTableFile(
  filePath: string,
  options?: LintPlanOptions,
): Promise<LintPlanResult> {
  const markdown = await Deno.readTextFile(filePath);
  const parsed = parsePlanTable(markdown);
  if (parsed === null) {
    throw new Error(
      `No Gate 2 plan table found in ${filePath} (expected header: | ${
        PLAN_TABLE_HEADER.join(" | ")
      } |)`,
    );
  }

  const rawDesignDocs: string[] = [];
  if (options?.designDocPaths) {
    for (const p of options.designDocPaths) rawDesignDocs.push(p);
  }
  if (options?.designDocPath !== undefined) {
    rawDesignDocs.push(options.designDocPath);
  }

  const designHeadingsByDoc = new Map<string, ReadonlySet<string>>(
    options?.designHeadingsByDoc ?? [],
  );
  if (rawDesignDocs.length === 1 && rawDesignDocs[0].trim() !== "") {
    const singleAbs = path.resolve(expandHome(rawDesignDocs[0].trim()));
    if (options?.designHeadings !== undefined) {
      designHeadingsByDoc.set(singleAbs, options.designHeadings);
    } else if (options?.designDocMarkdown !== undefined) {
      designHeadingsByDoc.set(singleAbs, extractDesignHeadings(options.designDocMarkdown));
    }
  }

  const seenAbsDocs = new Set<string>();
  const uniqueRawDesignDocs: string[] = [];
  for (const rawDoc of rawDesignDocs) {
    const trimmed = rawDoc.trim();
    if (trimmed === "") {
      uniqueRawDesignDocs.push(rawDoc);
      continue;
    }
    const absDocPath = path.resolve(expandHome(trimmed));
    if (seenAbsDocs.has(absDocPath)) continue;
    seenAbsDocs.add(absDocPath);
    uniqueRawDesignDocs.push(trimmed);
    if (!designHeadingsByDoc.has(absDocPath)) {
      try {
        const designMarkdown = await Deno.readTextFile(absDocPath);
        designHeadingsByDoc.set(absDocPath, extractDesignHeadings(designMarkdown));
      } catch {
        // checkGate1ApprovalRecord will record any unreadable design doc violation
      }
    }
  }

  let designHeadings: ReadonlySet<string> | undefined = options?.designHeadings;
  if (!designHeadings && options?.designDocMarkdown !== undefined) {
    designHeadings = extractDesignHeadings(options.designDocMarkdown);
  }

  const violations = validatePlanTable(parsed, {
    schema: options?.schema,
    modelLabels: options?.modelLabels ?? (options?.schema ? undefined : loadModelLabels()),
    activeRepos: options?.activeRepos,
    designDocPaths: options?.designDocPaths,
    designDocPath: options?.designDocPath,
    designHeadings,
    designHeadingsByDoc,
    markdown,
  });
  violations.push(
    ...await checkNeedsDesignRemovals(markdown, options?.fetchIssueBody ?? ghIssueBody),
    ...await checkDuplicatePlanTitles(
      parsed.rows,
      options?.runGh ?? runGhCommand,
      options?.activeRepos ?? ACTIVE_REPOS,
    ),
  );

  const gate1Approvals: NonNullable<LintPlanResult["gate1Approvals"]> = [];
  for (const rawDoc of uniqueRawDesignDocs) {
    const gate1 = await checkGate1ApprovalRecord(rawDoc, {
      stateDir: options?.stateDir,
    });
    if (!gate1.valid) {
      violations.push({
        rule: "gate1-approval-missing",
        line: 1,
        message: gate1.error ?? "Gate 1 approval check failed",
      });
    } else {
      const approvalLine = uniqueRawDesignDocs.length > 1
        ? `Gate 1 approval recorded ${gate1.approvedAt ?? ""} (${rawDoc}): "${gate1.reply ?? ""}"`
        : gate1.approvalLine!;
      gate1Approvals.push({
        docPath: rawDoc,
        approvedAt: gate1.approvedAt!,
        reply: gate1.reply!,
        approvalLine,
      });
    }
  }
  const gate1Approval: LintPlanResult["gate1Approval"] = gate1Approvals[0]
    ? {
      approvedAt: gate1Approvals[0].approvedAt,
      reply: gate1Approvals[0].reply,
      approvalLine: gate1Approvals[0].approvalLine,
    }
    : undefined;

  return {
    docPath: filePath,
    valid: violations.length === 0,
    violations,
    gate1Approval,
    gate1Approvals: gate1Approvals.length > 0 ? gate1Approvals : undefined,
  };
}

/** Reuse the issue-creation search before Gate 2, including comparisons within the plan. */
async function checkDuplicatePlanTitles(
  rows: PlanTableRow[],
  runner: CommandRunner,
  activeRepos: readonly string[],
): Promise<PlanTableViolation[]> {
  const searchable = rows.map((row) => ({
    row,
    title: row.cells[COL_TITLE].trim(),
    repo: normalizeRepoCell(row.cells[COL_REPO]),
  })).filter(({ title, repo }) =>
    !isMissingValue(title) && activeRepos.includes(repo) &&
    tokenizeTitle(title).length >= DUPLICATE_MIN_SHARED_TOKENS
  );
  const issuesByRepo = new Map<string, OpenIssueSummary[] | null>();
  const violations: PlanTableViolation[] = [];
  for (const { row, repo } of searchable) {
    if (issuesByRepo.has(repo)) continue;
    const issues = await fetchOpenIssueTitles(`WebJamApps/${repo}`, runner);
    issuesByRepo.set(repo, issues);
    if (issues === null) {
      violations.push({
        rule: "duplicate-title-search-failed",
        line: row.line,
        column: "Proposed title",
        message:
          `Duplicate-title search could not run or finish for WebJamApps/${repo}; refusing the plan.`,
      });
    }
  }

  // An exact existing title identifies an already-filed issue, not a new plan title.
  const newRows = searchable.filter(({ title, repo }) => {
    const issues = issuesByRepo.get(repo);
    return issues !== null && issues !== undefined &&
      !issues.some((issue) => issue.title === title);
  });
  for (const { row, title, repo } of newRows) {
    const openMatches = findSimilarOpenIssues(title, issuesByRepo.get(repo)!);
    const planMatches = findSimilarOpenIssues(
      title,
      newRows.filter((other) => other.row !== row).map((other) => ({
        number: other.row.line,
        title: other.title,
      })),
    );
    const matches: string[] = [];
    if (openMatches.length > 0) matches.push(formatCandidates(`WebJamApps/${repo}`, openMatches));
    for (const candidate of planMatches) {
      const other = newRows.find((entry) => entry.row.line === candidate.number)!;
      // Unfiled rows have no GitHub number; never present their positions as issue citations.
      matches.push(`plan row ${other.row.cells[0]} (${other.repo}) "${candidate.title}"`);
    }
    if (matches.length > 0) {
      violations.push({
        rule: "duplicate-title",
        line: row.line,
        column: "Proposed title",
        message: `New title "${title}" resembles ${
          matches.join(", ")
        }. Read each look-alike before revising the plan.`,
      });
    }
  }
  return violations;
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

// --- Steps after the merge (web-jam-tools#1801) ---

const STEPS_AFTER_MERGE_HEADING = /^(#{1,6})\s+Steps after the merge\b\s*(?:#+\s*)?$/i;
const STEP_ROW_LINE = /^\s*[-*]\s+row\s+(\d+)\s*:\s*(.*)$/i;

/** One parsed row entry from a plan file's `## Steps after the merge` section. */
export interface StepAfterMergeEntry {
  /** 1-based line number in the plan markdown file. */
  line: number;
  /** Row number cited in `- row <n>:`. */
  rowNumber: number;
  /** Backtick-quoted command spans listed on that line. */
  commands: string[];
}

/** Parsed result of a plan file's `## Steps after the merge` section. */
export interface ParsedStepsAfterMerge {
  foundSection: boolean;
  sectionLine: number;
  isNone: boolean;
  emptySection: boolean;
  entries: StepAfterMergeEntry[];
  invalidLines: Array<{ line: number; text: string }>;
}

/** Extracts non-empty trimmed backtick spans from a markdown text string. */
export function extractBacktickCommands(text: string): string[] {
  const cmds: string[] = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const cmd = match[1].trim();
    if (cmd.length > 0) cmds.push(cmd);
  }
  return cmds;
}

/** Indexes parsed plan-table rows by their numeric `#` cell when numeric, or 1-based position otherwise. */
export function indexPlanRowsByNumber(rows: readonly PlanTableRow[]): Map<number, PlanTableRow> {
  const map = new Map<number, PlanTableRow>();
  const hasNumeric = rows.some((r) => /^\d+$/.test(stripMdMarkers(r.cells[COL_NUM]).trim()));
  rows.forEach((row, idx) => {
    const rawNum = stripMdMarkers(row.cells[COL_NUM]).trim();
    const num = hasNumeric && /^\d+$/.test(rawNum) ? Number(rawNum) : idx + 1;
    if (!map.has(num)) {
      map.set(num, row);
    }
  });
  return map;
}

/** Parses the required `## Steps after the merge` section from a Gate 2 plan markdown file. */
export function parseStepsAfterMerge(markdown: string): ParsedStepsAfterMerge {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let fenceMarker = "";
  let foundSection = false;
  let sectionLevel = 0;
  let sectionLine = 0;
  let inSection = false;
  const contentLines: Array<{ line: number; raw: string; trimmed: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;

    const heading = rawLine.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      if (!foundSection && STEPS_AFTER_MERGE_HEADING.test(rawLine.trim())) {
        foundSection = true;
        sectionLevel = heading[1].length;
        sectionLine = i + 1;
        inSection = true;
      } else if (inSection && heading[1].length <= sectionLevel) {
        inSection = false;
      }
      continue;
    }

    if (!inSection) continue;
    if (trimmed === "" || trimmed.startsWith("<!--")) continue;
    contentLines.push({ line: i + 1, raw: rawLine, trimmed });
  }

  if (!foundSection) {
    return {
      foundSection: false,
      sectionLine: 0,
      isNone: false,
      emptySection: false,
      entries: [],
      invalidLines: [],
    };
  }

  if (contentLines.length === 0) {
    return {
      foundSection: true,
      sectionLine,
      isNone: false,
      emptySection: true,
      entries: [],
      invalidLines: [],
    };
  }

  if (
    contentLines.length === 1 &&
    /^none\.?$/i.test(stripMdMarkers(contentLines[0].trimmed))
  ) {
    return {
      foundSection: true,
      sectionLine,
      isNone: true,
      emptySection: false,
      entries: [],
      invalidLines: [],
    };
  }

  const entries: StepAfterMergeEntry[] = [];
  const invalidLines: Array<{ line: number; text: string }> = [];
  for (const item of contentLines) {
    const match = item.raw.match(STEP_ROW_LINE);
    if (!match) {
      invalidLines.push({ line: item.line, text: item.trimmed });
      continue;
    }
    entries.push({
      line: item.line,
      rowNumber: Number(match[1]),
      commands: extractBacktickCommands(match[2]),
    });
  }

  return {
    foundSection: true,
    sectionLine,
    isNone: false,
    emptySection: false,
    entries,
    invalidLines,
  };
}

/** Validates the `## Steps after the merge` section against the parsed plan table rows. */
export function checkStepsAfterMerge(
  markdown: string,
  rows: readonly PlanTableRow[],
  canonicalTiers: readonly string[],
): PlanTableViolation[] {
  const parsed = parseStepsAfterMerge(markdown);
  if (!parsed.foundSection) {
    return [{
      rule: "steps-after-merge-section-missing",
      line: 1,
      message:
        'Plan is missing required "## Steps after the merge" section -- write "none" or list each row with steps after the merge as "- row <n>: `<command>`"',
    }];
  }

  const violations: PlanTableViolation[] = [];
  if (parsed.emptySection) {
    violations.push({
      rule: "steps-after-merge-section-empty",
      line: parsed.sectionLine,
      message:
        '"## Steps after the merge" section is empty -- write "none" or list each row as "- row <n>: `<command>`"',
    });
    return violations;
  }

  for (const bad of parsed.invalidLines) {
    violations.push({
      rule: "steps-after-merge-invalid-line",
      line: bad.line,
      message:
        `Invalid line in "## Steps after the merge" ("${bad.text}") -- expected "none" or "- row <n>: \`<command>\`"`,
    });
  }

  if (parsed.isNone) return violations;

  const rowByNumber = indexPlanRowsByNumber(rows);
  const modelVocabulary = canonicalTiers.length > 0
    ? new Set(canonicalTiers.filter((name) => name !== "Josh"))
    : undefined;

  for (const entry of parsed.entries) {
    const row = rowByNumber.get(entry.rowNumber);
    if (!row) {
      violations.push({
        rule: "steps-after-merge-unknown-row",
        line: entry.line,
        message:
          `## Steps after the merge names row ${entry.rowNumber}, which the plan table does not have`,
      });
      continue;
    }

    if (entry.commands.length === 0) {
      violations.push({
        rule: "steps-after-merge-missing-command",
        line: entry.line,
        message:
          `## Steps after the merge lists row ${entry.rowNumber}: no command found (expected backtick-quoted command(s))`,
      });
    }

    const rawTier = row.cells[COL_TIER];
    const cleanTier = stripMdMarkers(rawTier);
    const tierParts = isMissingValue(rawTier)
      ? []
      : cleanTier.split("/").map((p) => p.trim()).filter(Boolean);
    const hasJosh = tierParts.some((p) => p.toLowerCase() === "josh");
    const hasModelLabel = modelVocabulary
      ? tierParts.some((p) => modelVocabulary.has(p))
      : tierParts.some((p) => p.toLowerCase() !== "josh");

    if (!hasJosh) {
      violations.push({
        rule: "steps-after-merge-missing-josh",
        line: row.line,
        column: "Model tier",
        message:
          `Steps after the merge lists row ${entry.rowNumber}, whose Model tier cell ("${cleanTier}") is missing the "Josh" label`,
      });
    }
    if (!hasModelLabel) {
      violations.push({
        rule: "steps-after-merge-missing-model-label",
        line: row.line,
        column: "Model tier",
        message:
          `Steps after the merge lists row ${entry.rowNumber}, whose Model tier cell ("${cleanTier}") is missing the model label beside "Josh"`,
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
  runGh?: CommandRunner;
  activeRepos?: string[];
  stateDir?: string;
  designDoc?: string;
  designDocs?: readonly string[];
  noOpen?: boolean;
  display?: string;
  openBrowserImpl?: (htmlPath: string, display?: string) => Promise<void>;
  renderDesignDocFileImpl?: (
    inputPath: string,
    outputPath: string,
    options?: RenderDesignDocOptions,
  ) => void;
}

/**
 * CLI runner for `deno task design:lint-plan <plan.md> --design-doc <doc.md> [...]`.
 */
export async function runLintPlanCli(
  args: string[],
  options?: LintPlanCliOptions,
): Promise<number> {
  const log = options?.log ?? console.log;
  const errorLog = options?.errorLog ?? console.error;

  const flags = parseArgs(args, {
    boolean: ["help", "json", "no-open", "no_open"],
    string: ["doc", "design-doc", "design_doc", "state-dir", "state_dir", "display"],
    collect: ["design-doc", "design_doc"],
    alias: {
      h: "help",
      j: "json",
    },
    default: {
      help: false,
      json: false,
      "no-open": false,
      no_open: false,
    },
  });

  if (flags.help) {
    log(`Usage: deno task design:lint-plan <plan.md> --design-doc <doc.md> [options]

Validates the Gate 2 plan table's cell values in a design document:
  - verifies the Gate 1 approval record on disk for each --design-doc
  - each Design cell names one supplied design and each supplied design is used
  - required Closes when headings exist in the design named by that row
  - missing values (empty, whitespace-only, "-"/"—"/"N/A")
  - unknown model tiers (against skills/fix-labels/labels.yaml)
  - unknown repos (against ACTIVE_REPOS in src/shared/repos.ts)
  - personal-name title prefixes ("Josh:", "Josh -", ...)
  - retiring rows (titles with retire/remove/delete/drop) without cleanup scope or "nothing else to remove"
  - out-of-range priorities (Urgent/High/Medium/Low only)
  - a Josh-labeled manual row with no paired agent row
  - a composite Josh-labeled manual row (doc review + live walkthrough)
  - a non-epic row that names no epic ("" or "none")
  - an epic row whose children sit in more than one repository when its repo is not web-jam-tools
  - a Tests cell with no statement of what proves the issue
  - new titles resembling open issues in their row's repository or other new
    plan titles; an incomplete or failed title listing refuses the plan
  - a "Needs Design label removals" item whose "Not resolved" part quotes or
    narrows a directive line of that issue's own body (read with gh; a body
    that cannot be read fails the check)
  - a required "## Steps after the merge" section ("none", or "- row <n>:" lines
    with backtick commands whose listed rows hold both Josh and a model label)

When validation passes, renders <plan>.html and opens it in Google Chrome.

Report-only validation. GitHub calls only read issue bodies and open titles with gh.

Arguments:
  <plan.md>               Path to markdown file containing the plan table

Options:
  --design-doc <path>     Repeat once per design named in the Design column
  --doc <path>            Explicit plan document path
  --display <display>     X11 display to open browser on (defaults to $DISPLAY or :0)
  --no-open               Skip opening <plan>.html in Google Chrome
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

  const collectStrings = (val: unknown): string[] => {
    if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
    if (typeof val === "string" && val.trim() !== "") return [val.trim()];
    return [];
  };
  const designDocPaths = [
    ...collectStrings(flags["design-doc"]),
    ...collectStrings(flags.design_doc),
    ...(options?.designDocs ?? []).map((s) => s.trim()).filter(Boolean),
    ...(options?.designDoc?.trim() ? [options.designDoc.trim()] : []),
  ];

  if (designDocPaths.length === 0) {
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
      runGh: options?.runGh,
      activeRepos: options?.activeRepos,
      designDocPaths,
      stateDir,
    });

    if (result.valid) {
      const htmlPath = resolveHtmlPath(result.docPath);
      const renderFile = options?.renderDesignDocFileImpl ?? renderDesignDocFile;
      renderFile(result.docPath, htmlPath, { isPlanPage: true });

      const noOpen = flags["no-open"] || flags.no_open || options?.noOpen;
      if (!noOpen) {
        const openBrowser = options?.openBrowserImpl ?? defaultOpenBrowserImpl;
        const display = (typeof flags.display === "string" ? flags.display : undefined) ||
          options?.display;
        try {
          await openBrowser(htmlPath, display);
        } catch (browserErr) {
          const msg = browserErr instanceof Error ? browserErr.message : String(browserErr);
          errorLog(`[design:lint-plan] Warning: Chrome could not be opened: ${msg}`);
        }
      }
    }

    if (flags.json) {
      log(JSON.stringify(result, null, 2));
    } else if (result.valid) {
      if (result.gate1Approvals && result.gate1Approvals.length > 0) {
        for (const approval of result.gate1Approvals) {
          log(approval.approvalLine);
        }
      } else if (result.gate1Approval) {
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
