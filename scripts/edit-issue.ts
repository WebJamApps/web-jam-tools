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

export interface Deps {
  readFileText: (path: string) => Promise<string>;
  runCmd: RunCmd;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the roster probe script path (tests only). */
  probeScriptPath?: string;
}

const USAGE =
  "usage: edit-issue --repo <owner/repo> --issue <n> [--author <tool — model>] [gh issue edit flags...] [--dry-run]\n  --author is required whenever --body or --body-file replaces the body.";

export async function run(args: string[], deps: Deps): Promise<number> {
  const opts = parseArgs(args);
  if (!opts.repo || !opts.issue || opts.rest.length === 0) {
    console.error(USAGE);
    return 1;
  }

  const bodyFileIdx = opts.rest.indexOf("--body-file");
  const bodyIdx = opts.rest.indexOf("--body");
  let bodyText: string | undefined;
  if (bodyFileIdx !== -1 && opts.rest[bodyFileIdx + 1] !== undefined) {
    bodyText = await deps.readFileText(opts.rest[bodyFileIdx + 1]);
  } else if (bodyIdx !== -1 && opts.rest[bodyIdx + 1] !== undefined) {
    bodyText = opts.rest[bodyIdx + 1];
  }
  if (bodyText !== undefined) {
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
    if (bodyFileIdx !== -1 && opts.rest[bodyFileIdx + 1] !== undefined) {
      opts.rest.splice(bodyFileIdx, 2, "--body", bodyText);
    } else {
      opts.rest[bodyIdx + 1] = bodyText;
    }
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
