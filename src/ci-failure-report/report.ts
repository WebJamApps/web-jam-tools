/**
 * Shared CircleCI failure reporter (web-jam-tools#1337, #1910): finds the newest CircleCI build on
 * a pull request's branch and reports failed steps with a sanitized excerpt of their output.
 *
 * Raw logs and signed URLs never leave this module: signed CircleCI output URLs, cloud presigned
 * URLs, PEM blocks, bare base64 runs, and credentials are withheld unconditionally, and any fetch,
 * payload, or safety post-check failure refuses to quote log text for that step.
 *
 * Design: ~/Dropbox/web-jam-llms/Operations/circleci-pr-checks-design.md, "Safe CircleCI failure
 * reports".
 */

import {
  findCredentialLiteral,
  FIXTURE_PRAGMA,
} from "../../hooks/lib/detect_credential_literal.ts";

export const WITHHELD = "[credential-like value withheld]";
export const WITHHELD_SIGNED_URL = "[signed CircleCI URL withheld]";
export const WITHHELD_NO_OUTPUT = "(this step recorded no output)";
export const WITHHELD_FETCH_FAILED = "(log text withheld: step output fetch failed)";
export const WITHHELD_FORMAT_UNVERIFIED =
  "(log text withheld: step output format could not be verified)";
export const WITHHELD_SAFETY_FAILED = "(log text withheld: safety check failed)";
export const PUBLIC_URL_UNAVAILABLE = "(public build URL unavailable)";
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

/**
 * Whole-text matchers for CircleCI private output URLs (including line-wrapped continuations
 * onto the next line) so both lines of a wrapped URL are withheld before line splitting.
 */
const WRAPPED_CIRCLECI_OUTPUT_URL =
  /https?:\/\/(?:[a-z0-9-]+\.)*circleci\.com(?:\/[^\s]*)?\/(?:api\/)?private\/output\/[^\s]*(?:\n[ \t]*[?&]token=[^\s]+)?/gi;
const WRAPPED_CIRCLECI_PATH_SPLIT =
  /https?:\/\/(?:[a-z0-9-]+\.)*circleci\.com\/[^\s]*\n[ \t]*(?:api\/)?private\/output\/[^\s]*(?:\n[ \t]*[?&]token=[^\s]+)?/gi;

/** Line-level matchers for signed CircleCI and cloud presigned URLs. */
const CIRCLECI_OUTPUT_PATH_WITH_TOKEN = /(?:\/api)?\/private\/output\/[^\s]*[?&]token=[^\s]*/gi;
const CIRCLECI_OUTPUT_PATH_RE = /\/(?:api\/)?private\/output\//i;
const CLOUD_PRESIGNED_URL_RE =
  /https?:\/\/[^\s]*[?&](?:X-Amz-Signature|X-Amz-Security-Token|X-Amz-Credential|AWSAccessKeyId|Signature|GoogleAccessId)=[^\s]*/gi;
const CLOUD_PRESIGNED_PARAM_RE =
  /(?:[?&])?(?:X-Amz-Signature|X-Amz-Security-Token|X-Amz-Credential|AWSAccessKeyId|Signature|GoogleAccessId)=/i;

/** Strip fixture-suppression pragmas so test logs cannot suppress credential detection. */
function withoutFixturePragma(text: string): string {
  return text.replaceAll(FIXTURE_PRAGMA, "");
}

/** True when a line carries any signed CircleCI URL or cloud presigned parameter. */
function hasSignedUrlLine(line: string): boolean {
  return (
    line.includes(WITHHELD_SIGNED_URL) ||
    CIRCLECI_OUTPUT_PATH_RE.test(line) ||
    CLOUD_PRESIGNED_PARAM_RE.test(line)
  );
}

/**
 * Validates that `buildUrl` is a public CircleCI build/pipeline URL with no query string, no
 * fragment, no userinfo, and no private output path. Returns `null` when invalid.
 */
export function sanitizePublicBuildUrl(rawUrl: string | undefined | null): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.search !== "" || parsed.hash !== "") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (CIRCLECI_OUTPUT_PATH_RE.test(parsed.pathname)) return null;
  const host = parsed.hostname.toLowerCase();
  if (host === "circleci.com" && /^\/gh\/WebJamApps\/[^/]+\/\d+\/?$/.test(parsed.pathname)) {
    return parsed.toString();
  }
  if (
    host === "app.circleci.com" &&
    /^\/pipelines\/gh\/WebJamApps\/[^/]+(?:\/[^/]+)*\/?$/.test(parsed.pathname)
  ) {
    return parsed.toString();
  }
  return null;
}

