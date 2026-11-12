// Classify every source span, then verify a rules-file cut before changing it.
import { parseArgs } from "@std/cli/parse-args";
import { dirname, join, resolve } from "@std/path";
import { loadLimits, type SessionLoadLimits } from "../session-load/report.ts";
import { appearsWordForWord } from "./low_mark.ts";
import { ACTIVE_REPOS } from "../shared/repos.ts";

const PARTS = {
  mainRules: { repo: "web-jam-tools", file: "AGENTS.md" },
  crossAiRules: { repo: "web-jam-tools", file: "docs/cross-ai-rules.md" },
  jammusicRules: { repo: "JaMmusic", file: "AGENTS.md" },
} as const;

export type RulesPart = keyof typeof PARTS | typeof ACTIVE_REPOS[number];

function rulesTarget(part: RulesPart): { repo: string; file: string } {
  return Object.hasOwn(PARTS, part)
    ? PARTS[part as keyof typeof PARTS]
    : { repo: part, file: "AGENTS.md" };
}

function rulesLimit(part: RulesPart, limits: SessionLoadLimits) {
  const target = rulesTarget(part);
  if (part === "crossAiRules") return limits.crossAiRules;
  if (target.repo === "web-jam-tools") return limits.mainRules;
  if (target.repo === "JaMmusic") return limits.jammusicRules;
  return {
    lowMark: limits.otherRepoRules.lowMarks?.[target.repo] ?? limits.otherRepoRules.overMark,
    overMark: limits.otherRepoRules.overMark,
  };
}
export type RulesSpanKind =
  | "rule"
  | "skill-instruction"
  | "backstory"
  | "repeat"
  | "scoped-rule"
  | "area-rule"
  | "reworded"
  | "removed-rule";

export interface RulesSpan {
  id: string;
  kind: RulesSpanKind;
  /** Exact source text, including whitespace; spans cover the whole file in order. */
  text: string;
  /** Defaults to keep for rules and drop for all other kinds. */
  action?: "keep" | "drop";
  target_skill?: string;
  /** Area slug and repository-relative folder; the file is docs/rules/<area>.md. */
  area?: string;
  folder?: string;
  /** The skill or always-read rules document that already says this rule. */
  already_said?: string;
  repeats?: string;
  replacement?: string;
  approved?: boolean;
  reason?: string;
  guard?: boolean;
  safety?: boolean;
  approval?: boolean;
}

export interface RulesCutsPlan {
  part: RulesPart;
  /** Relative to the plan file; defaults to this tools worktree's skills directory. */
  skills_dir?: string;
  spans: RulesSpan[];
}

export interface RulesCutsResult {
  before: string;
  after: string;
  rulesBefore: string[];
  rulesAfter: string[];
  beforeBytes: number;
  afterBytes: number;
  lowMark: number;
  overMark: number;
  report: string;
  areaFiles: { path: string; before: string | null; after: string }[];
}

function areaPointer(span: RulesSpan): string {
  return `Before changing anything under \`${span.folder}/\`, read \`docs/rules/${span.area}.md\`.`;
}

