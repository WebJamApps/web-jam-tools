// src/design-issue/stale_bodies.ts
// Helper script for reporting issues whose body is stale against an approved design document (web-jam-tools#746).

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import { expandHome } from "./gate1.ts";
import { defaultCommandRunner } from "./candidates.ts";
import type { CommandRunner } from "../flash-issues/types.ts";

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
  | "fetch-error";

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
  issues: string[] | IssueTarget[];
  defaultRepo?: string;
  readFile?: (path: string) => Promise<string> | string;
  fileExists?: (path: string) => Promise<boolean> | boolean;
  fetchIssue?: (repo: string, issueNumber: number) => Promise<IssueData>;
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

  const reasons: StalenessReason[] = [
    ...designRefReasons,
    ...questionReasons,
    ...scopeReasons,
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

  const targets = Array.isArray(options.issues) && options.issues.length > 0 &&
      typeof options.issues[0] === "object"
    ? (options.issues as IssueTarget[])
    : parseIssueList(options.issues as string[] | string, defaultRepo);

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
  - Verifies ## Design reference cites the target design document.
  - Flags open questions, TBD markers, and unresolved design forks.
  - Flags scope contradictions against design doc non-goals / out-of-scope items.

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

  if (parsedTargets.length === 0) {
    errorLog(
      "Error: No issues specified to scan. Provide issue numbers via --issues <list> or positional arguments.",
    );
    errorLog("Usage: deno task design:stale-bodies <doc.md> --issues 101,102");
    return 1;
  }

  try {
    const result = await scanStaleBodies({
      ...options,
      docPath,
      issues: parsedTargets,
      defaultRepo: flags.repo || options.defaultRepo,
      json: flags.json || options.json,
    });

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