/** Withhold signed URLs and credential-like content in a CI log before any of it is shown. */
export function sanitizeLog(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n")
    .replace(PEM_BLOCK, WITHHELD)
    .replace(WRAPPED_CIRCLECI_PATH_SPLIT, WITHHELD_SIGNED_URL)
    .replace(WRAPPED_CIRCLECI_OUTPUT_URL, WITHHELD_SIGNED_URL)
    .replace(CIRCLECI_OUTPUT_PATH_WITH_TOKEN, WITHHELD_SIGNED_URL)
    .replace(CLOUD_PRESIGNED_URL_RE, WITHHELD_SIGNED_URL);

  return normalized
    .split("\n")
    .map((line) => {
      if (hasSignedUrlLine(line)) return WITHHELD_SIGNED_URL;
      const checkLine = withoutFixturePragma(line);
      if (findCredentialLiteral(checkLine) !== null || BASE64_RUN.test(checkLine.trim())) {
        return WITHHELD;
      }
      return line;
    })
    .join("\n");
}

/**
 * Independent fail-closed post-check run on sanitized excerpts and assembled reports.
 * Throws if any signed CircleCI path, cloud presigned parameter, PEM marker, credential literal
 * (with `webjam-fixture-ok` stripped), or bare 40+ char base64 run remains.
 */
export function assertSafeReportText(text: string): void {
  if (CIRCLECI_OUTPUT_PATH_RE.test(text)) {
    throw new Error("signed CircleCI output path remained after sanitization");
  }
  if (CLOUD_PRESIGNED_PARAM_RE.test(text)) {
    throw new Error("cloud presigned URL parameter remained after sanitization");
  }
  if (/-----BEGIN [A-Z0-9 ]*-----/i.test(text) || text.includes("-----BEGIN ")) {
    throw new Error("PEM marker remained after sanitization");
  }
  const strippedAll = withoutFixturePragma(text);
  if (findCredentialLiteral(strippedAll) !== null) {
    throw new Error("credential literal remained after sanitization");
  }
  for (const line of text.split("\n")) {
    const stripped = withoutFixturePragma(line);
    if (findCredentialLiteral(stripped) !== null || BASE64_RUN.test(stripped.trim())) {
      throw new Error("credential or base64 run remained on line after sanitization");
    }
  }
}

export interface ReportSafetyDeps {
  sanitize?: (text: string) => string;
  verifySafe?: (text: string) => void;
}

