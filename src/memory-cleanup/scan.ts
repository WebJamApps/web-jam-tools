// src/memory-cleanup/scan.ts — web-jam-tools#1166
//
// Deterministic, no-model mechanical checks for /memory-cleanup Phase 1,
// covering surfaces 1 (`~/.claude/projects/*/memory`), 6
// (`~/Dropbox/web-jam-llms/{agy,claude-opus,claude-fable}-tasks.txt`) and 10
// (`~/.claude/shared-memory`). Mirrors the `src/memory-index/generator.ts` +
// `cli.ts` split and reuses that module's `scanMemoryDirectory` /
// `parseMemoryFile` / `generateMemoryIndex` so the two tools never disagree
// about what a "memory file" is. Same precedent as
// `scripts/drive-cleanup-prepass.sh`: a deterministic pre-pass resolves
// everything rule-shaped so the scan subagent only has to make judgment
// calls the JSON doesn't already answer.
//
// STRICTLY READ-ONLY: this module never writes, moves, or deletes anything.
// The only external process it shells out to is `gh` (issue/PR state
// lookups), always through an injectable `CommandRunner` so tests never hit
// the network.

import { join } from "@std/path";
import {
  type MemoryEntry,
  scanMemoryDirectory,
  type SkippedMemoryFile,
} from "../memory-index/generator.ts";
import { ACTIVE_REPOS, REPO_OWNER } from "../flash-issues/types.ts";

// --- gh command plumbing (injectable so tests never hit the network) ---

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[]) => Promise<CommandResult>;

