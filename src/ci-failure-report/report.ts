/**
 * The CI read of the fix-pr skill (web-jam-tools#1337): find the newest CircleCI build on a pull
 * request's branch, and report its failed steps with a sanitized excerpt of their output.
 *
 * Raw logs and their signed `output_url` links never leave this module: the report carries the
 * build, each failed step's name and exit code, and the last lines of its output after
 * sanitizeLog has withheld anything credential-like, multi-line private keys included.
 *
 * Design: ~/Dropbox/web-jam-llms/Token_Savings/fix-pr-design-2026-10-10.md, "What happens when
 * Josh types it", steps 1 and 7.
 */

import { findCredentialLiteral } from "../../hooks/lib/detect_credential_literal.ts";

export const WITHHELD = "[credential-like value withheld]";
export const EXCERPT_LINES = 30;
export const CIRCLECI_V1 = "https://circleci.com/api/v1.1/project/github/WebJamApps";

/** The statuses CircleCI gives a finished build that passed. */
const PASSED = new Set(["success", "fixed"]);

/**
 * A PEM-style block from its BEGIN marker to its END marker, or to the end of the log when the END
 * marker never comes. It also matches a block written on one line with escaped `\n`, as a JSON
 * key file prints.
 */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g;

/** A line that is only a long base64 run: a key or token body that lost its markers. */
const BASE64_RUN = /^[A-Za-z0-9+/=_-]{40,}$/;

/** Withhold everything credential-like in a CI log, across lines, before any of it is shown. */
export function sanitizeLog(text: string): string {
  return text.replace(PEM_BLOCK, WITHHELD)
    .split("\n")
    .map((line) =>
      findCredentialLiteral(line) !== null || BASE64_RUN.test(line.trim()) ? WITHHELD : line
    )
    .join("\n");
}

export interface FailedStep {
  step: string;
  exitCode: number | null;
  /** The last lines of the step's output, already sanitized. */
  excerpt: string[];
}

export type CiReport =
  | { kind: "unknown"; reason: string }
  | {
    kind: "read";
    build: number;
    buildUrl: string;
    status: string;
    failed: FailedStep[];
  };

export type FetchJson = (url: string) => Promise<unknown>;

interface BuildSummary {
  build_num?: number;
  vcs_revision?: string;
}

interface BuildAction {
  failed?: boolean | null;
  exit_code?: number | null;
  output_url?: string | null;
}

interface BuildDetail {
  build_num?: number;
  build_url?: string;
  status?: string;
  steps?: Array<{ name?: string; actions?: BuildAction[] }>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The failed step's output as text, sanitized, or a line saying it could not be read. */
async function stepOutput(action: BuildAction, fetchJson: FetchJson): Promise<string[]> {
  if (!action.output_url) return ["(this step recorded no output)"];
  try {
    const entries = await fetchJson(action.output_url);
    if (!Array.isArray(entries)) return ["(this step's output could not be read)"];
    const text = entries
      .map((e) => (typeof e?.message === "string" ? e.message : ""))
      .join("");
    const lines = sanitizeLog(text).replace(/\r/g, "").split("\n");
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.slice(-EXCERPT_LINES);
  } catch {
    // The error could quote the signed URL, so it is not repeated.
    return ["(this step's output could not be read)"];
  }
}

/**
 * Read CI for a pull request's head commit. The newest build on the branch is used only when it
 * built that commit; anything else is reported as unknown, never as passing.
 */
export async function ciFailureReport(
  repo: string,
  branch: string,
  head: string,
  fetchJson: FetchJson,
): Promise<CiReport> {
  const base = `${CIRCLECI_V1}/${encodeURIComponent(repo)}`;
  let builds: unknown;
  try {
    builds = await fetchJson(
      `${base}/tree/${encodeURIComponent(branch)}?limit=1&shallow=true`,
    );
  } catch (err) {
    return { kind: "unknown", reason: `the build lookup failed: ${errorText(err)}` };
  }
  const newest = Array.isArray(builds) ? builds[0] as BuildSummary | undefined : undefined;
  if (!newest || typeof newest.build_num !== "number") {
    return { kind: "unknown", reason: `CircleCI lists no build on ${branch}` };
  }
  if (newest.vcs_revision !== head) {
    return {
      kind: "unknown",
      reason: `the newest build on ${branch} (${newest.build_num}) is for ${
        String(newest.vcs_revision).slice(0, 8)
      }, not the head commit ${head.slice(0, 8)}`,
    };
  }
  let detail: BuildDetail;
  try {
    detail = await fetchJson(`${base}/${newest.build_num}`) as BuildDetail;
  } catch (err) {
    return {
      kind: "unknown",
      reason: `build ${newest.build_num} could not be read: ${errorText(err)}`,
    };
  }
  const failed: FailedStep[] = [];
  for (const step of detail.steps ?? []) {
    for (const action of step.actions ?? []) {
      if (!action.failed) continue;
      failed.push({
        step: step.name ?? "(unnamed step)",
        exitCode: typeof action.exit_code === "number" ? action.exit_code : null,
        excerpt: await stepOutput(action, fetchJson),
      });
    }
  }
  return {
    kind: "read",
    build: newest.build_num,
    buildUrl: detail.build_url ?? "",
    status: detail.status ?? "unknown",
    failed,
  };
}

/** The report as text: the only form of CI output the skill quotes. */
export function formatReport(report: CiReport): string {
  if (report.kind === "unknown") {
    return `CI unknown: ${report.reason}. Do not treat this as a passing build.`;
  }
  const lines = [`Build ${report.build} (${report.status}): ${report.buildUrl}`];
  if (!report.failed.length) {
    lines.push(
      PASSED.has(report.status)
        ? "No step failed."
        : `No step has failed so far, but the build is ${report.status}: do not treat it as passing.`,
    );
  }
  for (const f of report.failed) {
    lines.push(
      "",
      `Failed step: ${f.step} (exit ${f.exitCode ?? "unknown"})`,
      `Last ${f.excerpt.length} lines of its output, sanitized:`,
      ...f.excerpt.map((l) => `  ${l}`),
    );
  }
  // Every line of the report passes the same filter once more.
  return sanitizeLog(lines.join("\n"));
}