export interface FailedStep {
  step: string;
  exitCode: number | null;
  /** The last lines of the step's output, already sanitized. */
  excerpt: string[];
  /** Fixed notice when log text is absent or withheld; never contains untrusted log content. */
  withheldReason?: string;
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

/** Returns only an HTTP status label or a fixed label — never raw URLs or exception text. */
function safeLookupErrorLabel(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /^HTTP (\d{3})$/.exec(msg.trim());
  return m ? `HTTP ${m[1]}` : "network or parse error";
}

function sanitizeLabelField(value: string, fallback: string): string {
  const cleaned = sanitizeLog(value).replace(/\n+/g, " ").trim();
  try {
    assertSafeReportText(cleaned);
    return cleaned || fallback;
  } catch {
    return fallback;
  }
}

/** The failed step's output as text, sanitized and post-checked, or a fixed refusal notice. */
async function stepOutput(
  action: BuildAction,
  fetchJson: FetchJson,
  safetyDeps?: ReportSafetyDeps,
): Promise<{ excerpt: string[]; withheldReason?: string }> {
  if (!action.output_url) {
    return { excerpt: [], withheldReason: WITHHELD_NO_OUTPUT };
  }
  let entries: unknown;
  try {
    entries = await fetchJson(action.output_url);
  } catch {
    // The error could quote the signed URL, so it is never repeated.
    return { excerpt: [], withheldReason: WITHHELD_FETCH_FAILED };
  }
  if (
    !Array.isArray(entries) ||
    entries.some((e) =>
      e === null || typeof e !== "object" ||
      typeof (e as { message?: unknown }).message !== "string"
    )
  ) {
    return { excerpt: [], withheldReason: WITHHELD_FORMAT_UNVERIFIED };
  }

  const rawText = (entries as Array<{ message: string }>).map((e) => e.message).join("");
  if (rawText.trim() === "") {
    return { excerpt: [], withheldReason: WITHHELD_NO_OUTPUT };
  }

  const sanitize = safetyDeps?.sanitize ?? sanitizeLog;
  const verifySafe = safetyDeps?.verifySafe ?? assertSafeReportText;
  try {
    const sanitized = sanitize(rawText);
    const lines = sanitized.replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    const excerpt = lines.slice(-EXCERPT_LINES);
    verifySafe(excerpt.join("\n"));
    return { excerpt };
  } catch {
    return { excerpt: [], withheldReason: WITHHELD_SAFETY_FAILED };
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
  safetyDeps?: ReportSafetyDeps,
): Promise<CiReport> {
  const base = `${CIRCLECI_V1}/${encodeURIComponent(repo)}`;
  let builds: unknown;
  try {
    builds = await fetchJson(
      `${base}/tree/${encodeURIComponent(branch)}?limit=1&shallow=true`,
    );
  } catch (err) {
    return { kind: "unknown", reason: `the build lookup failed: ${safeLookupErrorLabel(err)}` };
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
      reason: `build ${newest.build_num} could not be read: ${safeLookupErrorLabel(err)}`,
    };
  }
  const failed: FailedStep[] = [];
  for (const step of detail.steps ?? []) {
    for (const action of step.actions ?? []) {
      if (!action.failed) continue;
      const out = await stepOutput(action, fetchJson, safetyDeps);
      failed.push({
        step: step.name ?? "(unnamed step)",
        exitCode: typeof action.exit_code === "number" ? action.exit_code : null,
        excerpt: out.excerpt,
        ...(out.withheldReason ? { withheldReason: out.withheldReason } : {}),
      });
    }
  }
  return {
    kind: "read",
    build: newest.build_num,
    buildUrl: sanitizePublicBuildUrl(detail.build_url) ?? PUBLIC_URL_UNAVAILABLE,
    status: detail.status ?? "unknown",
    failed,
  };
}

function buildSafeReportLines(
  report: Extract<CiReport, { kind: "read" }>,
  forceWithheldAll: boolean,
): string[] {
  const safeUrl = sanitizePublicBuildUrl(report.buildUrl) ?? PUBLIC_URL_UNAVAILABLE;
  const safeStatus = sanitizeLabelField(report.status, "unknown");
  const lines = [`Build ${report.build} (${safeStatus}): ${safeUrl}`];
  if (!report.failed.length) {
    lines.push(
      PASSED.has(report.status)
        ? "No step failed."
        : `No step has failed so far, but the build is ${safeStatus}: do not treat it as passing.`,
    );
    return lines;
  }
  for (const f of report.failed) {
    const safeStep = sanitizeLabelField(f.step, "(unnamed step)");
    lines.push("", `Failed step: ${safeStep} (exit ${f.exitCode ?? "unknown"})`);
    if (forceWithheldAll) {
      lines.push(`  ${WITHHELD_SAFETY_FAILED}`);
    } else if (f.withheldReason) {
      lines.push(`  ${f.withheldReason}`);
    } else {
      lines.push(
        `Last ${f.excerpt.length} lines of its output, sanitized:`,
        ...f.excerpt.map((l) => `  ${l}`),
      );
    }
  }
  return lines;
}

/** The report as text: the only form of CI output callers may quote. */
export function formatReport(report: CiReport, safetyDeps?: ReportSafetyDeps): string {
  const verifySafe = safetyDeps?.verifySafe ?? assertSafeReportText;
  if (report.kind === "unknown") {
    const safeReason = sanitizeLabelField(report.reason, "build lookup could not be verified");
    const msg = `CI unknown: ${safeReason}. Do not treat this as a passing build.`;
    try {
      verifySafe(msg);
      return msg;
    } catch {
      return "CI unknown: build lookup could not be verified. Do not treat this as a passing build.";
    }
  }

  const sanitize = safetyDeps?.sanitize ?? sanitizeLog;
  try {
    const candidate = sanitize(buildSafeReportLines(report, false).join("\n"));
    verifySafe(candidate);
    return candidate;
  } catch {
    return buildSafeReportLines(report, true).join("\n");
  }
}
