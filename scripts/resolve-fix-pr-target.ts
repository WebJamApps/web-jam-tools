/**
 * scripts/resolve-fix-pr-target.ts
 *
 * Read-only `deno task fix-pr:resolve-target <arguments>`: resolves the pull request a `/fix-pr`
 * call's arguments name (a GitHub link, `repo#N`, a bare number in this checkout, or a CircleCI build
 * or job link) through the shared parser and resolver in `hooks/lib/fix_run.ts`, then checks the pull
 * request is open, in this checkout's repository, from no fork, and not headed by `dev` or `main`.
 *
 * Prints `{ repo, number, branch, build }` as JSON on success; exits 1 with the refusal on stderr.
 * Design: ~/Dropbox/web-jam-llms/Token_Savings/fix-pr-design-2026-10-10.md, "Accepting CircleCI build
 * and job links". Explicit-argument mode only; the session-reading mode is a later step.
 */

import {
  githubRepository,
  parseFixPrTarget,
  PR_FIELDS,
  type PullRequestState,
  resolveFixPrTarget,
  runGhCommand,
  type TargetResolverDeps,
} from "../hooks/lib/fix_run.ts";

export interface ResolvedFixPrTarget {
  repo: string;
  number: number;
  branch: string;
  build: number | null;
}

export type ResolveCliResult =
  | { ok: true; target: ResolvedFixPrTarget }
  | { ok: false; reason: string };

export interface ResolveCliDeps extends TargetResolverDeps {
  /** The GitHub repository of the checkout the command runs in, or null when it cannot be read. */
  checkoutRepo?: () => Promise<string | null>;
}

async function originRepo(): Promise<string | null> {
  try {
    const result = await new Deno.Command("git", {
      args: ["remote", "get-url", "--push", "--all", "origin"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return result.code === 0 ? githubRepository(new TextDecoder().decode(result.stdout)) : null;
  } catch {
    return null;
  }
}

/** Resolve and verify the target; every failure, including a lookup error, is a refusal. */
export async function resolveTargetCli(
  args: string[],
  deps: ResolveCliDeps = {},
): Promise<ResolveCliResult> {
  const flag = args.find((arg) => arg.startsWith("--"));
  if (flag) return { ok: false, reason: `'${flag}' is not supported; pass the call's arguments` };
  const checkoutRepo = await (deps.checkoutRepo ?? originRepo)();
  // A link naming another repository is refused before any CircleCI or GitHub lookup.
  const parsed = parseFixPrTarget(args.join(" "));
  const named = parsed.ok ? parsed.target.repo : null;
  if (checkoutRepo && named && named.toLowerCase() !== checkoutRepo.toLowerCase()) {
    return { ok: false, reason: `the target is in ${named}, not this checkout's ${checkoutRepo}` };
  }
  const resolution = await resolveFixPrTarget(args.join(" "), checkoutRepo, deps);
  if (resolution.kind !== "resolved") return { ok: false, reason: resolution.reason };
  const { ref } = resolution;
  if (checkoutRepo && ref.repo.toLowerCase() !== checkoutRepo.toLowerCase()) {
    return {
      ok: false,
      reason: `the target is in ${ref.repo}, not this checkout's ${checkoutRepo}`,
    };
  }
  let pr: PullRequestState;
  try {
    const view = await (deps.runGh ?? runGhCommand)([
      "pr",
      "view",
      String(ref.number),
      "--repo",
      ref.repo,
      "--json",
      PR_FIELDS,
    ]);
    if (view.code !== 0) {
      return { ok: false, reason: "GitHub could not be read for the pull request" };
    }
    pr = JSON.parse(view.stdout);
  } catch {
    return { ok: false, reason: "GitHub returned malformed pull request data" };
  }
  if (
    !pr || typeof pr !== "object" || pr.number !== ref.number ||
    typeof pr.headRefName !== "string"
  ) {
    return { ok: false, reason: "GitHub returned malformed pull request data" };
  }
  if (pr.state !== "OPEN") {
    return { ok: false, reason: `pull request ${ref.repo}#${ref.number} is ${pr.state}, not open` };
  }
  if (
    pr.isCrossRepository !== false ||
    pr.headRepository?.nameWithOwner?.toLowerCase() !== ref.repo.toLowerCase()
  ) {
    return { ok: false, reason: "the pull request comes from another repository (a fork)" };
  }
  if (!pr.headRefName || pr.headRefName === "dev" || pr.headRefName === "main") {
    return { ok: false, reason: `the pull request's head branch '${pr.headRefName}' is protected` };
  }
  if (resolution.branch !== undefined && resolution.branch !== pr.headRefName) {
    return { ok: false, reason: "the pull request's head branch no longer matches the build" };
  }
  return {
    ok: true,
    target: {
      repo: ref.repo,
      number: ref.number,
      branch: pr.headRefName,
      build: resolution.build ?? null,
    },
  };
}

if (import.meta.main) {
  if (Deno.args.length === 1 && Deno.args[0] === "--help") {
    console.log("usage: deno task fix-pr:resolve-target <the /fix-pr call's arguments>");
    console.log("Prints { repo, number, branch, build } as JSON, or exits 1 with the refusal.");
    Deno.exit(0);
  }
  const result = await resolveTargetCli([...Deno.args]);
  if (!result.ok) {
    console.error(`Refused: ${result.reason}`);
    Deno.exit(1);
  }
  console.log(JSON.stringify(result.target));
}
