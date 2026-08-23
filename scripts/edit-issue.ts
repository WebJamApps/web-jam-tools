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
 */
import { checkNoCredentialLiteral, checkNotEmpty } from "./gh-write/guard.ts";
import { type RunCmd, runWithRetry } from "./gh-write/gh_runner.ts";

export interface Options {
  repo?: string;
  issue?: number;
  dryRun: boolean;
  rest: string[];
}

export function parseArgs(args: string[]): Options {
  const opts: Options = { dryRun: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo") opts.repo = args[++i];
    else if (arg === "--issue") opts.issue = Number(args[++i]);
    else if (arg === "--dry-run") opts.dryRun = true;
    else opts.rest.push(arg);
  }
  return opts;
}

export interface Deps {
  readFileText: (path: string) => Promise<string>;
  runCmd: RunCmd;
  sleep?: (ms: number) => Promise<void>;
}

const USAGE = "usage: edit-issue --repo <owner/repo> --issue <n> [gh issue edit flags...] [--dry-run]";

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
  }

  const credResult = checkNoCredentialLiteral(opts.rest.join(" "));
  if (!credResult.ok) {
    console.error(credResult.error);
    return 1;
  }

  const ghArgs = ["gh", "issue", "edit", `${opts.repo}#${opts.issue}`, ...opts.rest];

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