/** The real runner: shells out to `gh` via `Deno.Command`. */
export const runGhCommand: CommandRunner = async (args: string[]): Promise<CommandResult> => {
  const cmd = new Deno.Command("gh", { args, stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
};

export interface GhRef {
  repo: string;
  number: number;
}

export interface GhRefLookupOk {
  ok: true;
  kind: "issue" | "pr";
  state: string;
}

export interface GhRefLookupErr {
  ok: false;
  reason: string;
}

export type GhRefLookupResult = GhRefLookupOk | GhRefLookupErr;

/**
 * Resolves one `repo#number` citation's live state. Tries `gh issue view`
 * first, falls back to `gh pr view` (numbers share one namespace per repo,
 * and a memory/queue line rarely says which kind it is). A failure of BOTH
 * lookups is returned as an explicit `{ ok: false, reason }` — never thrown,
 * never silently swallowed — so the caller can surface it as an `error`
 * finding rather than dropping it or reporting the surface clean.
 */
export async function lookupGhRef(
  ref: GhRef,
  runner: CommandRunner,
): Promise<GhRefLookupResult> {
  const fullRepo = `${REPO_OWNER}/${ref.repo}`;
  const issueRes = await runner([
    "issue",
    "view",
    String(ref.number),
    "--repo",
    fullRepo,
    "--json",
    "state",
  ]);
  if (issueRes.code === 0) {
    try {
      const parsed = JSON.parse(issueRes.stdout) as { state: string };
      return { ok: true, kind: "issue", state: parsed.state };
    } catch (err) {
      return {
        ok: false,
        reason: `gh issue view ${fullRepo}#${ref.number} returned unparseable JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  const prRes = await runner([
    "pr",
    "view",
    String(ref.number),
    "--repo",
    fullRepo,
    "--json",
    "state",
  ]);
  if (prRes.code === 0) {
    try {
      const parsed = JSON.parse(prRes.stdout) as { state: string };
      return { ok: true, kind: "pr", state: parsed.state };
    } catch (err) {
      return {
        ok: false,
        reason: `gh pr view ${fullRepo}#${ref.number} returned unparseable JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  return {
    ok: false,
    reason: `gh issue view ${fullRepo}#${ref.number} failed (${
      issueRes.stderr.trim() || `exit ${issueRes.code}`
    }); gh pr view ${fullRepo}#${ref.number} failed (${
      prRes.stderr.trim() || `exit ${prRes.code}`
    })`,
  };
}

// --- citation extraction (repo#number, gated to the known repo roster) ---

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CITATION_RE = new RegExp(
  `\\b(${ACTIVE_REPOS.map(escapeRegExp).join("|")})#(\\d+)\\b`,
  "g",
);

/** Extracts every `repo#number` citation (gated to `ACTIVE_REPOS`), deduped. */
export function extractGhRefs(text: string): GhRef[] {
  const seen = new Map<string, GhRef>();
  for (const match of text.matchAll(CITATION_RE)) {
    const repo = match[1];
    const number = Number(match[2]);
    const key = `${repo}#${number}`;
    if (!seen.has(key)) {
      seen.set(key, { repo, number });
    }
  }
  return [...seen.values()];
}

// --- dangling [[link]] extraction ---

const LINK_RE = /\[\[([a-zA-Z0-9_-]+)\]\]/g;

/** Extracts every `[[slug]]` referenced in `text`, deduped, in order seen. */
export function extractLinkedSlugs(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(LINK_RE)) {
    seen.add(match[1]);
  }
  return [...seen];
}

function isSlugChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 45 // -
  );
}

/** True if `slug` appears in `haystack` as a whole token (not as part of a longer slug). */
export function containsWholeSlug(haystack: string, slug: string): boolean {
  if (slug.length === 0) return false;
  let pos = 0;
  while ((pos = haystack.indexOf(slug, pos)) !== -1) {
    const prevChar = pos > 0 ? haystack[pos - 1] : "";
    const nextChar = pos + slug.length < haystack.length ? haystack[pos + slug.length] : "";
    const prevOk = prevChar === "" || !isSlugChar(prevChar);
    const nextOk = nextChar === "" || !isSlugChar(nextChar);
    if (prevOk && nextOk) {
      return true;
    }
    pos += 1;
  }
  return false;
}

// --- findings & surface result shapes ---

export type FindingStatus = "flag" | "error" | "info";

export interface Finding {
  kind:
    | "unparseable-file"
    | "dangling-link"
    | "missing-from-index"
    | "index-file-missing"
    | "closed-issue"
    | "merged-pr"
    | "closed-pr"
    | "gh-lookup-error"
    | "queue-file-absent";
  status: FindingStatus;
  detail: string;
  file?: string;
  repo?: string;
  number?: number;
}

export interface SurfaceCheckedResult {
  surface: 1 | 6 | 10;
  status: "checked";
  dir?: string;
  paths?: string[];
  findings: Finding[];
  /** Mechanical metrics handed to the subagent as established fact. */
  metrics: {
    fileCount: number;
    skippedCount: number;
    inboundLinkCounts: Record<string, number>;
  };
}

export interface SurfaceErrorResult {
  surface: 1 | 6 | 10;
  status: "error";
  reason: string;
}

export type SurfaceResult = SurfaceCheckedResult | SurfaceErrorResult;

// --- surfaces 1 & 10: a memory directory + its MEMORY.md ---

async function readMemoryFileContents(dirPath: string): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for await (const entry of Deno.readDir(dirPath)) {
    if (!entry.isFile || entry.name === "MEMORY.md" || !entry.name.endsWith(".md")) {
      continue;
    }
    contents.set(entry.name, await Deno.readTextFile(join(dirPath, entry.name)));
  }
  return contents;
}

/**
 * Runs every mechanical check for one memory directory (surface 1 or 10):
 * index↔file sync (missing-from-index, by whole-token slug presence — see
 * module doc for why this is a set-membership check, not a byte-for-byte
 * `generateMemoryIndex` comparison), the null-parse list, a dangling-`[[link]]`
 * slug diff, per-file inbound link counts, and live `gh` state for every
 * `project`-typed memory that cites a `repo#number`.
 */
