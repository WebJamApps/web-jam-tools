#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * scripts/post-issue-comment.ts — web-jam-tools#685
 *
 * Guarded CLI over `gh issue comment`. hooks/block-raw-gh-write.sh denies
 * the raw form on both agent surfaces; this is the only route to it.
 */
import { runFormGuards } from "./gh-write/guard.ts";
import { type RunCmd, runWithRetry } from "./gh-write/gh_runner.ts";

export interface Options {
  repo?: string;
  issue?: number;
  bodyFile?: string;
  dryRun: boolean;
}

export function parseArgs(args: string[]): Options {
  const opts: Options = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo") opts.repo = args[++i];
    else if (arg === "--issue") opts.issue = Number(args[++i]);
    else if (arg === "--body-file") opts.bodyFile = args[++i];
    else if (arg === "--dry-run") opts.dryRun = true;
  }
  return opts;
}

export interface Deps {
  readFileText: (path: string) => Promise<string>;
  runCmd: RunCmd;
  sleep?: (ms: number) => Promise<void>;
}

const USAGE = "usage: post-issue-comment --repo <owner/repo> --issue <n> --body-file <path> [--dry-run]";

export async function run(args: string[], deps: Deps): Promise<number> {
  const opts = parseArgs(args);
  if (!opts.repo || !opts.issue || !opts.bodyFile) {
    console.error(USAGE);
    return 1;
  }

  const body = await deps.readFileText(opts.bodyFile);
  const formResult = runFormGuards(body);
  if (!formResult.ok) {
    console.error(formResult.error);
    return 1;
  }

  const ghArgs = ["gh", "issue", "comment", `${opts.repo}#${opts.issue}`, "--body-file", opts.bodyFile];

  if (opts.dryRun) {
    console.log(`dry run: would post comment via: ${ghArgs.join(" ")}`);
    return 0;
  }

  const result = await runWithRetry(deps.runCmd, ghArgs, { sleep: deps.sleep });
  if (result.code !== 0) {
    console.error(`gh issue comment failed after ${result.attempts} attempt(s): ${result.stderr}`);
    return 1;
  }
  console.log(`posted comment to ${opts.repo}#${opts.issue}`);
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