/** Refuse symlinks at every area-file component, including a missing file's parents. */
async function readAreaFile(root: string, area: string): Promise<string | null> {
  for (const relative of ["docs", "docs/rules", `docs/rules/${area}.md`]) {
    try {
      const info = await Deno.lstat(join(root, relative));
      if (info.isSymlink) throw new Error(`Area path must not be a symlink: ${relative}`);
      if (relative.endsWith(".md") ? !info.isFile : !info.isDirectory) {
        throw new Error(`Invalid area path: ${relative}`);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  }
  return await Deno.readTextFile(join(root, "docs/rules", `${area}.md`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(record: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new Error(`Unknown plan field: ${key}`);
  }
}

function isApprovalOrSafetyRule(span: Record<string, unknown>): boolean {
  if (span.guard === true || span.safety === true || span.approval === true) {
    return true;
  }
  if (typeof span.reason === "string") {
    const r = span.reason.toLowerCase();
    return (
      r.includes("approval") ||
      r.includes("safety") ||
      r.includes("guard") ||
      r.includes("credential") ||
      r.includes("spending") ||
      r.includes("deletion")
    );
  }
  return false;
}

const VALID_SPAN_KINDS: readonly RulesSpanKind[] = [
  "rule",
  "skill-instruction",
  "backstory",
  "repeat",
  "scoped-rule",
  "area-rule",
  "reworded",
  "removed-rule",
];

/** Reject malformed judgments before any file can change. */
export function parseRulesCutsPlan(value: unknown): RulesCutsPlan {
  if (!isRecord(value)) throw new Error("Plan must be an object");
  onlyKeys(value, ["part", "skills_dir", "spans"]);
  if (
    typeof value.part !== "string" ||
    (!Object.hasOwn(PARTS, value.part) && !ACTIVE_REPOS.some((repo) => repo === value.part))
  ) {
    throw new Error(
      "Plan part must be mainRules, crossAiRules, jammusicRules, or an active repository",
    );
  }
  if (
    value.skills_dir !== undefined && (typeof value.skills_dir !== "string" || !value.skills_dir)
  ) {
    throw new Error("skills_dir must be a nonempty path");
  }
  if (!Array.isArray(value.spans) || value.spans.length === 0) {
    throw new Error("Plan must classify every source span");
  }
  const ids = new Set<string>();
  for (const span of value.spans) {
    if (!isRecord(span)) throw new Error("Each span must be an object");
    onlyKeys(span, [
      "id",
      "kind",
      "text",
      "action",
      "target_skill",
      "area",
      "folder",
      "already_said",
      "repeats",
      "replacement",
      "approved",
      "reason",
      "guard",
      "safety",
      "approval",
    ]);
    if (typeof span.id !== "string" || !span.id.trim() || ids.has(span.id)) {
      throw new Error("Each span needs a unique nonempty id");
    }
    ids.add(span.id);
    if (typeof span.text !== "string" || !span.text) {
      throw new Error(`Span ${span.id} needs exact, nonempty source text`);
    }
    if (
      typeof span.kind !== "string" ||
      !VALID_SPAN_KINDS.includes(span.kind as RulesSpanKind)
    ) {
      throw new Error(`Unknown span kind for ${span.id}`);
    }
    if (span.action !== undefined) {
      if (span.action !== "keep" && span.action !== "drop") {
        throw new Error(`Span ${span.id}: invalid action ${String(span.action)}`);
      }
      if (span.kind === "rule" && span.action !== "keep") {
        throw new Error(`Span ${span.id}: rule must keep; cannot ${String(span.action)}`);
      }
      if (
        (span.kind === "skill-instruction" ||
          span.kind === "backstory" ||
          span.kind === "repeat" ||
          span.kind === "area-rule" ||
          span.kind === "scoped-rule") &&
        span.action !== "drop"
      ) {
        throw new Error(`Span ${span.id}: ${span.kind} must drop; cannot ${String(span.action)}`);
      }
      if (span.kind === "removed-rule") {
        const expected = span.approved === true ? "drop" : "keep";
        if (span.action !== expected) {
          const state = span.approved === true ? "approved" : "unapproved";
          throw new Error(
            `Span ${span.id}: ${state} removed-rule must ${expected}; cannot ${
              String(span.action)
            }`,
          );
        }
      }
      if (span.kind === "reworded") {
        if (span.action !== "keep") {
          throw new Error(`Span ${span.id}: reworded must keep; cannot ${String(span.action)}`);
        }
      }
    }
    if (
      (span.kind === "rule" ||
        span.kind === "scoped-rule" ||
        span.kind === "area-rule" ||
        span.kind === "reworded" ||
        span.kind === "removed-rule") &&
      !span.text.trim()
    ) {
      throw new Error(`Rule ${span.id} contains no rule text`);
    }
    if (span.approved !== undefined && typeof span.approved !== "boolean") {
      throw new Error(`Span ${span.id} approved must be a boolean`);
    }
    if (span.guard !== undefined && typeof span.guard !== "boolean") {
      throw new Error(`Span ${span.id} guard must be a boolean`);
    }
    if (span.safety !== undefined && typeof span.safety !== "boolean") {
      throw new Error(`Span ${span.id} safety must be a boolean`);
    }
    if (span.approval !== undefined && typeof span.approval !== "boolean") {
      throw new Error(`Span ${span.id} approval must be a boolean`);
    }
    if (span.reason !== undefined && typeof span.reason !== "string") {
      throw new Error(`Span ${span.id} reason must be a string`);
    }
    if (
      span.kind !== "scoped-rule" &&
      span.kind !== "area-rule" &&
      span.kind !== "skill-instruction" &&
      (span.guard !== undefined || span.safety !== undefined || span.approval !== undefined)
    ) {
      throw new Error(
        `Only a moving rule may name guard, safety, or approval: ${span.id}`,
      );
    }
    if (span.kind === "skill-instruction" || span.kind === "scoped-rule") {
      if (
        typeof span.target_skill !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(span.target_skill)
      ) {
        throw new Error(`Span ${span.id} needs a target_skill slug`);
      }
      if (isApprovalOrSafetyRule(span)) {
        throw new Error(`Approval and safety rules cannot be moved into a skill: ${span.id}`);
      }
    } else if (span.target_skill !== undefined) {
      throw new Error(
        `Only a skill-instruction or scoped-rule may name target_skill: ${span.id}`,
      );
    }
    if (span.kind === "area-rule") {
      if (typeof span.area !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(span.area)) {
        throw new Error(`Span ${span.id} needs a safe area slug`);
      }
      if (
        typeof span.folder !== "string" ||
        !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(span.folder) ||
        span.folder.split("/").some((segment) => segment === "." || segment === "..")
      ) throw new Error(`Span ${span.id} needs a repository-relative folder`);
      if (isApprovalOrSafetyRule(span)) {
        throw new Error(`Approval and safety rules cannot move into an area file: ${span.id}`);
      }
    } else if (span.area !== undefined || span.folder !== undefined) {
      throw new Error(`Only an area-rule may name area or folder: ${span.id}`);
    }
    if (span.reason === "already-said" && span.kind === "removed-rule") {
      if (typeof span.already_said !== "string" || !span.already_said.trim()) {
        throw new Error(`Removed rule ${span.id} must name the already_said place`);
      }
    } else if (span.already_said !== undefined) {
      throw new Error(`Only an already-said removal may name already_said: ${span.id}`);
    }
    if (span.kind === "repeat") {
      if (typeof span.repeats !== "string" || !span.repeats) {
        throw new Error(`Span ${span.id} needs the id of the span it repeats`);
      }
    } else if (span.repeats !== undefined) {
      throw new Error(`Only a repeat may name repeats: ${span.id}`);
    }
    if (span.kind === "reworded") {
      if (span.approved === true) {
        if (typeof span.replacement !== "string" || !span.replacement.trim()) {
          throw new Error(`Span ${span.id} needs a nonempty replacement`);
        }
      } else if (
        span.replacement !== undefined &&
        (typeof span.replacement !== "string" || !span.replacement.trim())
      ) {
        throw new Error(`Span ${span.id} replacement must be a nonempty string if provided`);
      }
    } else if (span.replacement !== undefined) {
      throw new Error(`Only a reworded span may name replacement: ${span.id}`);
    }
    if (span.kind === "removed-rule") {
      if (span.approved === true) {
        if (!["obsolete", "hook-enforced", "already-said"].includes(String(span.reason))) {
          throw new Error(
            `Removed rule ${span.id} requires reason "obsolete", "hook-enforced", or "already-said" when approved`,
          );
        }
      } else if (
        span.reason !== undefined &&
        span.reason !== "obsolete" &&
        span.reason !== "hook-enforced" && span.reason !== "already-said"
      ) {
        throw new Error(
          `Removed rule ${span.id} reason must be "obsolete", "hook-enforced", or "already-said" if provided`,
        );
      }
    } else if (
      span.kind !== "scoped-rule" && span.kind !== "area-rule" && span.reason !== undefined
    ) {
      throw new Error(`Only a removed-rule or scoped-rule may name reason: ${span.id}`);
    }
  }
  return value as unknown as RulesCutsPlan;
}

/** Build the proposed file entirely in memory; a refusal never leaves a partial cut. */
export async function planRulesCuts(
  source: string,
  plan: RulesCutsPlan,
  skillsDir: string,
  repoDir?: string,
  limits?: SessionLoadLimits,
): Promise<RulesCutsResult> {
  plan = parseRulesCutsPlan(plan);
  if (plan.spans.map((span) => span.text).join("") !== source) {
    throw new Error("Plan spans must cover the entire current file exactly, in source order");
  }
  const byId = new Map(plan.spans.map((span) => [span.id, span]));
  const words = (text: string) => text.trim().split(/\s+/).join(" ");
  for (const span of plan.spans) {
    if (span.kind === "skill-instruction" || span.kind === "scoped-rule") {
      if (
        isApprovalOrSafetyRule(span as unknown as Record<string, unknown>)
      ) {
        throw new Error(`Approval and safety rules cannot be moved into a skill: ${span.id}`);
      }
      const skillPath = join(skillsDir, span.target_skill!, "SKILL.md");
      const skill = await Deno.readTextFile(skillPath);
      if (!appearsWordForWord(skill, span.text)) {
        throw new Error(`Span ${span.id} does not appear word for word in ${skillPath}`);
      }
    }
    if (span.kind === "repeat") {
      const keeper = byId.get(span.repeats!);
      if (!keeper || keeper.kind !== "rule" || words(keeper.text) !== words(span.text)) {
        throw new Error(`Repeat ${span.id} must match a retained rule span word for word`);
      }
    }
  }

  const areaFiles: RulesCutsResult["areaFiles"] = [];
  const pointers = new Map<string, string>();
  for (const span of plan.spans.filter((span) => span.kind === "area-rule")) {
    if (!repoDir) throw new Error("Area moves require the source repository directory");
    const path = join(repoDir, "docs/rules", `${span.area}.md`);
    const pointer = areaPointer(span);
    if (pointers.has(path) && pointers.get(path) !== pointer) {
      throw new Error(`Area ${span.area} must name one folder`);
    }
    pointers.set(path, pointer);
    let file = areaFiles.find((file) => file.path === path);
    if (!file) {
      const before = await readAreaFile(repoDir, span.area!);
      file = { path, before, after: before ?? `# ${span.area} rules\n\n` };
      areaFiles.push(file);
    }
    if (!appearsWordForWord(file.after, span.text)) file.after += `\n\n${span.text}`;
    if (!appearsWordForWord(file.after, span.text)) throw new Error("Area move lost rule text");
  }
  const retainedText = plan.spans.filter((span) =>
    span.kind === "rule" || (span.kind === "reworded" && span.approved !== true) ||
    (span.kind === "removed-rule" && span.approved !== true)
  ).map((span) => span.text).concat(
    plan.spans.filter((span) => span.kind === "reworded" && span.approved === true)
      .map((span) => span.replacement!),
  ).join("\n");
  const addedPointers = new Set<string>();
  const keptChunks: string[] = [];
  for (const span of plan.spans) {
    if (span.kind === "rule") {
      keptChunks.push(span.text);
    } else if (span.kind === "area-rule") {
      const pointer = areaPointer(span);
      if (!retainedText.split("\n").includes(pointer) && !addedPointers.has(pointer)) {
        keptChunks.push(pointer + "\n");
        addedPointers.add(pointer);
      }
    } else if (span.kind === "reworded") {
      if (span.approved === true) {
        keptChunks.push(span.replacement!);
      } else {
        keptChunks.push(span.text);
      }
    } else if (span.kind === "removed-rule") {
      if (span.approved !== true) {
        keptChunks.push(span.text);
      }
    }
  }

  const after = keptChunks.reduce((text, chunk) => {
    const separator = text && !/\s$/.test(text) && !/^\s/.test(chunk) ? "\n\n" : "";
    return text + separator + chunk;
  }, "");

  const ruleSpans = plan.spans.filter((span) =>
    span.kind === "rule" ||
    span.kind === "scoped-rule" ||
    span.kind === "area-rule" ||
    span.kind === "reworded" ||
    span.kind === "removed-rule"
  );
  const rulesBefore = ruleSpans.map((span) => span.text);
  const rulesAfter: string[] = [];

  for (const span of ruleSpans) {
    if (span.kind === "rule") {
      rulesAfter.push(span.text);
    } else if (span.kind === "scoped-rule") {
      rulesAfter.push(`[moved to ${span.target_skill}] ${span.text}`);
    } else if (span.kind === "area-rule") {
      rulesAfter.push(`[moved to docs/rules/${span.area}.md] ${span.text}`);
      if (after.split("\n").filter((line) => line === areaPointer(span)).length !== 1) {
        throw new Error("Expected exactly one area pointer line");
      }
    } else if (span.kind === "reworded") {
      if (span.approved === true) {
        rulesAfter.push(`[reworded] ${span.replacement}`);
      } else {
        rulesAfter.push(span.text);
      }
    } else if (span.kind === "removed-rule") {
      if (span.approved === true) {
        rulesAfter.push(
          `[removed: ${span.reason}${
            span.already_said ? `; ${span.already_said}` : ""
          }] ${span.text}`,
        );
      } else {
        rulesAfter.push(span.text);
      }
    }
  }

  for (const span of ruleSpans) {
    if (
      span.kind === "rule" ||
      (span.kind === "reworded" && span.approved !== true) ||
      (span.kind === "removed-rule" && span.approved !== true)
    ) {
      if (!appearsWordForWord(after, span.text)) {
        throw new Error("Rules before and after differ");
      }
    }
    if (span.kind === "reworded" && span.approved === true) {
      if (!appearsWordForWord(after, span.replacement!)) {
        throw new Error("Reworded rule replacement missing from result");
      }
    }
  }

  if (rulesBefore.length === 0) throw new Error("Plan must retain at least one rule");
  const limit = rulesLimit(plan.part, limits ?? await loadLimits());
  if (!Number.isSafeInteger(limit.lowMark) || limit.lowMark! <= 0) {
    throw new Error(`No usable low mark in limits.json for ${plan.part}`);
  }
  const beforeBytes = new TextEncoder().encode(source).length;
  const afterBytes = new TextEncoder().encode(after).length;
  const overLowMark = afterBytes > limit.lowMark! ? afterBytes - limit.lowMark! : 0;

  const rulesUnchanged = JSON.stringify(rulesBefore) === JSON.stringify(rulesAfter);
  const reportLines = [
    `Rules file: ${rulesTarget(plan.part).repo}/${rulesTarget(plan.part).file}`,
    "Rules before:",
    JSON.stringify(rulesBefore, null, 2),
    "Rules after:",
    JSON.stringify(rulesAfter, null, 2),
    `Rules unchanged: ${rulesUnchanged ? "yes" : "no"}`,
    `Bytes: ${beforeBytes} -> ${afterBytes}; low mark ${limit.lowMark}; over at ${limit.overMark}`,
  ];
  if (overLowMark > 0) {
    reportLines.push(`${overLowMark} bytes over low mark`);
  }
  const report = reportLines.join("\n");
  return {
    before: source,
    after,
    rulesBefore,
    rulesAfter,
    beforeBytes,
    afterBytes,
    lowMark: limit.lowMark!,
    overMark: limit.overMark,
    report,
    areaFiles,
  };
}

async function git(dir: string, args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!result.success) {
    throw new Error(
      "Rules cuts require a feature worktree with a dev base and the expected origin repository",
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/** Cuts are prepared in feature worktrees for a draft PR, never in a shared checkout. */
async function assertFeatureWorktree(filePath: string, part: RulesPart): Promise<void> {
  const dir = dirname(filePath);
  const root = await git(dir, ["rev-parse", "--show-toplevel"]);
  const actual = await Deno.realPath(filePath);
  const target = rulesTarget(part);
  if (actual !== join(await Deno.realPath(root), target.file)) {
    throw new Error(
      `Expected ${target.file} at the worktree root; symlink targets are refused`,
    );
  }
  const branch = await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch === "dev" || branch === "main") throw new Error("Rules cuts require a feature branch");
  const gitDir = await git(dir, ["rev-parse", "--absolute-git-dir"]);
  const commonDir = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (gitDir === commonDir) throw new Error("Rules cuts require an isolated git worktree");
  const origin = await git(dir, ["remote", "get-url", "origin"]);
  const remoteRepo = origin.match(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)WebJamApps\/([a-zA-Z0-9_-]+?)(?:\.git)?$/i,
  )?.[1];
  if (remoteRepo?.toLowerCase() !== target.repo.toLowerCase()) {
    throw new Error(`Rules part ${part} requires the ${target.repo} repository`);
  }
  const refs = await git(dir, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/remotes/origin/dev",
    "refs/heads/dev",
  ]);
  const base = refs.split("\n").find((ref) => ref === "refs/remotes/origin/dev") ??
    "refs/heads/dev";
  await git(dir, ["merge-base", "--is-ancestor", base, "HEAD"]);
}

export async function runRulesCuts(options: {
  filePath: string;
  planPath: string;
  dryRun?: boolean;
}): Promise<RulesCutsResult> {
  const plan = parseRulesCutsPlan(JSON.parse(await Deno.readTextFile(options.planPath)));
  const filePath = resolve(options.filePath);
  const source = await Deno.readTextFile(filePath);
  const skillsDir = plan.skills_dir
    ? resolve(dirname(resolve(options.planPath)), plan.skills_dir)
    : new URL("../../skills", import.meta.url).pathname;
  const repoDir = resolve(dirname(filePath), plan.part === "crossAiRules" ? ".." : ".");
  const result = await planRulesCuts(source, plan, skillsDir, repoDir);
  if (!options.dryRun) {
    await assertFeatureWorktree(filePath, plan.part);
    if (await Deno.readTextFile(filePath) !== source) {
      throw new Error("Rules file changed during validation; refusing stale plan");
    }
    for (const file of result.areaFiles) {
      if (await readAreaFile(repoDir, file.path.split("/").at(-1)!.slice(0, -3)) !== file.before) {
        throw new Error("Area file changed during validation; refusing stale plan");
      }
    }
    // Preserve the rules in their destinations before removing them from the source.
    for (const file of result.areaFiles) {
      if (file.after === file.before) continue;
      await Deno.mkdir(dirname(file.path), { recursive: true });
      await Deno.writeTextFile(file.path, file.after);
    }
    await Deno.writeTextFile(filePath, result.after);
  }
  return result;
}

export async function runCli(args: string[]): Promise<number> {
  try {
    if (args.some((arg) => arg.startsWith("--dry-run=") || arg === "--no-dry-run")) {
      throw new Error("Use the bare --dry-run flag for a preview; flag values are not supported");
    }
    const flags = parseArgs(args, {
      string: ["plan", "file"],
      boolean: ["dry-run", "help"],
      alias: { h: "help" },
      unknown: (arg) => {
        throw new Error(`Unknown argument: ${arg}`);
      },
    });
    if (flags.help) {
      console.log(`Usage: deno task memory-cleanup:rules-cuts --plan PATH --file PATH [--dry-run]

Classify every source span as rule, skill-instruction, backstory, repeat,
scoped-rule, area-rule, reworded, or removed-rule.
The JSON plan has part (mainRules, crossAiRules, jammusicRules, or an active repo name), optional skills_dir,
and ordered spans with id, kind, and exact text. A skill-instruction or scoped-rule
needs target_skill; a repeat needs repeats (the id of an identical retained rule);
area-rule needs area (a slug) and folder (a repository-relative directory); its text
moves to docs/rules/<area>.md with one pointer line per area in the source.
reworded needs replacement when approved; removed-rule needs reason (obsolete, hook-enforced, or already-said)
when approved. already-said also needs already_said naming its existing location.
Approval and safety rules cannot move into skills or area files.
Moved text must already appear word for word in its target SKILL.md.
Dry runs write nothing. Applying requires an isolated feature worktree off dev;
finish through the draft-pr skill and let Josh review and merge the pull request.`);
      return 0;
    }
    if (!flags.plan || !flags.file || flags._.length) {
      throw new Error("Both --plan and --file are required; see --help");
    }
    const result = await runRulesCuts({
      filePath: flags.file,
      planPath: flags.plan,
      dryRun: flags["dry-run"],
    });
    console.log(
      flags["dry-run"]
        ? "Dry run: nothing written"
        : "Prepared rules cut: open a draft PR for review",
    );
    console.log(result.report);
    return 0;
  } catch (error) {
    console.error(`Refusing rules cut: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) Deno.exit(await runCli(Deno.args));
