// src/memory-cleanup/low_mark.ts — web-jam-tools#1242
// The memory half of the session-load cleanup: merge, move and ask-first removal of
// memories, guard-rule marking, and the after-run list with every part's size against
// its limit. The agent running /memory-cleanup makes the judgments and writes them to a
// plan file; this script does the file work and the checks.

import { parseArgs } from "@std/cli/parse-args";
import { dirname, isAbsolute, join, resolve } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { isValidSlug } from "../../scripts/consume_memory_rules.ts";
import { runCli as regenerateMemoryIndex } from "../memory-index/cli.ts";
import {
  computeSessionLoadReport,
  inspectBundledSkills,
  inspectSkillsDirectory,
  loadLimits,
  type PartLimit,
  type SessionLoadReportOptions,
} from "../session-load/report.ts";
import { ACTIVE_REPOS } from "../shared/repos.ts";

export const GUARD_KINDS = [
  "approval-gate",
  "deletion-guard",
  "credential-rule",
  "spending-rule",
] as const;
export type GuardKind = typeof GUARD_KINDS[number];

export interface MergeJudgment {
  keep: string;
  absorb: string[];
}

export interface MoveJudgment {
  slug: string;
  target_skill: string;
}

export interface RemovalJudgment {
  slug: string;
  reason: "hook-enforced" | "already-said";
  evidence: string;
}

export interface GuardJudgment {
  slug: string;
  kind: GuardKind;
}

/** The judgments the agent writes to a file; relative paths resolve against that file. */
export interface LowMarkPlan {
  skills_dir?: string;
  merges?: MergeJudgment[];
  moves?: MoveJudgment[];
  removals?: RemovalJudgment[];
  guards?: GuardJudgment[];
}

export type RowStatus = "merged" | "moved" | "archived" | "waiting" | "marked" | "refused";

export interface Row {
  status: RowStatus;
  slug: string;
  detail: string;
}

export interface LowMarkOptions {
  dir: string;
  plan: LowMarkPlan;
  skillsDir: string;
  /** Slugs Josh said yes to, row by row, for ask-first removals. */
  approved?: string[];
  dryRun?: boolean;
  report?: SessionLoadReportOptions;
}

export interface LowMarkResult {
  rows: Row[];
  partLines: string[];
  text: string;
  changed: boolean;
}

