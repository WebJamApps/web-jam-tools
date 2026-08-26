#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * scripts/post-pr-review.ts — web-jam-tools#685
 *
 * Guarded CLI over `gh pr review --comment`. This is the ONLY route to that
 * verb — hooks/block-raw-gh-write.sh denies the raw form on both agent
 * surfaces, so a dispatched reviewing subagent (which has no human present
 * to answer a permission prompt) completes its own review post instead of
 * writing a scratch file and handing the path back to the orchestrating
 * session.
 *
 * Never `--approve` or `--request-changes`: a verdict that blocks or clears
 * a merge is Josh's, not an agent's — this CLI does not expose those flags
 * at all, by construction (§4 of the design document).
 */
import {
  isAlreadyReviewedAtHeadSha,
  runFormGuards,
} from "./gh-write/guard.ts";
import { type RunCmd, runWithRetry } from "./gh-write/gh_runner.ts";

export interface Options {
  repo?: string;
  pr?: number;
  bodyFile?: string;
  dryRun: boolean;
}

export function parseArgs(args: string[]): Options {
  const opts: Options = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo") opts.repo = args[++i];
    else if (arg === "--pr") opts.pr = Number(args[++i]);
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

const USAGE = "usage: post-pr-review --repo <owner/repo> --pr <n> --body-file <path> [--dry-run]";

export async function run(args: string[], deps: Deps): Promise<number> {
  const opts = parseArgs(args);
  if (!opts.repo || !opts.pr || !opts.bodyFile) {
    console.error(USAGE);
    return 1;
  }

  const body = await deps.readFileText(opts.bodyFile);
  const formResult = runFormGuards(body, { requireReviewHeader: true });
  if (!formResult.ok) {
    console.error(formResult.error);
    return 1;
  }

  const already = await isAlreadyReviewedAtHeadSha(opts.repo, opts.pr, deps.runCmd);
  if (already.skip) {
    console.log(`skipping post: ${already.reason} — not double-posting`);
    return 0;
  }

  const ghArgs = [
    "gh",
    "pr",
    "review",
    String(opts.pr),
    "--repo",
    opts.repo,
    "--comment",
    "--body-file",
    opts.bodyFile,
  ];

  if (opts.dryRun) {
    console.log(`dry run: would post review comment via: ${ghArgs.join(" ")}`);
    return 0;
  }

  const result = await runWithRetry(deps.runCmd, ghArgs, { sleep: deps.sleep });
  if (result.code !== 0) {
    console.error(`gh pr review failed after ${result.attempts} attempt(s): ${result.stderr}`);
    return 1;
  }
  console.log(`posted review comment to ${opts.repo}#${opts.pr}`);
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
