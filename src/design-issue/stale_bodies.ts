// src/design-issue/stale_bodies.ts
// Helper script for reporting issues whose body is stale against an approved design document (web-jam-tools#746, web-jam-tools#888).

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import { expandHome } from "./gate1.ts";
import { defaultCommandRunner } from "./candidates.ts";
import type { CommandRunner } from "../flash-issues/types.ts";
import { parsePlanTable, splitTableRowCells } from "./plan_table.ts";

export interface IssueTarget {
  repo: string;
  number: number;
}

export interface IssueData {
  number: number;
  title: string;
  body: string;
  state?: string;
  url?: string;
  labels?: Array<{ name: string }>;
}

export type StalenessReasonType =
  | "design-reference"
  | "open-questions"
  | "scope-contradiction"
  | "fetch-error"
  | "verb-reconciliation"
  | "decision-reconciliation";

export interface StalenessReason {
  type: StalenessReasonType;
  message: string;
  detail?: string;
  line?: number;
}

export interface IssueStalenessReport {
  repo: string;
  number: number;
  title?: string;
  url?: string;
  status: "IN SYNC" | "STALE";
  reasons: StalenessReason[];
}

export interface StaleBodiesScanResult {
  docPath: string;
  issues: IssueStalenessReport[];
  summary: {
    total: number;
    inSync: number;
    stale: number;
  };
}

export interface StaleBodiesOptions {
  docPath: string;
  issues?: string[] | IssueTarget[];
  defaultRepo?: string;
  readFile?: (path: string) => Promise<string> | string;
  fileExists?: (path: string) => Promise<boolean> | boolean;
  fetchIssue?: (repo: string, issueNumber: number) => Promise<IssueData>;
  fetchSubIssues?: (repo: string, epicNumber: number) => Promise<IssueTarget[]>;
  runner?: CommandRunner;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
  json?: boolean;
}

export async function defaultFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(filePath);
    return stat.isFile;
  } catch {
    return false;
  }
}

export async function defaultReadFile(filePath: string): Promise<string> {
  return await Deno.readTextFile(filePath);
}

export async function defaultFetchIssue(
  repo: string,
  issueNumber: number,
  runner: CommandRunner = defaultCommandRunner,
): Promise<IssueData> {
  const result = await runner([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "number,title,body,state,url,labels",
  ]);

  if (result.code !== 0) {
    throw new Error(
      `Failed to fetch issue ${repo}#${issueNumber}: ${
        result.stderr.trim() || `exit code ${result.code}`
      }`,
    );
  }

  const parsed = JSON.parse(result.stdout) as {
    number: number;
    title: string;
    body?: string;
    state?: string;
    url?: string;
    labels?: Array<{ name: string }>;
  };

  return {
    number: parsed.number,
    title: parsed.title,
    body: parsed.body ?? "",
    state: parsed.state,
    url: parsed.url,
    labels: parsed.labels,
  };
}

export async function defaultFetchSubIssues(
  repo: string,
  epicNumber: number,
  runner: CommandRunner = defaultCommandRunner,
): Promise<IssueTarget[]> {
  const result = await runner([
    "api",
    `repos/${repo}/issues/${epicNumber}/sub_issues`,
  ]);

  if (result.code !== 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout) as Array<{
      number: number;
      repository?: { full_name?: string };
    }>;
    if (!Array.isArray(parsed)) return [];

    return parsed.map((item) => ({
      repo: item.repository?.full_name || repo,
      number: item.number,
    }));
  } catch {
    return [];
  }
}

/**
 * Parses a single issue citation (e.g. "101", "#101", "web-jam-tools#101", "WebJamApps/web-jam-tools#101").
 */
