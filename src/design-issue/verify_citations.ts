// src/design-issue/verify_citations.ts
// Citation liveness checker for design documents (web-jam-tools#1025): reads every issue or pull
// request a design document cites and fails on a title that no longer matches, or on a closed (or
// merged) citation the document does not acknowledge as closed. Network-dependent — kept out of
// lint_doc.ts, which must stay offline and deterministic so the existing test suite never reaches
// the network (web-jam-tools#1025 non-goal).

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import type { CommandRunner } from "../flash-issues/types.ts";
import { defaultCommandRunner } from "./candidates.ts";
import { expandHome } from "./gate1.ts";
import { splitTableRowCells } from "./plan_table.ts";
import { type IssueTarget, parseIssueTarget } from "./stale_bodies.ts";

export interface ParsedCitation {
  repo: string;
  number: number;
  /** 1-indexed PHYSICAL line the citation token itself sits on — always reported in violation
   * messages, even though `acknowledgementScope` (below) may span more than this one line. */
  line: number;
  lineContent: string;
  /** The title quoted immediately after the citation on the same physical line, e.g.
   * `web-jam-tools#1018 "hooks/agy-model-guard: ..."` — undefined when the citation carries no
   * quoted title, in which case the title-drift check does not apply to that citation. */
  quotedTitle?: string;
  /** The text the "acknowledged as closed" check searches for the word `closed` in
   * (web-jam-tools#1025 follow-up): the citation's own table CELL inside a table, or its own
   * SENTENCE — assembled across hard-wrapped physical lines — in prose. Never just the citation's
   * physical line on its own, since a sentence or a wrapped paragraph routinely spans several. */
  acknowledgementScope: string;
}

/** `repo#number` or `owner/repo#number`, e.g. `web-jam-tools#1018` or
 * `WebJamApps/web-jam-tools#1018`. Requires a repo token directly adjacent to `#` (no space), so
 * a bare `#1018` (a same-repo GitHub auto-close reference, not a citation) never matches. */
const REPO_NUMBER_CITATION_REGEX =
  /\b([A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?)#(\d+)/g;

/** `https://github.com/<owner>/<repo>/issues/<n>`. */
const ISSUE_URL_REGEX =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/g;

/** A straight-double-quoted title immediately following a citation (the convention this repo's
 * own citations use throughout: `repo#number "title"`). */
const QUOTED_TITLE_AFTER_REGEX = /^\s*"([^"]*)"/;

const FENCE_LINE_REGEX = /^\s*(```|~~~)/;
const HEADING_LINE_REGEX = /^\s*#{1,6}\s+/;
const LIST_ITEM_START_REGEX = /^\s*(?:[-*+]|\d+\.)\s+/;

/** A contiguous run of prose lines belonging to one paragraph or one list item — the unit
 * `computeAcknowledgementScope` joins into a single logical string before sentence-splitting. */
interface ProseBlock {
  startLine: number;
  endLine: number;
  lines: string[];
}

/**
 * Groups the document's lines into prose blocks for sentence-scoped acknowledgement
 * (web-jam-tools#1025 follow-up). A block ends at a blank line, a heading, a fenced code-block
 * boundary, a table-row line, or the start of a new list item — matching the boundaries a reader
 * would recognize as "this is a different unit of prose". A list item's own bullet/number line
 * and its indented continuation lines join into one block; a plain paragraph's hard-wrapped lines
 * join the same way. Table rows are deliberately excluded from every block: a citation on a table
 * row is scoped to its own cell instead (see `computeAcknowledgementScope`), never merged with
 * surrounding prose.
 */
function computeProseBlocks(lines: string[]): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  let current: { startLine: number; lines: string[] } | null = null;
  let inCodeBlock = false;

  const flush = () => {
    if (current && current.lines.length > 0) {
      blocks.push({
        startLine: current.startLine,
        endLine: current.startLine + current.lines.length - 1,
        lines: current.lines,
      });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (FENCE_LINE_REGEX.test(line)) {
      flush();
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const trimmed = line.trim();

    if (trimmed === "" || HEADING_LINE_REGEX.test(line) || trimmed.startsWith("|")) {
      flush();
      continue;
    }

    if (LIST_ITEM_START_REGEX.test(line)) {
      flush();
      current = { startLine: lineNum, lines: [line] };
      continue;
    }

    if (!current) {
      current = { startLine: lineNum, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }

  flush();
  return blocks;
}

function findProseBlock(blocks: ProseBlock[], lineNum: number): ProseBlock | undefined {
  return blocks.find((b) => lineNum >= b.startLine && lineNum <= b.endLine);
}

/** Backtick code-span ranges within a single logical (possibly block-joined) string — a simple
 * paired-backtick scan, not the full CommonMark run-length rule `lint_doc.ts` implements, because
 * sentence-splitting only needs "is this period inside `...`", not exact span boundaries for
 * banned-phrase matching. */
function computeCodeSpanRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      const close = text.indexOf("`", i + 1);
      if (close === -1) break;
      ranges.push({ start: i, end: close + 1 });
      i = close + 1;
    } else {
      i++;
    }
  }
  return ranges;
}