export async function scanMemoryIndexSurface(
  surface: 1 | 10,
  dirPath: string,
  runner: CommandRunner,
): Promise<SurfaceResult> {
  let contents: Map<string, string>;
  let entries: MemoryEntry[];
  let skipped: SkippedMemoryFile[];
  try {
    contents = await readMemoryFileContents(dirPath);
    ({ entries, skipped } = await scanMemoryDirectory(dirPath));
  } catch (err) {
    return {
      surface,
      status: "error",
      reason: `could not read memory directory ${dirPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const findings: Finding[] = [];
  const actualSlugs = [...contents.keys()].map((f) => f.replace(/\.md$/, ""));

  // (b) unparseable files
  for (const skip of skipped) {
    findings.push({
      kind: "unparseable-file",
      status: "flag",
      detail: `${skip.filename}: ${skip.reason}`,
      file: skip.filename,
    });
  }

  // (c) dangling [[link]] slug diff, (d) inbound link counts
  const actualSlugSet = new Set(actualSlugs);
  const inboundLinkCounts: Record<string, number> = {};
  for (const slug of actualSlugs) inboundLinkCounts[slug] = 0;
  const danglingSeen = new Set<string>();
  for (const [filename, content] of contents) {
    for (const linkedSlug of extractLinkedSlugs(content)) {
      if (actualSlugSet.has(linkedSlug)) {
        inboundLinkCounts[linkedSlug] = (inboundLinkCounts[linkedSlug] ?? 0) + 1;
      } else if (!danglingSeen.has(linkedSlug)) {
        danglingSeen.add(linkedSlug);
        findings.push({
          kind: "dangling-link",
          status: "flag",
          detail: `[[${linkedSlug}]] referenced from ${filename} has no matching ${linkedSlug}.md`,
          file: filename,
        });
      }
    }
  }

  // (a) index↔file sync — whole-token slug membership against MEMORY.md text.
  // NOTE: this is deliberately NOT a byte-for-byte `generateMemoryIndex()`
  // comparison. A real MEMORY.md's line-wrapping can legitimately drift from
  // what the generator would emit today (see web-jam-tools#1166 PR — the
  // `-home-joshua` memory dir differs from the generator's output only in
  // where two long lines wrap, not in which slugs are present) while still
  // containing every slug. Reporting that wrapping drift as a "missing entry"
  // would be a false alarm; this check answers the question Phase 1 actually
  // needs answered: is every file's slug findable in the index text at all.
  const memoryMdPath = join(dirPath, "MEMORY.md");
  let memoryMdContent: string | null = null;
  try {
    memoryMdContent = await Deno.readTextFile(memoryMdPath);
  } catch (err) {
    findings.push({
      kind: "index-file-missing",
      status: "error",
      detail: `${memoryMdPath} could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
  if (memoryMdContent !== null) {
    for (const slug of actualSlugs) {
      if (!containsWholeSlug(memoryMdContent, slug)) {
        findings.push({
          kind: "missing-from-index",
          status: "flag",
          detail: `${slug}.md exists on disk but its slug does not appear in ${memoryMdPath}`,
          file: `${slug}.md`,
        });
      }
    }
  }

  // (e) live gh state for every project-typed memory citing repo#number
  const projectEntries = entries.filter((e) => e.type === "project");
  const refsByEntry = new Map<string, GhRef[]>();
  const allRefs = new Map<string, GhRef>();
  for (const entry of projectEntries) {
    const content = contents.get(entry.filename) ?? "";
    const refs = extractGhRefs(content);
    if (refs.length > 0) {
      refsByEntry.set(entry.filename, refs);
      for (const ref of refs) allRefs.set(`${ref.repo}#${ref.number}`, ref);
    }
  }
  const refStates = new Map<string, GhRefLookupResult>();
  for (const [key, ref] of allRefs) {
    refStates.set(key, await lookupGhRef(ref, runner));
  }
  for (const [filename, refs] of refsByEntry) {
    for (const ref of refs) {
      const key = `${ref.repo}#${ref.number}`;
      const result = refStates.get(key)!;
      if (!result.ok) {
        findings.push({
          kind: "gh-lookup-error",
          status: "error",
          detail: `${filename} cites ${key}: ${result.reason}`,
          file: filename,
          repo: ref.repo,
          number: ref.number,
        });
      } else if (result.kind === "issue" && result.state === "CLOSED") {
        findings.push({
          kind: "closed-issue",
          status: "flag",
          detail: `${filename} cites ${key}, a CLOSED issue`,
          file: filename,
          repo: ref.repo,
          number: ref.number,
        });
      } else if (result.kind === "pr" && result.state === "MERGED") {
        findings.push({
          kind: "merged-pr",
          status: "flag",
          detail: `${filename} cites ${key}, a MERGED pull request`,
          file: filename,
          repo: ref.repo,
          number: ref.number,
        });
      } else if (result.kind === "pr" && result.state === "CLOSED") {
        findings.push({
          kind: "closed-pr",
          status: "flag",
          detail: `${filename} cites ${key}, a CLOSED (unmerged) pull request`,
          file: filename,
          repo: ref.repo,
          number: ref.number,
        });
      }
    }
  }

  return {
    surface,
    status: "checked",
    dir: dirPath,
    findings,
    metrics: {
      fileCount: actualSlugs.length,
      skippedCount: skipped.length,
      inboundLinkCounts,
    },
  };
}

// --- surface 6: the Dropbox queue files ---

export const DEFAULT_QUEUE_FILENAMES = [
  "agy-tasks.txt",
  "claude-opus-tasks.txt",
  "claude-fable-tasks.txt",
] as const;

/**
 * Runs the mechanical check for surface 6: every `repo#number` citation on
 * every line of the given queue files, checked against live `gh` state.
 * A queue file simply not existing (several of these were retired) is
 * reported as an `info`-status finding, not an error — it's an expected,
 * verified fact, not a failed check.
 */
export async function scanQueueSurface(
  paths: string[],
  runner: CommandRunner,
): Promise<SurfaceResult> {
  const findings: Finding[] = [];
  const allRefs = new Map<string, GhRef>();
  const refsByFile = new Map<string, GhRef[]>();
  let filesRead = 0;

  for (const path of paths) {
    let content: string;
    try {
      content = await Deno.readTextFile(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        findings.push({
          kind: "queue-file-absent",
          status: "info",
          detail: `${path} does not exist (nothing to scan)`,
          file: path,
        });
        continue;
      }
      return {
        surface: 6,
        status: "error",
        reason: `could not read queue file ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    filesRead++;
    const refs = extractGhRefs(content);
    if (refs.length > 0) {
      refsByFile.set(path, refs);
      for (const ref of refs) allRefs.set(`${ref.repo}#${ref.number}`, ref);
    }
  }

  const refStates = new Map<string, GhRefLookupResult>();
  for (const [key, ref] of allRefs) {
    refStates.set(key, await lookupGhRef(ref, runner));
  }
  for (const [path, refs] of refsByFile) {
    for (const ref of refs) {
      const key = `${ref.repo}#${ref.number}`;
      const result = refStates.get(key)!;
      if (!result.ok) {
        findings.push({
          kind: "gh-lookup-error",
          status: "error",
          detail: `${path} references ${key}: ${result.reason}`,
          file: path,
          repo: ref.repo,
          number: ref.number,
        });
      } else if (result.kind === "issue" && result.state === "CLOSED") {
        findings.push({
          kind: "closed-issue",
          status: "flag",
          detail: `${path} references ${key}, a CLOSED issue`,
          file: path,
          repo: ref.repo,
          number: ref.number,
        });
      } else if (result.kind === "pr" && result.state === "MERGED") {
        findings.push({
          kind: "merged-pr",
          status: "flag",
          detail: `${path} references ${key}, a MERGED pull request`,
          file: path,
          repo: ref.repo,
          number: ref.number,
        });
      } else if (result.kind === "pr" && result.state === "CLOSED") {
        findings.push({
          kind: "closed-pr",
          status: "flag",
          detail: `${path} references ${key}, a CLOSED (unmerged) pull request`,
          file: path,
          repo: ref.repo,
          number: ref.number,
        });
      }
    }
  }

  return {
    surface: 6,
    status: "checked",
    paths,
    findings,
    metrics: {
      fileCount: filesRead,
      skippedCount: paths.length - filesRead,
      inboundLinkCounts: {},
    },
  };
}

// --- top-level scan ---

export interface MemoryCleanupScanResult {
  generatedAt: string;
  surfaces: SurfaceResult[];
}

export interface MemoryCleanupScanOptions {
  surface1Dir: string;
  surface10Dir: string;
  surface6Paths: string[];
  runner?: CommandRunner;
}

export async function runMemoryCleanupScan(
  options: MemoryCleanupScanOptions,
): Promise<MemoryCleanupScanResult> {
  const runner = options.runner ?? runGhCommand;
  const surfaces: SurfaceResult[] = [
    await scanMemoryIndexSurface(1, options.surface1Dir, runner),
    await scanQueueSurface(options.surface6Paths, runner),
    await scanMemoryIndexSurface(10, options.surface10Dir, runner),
  ];
  return {
    generatedAt: new Date().toISOString(),
    surfaces,
  };
}
