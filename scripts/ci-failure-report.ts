#!/usr/bin/env -S deno run --allow-net=circleci.com --allow-env=CIRCLECI_TOKEN
// scripts/ci-failure-report.ts — shared CircleCI failure report CLI (web-jam-tools#1337, #1910)
//
// Usage: deno task ci-failure-report --repo <Repo> --branch <branch> --head <commit>
//
// Prints the newest CircleCI build on the branch when it built <commit>, each failed step with its
// exit code, and a sanitized excerpt of its output. Raw logs and signed log links stay inside.
// CIRCLECI_TOKEN is sent only to CircleCI API endpoints, never to presigned output_url fetches.
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

/** True only for CircleCI REST API v1.1/v2 endpoints where `Circle-Token` is needed. */
export function isCircleCiApiUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "circleci.com" &&
      (url.pathname.startsWith("/api/v1.1/") || url.pathname.startsWith("/api/v2/"))
    );
  } catch {
    return false;
  }
}

/**
 * Builds the default JSON fetcher: sends `Circle-Token` only to CircleCI API endpoints,
 * omits it on presigned `output_url` fetches, and refuses redirects on `output_url`.
 */
export function createDefaultFetcher(
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): FetchJson {
  return async (url: string) => {
    const isApi = isCircleCiApiUrl(url);
    const init: RequestInit = {};
    if (isApi && token) {
      init.headers = { "Circle-Token": token };
    }
    if (!isApi) {
      init.redirect = "error";
    }
    const res = await fetchImpl(url, init);
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  };
}

export async function main(args: string[], fetchJson?: FetchJson): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed) {
    console.error(USAGE);
    return 1;
  }
  const token = Deno.env.get("CIRCLECI_TOKEN");
  const fetcher: FetchJson = fetchJson ?? createDefaultFetcher(token);
  const report = await ciFailureReport(parsed.repo, parsed.branch, parsed.head, fetcher);
  console.log(formatReport(report));
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