/** A small, fixed list of common abbreviations whose trailing period must not be read as a
 * sentence terminator — "however is simplest and testable" per web-jam-tools#1025 follow-up: a
 * closed, enumerated denylist matched against the text immediately before the candidate period,
 * the same shape `lint_doc.ts`'s own hedge-phrase list uses rather than a general NLP approach. */
const ABBREVIATION_BEFORE_PERIOD_REGEX = /\b(?:e\.g|i\.e|etc|vs|approx)\.$/i;

/** A sentence found by `splitIntoSentences`, carrying its `[start, end)` character offsets in the
 * text it was split from — needed so a repeated citation (the exact same `repo#number` text
 * appearing more than once in the same block, e.g. two mentions of the same issue on adjacent
 * physical lines) resolves to the sentence it actually sits in rather than always the first
 * textual match. */
interface Sentence {
  text: string;
  start: number;
  end: number;
}

/**
 * Splits a logical (block-joined) string into sentences on `.`, `!`, or `?` followed by
 * whitespace or end-of-string — never on that same punctuation followed immediately by a
 * non-whitespace character, which is what already keeps a version/decimal number like `1.38.15`
 * from splitting (its internal periods are each immediately followed by a digit, never
 * whitespace, so they are never even candidate terminators). Two further exceptions apply to a
 * candidate terminator that IS followed by whitespace: one sitting inside a backtick code span
 * (e.g. `` `hooks/lib/opus_gate.ts` `` or `` `Bash|mcp__.*` ``), and one ending a short fixed
 * list of common abbreviations (`e.g.`, `i.e.`, `etc.`, `vs.`, `approx.`) — neither ends a
 * sentence.
 */
function splitIntoSentences(text: string): Sentence[] {
  const codeRanges = computeCodeSpanRanges(text);
  const isInCodeSpan = (idx: number) => codeRanges.some((r) => idx >= r.start && idx < r.end);

  const rawSentences: Array<{ start: number; end: number }> = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (isInCodeSpan(i)) continue;

    const next = i + 1 < text.length ? text[i + 1] : undefined;
    const followedByBoundary = next === undefined || /\s/.test(next);
    if (!followedByBoundary) continue;

    if (ch === "." && ABBREVIATION_BEFORE_PERIOD_REGEX.test(text.slice(0, i + 1))) {
      continue;
    }

    rawSentences.push({ start, end: i + 1 });
    start = i + 1;
  }

  if (start < text.length) {
    rawSentences.push({ start, end: text.length });
  }

  return rawSentences
    .map(({ start: s, end: e }) => ({ text: text.slice(s, e).trim(), start: s, end: e }))
    .filter((s) => s.text.length > 0);
}

/** Maps a match position within one physical (untrimmed) line of a prose block to its absolute
 * offset in that block's joined-and-trimmed text, so the right sentence can be found by position
 * rather than by re-searching for the citation's text (which breaks when the same citation text
 * appears more than once in the block — see `Sentence` above). */
function buildBlockTextWithLineOffsets(
  block: ProseBlock,
): { text: string; lineTextOffset: Map<number, number>; lineLeadingStrip: Map<number, number> } {
  let text = "";
  const lineTextOffset = new Map<number, number>();
  const lineLeadingStrip = new Map<number, number>();

  for (let idx = 0; idx < block.lines.length; idx++) {
    const rawLine = block.lines[idx];
    const trimmedLine = rawLine.trim();
    const leadingStripped = rawLine.length - rawLine.trimStart().length;
    const lineNum = block.startLine + idx;

    if (idx > 0) text += " ";
    lineTextOffset.set(lineNum, text.length);
    lineLeadingStrip.set(lineNum, leadingStripped);
    text += trimmedLine;
  }

  return { text, lineTextOffset, lineLeadingStrip };
}

