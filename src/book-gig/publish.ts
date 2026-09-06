// src/book-gig/publish.ts — Publish rendered HTML review artifacts to web-jam-back /outreach/report

import { type BackendConfigOptions, resolveBackendConfig } from "./outreach_api.ts";
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
 * Format the payload to post to POST /outreach/report
 */
export function formatReportPayload(
  result: BookGigResult,
  htmlContent: string,
): PublishReportPayload {
  const weekendSlug = result.weekend
    ? `${result.weekend.start}-to-${result.weekend.end}`
    : `replies-${new Date().toISOString().slice(0, 10)}`;

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
