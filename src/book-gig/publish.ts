// src/book-gig/publish.ts — Publish rendered HTML review artifacts to web-jam-back /outreach/report,
// the sole durable copy of a /book-gig run report (web-jam-tools#955)

import { type BackendConfigOptions, resolveBackendConfig } from "./outreach_api.ts";
import { extractRunDataFromHtml, renderDarkHtml } from "./html.ts";
import { mergeWeekendRuns } from "./gmail.ts";
import { openHtmlInBrowser } from "./browser.ts";
import type { BookGigResult } from "./types.ts";

export const WEB_JAM_REPORT_BASE_URL = "https://www.web-jam.com/outreach/report";

export interface PublishReportResult {
  success: boolean;
  url?: string;
  weekend?: string;
  error?: string;
  statusCode?: number;
}

export interface PublishReportPayload {
  weekend: string;
  title: string;
  htmlContent: string;
  candidatesCount: number;
  dispatchedCount: number;
  metadata?: Record<string, unknown>;
}

/**
 * The stable slug identifying a weekend's (or replies scan's) single durable report record.
 */
export function weekendReportSlug(result: BookGigResult): string {
  return result.weekend
    ? `${result.weekend.start}-to-${result.weekend.end}`
    : `replies-${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Format the payload to post to POST /outreach/report
 */
export function formatReportPayload(
  result: BookGigResult,
  htmlContent: string,
): PublishReportPayload {
  const weekendSlug = weekendReportSlug(result);

  const title = result.weekend?.label
    ? `Gig Outreach Review: ${result.weekend.label}`
    : "Gig Outreach Run Report";

  return {
    weekend: weekendSlug,
    title,
    htmlContent,
    candidatesCount: result.candidates?.length ?? 0,
    dispatchedCount: result.batchDispatch?.sent ?? 0,
    metadata: {
      mode: result.mode,
      location: result.location?.raw,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Publish the rendered HTML review artifact to web-jam-back via POST /outreach/report
 */
export async function publishOutreachReport(
  result: BookGigResult,
  htmlContent: string,
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<PublishReportResult> {
  const payload = formatReportPayload(result, htmlContent);
  const weekendSlug = payload.weekend;
  const canonicalUrl = `${WEB_JAM_REPORT_BASE_URL}/${weekendSlug}`;

  try {
    const { baseUrl, token } = await resolveBackendConfig(options);
    const apiUrl = `${baseUrl}/outreach/report`;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await fetchFn(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(
        `[book-gig] Warning: Failed to publish HTML report to web-jam-back (HTTP ${res.status}): ${errText}`,
      );
      return {
        success: false,
        weekend: weekendSlug,
        error: `HTTP ${res.status}: ${errText}`,
        statusCode: res.status,
      };
    }

    return {
      success: true,
      url: canonicalUrl,
      weekend: weekendSlug,
      statusCode: res.status,
    };
  } catch (err) {
    const errMsg = (err as Error).message;
    console.warn(`[book-gig] Warning: Error publishing HTML report to web-jam-back: ${errMsg}`);
    return {
      success: false,
      weekend: weekendSlug,
      error: errMsg,
    };
  }
}

/**
 * Fetch the previously stored report HTML for a weekend from GET /outreach/report/:weekend,
 * so a new batch can accumulate into it. Returns null if none exists yet (HTTP 404) or the
 * fetch fails — a missing/unreadable previous report is treated as "start fresh", never an error.
 */
export async function fetchOutreachReport(
  weekendSlug: string,
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const { baseUrl } = await resolveBackendConfig(options);
    const url = `${baseUrl}/outreach/report/${encodeURIComponent(weekendSlug)}`;
    const res = await fetchFn(url, { method: "GET", headers: { Accept: "text/html" } });

    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      console.warn(
        `[book-gig] Note: fetching prior report for '${weekendSlug}' returned HTTP ${res.status}`,
      );
      return null;
    }

    return await res.text();
  } catch (err) {
    console.warn(
      `[book-gig] Note: could not fetch prior report for '${weekendSlug}': ${
        (err as Error).message
      }`,
    );
    return null;
  }
}

/**
 * Write the rendered report HTML to a disposable local scratch file purely so it can be
 * opened in Chrome immediately. This file is never read back — the database copy posted via
 * POST /outreach/report is the sole durable record (web-jam-tools#955, decision D-51).
 */
export async function writeScratchReportHtml(
  htmlContent: string,
  weekendSlug: string,
  scratchDir?: string,
): Promise<string> {
  const dir = scratchDir ?? `${await Deno.makeTempDir({ prefix: "book-gig-review-" })}`;
  await Deno.mkdir(dir, { recursive: true });
  const htmlPath = `${dir}/book-gig-run-${weekendSlug}.html`;
  await Deno.writeTextFile(htmlPath, htmlContent);
  return htmlPath;
}

export interface PublishAndOpenOptions extends BackendConfigOptions {
  /** Suppress the automatic Chrome open (mirrors the CLI's --no-open flag). */
  noOpen?: boolean;
  /** Override the disposable scratch directory the rendered HTML opens from (tests only). */
  scratchDir?: string;
  /** Dependency-injectable browser opener, for tests. */
  openBrowser?: (htmlPath: string) => Promise<boolean>;
}

export interface PublishAndOpenReportResult {
  result: BookGigResult;
  htmlPath: string | null;
  opened: boolean;
}

/**
 * The single entry point a /book-gig run calls to report its result: reads any previously
 * stored report for this weekend from the database, merges the current run's candidates/pitches/
 * batch tallies into it, posts the merged HTML back to POST /outreach/report as the one durable
 * copy, and writes that same HTML to a disposable scratch file purely so it can open in Chrome.
 * No file is ever written under ~/Dropbox/ (web-jam-tools#955, decision D-51).
 */
export async function publishAndOpenReport(
  result: BookGigResult,
  options: PublishAndOpenOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<PublishAndOpenReportResult> {
  const weekendSlug = weekendReportSlug(result);

  let merged = result;
  const alreadyConsolidated = (result as unknown as { _alreadyConsolidated?: boolean })
    ._alreadyConsolidated;
  if (result.weekend && !alreadyConsolidated) {
    const existingHtml = await fetchOutreachReport(weekendSlug, options, fetchFn);
    if (existingHtml) {
      const existingData = extractRunDataFromHtml(existingHtml);
      if (existingData) {
        merged = mergeWeekendRuns(
          {
            candidates: existingData.candidates ?? [],
            pitches: existingData.pitches ?? [],
            batchDispatch: existingData.batchDispatch,
            reportUrl: existingData.reportUrl,
          },
          result,
        );
      }
    }
  }

  const finalHtml = renderDarkHtml(merged);
  const publishRes = await publishOutreachReport(merged, finalHtml, options, fetchFn);
  if (publishRes.success && publishRes.url) {
    merged = { ...merged, reportUrl: publishRes.url };
  }

  let htmlPath: string | null = null;
  let opened = false;
  try {
    htmlPath = await writeScratchReportHtml(finalHtml, weekendSlug, options.scratchDir);
    merged = { ...merged, htmlPath };
    if (!options.noOpen) {
      const opener = options.openBrowser || openHtmlInBrowser;
      opened = await opener(htmlPath);
      merged = { ...merged, openedBrowser: opened };
    }
  } catch (err) {
    console.warn(
      `[book-gig] Warning: could not write scratch report artifact: ${(err as Error).message}`,
    );
  }

  return { result: merged, htmlPath, opened };
}
