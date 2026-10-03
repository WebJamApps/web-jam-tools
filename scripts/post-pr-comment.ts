#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * scripts/post-pr-comment.ts — web-jam-tools#685
 *
 * Guarded CLI over `gh pr comment`. hooks/block-raw-gh-write.sh denies the
 * raw form on both agent surfaces; this is the only route to it.
 */
import { probeRoster } from "../hooks/lib/authored_by_footer.ts";
import { extractFooterEntries, REVIEW_SUMMARY_HEADER, runFormGuards } from "./gh-write/guard.ts";
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
  createPrScriptPath?: string;
}

const USAGE = "usage: post-pr-comment --repo <owner/repo> --pr <n> --body-file <path> [--dry-run]";

export async function run(args: string[], deps: Deps): Promise<number> {
  const opts = parseArgs(args);
  if (!opts.repo || !opts.pr || !opts.bodyFile) {
    console.error(USAGE);
    return 1;
  }

  const body = await deps.readFileText(opts.bodyFile);
  const formResult = runFormGuards(body, {
    // A body carrying the review header is a Step 4 follow-up review; any other
    // comment (e.g. a "Fixed by" note) is posted exactly as before.
    requireReviewerLine: body.includes(REVIEW_SUMMARY_HEADER),
  });
  if (!formResult.ok) {
    console.error(formResult.error);
    return 1;
  }

  // --- Author roster check for Work-by footers (web-jam-tools#1200) ---
  const footers = extractFooterEntries(body);
  if (footers.length > 0) {
    for (const footer of footers) {
      // The probe call and its three-outcome classification live in one place.
      const probe = await probeRoster(footer.author, deps.runCmd, deps.createPrScriptPath);
      if (probe.outcome === "not-on-roster") {
        console.error(
          `refusing to post: footer line '${footer.line}' names a model not on the author roster.`,
        );
        console.error(probe.rosterMessage);
        return 1;
      }
      if (probe.outcome === "could-not-run") {
        console.error(`refusing to post: ${probe.message}`);
        return 1;
      }
    }
  }

  const ghArgs = [
    "gh",
    "pr",
    "comment",
    String(opts.pr),
    "--repo",
    opts.repo,
    "--body-file",
    opts.bodyFile,
  ];

  if (opts.dryRun) {
    console.log(`dry run: would post comment via: ${ghArgs.join(" ")}`);
    return 0;
  }

  const result = await runWithRetry(deps.runCmd, ghArgs, { sleep: deps.sleep });
  if (result.code !== 0) {
    console.error(`gh pr comment failed after ${result.attempts} attempt(s): ${result.stderr}`);
    return 1;
  }
  console.log(`posted comment to ${opts.repo}#${opts.pr}`);
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