/**
 * Resolves the acknowledgement-check scope for one citation (web-jam-tools#1025 follow-up):
 * inside a table row, the citation's own cell (an adjacent cell saying "closed" does not
 * acknowledge it); in prose, the sentence carrying the citation, assembled across whatever
 * hard-wrapped physical lines that sentence spans and located by the citation's actual position
 * (not by re-searching its text, so a citation repeated verbatim elsewhere in the same block
 * doesn't get mismatched to the wrong sentence). Falls back to the citation's own physical line
 * if no narrower scope can be resolved (e.g. a citation sitting directly in a heading).
 */
function computeAcknowledgementScope(
  line: string,
  matchIndex: number,
  matchText: string,
  isTableLine: boolean,
  proseBlock: ProseBlock | undefined,
  lineNum: number,
): string {
  if (isTableLine) {
    const cells = splitTableRowCells(line);
    const cell = cells.find((c) => c.includes(matchText));
    return cell ?? line.trim();
  }

  if (!proseBlock) {
    return line.trim();
  }

  const { text, lineTextOffset, lineLeadingStrip } = buildBlockTextWithLineOffsets(proseBlock);
  const lineOffset = lineTextOffset.get(lineNum);
  const leadingStripped = lineLeadingStrip.get(lineNum);

  if (lineOffset === undefined || leadingStripped === undefined) {
    return text;
  }

  const absoluteStart = lineOffset + (matchIndex - leadingStripped);
  const absoluteEnd = absoluteStart + matchText.length;

  const sentences = splitIntoSentences(text);
  const sentence = sentences.find((s) => absoluteStart >= s.start && absoluteEnd <= s.end);
  return sentence?.text ?? text;
}

/**
 * Extracts every `repo#number`, `owner/repo#number`, and GitHub issue URL citation from a design
 * document, each with its 1-indexed line number, (if present) the title quoted beside it, and its
 * acknowledgement scope (see `computeAcknowledgementScope`). Skips fenced code blocks, matching
 * `lint_doc.ts`'s convention for the same reason: a citation used only as a formatting example
 * inside a code span is not a live citation.
 */
export function extractCitations(
  content: string,
  defaultRepo = "WebJamApps/web-jam-tools",
): ParsedCitation[] {
  const lines = content.split(/\r?\n/);
  const citations: ParsedCitation[] = [];
  const proseBlocks = computeProseBlocks(lines);
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (FENCE_LINE_REGEX.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const isTableLine = line.trim().startsWith("|");
    const proseBlock = isTableLine ? undefined : findProseBlock(proseBlocks, lineNum);

    const addCitation = (target: IssueTarget, matchIndex: number, matchText: string) => {
      const after = line.slice(matchIndex + matchText.length);
      const titleMatch = after.match(QUOTED_TITLE_AFTER_REGEX);
      citations.push({
        repo: target.repo,
        number: target.number,
        line: lineNum,
        lineContent: line,
        quotedTitle: titleMatch ? titleMatch[1] : undefined,
        acknowledgementScope: computeAcknowledgementScope(
          line,
          matchIndex,
          matchText,
          isTableLine,
          proseBlock,
          lineNum,
        ),
      });
    };

    for (const m of line.matchAll(REPO_NUMBER_CITATION_REGEX)) {
      const target = parseIssueTarget(`${m[1]}#${m[2]}`, defaultRepo);
      if (!target || m.index === undefined) continue;
      addCitation(target, m.index, m[0]);
    }

    for (const m of line.matchAll(ISSUE_URL_REGEX)) {
      if (m.index === undefined) continue;
      addCitation({ repo: `${m[1]}/${m[2]}`, number: parseInt(m[3], 10) }, m.index, m[0]);
    }
  }

  return citations;
}

export interface CitationLookup {
  title?: string;
  state?: "OPEN" | "CLOSED";
  /** Present when the lookup could not be completed for this citation — the check must refuse
   * (fail closed) rather than treat it as passing. */
  error?: string;
}