interface Memory {
  path: string;
  raw: string;
  body: string;
  description: string;
  guard: boolean;
  /** The frontmatter is there but cannot be parsed: treated like a guard rule, never touched. */
  unreadable: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const OPENS_FRONTMATTER = /^---[ \t]*(?:\r?\n|$)/;

/** The parsed frontmatter, `{}` when there is none, or `null` when it cannot be parsed. */
function readFrontmatter(raw: string): Record<string, unknown> | null {
  const match = raw.match(FRONTMATTER);
  // A header that opens with `---` but never closes is a broken block, not "no frontmatter".
  if (!match) return OPENS_FRONTMATTER.test(raw) ? null : {};
  try {
    const parsed = parseYaml(match[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function readMemory(dir: string, slug: string): Promise<Memory | null> {
  if (!isValidSlug(slug)) return null;
  const path = join(dir, `${slug}.md`);
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    return null;
  }
  const fm = readFrontmatter(raw);
  const metadata = fm?.metadata as Record<string, unknown> | null | undefined;
  return {
    path,
    raw,
    body: raw.replace(FRONTMATTER, ""),
    description: typeof fm?.description === "string" ? fm.description : "",
    guard: metadata?.guard === true,
    unreadable: fm === null,
  };
}

function words(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** True when every word of `needle` appears in `haystack`, in order, with nothing between. */
export function appearsWordForWord(haystack: string, needle: string): boolean {
  const wanted = words(needle);
  if (wanted === "") return false;
  return ` ${words(haystack)} `.includes(` ${wanted} `);
}

/**
 * Sets `metadata.guard: true` by updating the parsed frontmatter, so an existing
 * `guard: false` or an inline `metadata: {...}` never ends up with a duplicate key.
 * Throws when the frontmatter cannot be parsed or `metadata` is not a mapping.
 */
export function markGuardRaw(raw: string): string {
  const fm = readFrontmatter(raw);
  if (fm === null) throw new Error("frontmatter cannot be parsed");
  const match = raw.match(FRONTMATTER);
  if (!match) return `---\nmetadata:\n  guard: true\n---\n${raw}`;
  const current = fm.metadata ?? {};
  if (typeof current !== "object" || Array.isArray(current)) {
    throw new Error("frontmatter metadata is not a mapping");
  }
  const { guard: _old, ...rest } = current as Record<string, unknown>;
  const yaml = stringifyYaml({ ...fm, metadata: { guard: true, ...rest } });
  return raw.replace(FRONTMATTER, `---\n${yaml.trimEnd()}\n---\n`);
}

function appendMerged(keeperRaw: string, absorbSlug: string, absorbed: Memory): string {
  const description = absorbed.description ? `${absorbed.description}\n\n` : "";
  return `${keeperRaw.trimEnd()}\n\n## Merged from [[${absorbSlug}]]\n\n${description}${absorbed.body.trim()}\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function archiveMemory(dir: string, slug: string, dryRun: boolean): Promise<void> {
  const archiveDir = join(dir, "archive");
  const dest = join(archiveDir, `${slug}.md`);
  if (await exists(dest)) throw new Error(`memory/archive/${slug}.md already exists`);
  if (dryRun) return;
  await Deno.mkdir(archiveDir, { recursive: true });
  await Deno.rename(join(dir, `${slug}.md`), dest);
}

async function memoryFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".md") && entry.name !== "MEMORY.md") {
      files.push(entry.name);
    }
  }
  return files;
}

const number = (n: number): string => n.toLocaleString("en-US");

async function fileSize(path: string): Promise<number> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile ? stat.size : 0;
  } catch {
    return 0;
  }
}

function partLine(name: string, size: number, limit: PartLimit): string {
  const low = limit.lowMark === undefined ? "" : `low ${number(limit.lowMark)} · `;
  const state = size > limit.overMark ? "OVER" : "ok";
  return `  ${name.padEnd(22)}${number(size).padStart(8)}  ${low}over at ${
    number(limit.overMark)
  }  ${state}`;
}

async function partLines(
  dir: string,
  report: SessionLoadReportOptions,
): Promise<string[]> {
  const limits = await loadLimits(report.limitsPath);
  const home = report.homeDir ?? Deno.env.get("HOME") ?? "/home/joshua";
  const apps = report.webJamAppsDir ?? join(home, "WebJamApps");
  const indexPath = join(dir, "MEMORY.md");
  const lines = [
    partLine("memory index", await fileSize(indexPath), limits.memoryIndex),
    partLine(
      "global CLAUDE.md",
      await fileSize(report.globalClaudeMdPath ?? join(home, ".claude/CLAUDE.md")),
      limits.globalClaudeMd,
    ),
    partLine(
      "main rules",
      await fileSize(join(apps, "web-jam-tools/AGENTS.md")),
      limits.mainRules,
    ),
    partLine(
      "cross-AI rules",
      await fileSize(join(apps, "web-jam-tools/docs/cross-ai-rules.md")),
      limits.crossAiRules,
    ),
    partLine(
      "JaMmusic rules",
      await fileSize(join(apps, "JaMmusic/AGENTS.md")),
      limits.jammusicRules,
    ),
  ];
  for (const repo of ACTIVE_REPOS) {
    if (repo === "web-jam-tools" || repo === "JaMmusic") continue;
    lines.push(
      partLine(
        `${repo} rules`,
        await fileSize(join(apps, repo, "AGENTS.md")),
        limits.otherRepoRules,
      ),
    );
  }
  lines.push("", ...await skillLines(report, limits));
  const session = await computeSessionLoadReport({ ...report, memoryIndexPath: indexPath });
  lines.push("", ...session.text.split("\n"));
  return lines;
}

/** One line per surface for skill descriptions, plus the bundled skills Claude Code loads in full. */
async function skillLines(
  report: SessionLoadReportOptions,
  limits: Awaited<ReturnType<typeof loadLimits>>,
): Promise<string[]> {
  const home = report.homeDir ?? Deno.env.get("HOME") ?? "/home/joshua";
  const max = limits.skillDescription.overMark;
  const surfaces: [string, string][] = [
    ["Claude Code skills", report.claudeSkillsDir ?? join(home, ".claude/skills")],
    [
      "agy skills",
      report.agySkillsDir ?? join(home, ".gemini/config/plugins/webjam-tasks/skills"),
    ],
    ["Codex skills", report.codexSkillsDir ?? join(home, ".codex/skills")],
  ];
  const lines: string[] = [];
  for (const [name, path] of surfaces) {
    const found = await inspectSkillsDirectory(path, max);
    if (found.skills.length === 0) lines.push(`  ${name}: no skills installed`);
    for (const skill of found.skills) {
      lines.push(partLine(`${name}: ${skill.name}`, skill.size, limits.skillDescription));
    }
  }
  const bundled = await inspectBundledSkills(
    report.claudeSettingsPath ?? join(home, ".claude/settings.json"),
    limits.bundledSkills,
  );
  lines.push(
    `  ${"Claude Code bundled".padEnd(22)}${number(bundled).padStart(8)}  of ${
      number(limits.bundledSkills.totalCount)
    } load full text, none allowed  ${bundled > 0 ? "OVER" : "ok"}`,
  );
  return lines;
}

const HEADINGS: [RowStatus, string][] = [
  ["merged", "Merged"],
  ["moved", "Moved to a skill"],
  ["archived", "Archived"],
  ["waiting", "Waiting for Josh's yes"],
  ["marked", "Newly marked as guard rules"],
  ["refused", "Refused"],
];

function formatResult(rows: Row[], sizes: string[], dryRun: boolean): string {
  const out = [dryRun ? "Memory low mark — dry run, nothing written" : "Memory low mark — done"];
  for (const [status, heading] of HEADINGS) {
    const group = rows.filter((row) => row.status === status);
    out.push("", `${heading}: ${group.length === 0 ? "none" : group.length}`);
    for (const row of group) out.push(`  - ${row.slug} — ${row.detail}`);
  }
  out.push("", "Part sizes against their limits:", ...sizes);
  return out.join("\n");
}

export async function runLowMark(options: LowMarkOptions): Promise<LowMarkResult> {
  const { dir, plan, skillsDir } = options;
  const dryRun = options.dryRun ?? false;
  const approved = new Set(options.approved ?? []);
  const rows: Row[] = [];
  const claimed = new Set<string>();
  const guards = new Set<string>();
  let changed = false;

  const refuse = (slug: string, detail: string) => rows.push({ status: "refused", slug, detail });

  // A slug takes part in one row only; a guard rule takes part in none.
  const claim = async (slug: string): Promise<Memory | null> => {
    if (claimed.has(slug)) return refuse(slug, "already used by another row in this run"), null;
    const memory = await readMemory(dir, slug);
    if (!memory) return refuse(slug, "memory file not found"), null;
    if (memory.unreadable) {
      return refuse(slug, "frontmatter cannot be parsed: left untouched"), null;
    }
    if (memory.guard || guards.has(slug)) {
      return refuse(slug, "guard rule: never offered, merged, moved or removed"), null;
    }
    claimed.add(slug);
    return memory;
  };

  for (const { slug, kind } of plan.guards ?? []) {
    if (!(GUARD_KINDS as readonly string[]).includes(kind)) {
      refuse(slug, `unknown guard kind "${kind}"`);
      continue;
    }
    const memory = await readMemory(dir, slug);
    if (!memory) {
      refuse(slug, "memory file not found");
      continue;
    }
    // A classified guard stays protected for every later row, even when marking it fails.
    guards.add(slug);
    if (memory.unreadable) {
      refuse(slug, "frontmatter cannot be parsed: not marked, left untouched");
      continue;
    }
    if (memory.guard) continue;
    try {
      const marked = markGuardRaw(memory.raw);
      const persisted = readFrontmatter(marked);
      if ((persisted?.metadata as Record<string, unknown> | undefined)?.guard !== true) {
        throw new Error("guard flag did not persist");
      }
      if (!dryRun) await Deno.writeTextFile(memory.path, marked);
    } catch (error) {
      refuse(slug, `not marked: ${(error as Error).message}`);
      continue;
    }
    changed = true;
    rows.push({ status: "marked", slug, detail: kind });
  }

  for (const { keep, absorb } of plan.merges ?? []) {
    const keeper = await claim(keep);
    if (!keeper) continue;
    let merged = keeper.raw;
    const taken: string[] = [];
    for (const slug of absorb) {
      const absorbed = await claim(slug);
      if (!absorbed) continue;
      merged = appendMerged(merged, slug, absorbed);
      taken.push(slug);
    }
    if (taken.length === 0) {
      refuse(keep, "nothing to merge into it");
      continue;
    }
    try {
      for (const slug of taken) await archiveMemory(dir, slug, true);
      if (!dryRun) {
        await Deno.writeTextFile(keeper.path, merged);
        for (const slug of taken) await archiveMemory(dir, slug, false);
      }
      changed = true;
      rows.push({ status: "merged", slug: keep, detail: `absorbed ${taken.join(", ")}` });
    } catch (error) {
      refuse(keep, (error as Error).message);
    }
  }

  for (const { slug, target_skill } of plan.moves ?? []) {
    const memory = await claim(slug);
    if (!memory) continue;
    if (!isValidSlug(target_skill)) {
      refuse(slug, `invalid target skill "${target_skill}"`);
      continue;
    }
    let skillText: string;
    try {
      skillText = await Deno.readTextFile(join(skillsDir, target_skill, "SKILL.md"));
    } catch {
      refuse(slug, `skill ${target_skill} not found`);
      continue;
    }
    if (!appearsWordForWord(skillText, memory.body)) {
      refuse(slug, `text does not appear word for word in ${target_skill}; memory left in place`);
      continue;
    }
    try {
      await archiveMemory(dir, slug, dryRun);
      changed = true;
      rows.push({ status: "moved", slug, detail: `now in skill ${target_skill}` });
    } catch (error) {
      refuse(slug, (error as Error).message);
    }
  }

  for (const { slug, reason, evidence } of plan.removals ?? []) {
    const memory = await claim(slug);
    if (!memory) continue;
    const detail = `${
      reason === "hook-enforced" ? "a hook enforces it" : "already said elsewhere"
    }: ${evidence}`;
    if (!approved.has(slug)) {
      rows.push({ status: "waiting", slug, detail });
      continue;
    }
    try {
      await archiveMemory(dir, slug, dryRun);
      changed = true;
      rows.push({ status: "archived", slug, detail });
    } catch (error) {
      refuse(slug, (error as Error).message);
    }
  }

  if (changed && !dryRun) {
    const before = await memoryFiles(dir);
    // Every classified guard is kept out of the index run's archive, marked on disk or not.
    await regenerateMemoryIndex([
      "--dir",
      dir,
      ...[...guards].flatMap((slug) => ["--protect", slug]),
    ]);
    // The index run archives other completed checkpoints itself; name each one.
    const after = new Set(await memoryFiles(dir));
    for (const file of before) {
      if (after.has(file)) continue;
      const slug = file.replace(/\.md$/, "");
      if (rows.some((row) => row.slug === slug && row.status !== "refused")) continue;
      rows.push({
        status: "archived",
        slug,
        detail: "completed checkpoint, archived by the memory index run",
      });
    }
  }

  const sizes = await partLines(dir, options.report ?? {});
  return { rows, partLines: sizes, text: formatResult(rows, sizes, dryRun), changed };
}

function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return path.replace(/^~(?:\/|$)/, `${Deno.env.get("HOME") || "/home/joshua"}/`);
  }
  return path;
}

export async function runCli(args: string[]): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["dry-run", "help"],
    string: ["dir", "plan", "skills-dir", "approve"],
    collect: ["approve"],
  });

  if (flags.help) {
    console.log(
      "Usage: deno task memory-cleanup:run [--dry-run] [--dir <memory dir>] [--plan <file>] " +
        "[--skills-dir <dir>] [--approve <slug>]...",
    );
    console.log("Applies the agent's judgments (the plan file) to the memory folder.");
    console.log("--dry-run writes nothing. --approve <slug> is Josh's yes for one removal row.");
    return 0;
  }

  const dir = resolve(expandHome(flags.dir || "~/.claude/projects/-home-joshua/memory"));
  const planPath = resolve(expandHome(flags.plan || join(dir, "low-mark-plan.json")));
  let plan: LowMarkPlan;
  try {
    plan = JSON.parse(await Deno.readTextFile(planPath));
  } catch (error) {
    console.error(`Cannot read the plan file ${planPath}: ${(error as Error).message}`);
    return 1;
  }

  const planSkills = plan.skills_dir && !isAbsolute(plan.skills_dir)
    ? join(dirname(planPath), plan.skills_dir)
    : plan.skills_dir;
  const skillsDir = resolve(
    expandHome(
      flags["skills-dir"] || planSkills || new URL("../../skills", import.meta.url).pathname,
    ),
  );

  const result = await runLowMark({
    dir,
    plan,
    skillsDir,
    dryRun: flags["dry-run"],
    approved: flags.approve.flatMap((value) => value.split(",")).filter(Boolean),
  });
  console.log(result.text);
  return 0;
}

if (import.meta.main) {
  const exitCode = await runCli(Deno.args);
  if (exitCode !== 0) Deno.exit(exitCode);
}
