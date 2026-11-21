#!/usr/bin/env -S deno run --allow-net=circleci.com --allow-env=CIRCLECI_TOKEN
// scripts/ci-failure-report.ts — the fix-pr skill's CI read (web-jam-tools#1337)
//
// Usage: deno task ci-failure-report --repo <Repo> --branch <branch> --head <commit>
//
// Prints the newest CircleCI build on the branch when it built <commit>, each failed step with its
// exit code, and a sanitized excerpt of its output. Raw logs and signed log links stay inside.
// CIRCLECI_TOKEN is read from the environment when set; public projects need none.
import { ciFailureReport, type FetchJson, formatReport } from "../src/ci-failure-report/report.ts";

const USAGE = "usage: ci-failure-report --repo <Repo> --branch <branch> --head <commit>";

function parseArgs(args: string[]): { repo: string; branch: string; head: string } | null {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--(repo|branch|head)(?:=(.*))?$/.exec(args[i]);
    if (!m) return null;
    const value = m[2] ?? args[++i];
    if (!value) return null;
    out[m[1]] = value;
  }
  return out.repo && out.branch && out.head
    ? { repo: out.repo, branch: out.branch, head: out.head }
    : null;
}

export async function main(args: string[], fetchJson?: FetchJson): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed) {
    console.error(USAGE);
    return 1;
  }
  const token = Deno.env.get("CIRCLECI_TOKEN");
  const fetcher: FetchJson = fetchJson ?? (async (url) => {
    const res = await fetch(url, token ? { headers: { "Circle-Token": token } } : undefined);
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  });
  const report = await ciFailureReport(parsed.repo, parsed.branch, parsed.head, fetcher);
  console.log(formatReport(report));
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