export type CitationLookupFn = (
  targets: Array<{ repo: string; number: number }>,
) => Promise<Map<string, CitationLookup>>;

interface GraphQlIssueField {
  number?: number;
  title?: string;
  state?: string;
}

interface GraphQlError {
  type?: string;
  path?: Array<string | number>;
  message?: string;
}

interface GraphQlResponse {
  data?: {
    repository?: Record<string, GraphQlIssueField | null> | null;
  };
  errors?: GraphQlError[];
}

/** GraphQL aliases for an issue number's issue-shaped and pull-request-shaped lookups; aliases
 * must start with a letter. A citation's number may name either — GitHub shares one number
 * sequence between Issues and Pull Requests in a repo, and design documents legitimately cite
 * both the same way (`repo#number`), so both are requested and whichever resolves wins. */
function issueAliasFor(n: number): string {
  return `i${n}`;
}
function pullRequestAliasFor(n: number): string {
  return `p${n}`;
}

/** Maps a Pull Request's raw GraphQL `state` (OPEN / CLOSED / MERGED) to the same two-value
 * shape an Issue's state already uses: MERGED and CLOSED both count as closed for the
 * acknowledgement check (a merged PR is exactly as "no longer open work" as a closed one), and
 * only OPEN counts as open. */
function mapPullRequestState(rawState: string): "OPEN" | "CLOSED" {
  const upper = rawState.toUpperCase();
  return upper === "CLOSED" || upper === "MERGED" ? "CLOSED" : "OPEN";
}

/**
 * Looks up the live `state` and `title` of every cited issue-or-pull-request via `gh api
 * graphql`, batched one network call per distinct repo (every number cited in that repo gets an
 * issue-shaped AND a pull-request-shaped aliased field in a single query) rather than one call
 * per citation. Fails closed per citation: a repo that cannot be resolved, a command that errors
 * or times out, unparseable output, or a number that resolves as NEITHER an issue nor a pull
 * request all produce a `CitationLookup` with `error` set — never a silent "not found" that could
 * be mistaken for "resolved, and it's fine" (the same fail-closed shape as
 * `DesignDocResolutionRefusal` in gate1.ts, web-jam-tools#942).
 */