export function parseIssueTarget(
  raw: string,
  defaultRepo = "WebJamApps/web-jam-tools",
): IssueTarget | null {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return null;

  if (trimmed.includes("#")) {
    const [repoPart, numPart] = trimmed.split("#");
    const num = parseInt(numPart.trim(), 10);
    if (isNaN(num) || num <= 0) return null;

    const trimmedRepo = repoPart.trim();
    if (!trimmedRepo) {
      return { repo: defaultRepo, number: num };
    }

    if (trimmedRepo.includes("/")) {
      return { repo: trimmedRepo, number: num };
    }

    const defaultOwner = defaultRepo.includes("/") ? defaultRepo.split("/")[0] : "WebJamApps";
    return { repo: `${defaultOwner}/${trimmedRepo}`, number: num };
  }

  const num = parseInt(trimmed.replace(/^#/, ""), 10);
  if (isNaN(num) || num <= 0) return null;

  return { repo: defaultRepo, number: num };
}

/**
 * Parses a collection or comma-delimited string of issue citations.
 */
export function parseIssueList(
  raw: string | string[],
  defaultRepo = "WebJamApps/web-jam-tools",
): IssueTarget[] {
  const tokens: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") {
        tokens.push(...item.split(/[,\s]+/));
      }
    }
  } else if (typeof raw === "string") {
    tokens.push(...raw.split(/[,\s]+/));
  }

  const targets: IssueTarget[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (!token.trim()) continue;
    const target = parseIssueTarget(token, defaultRepo);
    if (target) {
      const key = `${target.repo}#${target.number}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(target);
      }
    }
  }

  return targets;
}

export interface DocumentIssueExtraction {
  epics: IssueTarget[];
  issues: IssueTarget[];
  all: IssueTarget[];
}

/**
 * Extracts child sub-issue references, table issue links, and Epic citations from a design document.
 */
export function extractDocumentIssueTargets(
  docContent: string,
  defaultRepo = "WebJamApps/web-jam-tools",
): DocumentIssueExtraction {
  const epics: IssueTarget[] = [];
  const issues: IssueTarget[] = [];
  const seenEpics = new Set<string>();
  const seenIssues = new Set<string>();

  function addEpic(target: IssueTarget | null) {
    if (!target) return;
    const key = `${target.repo}#${target.number}`;
    if (!seenEpics.has(key)) {
      seenEpics.add(key);
      epics.push(target);
    }
  }

  function addIssue(target: IssueTarget | null) {
    if (!target) return;
    const key = `${target.repo}#${target.number}`;
    if (!seenIssues.has(key)) {
      seenIssues.add(key);
      issues.push(target);
    }
  }

  // 1. Check Gate 2 plan table if present
  try {
    const planTable = parsePlanTable(docContent);
    if (planTable) {
      const headerLower = planTable.headerCells.map((c) => c.toLowerCase());
      const titleIdx = headerLower.findIndex((c) => c.includes("title"));
      const epicIdx = headerLower.findIndex((c) => c.includes("epic"));

      for (const row of planTable.rows) {
        if (epicIdx !== -1 && row.cells[epicIdx]) {
          const epicCell = row.cells[epicIdx];
          const epicMatch =
            epicCell.match(/(?:(?:[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)?#)|(?:#))(\d+)/) ||
            epicCell.match(/github\.com\/([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)\/issues\/(\d+)/);
          if (epicMatch) {
            const target = parseIssueTarget(epicMatch[0], defaultRepo);
            addEpic(target);
          }
        }

        if (titleIdx !== -1 && row.cells[titleIdx]) {
          const titleCell = row.cells[titleIdx];
          const issueMatch =
            titleCell.match(/github\.com\/([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)\/issues\/(\d+)/) ||
            titleCell.match(/\[#?(\d+)\]/) ||
            titleCell.match(/(?:[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)?#)(\d+)/);
          if (issueMatch) {
            const target = parseIssueTarget(issueMatch[0].replace(/[\[\]]/g, ""), defaultRepo);
            addIssue(target);
          }
        }
      }
    }
  } catch {
    // Non-fatal if plan table has parse issues
  }

  // 2. Scan all markdown tables for Issue Link / Epic / Proposed title / sub-issue columns
  const lines = docContent.split(/\r?\n/);
  let tableHeaderCols: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) {
      tableHeaderCols = [];
      continue;
    }

    const cells = splitTableRowCells(line);
    // If this is an alignment row, skip
    if (cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))) {
      continue;
    }

    if (tableHeaderCols.length === 0) {
      tableHeaderCols = cells.map((c) => c.toLowerCase());
      continue;
    }

    for (let colIdx = 0; colIdx < cells.length; colIdx++) {
      const cell = cells[colIdx];
      const colHeader = tableHeaderCols[colIdx] || "";
      const isEpicColumn = colHeader.includes("epic");

      // Search for GitHub issue URLs in table cell
      const urlMatches = cell.matchAll(
        /https:\/\/github\.com\/([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)\/issues\/(\d+)/gi,
      );
      for (const match of urlMatches) {
        const target: IssueTarget = { repo: match[1], number: parseInt(match[2], 10) };
        if (isEpicColumn || /epic/i.test(cell)) {
          addEpic(target);
        } else {
          addIssue(target);
        }
      }

      // Search for citations like [web-jam-back#1052](...) or [#885](...)
      const citeMatches = cell.matchAll(/\[(?:([A-Za-z0-9_.\-]+)#)?(\d+)\]/gi);
      for (const match of citeMatches) {
        const repoName = match[1];
        const num = parseInt(match[2], 10);
        const target = parseIssueTarget(repoName ? `${repoName}#${num}` : `#${num}`, defaultRepo);
        if (isEpicColumn || /epic/i.test(cell)) {
          addEpic(target);
        } else {
          addIssue(target);
        }
      }
    }
  }

  // 3. Scan document prose for Epic citations (e.g. "Part of ...#737" or "Epic #737")
  const epicProseMatches = docContent.matchAll(
    /(?:(?:Part\s+of|Child\s+of|Epic:?|under\s+Epic)\s+(?:\[[^\]]*\]\()?https:\/\/github\.com\/([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)\/issues\/(\d+))/gi,
  );
  for (const match of epicProseMatches) {
    addEpic({ repo: match[1], number: parseInt(match[2], 10) });
  }

  const epicShorthandMatches = docContent.matchAll(
    /(?:(?:Part\s+of|Child\s+of|Epic:?|under\s+Epic)\s+([A-Za-z0-9_.\-]+#[0-9]+|#[0-9]+))/gi,
  );
  for (const match of epicShorthandMatches) {
    addEpic(parseIssueTarget(match[1], defaultRepo));
  }

  // Combine into deduplicated list
  const all: IssueTarget[] = [...issues];
  for (const epic of epics) {
    const key = `${epic.repo}#${epic.number}`;
    if (!seenIssues.has(key)) {
      all.push(epic);
    }
  }

  return { epics, issues, all };
}

/**
 * Extracts out-of-scope topics / items from the design document content.
 */
export function extractOutOfScopeItems(
  docContent: string,
): Array<{ topic: string; fullText: string }> {
  const outOfScopeRegex =
    /(?:^|\n)#{1,4}\s+(?:What\s+stays\s+out\s+of\s+scope|Non-goals|Non-Goals|Out\s+of\s+[Ss]cope|Excluded\s+[Ss]cope)\b[^\n]*\n([\s\S]*?)(?=\n#{1,4}\s+[^\n]+|$)/i;
  const match = docContent.match(outOfScopeRegex);
  if (!match) return [];

  const sectionBody = match[1];
  const items: Array<{ topic: string; fullText: string }> = [];

  // Match bullet points: - ..., * ..., or 1. ...
  const lines = sectionBody.split(/\r?\n/);
  let currentItem = "";

  for (const line of lines) {
    const bulletMatch = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    if (bulletMatch) {
      if (currentItem.trim()) {
        const full = currentItem.trim().replace(/[*`_]/g, "");
        const topic = extractTopicPhrase(full);
        if (topic) items.push({ topic, fullText: full });
      }
      currentItem = bulletMatch[1];
    } else if (currentItem && line.trim() && !/^\s*```/.test(line)) {
      currentItem += " " + line.trim();
    } else if (!currentItem && line.trim() && !/^\s*```/.test(line)) {
      // Paragraph text
      const full = line.trim().replace(/[*`_]/g, "");
      const topic = extractTopicPhrase(full);
      if (topic) items.push({ topic, fullText: full });
    }
  }

  if (currentItem.trim()) {
    const full = currentItem.trim().replace(/[*`_]/g, "");
    const topic = extractTopicPhrase(full);
    if (topic) items.push({ topic, fullText: full });
  }

  return items;
}

function extractTopicPhrase(text: string): string {
  let cleaned = text.trim();
  // Strip citations like "[web-jam-tools#732](...)" or "owned by web-jam-tools#732"
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  cleaned = cleaned.replace(/,\s*owned\s+by\s+[^.,;\n]+/i, "");
  cleaned = cleaned.replace(/\(owned\s+by\s+[^)]+\)/i, "");

  // Split on first period, em-dash, or semicolon
  const parts = cleaned.split(/(?:\.\s+|—|;\s+)/);
  let candidate = parts[0].trim();
  candidate = candidate.replace(/[.,;:]+$/, "").trim();
  return candidate;
}

/**
 * Checks the issue body's ## Design reference against the target design document.
 */
export async function checkDesignReference(
  issueBody: string,
  targetDocPath: string,
  fileExists: (path: string) => Promise<boolean> | boolean = defaultFileExists,
): Promise<StalenessReason[]> {
  const violations: StalenessReason[] = [];

  const designRefRegex =
    /(?:^|\n)#{1,4}\s+Design\s+reference\b[^\n]*\n([\s\S]*?)(?=\n#{1,4}\s+[^\n]+|$)/i;
  const match = issueBody.match(designRefRegex);

  if (!match) {
    const isChildSubIssue =
      /(?:^|\n)\s*(?:Child\s+of|Part\s+of)\s+(?:\[[^\]]*\]\([^)]+\)|[^\n]+(?:#|\/issues\/)\d+)/i
        .test(issueBody);
    if (isChildSubIssue) {
      // Child sub-issues cite their parent Epic rather than having a standalone ## Design reference
      return violations;
    }

    violations.push({
      type: "design-reference",
      message: "Missing required '## Design reference' section in issue body",
    });
    return violations;
  }

  const sectionContent = match[1].trim();
  if (!sectionContent) {
    violations.push({
      type: "design-reference",
      message: "The '## Design reference' section does not cite a design document path",
    });
    return violations;
  }

  // Extract candidate file paths
  const candidatePaths: string[] = [];

  // Match markdown links: [label](path)
  const linkMatches = sectionContent.matchAll(/\[(?:[^\]]*)\]\(([^)]+\.md(?:#[^)]*)?)\)/gi);
  for (const m of linkMatches) {
    candidatePaths.push(m[1].split("#")[0].trim());
  }

  // Match backticked paths: `path.md`
  const backtickMatches = sectionContent.matchAll(/`([^`]+\.md)`/gi);
  for (const m of backtickMatches) {
    candidatePaths.push(m[1].trim());
  }

  // Match labeled paths: Document: /path/to/doc.md or Path: doc.md
  const labeledMatches = sectionContent.matchAll(
    /(?:Document|Doc|Path|Reference|File):\s*`?([^\s`\n\r]+\.md)`?/gi,
  );
  for (const m of labeledMatches) {
    candidatePaths.push(m[1].trim());
  }

  // Match naked markdown file paths
  const nakedMatches = sectionContent.matchAll(
    /(?:file:\/\/)?((?:~|\/|[A-Za-z0-9_.\-\/]+)\/[A-Za-z0-9_.\-]+\.md)/gi,
  );
  for (const m of nakedMatches) {
    candidatePaths.push(m[1].trim());
  }

  const uniqueCandidates = Array.from(new Set(candidatePaths));

  if (uniqueCandidates.length === 0) {
    violations.push({
      type: "design-reference",
      message: "The '## Design reference' section does not cite a valid design document path (.md)",
    });
    return violations;
  }

  const targetExpanded = path.resolve(expandHome(targetDocPath));
  const targetBasename = path.basename(targetExpanded);

  let matchedCorrectDoc = false;
  let fileMissing = false;
  let missingPath = "";
  let mismatchedPath = "";

  for (const candidate of uniqueCandidates) {
    const candidateExpanded = path.resolve(expandHome(candidate));
    const candidateBasename = path.basename(candidateExpanded);

    const isMatch = candidateExpanded === targetExpanded ||
      candidateBasename === targetBasename;

    if (isMatch) {
      matchedCorrectDoc = true;
      const exists = await fileExists(candidateExpanded);
      if (!exists) {
        fileMissing = true;
        missingPath = candidate;
      }
    } else {
      mismatchedPath = candidate;
    }
  }

  if (!matchedCorrectDoc) {
    violations.push({
      type: "design-reference",
      message: `Design reference points to a different document: '${
        mismatchedPath || uniqueCandidates[0]
      }' (expected '${targetDocPath}')`,
    });
  } else if (fileMissing) {
    violations.push({
      type: "design-reference",
      message: `Design reference document does not exist on disk: '${missingPath}'`,
    });
  }

  return violations;
}

/**
 * Checks the issue body for unresolved questions, TBD markers, and design forks.
 */
export function checkOpenQuestionsAndTbd(issueBody: string): StalenessReason[] {
  const violations: StalenessReason[] = [];
  const lines = issueBody.split(/\r?\n/);

  let inCodeBlock = false;

  const tbdMarkerRegexes = [
    /\b(?:\[TBD\]|\(TBD\)|TBD)\b/,
    /\b(?:\[TODO\]|\(TODO\)|TODO)\b/,
    /\bFIXME\b/,
    /\bTO\s+BE\s+DETERMINED\b/i,
    /\bTO\s+BE\s+DECIDED\b/i,
    /\bUNDECIDED\b/i,
    /\bUNRESOLVED\b/i,
    /\bNeeds\s+Design\b/i,
    /\bPending\s+Design\b/i,
    /\bTo\s+be\s+designed\b/i,
    /\bNeeds\s+architectural\s+decision\b/i,
    /\bAwaiting\s+design\b/i,
  ];

  const questionHeadingRegex =
    /^\s*#{1,6}\s+(?:Open\s+Questions?|Questions?\s+to\s+resolve|Questions?|Needs\s+Design|TBD|Unresolved\s+Questions?)\b/i;

  const questionPromptRegexes = [
    /^\s*(?:[-*+]|\d+\.)?\s*(?:What\s+should|How\s+should|Which\s+approach|Should\s+we\b|Whether\s+to\b|Decide\s+whether\b|Decide\s+between\b).*\?/i,
    /^\s*(?:[-*+]|\d+\.)?\s*(?:Open\s+question|Design\s+question|Question):\s*.+/i,
  ];

  const designForkRegexes = [
    /\bOption\s+1\s*:.*\bOption\s+2\s*:/i,
    /\bApproach\s+A\s+vs\s+Approach\s+B\b/i,
    /\bAlternative\s+1\s+vs\s+Alternative\s+2\b/i,
    /\bWhether\s+to\s+[^.\n]+\s+or\s+[^.\n]+/i,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) continue;

    // Check for unresolved heading
    if (questionHeadingRegex.test(line)) {
      violations.push({
        type: "open-questions",
        message: `Issue body contains unresolved question section: "${line.trim()}"`,
        line: lineNum,
        detail: line.trim(),
      });
      continue;
    }

    // Check for TBD markers
    for (const regex of tbdMarkerRegexes) {
      const m = line.match(regex);
      if (m) {
        violations.push({
          type: "open-questions",
          message: `Issue body contains unresolved marker: "${m[0]}"`,
          line: lineNum,
          detail: line.trim(),
        });
        break;
      }
    }

    // Check for open question prompts
    for (const regex of questionPromptRegexes) {
      if (regex.test(line)) {
        violations.push({
          type: "open-questions",
          message: `Issue body contains open question: "${line.trim()}"`,
          line: lineNum,
          detail: line.trim(),
        });
        break;
      }
    }

    // Check for design forks / undecided options
    for (const regex of designForkRegexes) {
      if (regex.test(line)) {
        violations.push({
          type: "open-questions",
          message: `Issue body contains unresolved design fork or alternatives: "${line.trim()}"`,
          line: lineNum,
          detail: line.trim(),
        });
        break;
      }
    }
  }

  return violations;
}

/**
 * Checks the issue body against out-of-scope non-goals in the design document.
 */
export function checkScopeContradictions(
  issueBody: string,
  outOfScopeItems: Array<{ topic: string; fullText: string }>,
  docFilename: string,
): StalenessReason[] {
  const violations: StalenessReason[] = [];
  if (outOfScopeItems.length === 0) return violations;

  const lines = issueBody.split(/\r?\n/);
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip section headers and design references
    if (/^#{1,6}\s+/.test(trimmed)) continue;

    for (const item of outOfScopeItems) {
      const topic = item.topic.trim();
      if (!topic || topic.length < 5) continue;

      // Check direct phrase match (case-insensitive with word boundary)
      if (matchesTopicPhrase(trimmed, topic)) {
        violations.push({
          type: "scope-contradiction",
          message:
            `Issue body contradicts design document non-goals: requires '${topic}' which is listed as out of scope in '${docFilename}'`,
          line: lineNum,
          detail: `Line ${lineNum}: "${trimmed}"`,
        });
        break;
      }

      // Check keyword overlap (if >= 3 meaningful words match in this line)
      const keywords = topic
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));

      if (keywords.length >= 3) {
        const lowerLine = trimmed.toLowerCase();
        const matches = keywords.filter((k) => lowerLine.includes(k));
        if (
          matches.length >= Math.min(keywords.length, 3) && matches.length / keywords.length >= 0.75
        ) {
          violations.push({
            type: "scope-contradiction",
            message:
              `Issue body contradicts design document non-goals: requires '${topic}' which is listed as out of scope in '${docFilename}'`,
            line: lineNum,
            detail: `Line ${lineNum}: "${trimmed}"`,
          });
          break;
        }
      }
    }
  }

  return violations;
}

const STOP_WORDS = new Set([
  "this",
  "that",
  "these",
  "those",
  "from",
  "with",
  "into",
  "over",
  "after",
  "before",
  "about",
  "above",
  "below",
  "under",
  "where",
  "which",
  "while",
  "their",
  "there",
  "other",
  "every",
  "stays",
  "scope",
]);

function matchesTopicPhrase(text: string, topic: string): boolean {
  const lowerText = ` ${text.toLowerCase()} `;
  const lowerTopic = topic.toLowerCase();
  const idx = lowerText.indexOf(lowerTopic);
  if (idx === -1) return false;
  const beforeChar = lowerText[idx - 1] || " ";
  const afterChar = lowerText[idx + lowerTopic.length] || " ";
  const isWordChar = (c: string) => /[a-z0-9_]/.test(c);
  return !isWordChar(beforeChar) && !isWordChar(afterChar);
}

/**
 * Analyzes a single issue data object against the design document.
 */
export interface DesignDecision {
  id: string;
  decision: string;
  outcome: string;
  endpoints: string[];
  verbs: string[];
}

export function extractDecisionsFromDoc(docContent: string): DesignDecision[] {
  const decisions: DesignDecision[] = [];

  const decisionSectionRegex =
    /(?:^|\n)#{1,4}\s+(?:Decision\s+[Rr]ecord|Decisions\s+[Rr]ecord|Decisions|Appendix\s+C[^\n]*)\b[^\n]*\n([\s\S]*?)(?=\n#{1,4}\s+[^\n]+|$)/gi;

  let sectionMatch: RegExpExecArray | null;
  while ((sectionMatch = decisionSectionRegex.exec(docContent)) !== null) {
    const sectionText = sectionMatch[1];
    const lines = sectionText.split(/\r?\n/);

    let headerIdx = -1;
    let headerCells: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("|")) continue;

      const cells = splitTableRowCells(line);
      const lower = cells.map((c) => c.toLowerCase());
      if (
        lower.some((c) => c.includes("decision")) &&
        lower.some((c) => c.includes("outcome") || c.includes("resolution") || c.includes("chosen"))
      ) {
        headerIdx = i;
        headerCells = lower;
        break;
      }
    }

    if (headerIdx === -1) continue;

    const idCol = headerCells.findIndex((c) => c === "#" || c.includes("id"));
    const decCol = headerCells.findIndex((c) => c.includes("decision"));
    const outcomeCol = headerCells.findIndex((c) =>
      c.includes("outcome") || c.includes("resolution") || c.includes("chosen")
    );

    for (let i = headerIdx + 2; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("|")) continue;

      const cells = splitTableRowCells(line);
      if (cells.length < Math.max(idCol, decCol, outcomeCol) + 1) continue;

      const id = idCol !== -1 ? cells[idCol] : "";
      const dec = decCol !== -1 ? cells[decCol] : "";
      const outcome = outcomeCol !== -1 ? cells[outcomeCol] : "";

      if (!dec && !outcome) continue;

      const combined = `${dec} ${outcome}`;
      const endpointMatches = combined.matchAll(/[/][a-zA-Z0-9_.:\-/]+/g);
      const endpoints = Array.from(
        new Set(Array.from(endpointMatches).map((m) => m[0].replace(/[.,;:`'"]+$/, ""))),
      ).filter((ep) => ep.length >= 3 && !ep.endsWith("/"));

      const verbMatches = combined.matchAll(/\b(GET|POST|PUT|DELETE|PATCH)\b/g);
      const verbs = Array.from(
        new Set(Array.from(verbMatches).map((m) => m[1].toUpperCase())),
      );

      decisions.push({
        id,
        decision: dec,
        outcome,
        endpoints,
        verbs,
      });
    }
  }

  return decisions;
}

export interface EndpointSpec {
  endpoint: string;
  verbs: Set<string>;
  sourceDecisions: string[];
}

export function extractEndpointsFromDoc(
  docContent: string,
  decisions: DesignDecision[] = [],
): Map<string, EndpointSpec> {
  const map = new Map<string, EndpointSpec>();

  function register(endpoint: string, verb: string, source: string) {
    const cleanEndpoint = endpoint.replace(/[`'"]/g, "").replace(/[.,;:]+$/, "");
    if (!cleanEndpoint.startsWith("/") || cleanEndpoint.length < 2) return;
    if (!map.has(cleanEndpoint)) {
      map.set(cleanEndpoint, {
        endpoint: cleanEndpoint,
        verbs: new Set(),
        sourceDecisions: [],
      });
    }
    const spec = map.get(cleanEndpoint)!;
    spec.verbs.add(verb.toUpperCase());
    if (source && !spec.sourceDecisions.includes(source)) {
      spec.sourceDecisions.push(source);
    }
  }

  // 1. From decisions
  for (const dec of decisions) {
    const source = dec.id ? `Decision ${dec.id}` : dec.decision;
    const combined = `${dec.decision} ${dec.outcome}`;
    const matches = combined.matchAll(
      /\b(GET|POST|PUT|DELETE|PATCH)\s+([/][a-zA-Z0-9_.:\-/]+)/gi,
    );
    for (const m of matches) {
      register(m[2], m[1], source);
    }
  }

  // 2. From document Architecture / Endpoints sections or body
  const endpointMatches = docContent.matchAll(
    /\b(GET|POST|PUT|DELETE|PATCH)\s+([/][a-zA-Z0-9_.:\-/]+)/gi,
  );
  for (const m of endpointMatches) {
    register(m[2], m[1], "Architecture / Specification");
  }

  return map;
}

function normalizeRoutePrefix(endpoint: string): string {
  return endpoint.split("/:")[0].toLowerCase();
}

/**
 * Reconciles sub-issue titles and acceptance criteria against the design document's
 * Decisions Record and Architecture sections (web-jam-tools#888).
 */
export function checkDecisionAndVerbReconciliation(
  issue: IssueData,
  docDecisions: DesignDecision[],
  docEndpoints: Map<string, EndpointSpec>,
): StalenessReason[] {
  const violations: StalenessReason[] = [];
  const fullText = `${issue.title} ${issue.body}`;
  const fullTextLower = fullText.toLowerCase();

  // 1. Check HTTP Endpoints and Verbs
  for (const [endpoint, spec] of docEndpoints.entries()) {
    const endpointPrefix = normalizeRoutePrefix(endpoint);
    const mentionsEndpoint = fullTextLower.includes(endpoint.toLowerCase()) ||
      (endpointPrefix.length > 3 && fullTextLower.includes(endpointPrefix));

    if (!mentionsEndpoint) continue;

    // Extract verbs present in issue title and body
    const titleVerbs = new Set(
      Array.from(issue.title.matchAll(/\b(GET|POST|PUT|DELETE|PATCH)\b/gi)).map((m) =>
        m[0].toUpperCase()
      ),
    );
    const bodyVerbs = new Set(
      Array.from(issue.body.matchAll(/\b(GET|POST|PUT|DELETE|PATCH)\b/gi)).map((m) =>
        m[0].toUpperCase()
      ),
    );
    const allIssueVerbs = new Set([...titleVerbs, ...bodyVerbs]);

    // Only apply verb reconciliation if the issue mentions at least one HTTP verb or is titled as an endpoint task
    const hasAnyVerb = titleVerbs.size > 0 ||
      Array.from(spec.verbs).some((v) => allIssueVerbs.has(v));

    if (!hasAnyVerb) continue;

    const missingVerbs: string[] = [];
    for (const verb of spec.verbs) {
      if (!allIssueVerbs.has(verb)) {
        missingVerbs.push(verb);
      }
    }

    if (missingVerbs.length > 0) {
      const sourceDesc = spec.sourceDecisions.length > 0
        ? spec.sourceDecisions.join(", ")
        : "Design Architecture";
      const verbList = missingVerbs.join(", ");
      violations.push({
        type: "verb-reconciliation",
        message:
          `Sub-issue is missing HTTP method(s) ${verbList} for endpoint '${endpoint}' specified in design document (${sourceDesc})`,
        detail:
          `Reconciliation guidance: Update issue title to include ${verbList} and add acceptance criteria covering ${verbList} ${endpoint} (e.g. takedown / error handling).`,
      });
    }

    // Check if title specifically specifies verbs but is missing a newly approved verb
    if (titleVerbs.size > 0) {
      for (const verb of spec.verbs) {
        if (!titleVerbs.has(verb)) {
          const alreadyReported = violations.some(
            (v) =>
              v.type === "verb-reconciliation" &&
              v.message.includes(`title is missing HTTP method '${verb}'`),
          );
          if (!alreadyReported) {
            violations.push({
              type: "verb-reconciliation",
              message:
                `Sub-issue title is missing HTTP method '${verb}' for endpoint '${endpoint}'`,
              detail:
                `Reconciliation guidance: Update issue title from "${issue.title}" to include ${verb}.`,
            });
          }
        }
      }
    }
  }

  // 2. Check Decision Outcomes that specifically mention or relate to this issue
  for (const dec of docDecisions) {
    const decId = dec.id ? `Decision ${dec.id}` : `Decision "${dec.decision}"`;
    // Check if decision specifically targets this issue (e.g. by issue citation "#1052")
    const citesIssue = dec.outcome.includes(`#${issue.number}`) ||
      dec.decision.includes(`#${issue.number}`);

    let relatesToIssue = citesIssue;
    if (!relatesToIssue) {
      for (const ep of dec.endpoints) {
        const epPrefix = normalizeRoutePrefix(ep);
        if (
          fullTextLower.includes(ep.toLowerCase()) ||
          (epPrefix.length > 3 && fullTextLower.includes(epPrefix))
        ) {
          relatesToIssue = true;
          break;
        }
      }
    }

    if (relatesToIssue) {
      const outcomeLower = dec.outcome.toLowerCase();
      // Check for takedown / deletion / 404 requirement
      const needsTakedown = outcomeLower.includes("takedown") ||
        (outcomeLower.includes("delete") && outcomeLower.includes("404"));

      if (needsTakedown) {
        const bodyLower = issue.body.toLowerCase();
        const hasTakedownInAc = bodyLower.includes("delete") &&
          (bodyLower.includes("404") || bodyLower.includes("takedown") ||
            bodyLower.includes("removes"));
        if (!hasTakedownInAc) {
          violations.push({
            type: "decision-reconciliation",
            message:
              `Sub-issue fails to reflect ${decId} ("${dec.decision}"): missing takedown / deletion criteria`,
            detail: `Reconciliation guidance: Add acceptance criterion covering: "${
              dec.outcome.slice(0, 140).trim()
            }..."`,
          });
        }
      }
    }
  }

  return violations;
}

export async function analyzeIssueStaleness(
  issue: IssueData,
  repo: string,
  targetDocPath: string,
  docContent: string,
  options: Partial<StaleBodiesOptions> = {},
): Promise<IssueStalenessReport> {
  const fileExists = options.fileExists ?? defaultFileExists;
  const docFilename = path.basename(targetDocPath);
  const outOfScopeItems = extractOutOfScopeItems(docContent);

  const designRefReasons = await checkDesignReference(
    issue.body,
    targetDocPath,
    fileExists,
  );
  const questionReasons = checkOpenQuestionsAndTbd(issue.body);
  const scopeReasons = checkScopeContradictions(
    issue.body,
    outOfScopeItems,
    docFilename,
  );

  const docDecisions = extractDecisionsFromDoc(docContent);
  const docEndpoints = extractEndpointsFromDoc(docContent, docDecisions);
  const reconciliationReasons = checkDecisionAndVerbReconciliation(
    issue,
    docDecisions,
    docEndpoints,
  );

  const reasons: StalenessReason[] = [
    ...designRefReasons,
    ...questionReasons,
    ...scopeReasons,
    ...reconciliationReasons,
  ];

  return {
    repo,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    status: reasons.length === 0 ? "IN SYNC" : "STALE",
    reasons,
  };
}

/**
 * Scans a list of issues against the specified design document.
 */
export async function scanStaleBodies(
  options: StaleBodiesOptions,
): Promise<StaleBodiesScanResult> {
  const readFile = options.readFile ?? defaultReadFile;
  const fetchIssue = options.fetchIssue ?? ((r, n) => defaultFetchIssue(r, n, options.runner));
  const fetchSubIssues = options.fetchSubIssues ??
    ((r, n) => defaultFetchSubIssues(r, n, options.runner));
  const defaultRepo = options.defaultRepo ?? "WebJamApps/web-jam-tools";

  const resolvedDocPath = path.resolve(expandHome(options.docPath));

  let docContent: string;
  try {
    docContent = await readFile(resolvedDocPath);
  } catch (err) {
    throw new Error(
      `Design document not found or cannot be read at ${resolvedDocPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let targets: IssueTarget[] = [];
  if (
    options.issues &&
    (Array.isArray(options.issues) ? options.issues.length > 0 : Boolean(options.issues))
  ) {
    targets = Array.isArray(options.issues) && options.issues.length > 0 &&
        typeof options.issues[0] === "object"
      ? (options.issues as IssueTarget[])
      : parseIssueList(options.issues as string[] | string, defaultRepo);
  } else {
    // Auto-extract from design document: tables, plan table, Epics, and their sub-issues
    const extracted = extractDocumentIssueTargets(docContent, defaultRepo);
    const subIssueTargets: IssueTarget[] = [];

    for (const epic of extracted.epics) {
      try {
        const subs = await fetchSubIssues(epic.repo, epic.number);
        subIssueTargets.push(...subs);
      } catch {
        // Non-fatal
      }
    }

    let combined: IssueTarget[] = [];
    if (extracted.issues.length > 0 || subIssueTargets.length > 0) {
      combined = [...extracted.issues, ...subIssueTargets];
    } else {
      combined = [...extracted.epics];
    }

    const seen = new Set<string>();
    for (const t of combined) {
      const key = `${t.repo}#${t.number}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(t);
      }
    }
  }

  const reports: IssueStalenessReport[] = [];

  for (const target of targets) {
    try {
      const issueData = await fetchIssue(target.repo, target.number);
      const report = await analyzeIssueStaleness(
        issueData,
        target.repo,
        resolvedDocPath,
        docContent,
        options,
      );
      reports.push(report);
    } catch (err) {
      reports.push({
        repo: target.repo,
        number: target.number,
        status: "STALE",
        reasons: [
          {
            type: "fetch-error",
            message: `Failed to fetch issue ${target.repo}#${target.number}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        ],
      });
    }
  }

  const inSyncCount = reports.filter((r) => r.status === "IN SYNC").length;
  const staleCount = reports.filter((r) => r.status === "STALE").length;

  return {
    docPath: resolvedDocPath,
    issues: reports,
    summary: {
      total: reports.length,
      inSync: inSyncCount,
      stale: staleCount,
    },
  };
}

/**
 * Formats scan results into a human-readable text report.
 */
export function formatStaleBodiesReport(result: StaleBodiesScanResult): string {
  const lines: string[] = [];
  lines.push(
    `[design:stale-bodies] Scanned ${result.summary.total} issue(s) against ${result.docPath}:`,
  );
  lines.push("");

  for (const issue of result.issues) {
    const titlePart = issue.title ? ` "${issue.title}"` : "";
    const header = `Issue ${issue.repo}#${issue.number}${titlePart}: ${issue.status}`;
    lines.push(header);

    if (issue.status === "IN SYNC") {
      lines.push("  - Design reference: OK");
      lines.push("  - Open questions / TBD: None");
      lines.push("  - Scope / Non-goals: In sync");
      lines.push("  - Decisions & Verbs: In sync");
    } else {
      for (const reason of issue.reasons) {
        const detailPart = reason.detail ? ` (${reason.detail})` : "";
        lines.push(`  - [${reason.type}] ${reason.message}${detailPart}`);
      }
    }
    lines.push("");
  }

  lines.push(
    `Summary: ${result.summary.inSync} issue(s) in sync, ${result.summary.stale} issue(s) stale.`,
  );
  return lines.join("\n");
}

/**
 * CLI runner for deno task design:stale-bodies.
 */
export async function runStaleBodiesCli(
  args: string[] = [],
  options: Partial<StaleBodiesOptions> = {},
): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["help", "json"],
    string: ["doc", "issues", "repo"],
    alias: {
      h: "help",
      j: "json",
      d: "doc",
      i: "issues",
      r: "repo",
    },
    default: {
      help: false,
      json: false,
      repo: "WebJamApps/web-jam-tools",
    },
  });

  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;

  if (flags.help) {
    log(`Usage: deno task design:stale-bodies <doc.md> [options]
   or: deno task design:stale-bodies --doc <doc.md> --issues <101,102>

Analyzes issue bodies against a design document to detect staleness:
  - Verifies ## Design reference cites the target design document or parent Epic.
  - Flags open questions, TBD markers, and unresolved design forks.
  - Flags scope contradictions against design doc non-goals / out-of-scope items.
  - Reconciles child sub-issue titles, acceptance criteria, and HTTP verbs against design decisions and architecture.

Arguments:
  <doc.md>                  Path to design document markdown file

Options:
  -d, --doc <path>          Explicit design document path
  -i, --issues <list>       Comma- or space-separated list of issue numbers/citations (e.g. "101,102" or "web-jam-tools#724")
  -r, --repo <owner/repo>   Default repository if not specified in issue citation (default: WebJamApps/web-jam-tools)
  -j, --json                Output report in JSON format
  -h, --help                Show this help message
`);
    return 0;
  }

  const docPath = flags.doc ||
    (flags._.length > 0 ? String(flags._[0]) : "") ||
    options.docPath ||
    "";

  if (!docPath) {
    errorLog("Error: Missing required design document path.");
    errorLog("Usage: deno task design:stale-bodies <doc.md> --issues <list>");
    return 1;
  }

  const issueArgs: string[] = [];
  if (flags.issues) {
    issueArgs.push(flags.issues);
  }

  const positionalIssues = flags.doc ? flags._ : flags._.slice(1);
  for (const pos of positionalIssues) {
    issueArgs.push(String(pos));
  }

  if (options.issues) {
    if (Array.isArray(options.issues)) {
      for (const item of options.issues) {
        if (typeof item === "string") {
          issueArgs.push(item);
        } else if (item && typeof item === "object") {
          issueArgs.push(`${item.repo}#${item.number}`);
        }
      }
    } else if (typeof options.issues === "string") {
      issueArgs.push(options.issues);
    }
  }

  const parsedTargets = parseIssueList(
    issueArgs,
    flags.repo || options.defaultRepo,
  );

  try {
    const result = await scanStaleBodies({
      ...options,
      docPath,
      issues: parsedTargets.length > 0 ? parsedTargets : undefined,
      defaultRepo: flags.repo || options.defaultRepo,
      json: flags.json || options.json,
    });

    if (result.summary.total === 0) {
      errorLog(
        "Error: No issues specified to scan and none found in design document.",
      );
      errorLog("Usage: deno task design:stale-bodies <doc.md> --issues 101,102");
      return 1;
    }

    if (flags.json || options.json) {
      log(JSON.stringify(result, null, 2));
    } else {
      log(formatStaleBodiesReport(result));
    }

    return 0;
  } catch (err) {
    errorLog(
      `[design:stale-bodies] Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}
