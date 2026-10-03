#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * scripts/edit-issue.ts — web-jam-tools#685
 *
 * Guarded CLI over `gh issue edit`. hooks/block-raw-gh-write.sh denies the
 * raw form on both agent surfaces; this is the only route to it.
 *
 * Every `gh issue edit` flag (`--add-label`, `--remove-label`, `--body`,
 * `--milestone`, ...) passes through verbatim after `--repo`/`--issue`/
 * `--dry-run` are pulled out — this CLI does not re-invent that flag surface.
 * The empty-body and credential-literal guards bind all four verbs (§4 of
 * the design document): every remaining argument value is scanned for a
 * credential-shaped literal, and a `--body`/`--body-file` value specifically
 * is also checked for emptiness.
 *
 * `--author "<tool — model>"` is consumed here and never passed to gh
 * (web-jam-tools#1205). When the edit replaces the body it is required,
 * roster-checked, and the new body ends with one `🤖 Authored by` footer
 * naming the editing model in place of any earlier one.
 */
import { checkAuthorOnRoster, withFooter } from "../hooks/lib/authored_by_footer.ts";
import { checkNoCredentialLiteral, checkNotEmpty } from "./gh-write/guard.ts";
import { type RunCmd, runWithRetry } from "./gh-write/gh_runner.ts";

export interface Options {
  repo?: string;
  issue?: number;
  dryRun: boolean;
  author?: string;
  rest: string[];
}

export function parseArgs(args: string[]): Options {
  const opts: Options = { dryRun: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo") opts.repo = args[++i];
    else if (arg === "--issue") opts.issue = Number(args[++i]);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--author") opts.author = args[++i] ?? "";
    else if (arg.startsWith("--author=")) opts.author = arg.slice("--author=".length);
    else opts.rest.push(arg);
  }
  return opts;
}

export interface BodyFlag {
  kind: "text" | "file";
  /** Position of the flag in the argument list. */
  index: number;
  /** How many arguments the flag and its value take up (1 or 2). */
  span: number;
  /** The body text or the file path; undefined when the flag is last with no value. */
  value: string | undefined;
}

/**
 * Every body-replacing flag in `rest`, in every form `gh issue edit` accepts:
 * `--body <t>`, `--body=<t>`, `-b <t>`, `-b=<t>`, `-b<t>`, and the same five
 * for `--body-file` / `-F`. A value that follows a spaced flag is skipped, so
 * a body whose text is itself `-b` is not read as a second flag.
 */
export function findBodyFlags(rest: string[]): BodyFlag[] {
  const found: BodyFlag[] = [];
  const attached = (arg: string, short: string) =>
    arg.startsWith(`${short}=`) ? arg.slice(short.length + 1) : arg.slice(short.length);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--body" || arg === "-b") {
      found.push({ kind: "text", index: i, span: 2, value: rest[i + 1] });
      i++;
    } else if (arg === "--body-file" || arg === "-F") {
      found.push({ kind: "file", index: i, span: 2, value: rest[i + 1] });
      i++;
    } else if (arg.startsWith("--body=")) {
      found.push({ kind: "text", index: i, span: 1, value: arg.slice("--body=".length) });
    } else if (arg.startsWith("--body-file=")) {
      found.push({ kind: "file", index: i, span: 1, value: arg.slice("--body-file=".length) });
    } else if (arg.startsWith("-b") && !arg.startsWith("--")) {
      found.push({ kind: "text", index: i, span: 1, value: attached(arg, "-b") });
    } else if (arg.startsWith("-F") && !arg.startsWith("--")) {
      found.push({ kind: "file", index: i, span: 1, value: attached(arg, "-F") });
    }
  }
  return found;
}

export interface Deps {
  readFileText: (path: string) => Promise<string>;
  runCmd: RunCmd;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the roster probe script path (tests only). */
  probeScriptPath?: string;
}

const USAGE =
  "usage: edit-issue --repo <owner/repo> --issue <n> [--author <tool — model>] [gh issue edit flags...] [--dry-run]\n  --author is required whenever the body is replaced (--body, -b, --body-file or -F, in any form).";

export async function run(args: string[], deps: Deps): Promise<number> {
  const opts = parseArgs(args);
  if (!opts.repo || !opts.issue || opts.rest.length === 0) {
    console.error(USAGE);
    return 1;
  }

  const bodyFlags = findBodyFlags(opts.rest);
  if (bodyFlags.length > 1) {
    console.error(
      "refusing to edit: the body is given more than once (--body / -b / --body-file / -F); give it exactly once.",
    );
    return 1;
  }
  const bodyFlag = bodyFlags[0];
  let bodyText: string | undefined;
  if (bodyFlag !== undefined) {
    if (bodyFlag.value === undefined) {
      console.error(`refusing to edit: ${opts.rest[bodyFlag.index]} is given with no value.`);
      return 1;
    }
    bodyText = bodyFlag.kind === "file" ? await deps.readFileText(bodyFlag.value) : bodyFlag.value;
  }
  if (bodyText !== undefined && bodyFlag !== undefined) {
    const notEmpty = checkNotEmpty(bodyText);
    if (!notEmpty.ok) {
      console.error(notEmpty.error);
      return 1;
    }
    // Authored-by footer (web-jam-tools#1205): the replacement body names the editing model.
    const authorCheck = await checkAuthorOnRoster(opts.author, deps.runCmd, deps.probeScriptPath);
    if (!authorCheck.ok) {
      console.error(`refusing to edit: ${authorCheck.message}`);
      return 1;
    }
    bodyText = withFooter(bodyText, opts.author!);
    // Whatever form the body arrived in, gh receives it as `--body <text>`.
    opts.rest.splice(bodyFlag.index, bodyFlag.span, "--body", bodyText);
  }

  const credResult = checkNoCredentialLiteral(opts.rest.join(" "));
  if (!credResult.ok) {
    console.error(credResult.error);
    return 1;
  }

  const ghArgs = ["gh", "issue", "edit", String(opts.issue), "--repo", opts.repo, ...opts.rest];

  if (opts.dryRun) {
    console.log(`dry run: would edit issue via: ${ghArgs.join(" ")}`);
    return 0;
  }

  const result = await runWithRetry(deps.runCmd, ghArgs, { sleep: deps.sleep });
  if (result.code !== 0) {
    console.error(`gh issue edit failed after ${result.attempts} attempt(s): ${result.stderr}`);
    return 1;
  }
  console.log(`edited ${opts.repo}#${opts.issue}`);
  return 0;
}

async function realRunCmd(cmd: string[]) {
  const command = new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await command.output();
  return { code, stdout: new TextDecoder().decode(stdout), stderr: new TextDecoder().decode(stderr) };
}

if (import.meta.main) {
  const deps: Deps = { readFileText: (p) => Deno.readTextFile(p), runCmd: realRunCmd };
  Deno.exit(await run(Deno.args, deps));
}