export async function defaultLookupCitations(
  targets: Array<{ repo: string; number: number }>,
  runner: CommandRunner = defaultCommandRunner,
): Promise<Map<string, CitationLookup>> {
  const results = new Map<string, CitationLookup>();

  const byRepo = new Map<string, Set<number>>();
  for (const t of targets) {
    if (!byRepo.has(t.repo)) byRepo.set(t.repo, new Set());
    byRepo.get(t.repo)!.add(t.number);
  }

  for (const [repo, numbers] of byRepo) {
    const key = (n: number) => `${repo}#${n}`;
    const slashIdx = repo.indexOf("/");

    if (slashIdx === -1 || slashIdx === 0 || slashIdx === repo.length - 1) {
      for (const n of numbers) {
        results.set(key(n), {
          error: `Repo "${repo}" could not be resolved (expected "owner/repo")`,
        });
      }
      continue;
    }

    const owner = repo.slice(0, slashIdx);
    const name = repo.slice(slashIdx + 1);

    const fields = Array.from(numbers)
      .flatMap((n) => [
        `${issueAliasFor(n)}: issue(number: ${n}) { number title state }`,
        `${pullRequestAliasFor(n)}: pullRequest(number: ${n}) { number title state }`,
      ])
      .join("\n        ");
    const query = `query {
      repository(owner: "${owner}", name: "${name}") {
        ${fields}
      }
    }`;

    let cmdResult;
    try {
      cmdResult = await runner(["api", "graphql", "-f", `query=${query}`]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const n of numbers) {
        results.set(key(n), { error: `Lookup failed for ${repo}: ${msg}` });
      }
      continue;
    }

    // `gh api graphql` exits non-zero whenever the GraphQL response carries ANY error — even a
    // single field-level error (e.g. a citation naming a PR number, which the `issue()` field
    // cannot resolve — GitHub's GraphQL schema distinguishes Issues from Pull Requests) sitting
    // alongside perfectly good data for every other field in the same batched query. Parsing
    // stdout regardless of exit code, rather than treating a non-zero exit as a whole-repo
    // failure, is what keeps one bad citation from poisoning every other citation in the same
    // repo's batch.
    let parsed: GraphQlResponse | undefined;
    if (cmdResult.stdout.trim() !== "") {
      try {
        parsed = JSON.parse(cmdResult.stdout);
      } catch {
        parsed = undefined;
      }
    }

    if (!parsed) {
      const msg = cmdResult.stderr.trim() || `exit code ${cmdResult.code}`;
      for (const n of numbers) {
        results.set(key(n), { error: `Lookup failed for ${repo}: ${msg}` });
      }
      continue;
    }

    const repoData = parsed.data?.repository;
    if (!repoData) {
      const errMsg = parsed.errors && parsed.errors.length > 0
        ? parsed.errors.map((e) => e.message).filter(Boolean).join("; ")
        : cmdResult.stderr.trim() || `repository "${repo}" could not be resolved`;
      for (const n of numbers) {
        results.set(key(n), { error: errMsg || `repository "${repo}" could not be resolved` });
      }
      continue;
    }

    for (const n of numbers) {
      const iAlias = issueAliasFor(n);
      const pAlias = pullRequestAliasFor(n);
      const issueData = repoData[iAlias];
      const prData = repoData[pAlias];

      const issueResolved = issueData && typeof issueData.title === "string" &&
        typeof issueData.state === "string";
      const prResolved = prData && typeof prData.title === "string" &&
        typeof prData.state === "string";

      if (issueResolved) {
        results.set(key(n), {
          title: issueData!.title,
          state: issueData!.state!.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
        });
        continue;
      }

      if (prResolved) {
        results.set(key(n), {
          title: prData!.title,
          state: mapPullRequestState(prData!.state!),
        });
        continue;
      }

      // Neither an issue nor a pull request of this number exists (or GraphQL couldn't resolve
      // either) — refuse, naming whichever field error is available.
      const fieldError = parsed.errors?.find((e) =>
        Array.isArray(e.path) && (e.path.includes(iAlias) || e.path.includes(pAlias))
      );
      results.set(key(n), {
        error: fieldError?.message ?? `Issue or pull request ${repo}#${n} could not be resolved`,
      });
    }
  }

  return results;
}

export type CitationViolationRule =
  | "drifted-citation-title"
  | "unacknowledged-closed-citation"
  | "unresolved-citation";

export interface CitationViolation {
  rule: CitationViolationRule;
  message: string;
  line?: number;
  lineContent?: string;
}

export interface VerifyCitationsResult {
  docPath: string;
  valid: boolean;
  violations: CitationViolation[];
}

export interface VerifyCitationsOptions {
  defaultRepo?: string;
  lookupImpl?: CitationLookupFn;
}

const CLOSED_WORD_REGEX = /\b(?:closed|merged)\b/i;

/**
 * Checks a design document's citations for liveness (web-jam-tools#1025): every cited issue or
 * pull request's live title must match a title quoted beside it, and every closed (or merged)
 * citation must be acknowledged as closed within its acknowledgement scope — its own table CELL
 * inside a table, or its own SENTENCE (assembled across hard-wrapped physical lines) in prose.
 * Violation messages still report the citation's own physical line number regardless of how wide
 * its scope was. A citation whose lookup cannot be completed is never treated as passing — it
 * becomes its own violation (`unresolved-citation`), so `valid` is `false` and the caller can tell
 * a refusal from a clean pass. A document with no citations at all passes without ever calling
 * `lookupImpl` — no network access, matching the production shape of most `design:lint-doc`-clean
 * fixtures.
 */
