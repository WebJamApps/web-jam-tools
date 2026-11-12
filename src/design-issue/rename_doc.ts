import * as path from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import { checkAuthorOnRoster } from "../../hooks/lib/authored_by_footer.ts";
import { ACTIVE_REPOS, type CommandResult, REPO_OWNER } from "../shared/repos.ts";
import { expandHome, isDesignDocFilename } from "./gate1.ts";
import {
  carryGate1Record,
  computeFingerprint,
  getGate1RecordPath,
  loadGate1Record,
} from "./gate1_record.ts";

type Runner = (command: string[]) => Promise<CommandResult>;
export interface RenameOptions {
  dropboxDir?: string;
  reposDir?: string;
  stateDir?: string;
  repos?: readonly string[];
  author?: string;
  runner?: Runner;
}
interface Issue {
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed";
  body: string;
}
export interface RenameChange {
  kind: "rename" | "write" | "issue";
  target: string;
  source?: string;
  before: string;
  after: string;
  issue?: Issue;
}
export interface RenamePlan {
  changes: RenameChange[];
  closedIssues: string[];
  snapshots: Map<string, string>;
  absent: Set<string>;
  options: RenameOptions;
}
const commandRunner: Runner = async ([command, ...args]) => {
  const output = await new Deno.Command(command, { args, stdout: "piped", stderr: "piped" })
    .output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return { code: output.code, stdout: decode(output.stdout), stderr: decode(output.stderr) };
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const citation = (issue: Issue) => `${issue.repo}#${issue.number} "${issue.title}"`;

async function readText(file: string): Promise<string> {
  try {
    const stat = await Deno.lstat(file);
    if (!stat.isFile || (stat.mode !== null && (stat.mode & 0o444) === 0)) {
      throw new Error("not a readable regular file (symlinks are not followed)");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(await Deno.readFile(file));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${message(error)}`);
  }
}
async function exists(file: string): Promise<boolean> {
  try {
    await Deno.lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw new Error(`Cannot inspect ${file}: ${message(error)}`);
  }
}
async function requireAbsent(file: string): Promise<void> {
  if (await exists(file)) throw new Error(`Destination already exists: ${file}`);
}

/** Enumerate canonical documents/runbooks and their renders, excluding backup trees. */
async function collectDropboxFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const excluded = new Set([".git", ".trash", "Trash", "backups", "claude-backup", "node_modules"]);
  async function visit(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory && !excluded.has(entry.name)) await visit(file);
      const markdown = entry.name.replace(/\.html$/i, ".md");
      if (isDesignDocFilename(markdown) || /-manual-steps-.*\.(md|html)$/i.test(entry.name)) {
        if (!entry.isDirectory) files.push(file);
      }
    }
  }
  try {
    await visit(root);
  } catch (error) {
    throw new Error(`Cannot scan documents/runbooks under ${root}: ${message(error)}`);
  }
  return files.sort();
}
function parseIssues(raw: string, repo: string): Issue[] {
  let pages: unknown;
  try {
    pages = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cannot read issue bodies for ${repo}: ${message(error)}`);
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`Cannot read issue bodies for ${repo}: expected paginated arrays`);
  }
  const issues = pages.flat().filter((item) => !item?.pull_request).map((item) => {
    if (
      !item || !Number.isInteger(item.number) || item.number < 1 ||
      typeof item.title !== "string" || !["open", "closed"].includes(item.state) ||
      !(typeof item.body === "string" || item.body === null)
    ) throw new Error(`Cannot read issue body for ${repo}: malformed issue response`);
    return {
      repo,
      number: item.number,
      title: item.title,
      state: item.state,
      body: item.body ?? "",
    };
  });
  const unique = new Map<number, Issue>();
  for (const issue of issues) {
    const previous = unique.get(issue.number);
    if (previous && JSON.stringify(previous) !== JSON.stringify(issue)) {
      throw new Error(`Issue changed between pages: ${citation(issue)}`);
    }
    unique.set(issue.number, issue);
  }
  return [...unique.values()];
}
async function checkedCommand(runner: Runner, args: string[]): Promise<string> {
  const result = await runner(args);
  if (result.code !== 0) {
    throw new Error(`${args[0]} lookup failed for ${args.at(-1)}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Complete every read and destination check before returning an executable plan. */
export async function planDocRename(
  doc: string,
  newName: string,
  options: RenameOptions = {},
): Promise<RenamePlan> {
  const source = path.resolve(expandHome(doc));
  const name = path.basename(newName);
  const target = path.isAbsolute(newName) || path.dirname(newName) !== "."
    ? path.resolve(expandHome(newName))
    : path.join(path.dirname(source), name);
  if (path.dirname(target) !== path.dirname(source)) {
    throw new Error("Rename must stay in the same folder");
  }
  if (!isDesignDocFilename(name) || /(?:\d{4}[-_]\d{2}[-_]\d{2}|\d{8})/.test(name)) {
    throw new Error(`New name must be a design Markdown filename with no date: ${name}`);
  }
  if (!isDesignDocFilename(path.basename(source))) {
    throw new Error(`Not a design document: ${source}`);
  }
  const plan: RenamePlan = {
    changes: [],
    closedIssues: [],
    snapshots: new Map(),
    absent: new Set(),
    options,
  };
  const remember = async (file: string) => {
    if (!plan.snapshots.has(file)) plan.snapshots.set(file, await readText(file));
    return plan.snapshots.get(file)!;
  };
  const reserve = async (file: string) => {
    await requireAbsent(file);
    plan.absent.add(file);
  };
  const oldName = path.basename(source);
  const oldHtml = oldName.replace(/\.md$/i, ".html");
  const newHtml = name.replace(/\.md$/i, ".html");
  const replace = (text: string) => text.replaceAll(oldName, name).replaceAll(oldHtml, newHtml);
  await reserve(target);
  await reserve(target.replace(/\.md$/i, ".html"));
  await reserve(getGate1RecordPath(target, options.stateDir));
  const before = await remember(source);
  const addWrite = (file: string, previous: string, next: string) => {
    if (next !== previous) {
      plan.changes.push({ kind: "write", target: file, before: previous, after: next });
    }
  };
  const addMove = (from: string, to: string, previous: string, next: string) => {
    plan.changes.push({
      kind: "rename",
      source: from,
      target: to,
      before: previous,
      after: previous,
    });
    addWrite(to, previous, next);
  };
  addMove(source, target, before, replace(before));
  const htmlSource = source.replace(/\.md$/i, ".html");
  if (await exists(htmlSource)) {
    const html = await remember(htmlSource);
    addMove(htmlSource, target.replace(/\.md$/i, ".html"), html, replace(html));
  } else plan.absent.add(htmlSource);

  async function carryRecord(file: string, previous: string, next: string, movedTo?: string) {
    const recordFile = getGate1RecordPath(file, options.stateDir);
    if (!await exists(recordFile)) {
      plan.absent.add(recordFile);
      return;
    }
    const raw = await remember(recordFile);
    const record = await loadGate1Record(file, { stateDir: options.stateDir });
    if (
      !record || JSON.stringify(record) !== JSON.stringify(JSON.parse(raw)) ||
      record.docPath !== file
    ) {
      throw new Error(`Gate 1 record changed or has the wrong document path: ${recordFile}`);
    }
    if (
      typeof record.presentedFingerprint !== "string" || typeof record.presentedAt !== "string" ||
      (record.approvedAt !== undefined &&
        [record.approvedAt, record.reply, record.approvedFingerprint].some((value) =>
          typeof value !== "string" || !value
        ))
    ) throw new Error(`Malformed Gate 1 record: ${recordFile}`);
    if (
      !movedTo &&
      (!record.approvedAt || record.approvedFingerprint !== computeFingerprint(previous))
    ) return;
    const carried = carryGate1Record(record, movedTo ?? file, previous, next, replace);
    const rewritten = JSON.stringify(carried, null, 2) + "\n";
    if (movedTo) addMove(recordFile, getGate1RecordPath(movedTo, options.stateDir), raw, rewritten);
    else addWrite(recordFile, raw, rewritten);
  }
  await carryRecord(source, before, replace(before), target);
  const home = Deno.env.get("HOME") || "/home/joshua";
  const dropbox = path.resolve(
    expandHome(options.dropboxDir ?? path.join(home, "Dropbox/web-jam-llms")),
  );
  const reposDir = path.resolve(expandHome(options.reposDir ?? path.join(home, "WebJamApps")));
  const candidates = new Set(await collectDropboxFiles(dropbox));
  const runner = options.runner ?? commandRunner;
  const repos = [...new Set(options.repos ?? ACTIVE_REPOS)];
  if (
    repos.length === 0 ||
    repos.some((repo) => !ACTIVE_REPOS.includes(repo as typeof ACTIVE_REPOS[number]))
  ) {
    throw new Error("Repository scope must name active WebJamApps repositories");
  }
  for (const repo of repos) {
    const dir = path.join(reposDir, repo);
    const root = await checkedCommand(runner, ["git", "-C", dir, "rev-parse", "--show-toplevel"]);
    if (path.resolve(root.trim()) !== await Deno.realPath(dir)) {
      throw new Error(`Repository directory is not its Git root: ${dir}`);
    }
    const result = await runner([
      "git",
      "-C",
      dir,
      "grep",
      "-I",
      "-l",
      "-z",
      "-F",
      "-e",
      oldName,
      "-e",
      oldHtml,
      "--",
    ]);
    if (result.code > 1 || result.stderr.trim()) {
      throw new Error(`Cannot read repository pointers in ${dir}: ${result.stderr}`);
    }
    for (const relative of result.stdout.split("\0").filter(Boolean)) {
      const file = path.resolve(dir, relative);
      if (!file.startsWith(dir + path.SEPARATOR)) {
        throw new Error(`Unsafe repository pointer: ${relative}`);
      }
      candidates.add(file);
    }
  }
  for (const file of [...candidates].sort()) {
    if (file === source || file === htmlSource) continue;
    if (path.basename(file) === oldName && isDesignDocFilename(path.basename(file))) {
      throw new Error(`Ambiguous old filename: both ${source} and ${file} exist`);
    }
    const previous = await remember(file);
    const next = replace(previous);
    addWrite(file, previous, next);
    if (next !== previous && isDesignDocFilename(path.basename(file))) {
      await carryRecord(file, previous, next);
    }
  }
  for (const repo of repos) {
    const fullRepo = `${REPO_OWNER}/${repo}`;
    const raw = await checkedCommand(runner, [
      "gh",
      "api",
      "--paginate",
      "--slurp",
      `repos/${fullRepo}/issues?state=all&per_page=100`,
    ]);
    for (const issue of parseIssues(raw, fullRepo)) {
      const after = replace(issue.body);
      if (after === issue.body) continue;
      if (issue.state === "closed") plan.closedIssues.push(citation(issue));
      else {plan.changes.push({
          kind: "issue",
          target: citation(issue),
          issue,
          before: issue.body,
          after,
        });}
    }
  }
  return plan;
}

function describe(change: RenameChange): string {
  return change.kind === "rename"
    ? `rename ${change.source} -> ${change.target}`
    : `${change.kind} ${change.target}`;
}
async function checkIssue(issue: Issue, runner: Runner) {
  const raw = await checkedCommand(runner, [
    "gh",
    "api",
    `repos/${issue.repo}/issues/${issue.number}`,
  ]);
  let current: Issue | undefined;
  try {
    [current] = parseIssues(JSON.stringify([[JSON.parse(raw)]]), issue.repo);
  } catch (error) {
    throw new Error(`Cannot read ${citation(issue)}: ${message(error)}`);
  }
  if (
    !current || current.number !== issue.number || current.state !== "open" ||
    current.body !== issue.body
  ) {
    throw new Error(`Issue changed or closed since planning: ${citation(issue)}`);
  }
}
export class RenameApplyError extends Error {
  constructor(
    public completed: string[],
    public failed: string,
    public pending: string[],
    error: unknown,
  ) {
    super(`Stopped at ${failed}: ${message(error)} (the failed write may be partial)`);
  }
}

export async function applyDocRename(
  plan: RenamePlan,
  writeText: (file: string, content: string) => Promise<void> = Deno.writeTextFile,
): Promise<void> {
  const runner = plan.options.runner ?? commandRunner;
  const issueChanges = plan.changes.filter((change) => change.issue);
  if (issueChanges.length) {
    if (!plan.options.author?.trim()) {
      throw new Error("--author is required to rewrite open issue bodies");
    }
    const check = await checkAuthorOnRoster(plan.options.author, runner);
    if (!check.ok) throw new Error(check.message);
  }
  for (const [file, before] of plan.snapshots) {
    if (await readText(file) !== before) throw new Error(`File changed since planning: ${file}`);
  }
  for (const file of plan.absent) await requireAbsent(file);
  for (const change of issueChanges) await checkIssue(change.issue!, runner);
  const completed: string[] = [];
  for (const [index, change] of plan.changes.entries()) {
    try {
      if (change.kind === "rename") {
        await requireAbsent(change.target);
        if (await readText(change.source!) !== change.before) {
          throw new Error("Source changed since planning");
        }
        // Link/unlink refuses a concurrently created destination instead of overwriting it.
        // A failure between these calls is reported as a partial action and stops the run.
        await Deno.link(change.source!, change.target);
        await Deno.remove(change.source!);
      } else if (change.kind === "write") {
        if (await readText(change.target) !== change.before) {
          throw new Error("File changed since planning");
        }
        await writeText(change.target, change.after);
      } else {
        await checkIssue(change.issue!, runner);
        const bodyFile = await Deno.makeTempFile({ prefix: "design-rename-body-", suffix: ".md" });
        try {
          await Deno.writeTextFile(bodyFile, change.after);
          await checkedCommand(runner, [
            "deno",
            "task",
            "--config",
            path.fromFileUrl(new URL("../../deno.json", import.meta.url)),
            "edit-issue",
            "--repo",
            change.issue!.repo,
            "--issue",
            String(change.issue!.number),
            "--author",
            plan.options.author!,
            "--body-file",
            bodyFile,
          ]);
        } finally {
          await Deno.remove(bodyFile);
        }
      }
      completed.push(describe(change));
    } catch (error) {
      throw new RenameApplyError(
        completed,
        describe(change),
        plan.changes.slice(index + 1).map(describe),
        error,
      );
    }
  }
}

export async function runRenameDocCli(
  args: string[],
  options: RenameOptions = {},
): Promise<number> {
  try {
    const flags = parseArgs(args, {
      boolean: ["apply", "help"],
      string: ["dropbox-dir", "repos-dir", "state-dir", "repos", "author"],
      alias: { h: "help" },
      unknown: (arg) => {
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        return true;
      },
    });
    if (flags.help) {
      console.log(
        "Usage: deno task design:rename-doc <doc.md> <new-name.md> [--apply] [--author <tool — model>]\nDry run by default. Renames in the same folder; new names must be undated.\nScope: design documents/runbooks and their HTML under ~/Dropbox/web-jam-llms, tracked text in active repos under ~/WebJamApps, and all their issue bodies. Closed issues are listed only.\nOverrides: --dropbox-dir, --repos-dir, --state-dir, --repos (comma-separated active repo names).\nStops at the first failed write and reports completed and pending actions.",
      );
      return 0;
    }
    if (flags._.length !== 2) {
      throw new Error("Expected document path and new filename (see --help)");
    }
    const plan = await planDocRename(String(flags._[0]), String(flags._[1]), {
      ...options,
      dropboxDir: flags["dropbox-dir"] ?? options.dropboxDir,
      reposDir: flags["repos-dir"] ?? options.reposDir,
      stateDir: flags["state-dir"] ?? options.stateDir,
      repos: flags.repos?.split(",") ?? options.repos,
      author: flags.author ?? options.author,
    });
    console.log(`[design:rename-doc] ${flags.apply ? "APPLY" : "DRY RUN"}`);
    for (const change of plan.changes) console.log(`  ${describe(change)}`);
    for (const issue of plan.closedIssues) console.log(`  Closed issue left unchanged: ${issue}`);
    if (flags.apply) {
      await applyDocRename(plan);
      console.log(`[design:rename-doc] APPLIED ${plan.changes.length} action(s)`);
    } else console.log("Nothing changed. Run with --apply to execute this plan.");
    return 0;
  } catch (error) {
    console.error(`[design:rename-doc] REFUSED: ${message(error)}`);
    if (error instanceof RenameApplyError) {
      console.error(`Completed: ${error.completed.join("; ") || "none"}`);
      console.error(`Not attempted: ${error.pending.join("; ") || "none"}`);
    }
    return 1;
  }
}
