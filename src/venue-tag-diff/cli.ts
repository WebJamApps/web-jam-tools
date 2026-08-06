// CLI for venue-tag-diff (web-jam-tools venue-tag-diff feature). Ported from
// a working prototype that ran successfully against production. Thin I/O
// wrapper around the pure classifier in ./diff.ts: fetches the live venue
// list, reads a tag proposal file, diffs them, and prints a report.
//
// Run: deno task venue-tag:diff <proposal.json>
//
// Auth follows the same pattern as src/outreach-cron/advance_cadence.ts: the
// AI-agent bearer token is read from the WEB_JAM_LLM_TOKEN environment
// variable, never from a file and never printed. The backend base URL
// defaults to production and can be overridden via WEB_JAM_BACK_URL.
//
// Never reads or prints venue contact fields (email, phone, contact name) —
// the diff only ever touches `_id`, `name`, and the six TAG_FIELDS from
// ./diff.ts. Venue names are printed; they're public business names, not
// contact data.
import {
  classifyVenueTags,
  type LiveVenue,
  type ProposalVenue,
  type VenueTagDiffResult,
} from "./diff.ts";

export const DEFAULT_BACKEND = "https://webjamsalem.herokuapp.com";

export interface BackendConfig {
  baseUrl: string;
  token: string;
}

/** Resolve backend URL + bearer token from the environment. Never reads a token file. */
export function backendConfig(): BackendConfig {
  // Trailing slash trimmed so `${baseUrl}/venue` never doubles up.
  const baseUrl = (Deno.env.get("WEB_JAM_BACK_URL") || DEFAULT_BACKEND).replace(/\/+$/, "");
  const token = Deno.env.get("WEB_JAM_LLM_TOKEN");
  if (!token) {
    throw new Error("Missing WEB_JAM_LLM_TOKEN — export it before running this tool.");
  }
  return { baseUrl, token };
}

/**
 * GET /venue with the bearer token and normalize the response shape: a bare
 * array, or an object carrying `venues` or `data`.
 */
export async function fetchLiveVenues(config: BackendConfig): Promise<LiveVenue[]> {
  const resp = await fetch(`${config.baseUrl}/venue`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (!resp.ok) {
    throw new Error(`GET /venue failed: ${resp.status} ${await resp.text()}`);
  }
  const body = await resp.json();
  if (Array.isArray(body)) return body as LiveVenue[];
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    return (obj.venues ?? obj.data ?? []) as LiveVenue[];
  }
  return [];
}

/** Read and parse a tag proposal file: an array of venue objects. */
export async function loadProposal(path: string): Promise<ProposalVenue[]> {
  const text = await Deno.readTextFile(path);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON array of venue proposal objects`);
  }
  return parsed as ProposalVenue[];
}

const MAX_LISTED = 15;

/** Render the classification result as the human-readable report (pure, testable). */
export function formatReport(
  result: VenueTagDiffResult,
  counts: { liveCount: number; proposalCount: number },
): string {
  const lines: string[] = [];
  lines.push(`live venues: ${counts.liveCount}`);
  lines.push(`proposal records: ${counts.proposalCount}`);
  lines.push("");
  lines.push(`proposal rows whose tags MATCH live DB : ${result.matchedCount}`);
  lines.push(`proposal rows that DIVERGE from live   : ${result.diverged.length}`);
  lines.push(`proposal rows whose venue is GONE      : ${result.missing.length}`);

  if (result.diverged.length > 0) {
    lines.push("");
    lines.push("-- diverging (name: field proposed -> live) --");
    for (const row of result.diverged.slice(0, MAX_LISTED)) {
      const parts = row.diffs.map(
        (d) => `${d.field} ${JSON.stringify(d.proposed)}->${JSON.stringify(d.live)}`,
      );
      lines.push(`  ${row.name}: ${parts.join(", ")}`);
    }
    if (result.diverged.length > MAX_LISTED) {
      lines.push(`  ... and ${result.diverged.length - MAX_LISTED} more`);
    }
  }

  if (result.missing.length > 0) {
    lines.push("");
    lines.push("-- no longer in DB --");
    const names = result.missing.slice(0, MAX_LISTED).map((m) => m.name);
    lines.push(`  ${names.join(", ")}${result.missing.length > MAX_LISTED ? " ..." : ""}`);
  }

  return lines.join("\n");
}

export async function main(args: string[] = Deno.args): Promise<number> {
  const proposalPath = args[0];
  if (!proposalPath) {
    console.error("Usage: deno task venue-tag:diff <proposal.json>");
    return 1;
  }

  let config: BackendConfig;
  try {
    config = backendConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let live: LiveVenue[];
  try {
    live = await fetchLiveVenues(config);
  } catch (err) {
    console.error(`API error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let proposal: ProposalVenue[];
  try {
    proposal = await loadProposal(proposalPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const result = classifyVenueTags(proposal, live);
  console.log(formatReport(result, { liveCount: live.length, proposalCount: proposal.length }));
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