export async function verifyCitations(
  content: string,
  docPath = "",
  options: VerifyCitationsOptions = {},
): Promise<VerifyCitationsResult> {
  const defaultRepo = options.defaultRepo ?? "WebJamApps/web-jam-tools";
  const citations = extractCitations(content, defaultRepo);

  if (citations.length === 0) {
    return { docPath, valid: true, violations: [] };
  }

  const lookup = options.lookupImpl ?? defaultLookupCitations;
  const uniqueTargets = Array.from(
    new Map(
      citations.map((c) => [`${c.repo}#${c.number}`, { repo: c.repo, number: c.number }]),
    ).values(),
  );

  const results = await lookup(uniqueTargets);
  const violations: CitationViolation[] = [];

  for (const citation of citations) {
    const key = `${citation.repo}#${citation.number}`;
    const result = results.get(key);

    if (!result || result.error) {
      violations.push({
        rule: "unresolved-citation",
        message: `Could not resolve citation ${key} at line ${citation.line}: ${
          result?.error ?? "no lookup result returned"
        }`,
        line: citation.line,
        lineContent: citation.lineContent,
      });
      continue;
    }

    if (
      citation.quotedTitle !== undefined && result.title !== undefined &&
      citation.quotedTitle !== result.title
    ) {
      violations.push({
        rule: "drifted-citation-title",
        message:
          `Citation ${key} at line ${citation.line} quotes title "${citation.quotedTitle}" but the live title is "${result.title}"`,
        line: citation.line,
        lineContent: citation.lineContent,
      });
    }

    if (result.state === "CLOSED" && !CLOSED_WORD_REGEX.test(citation.acknowledgementScope)) {
      violations.push({
        rule: "unacknowledged-closed-citation",
        message:
          `Citation ${key} at line ${citation.line} is closed but its sentence (or table cell) does not acknowledge it as closed`,
        line: citation.line,
        lineContent: citation.lineContent,
      });
    }
  }

  return { docPath, valid: violations.length === 0, violations };
}

/** Reads and checks a design document file's citations from disk. */
export async function verifyCitationsFile(
  filePath: string,
  options: VerifyCitationsOptions = {},
): Promise<VerifyCitationsResult> {
  if (!filePath || filePath.trim() === "") {
    throw new Error("Design document path is required");
  }

  const absPath = path.resolve(expandHome(filePath.trim()));

  let content: string;
  try {
    content = await Deno.readTextFile(absPath);
  } catch (err) {
    throw new Error(
      `Design document not found or cannot be read at ${absPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (content.trim() === "") {
    throw new Error(`Design document at ${absPath} is empty`);
  }

  return verifyCitations(content, absPath, options);
}

/**
 * CLI runner for `deno task design:verify-citations <doc.md>`.
 *
 * Exit codes:
 *   0  Every citation resolved and passed (or the document cites nothing).
 *   1  At least one citation resolved but failed (drifted title / unacknowledged closed issue).
 *   2  REFUSED — at least one citation's lookup could not be completed.
 */
export async function runVerifyCitationsCli(
  args: string[],
  options: VerifyCitationsOptions = {},
): Promise<number> {
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
    console.log(`Usage: deno task design:verify-citations <doc.md> [options]

Reads every issue or pull request a design document cites (repo#number, owner/repo#number, or a
GitHub issue URL) and checks it against the live issue or pull request:
  - Fails if the document quotes a title beside a citation and the live title differs.
  - Fails if the cited issue is CLOSED (or the cited pull request is CLOSED or MERGED) and the
    sentence carrying the citation does not say "closed" or "merged".
  - REFUSES (exit 2) rather than passing when a lookup cannot be completed — the call errors,
    times out, is rate-limited, returns unparseable data, names a repo that cannot be resolved, or
    the number names neither an issue nor a pull request.

Arguments:
  <doc.md>        Path to design document markdown file

Options:
  --doc <path>    Explicit design document path
  -j, --json      Output result as JSON
  -h, --help      Show this help message
`);
    return 0;
  }

  const docPath = flags.doc || (flags._.length > 0 ? String(flags._[0]) : "");
  if (!docPath) {
    console.error("Error: Missing required design document path.");
    console.error("Usage: deno task design:verify-citations <doc.md>");
    return 1;
  }

  try {
    const result = await verifyCitationsFile(docPath, options);

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.valid) {
      console.log(
        `[design:verify-citations] PASS: ${result.docPath} — every citation resolved and passed.`,
      );
    } else {
      console.error(
        `[design:verify-citations] FAIL: ${result.docPath} has ${result.violations.length} violation(s):`,
      );
      for (const v of result.violations) {
        const location = v.line ? ` (line ${v.line})` : "";
        console.error(`  - [${v.rule}]${location} ${v.message}`);
      }
    }

    if (result.valid) return 0;
    const hasUnresolved = result.violations.some((v) => v.rule === "unresolved-citation");
    return hasUnresolved ? 2 : 1;
  } catch (err) {
    console.error(
      `[design:verify-citations] Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}
