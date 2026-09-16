// src/design-issue/verify_citations.ts
// Citation liveness checker for design documents (web-jam-tools#1025): reads every issue a
// design document cites and fails on a title that no longer matches, or on a closed issue the
// document does not acknowledge as closed. Network-dependent — kept out of lint_doc.ts, which
// must stay offline and deterministic so the existing test suite never reaches the network
// (web-jam-tools#1025 non-goal).

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import type { CommandRunner } from "../flash-issues/types.ts";
import { defaultCommandRunner } from "./candidates.ts";
import { expandHome } from "./gate1.ts";
import { type IssueTarget, parseIssueTarget } from "./stale_bodies.ts";

export interface ParsedCitation {
  repo: string;
  number: number;
  line: number;
  lineContent: string;
  /** The title quoted immediately after the citation on the same line, e.g.
   * `web-jam-tools#1018 "hooks/agy-model-guard: ..."` — undefined when the citation carries no
   * quoted title, in which case the title-drift check does not apply to that citation. */
  quotedTitle?: string;
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

/**
 * Extracts every `repo#number`, `owner/repo#number`, and GitHub issue URL citation from a design
 * document, each with its 1-indexed line number and (if present) the title quoted beside it.
 * Skips fenced code blocks, matching `lint_doc.ts`'s convention for the same reason: a citation
 * used only as a formatting example inside a code span is not a live citation.
 */
export function extractCitations(
  content: string,
  defaultRepo = "WebJamApps/web-jam-tools",
): ParsedCitation[] {
  const lines = content.split(/\r?\n/);
  const citations: ParsedCitation[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const addCitation = (target: IssueTarget, matchIndex: number, matchLength: number) => {
      const after = line.slice(matchIndex + matchLength);
      const titleMatch = after.match(QUOTED_TITLE_AFTER_REGEX);
      citations.push({
        repo: target.repo,
        number: target.number,
        line: lineNum,
        lineContent: line,
        quotedTitle: titleMatch ? titleMatch[1] : undefined,
      });
    };

    for (const m of line.matchAll(REPO_NUMBER_CITATION_REGEX)) {
      const target = parseIssueTarget(`${m[1]}#${m[2]}`, defaultRepo);
      if (!target || m.index === undefined) continue;
      addCitation(target, m.index, m[0].length);
    }

    for (const m of line.matchAll(ISSUE_URL_REGEX)) {
      if (m.index === undefined) continue;
      addCitation({ repo: `${m[1]}/${m[2]}`, number: parseInt(m[3], 10) }, m.index, m[0].length);
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

/** GraphQL alias for an issue number; aliases must start with a letter. */
function aliasFor(n: number): string {
  return `i${n}`;
}

/**
 * Looks up the live `state` and `title` of every cited issue via `gh api graphql`, batched one
 * network call per distinct repo (every number cited in that repo is a separate aliased field in
 * a single query) rather than one call per citation. Fails closed per citation: a repo that
 * cannot be resolved, a command that errors or times out, unparseable output, or an issue number
 * GraphQL could not resolve all produce a `CitationLookup` with `error` set — never a silent
 * "not found" that could be mistaken for "resolved, and it's fine" (the same fail-closed shape as
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
      .map((n) => `${aliasFor(n)}: issue(number: ${n}) { number title state }`)
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
      const alias = aliasFor(n);
      const issueData = repoData[alias];

      if (
        !issueData || typeof issueData.title !== "string" || typeof issueData.state !== "string"
      ) {
        const fieldError = parsed.errors?.find((e) =>
          Array.isArray(e.path) && e.path.includes(alias)
        );
        results.set(key(n), {
          error: fieldError?.message ?? `Issue ${repo}#${n} could not be resolved`,
        });
        continue;
      }

      results.set(key(n), {
        title: issueData.title,
        state: issueData.state.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
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

const CLOSED_WORD_REGEX = /\bclosed\b/i;

/**
 * Checks a design document's citations for liveness (web-jam-tools#1025): every cited issue's
 * live title must match a title quoted beside it, and every closed cited issue must be
 * acknowledged as closed on the line that cites it (for a table row, the whole row is one line,
 * so "anywhere in that row" and "on that line" are the same check). A citation whose lookup
 * cannot be completed is never treated as passing — it becomes its own violation
 * (`unresolved-citation`), so `valid` is `false` and the caller can tell a refusal from a clean
 * pass. A document with no citations at all passes without ever calling `lookupImpl` — no network
 * access, matching the production shape of most `design:lint-doc`-clean fixtures.
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

    if (result.state === "CLOSED" && !CLOSED_WORD_REGEX.test(citation.lineContent)) {
      violations.push({
        rule: "unacknowledged-closed-citation",
        message:
          `Citation ${key} at line ${citation.line} is closed but the line does not acknowledge it as closed`,
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

Reads every issue a design document cites (repo#number, owner/repo#number, or a GitHub issue URL)
and checks it against the live issue:
  - Fails if the document quotes a title beside a citation and the live title differs.
  - Fails if the cited issue's live state is CLOSED and the citing line does not say "closed".
  - REFUSES (exit 2) rather than passing when a lookup cannot be completed — the call errors,
    times out, is rate-limited, returns unparseable data, or names a repo that cannot be resolved.

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
