// src/venue-mining/record_sweep.ts
// Record a completed venue-mining metro sweep into the backend sweep history database (web-jam-tools#1045).
import { parseArgs } from "@std/cli/parse-args";
import { buildHeaders, resolveBackendConfig } from "../book-gig/outreach_api.ts";
import { fetchSweepHistory, type MetroPublication, type SweepHistoryRecord } from "./sweep.ts";

export interface RecordSweepOptions {
  metro: string;
  sweptAt: string;
  pubName: string;
  pubUrl: string;
  pubApi?: string;
  pubType?: string;
  venuesCreated: number;
  coverageArea?: string[];
  excludeKeywords?: string[];
  notes?: string;
  backendUrl?: string;
  token?: string;
  fetchFn?: typeof fetch;
}

export interface RecordSweepResult {
  status: "recorded" | "already_recorded" | "failed";
  statusCode?: number;
  data?: unknown;
  error?: string;
  retryCommand: string;
  /** Settings not passed on the command line that were copied from the newest record. */
  inherited?: string[];
}

/**
 * Fill settings the caller didn't pass from the metro's newest sweep record.
 * Publication api/type carry forward only when the publication url is unchanged,
 * so switching publications never inherits the old one's endpoint. Returns the
 * names of the settings copied.
 */
export function carryForwardSettings(
  payload: Record<string, unknown>,
  publication: MetroPublication,
  newest: SweepHistoryRecord | undefined,
): string[] {
  const inherited: string[] = [];
  if (!newest) return inherited;
  if (newest.publication?.url === publication.url) {
    if (!publication.api && newest.publication.api) {
      publication.api = newest.publication.api;
      inherited.push("publication.api");
    }
    if (!publication.type && newest.publication.type) {
      publication.type = newest.publication.type;
      inherited.push("publication.type");
    }
  }
  if (payload.coverageArea === undefined && newest.coverageArea?.length) {
    payload.coverageArea = newest.coverageArea;
    inherited.push("coverageArea");
  }
  if (payload.excludeKeywords === undefined && newest.excludeKeywords?.length) {
    payload.excludeKeywords = newest.excludeKeywords;
    inherited.push("excludeKeywords");
  }
  return inherited;
}

export function buildRetryCommand(options: RecordSweepOptions): string {
  const parts = [
    "deno task venue-mining:record-sweep",
    `--metro ${options.metro}`,
    `--swept-at ${options.sweptAt}`,
    `--pub-name ${JSON.stringify(options.pubName)}`,
    `--pub-url ${JSON.stringify(options.pubUrl)}`,
  ];
  if (options.pubApi) parts.push(`--pub-api ${JSON.stringify(options.pubApi)}`);
  if (options.pubType) parts.push(`--pub-type ${options.pubType}`);
  parts.push(`--venues-created ${options.venuesCreated}`);
  if (options.coverageArea && options.coverageArea.length > 0) {
    parts.push(`--coverage-area ${JSON.stringify(options.coverageArea.join(","))}`);
  }
  if (options.excludeKeywords && options.excludeKeywords.length > 0) {
    parts.push(`--exclude-keywords ${JSON.stringify(options.excludeKeywords.join(","))}`);
  }
  if (options.notes) parts.push(`--notes ${JSON.stringify(options.notes)}`);
  return parts.join(" \\\n  ");
}

export async function recordSweep(options: RecordSweepOptions): Promise<RecordSweepResult> {
  const retryCommand = buildRetryCommand(options);

  if (!options.metro || !options.metro.trim()) {
    return {
      status: "failed",
      error: "Missing required option: --metro",
      retryCommand,
    };
  }
  if (
    !options.sweptAt || !/^\d{4}-\d{2}-\d{2}$/.test(options.sweptAt.trim()) ||
    Number.isNaN(new Date(options.sweptAt.trim()).getTime())
  ) {
    return {
      status: "failed",
      error: "Invalid or missing required option: --swept-at (must be a valid date YYYY-MM-DD)",
      retryCommand,
    };
  }
  if (!options.pubName || !options.pubName.trim()) {
    return {
      status: "failed",
      error: "Missing required option: --pub-name",
      retryCommand,
    };
  }
  if (!options.pubUrl || !options.pubUrl.trim()) {
    return {
      status: "failed",
      error: "Missing required option: --pub-url",
      retryCommand,
    };
  }
  if (
    options.venuesCreated === undefined ||
    !Number.isInteger(options.venuesCreated) ||
    options.venuesCreated < 0
  ) {
    return {
      status: "failed",
      error: "Invalid or missing required option: --venues-created (must be an integer >= 0)",
      retryCommand,
    };
  }

  const publication: {
    name: string;
    url: string;
    api?: string;
    type?: string;
  } = {
    name: options.pubName.trim(),
    url: options.pubUrl.trim(),
  };
  if (options.pubApi && options.pubApi.trim()) publication.api = options.pubApi.trim();
  if (options.pubType && options.pubType.trim()) publication.type = options.pubType.trim();

  const payload: Record<string, unknown> = {
    metroSlug: options.metro.trim(),
    sweptAt: options.sweptAt.trim(),
    publication,
    venuesCreatedCount: options.venuesCreated,
  };

  if (options.coverageArea && options.coverageArea.length > 0) {
    payload.coverageArea = options.coverageArea;
  }
  if (options.excludeKeywords && options.excludeKeywords.length > 0) {
    payload.excludeKeywords = options.excludeKeywords;
  }
  if (options.notes && options.notes.trim()) {
    payload.notes = options.notes.trim();
  }

  const config = await resolveBackendConfig({
    backendUrl: options.backendUrl,
    token: options.token,
  });
  const fetchFn = options.fetchFn || fetch;
  const headers = buildHeaders(config.token);

  // The next sweep reads its settings from this record only, so any setting not
  // passed is carried forward from the metro's newest record. Fail closed if that
  // history can't be read — never save a record that silently drops settings.
  let history;
  try {
    history = await fetchSweepHistory({
      metroSlug: options.metro.trim(),
      backendUrl: config.baseUrl,
      token: config.token,
      fetchFn,
    });
  } catch (err) {
    return {
      status: "failed",
      error: `Could not read sweep history to carry settings forward: ${(err as Error).message}`,
      retryCommand,
    };
  }
  const inherited = carryForwardSettings(payload, publication, history[0]);

  const targetUrl = `${config.baseUrl}/venue-mining/sweep`;
  try {
    const res = await fetchFn(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (res.status === 201) {
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return {
        status: "recorded",
        statusCode: 201,
        data,
        retryCommand,
        inherited,
      };
    }

    if (res.status === 409) {
      return {
        status: "already_recorded",
        statusCode: 409,
        error: "Sweep for this metro and date already exists",
        retryCommand,
      };
    }

    const text = await res.text();
    return {
      status: "failed",
      statusCode: res.status,
      error: `HTTP ${res.status}: ${text}`,
      retryCommand,
    };
  } catch (err) {
    return {
      status: "failed",
      error: `Network error: ${(err as Error).message}`,
      retryCommand,
    };
  }
}

function printUsage() {
  console.log(`
venue-mining record-sweep: Record a completed metro sweep into the backend sweep history.

Usage:
  deno task venue-mining:record-sweep [options]

Required Options:
  --metro <slug>              Metro slug (e.g. charlottesville)
  --swept-at <YYYY-MM-DD>     Date the sweep occurred
  --pub-name <name>           Publication name (e.g. "C-VILLE Weekly")
  --pub-url <url>             Publication website or calendar URL
  --venues-created <N>        Number of net-new venues created in database (integer >= 0)

Optional:
  --pub-api <api-url>         Publication JSON or calendar API endpoint URL
  --pub-type <type>           Publication type (e.g. scenethink)
  --coverage-area <towns>     Comma-separated list of towns/cities in coverage area
  --exclude-keywords <words>  Comma-separated list of non-music keywords to exclude
  --notes <text>              Run notes / summary
  --backend-url <url>         Backend base URL (default: WEB_JAM_BACK_URL or production)
  --token <token>             Auth Bearer token (default: WEB_JAM_LLM_TOKEN or local file)
  -h, --help                  Show this help message
`);
}

function parseList(val: unknown): string[] | undefined {
  if (typeof val !== "string" || !val.trim()) return undefined;
  return val.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

if (import.meta.main) {
  const flags = parseArgs(Deno.args, {
    boolean: ["help"],
    string: [
      "metro",
      "swept-at",
      "pub-name",
      "pub-url",
      "pub-api",
      "pub-type",
      "venues-created",
      "coverage-area",
      "exclude-keywords",
      "notes",
      "backend-url",
      "token",
    ],
    alias: {
      h: "help",
      m: "metro",
    },
  });

  if (flags.help) {
    printUsage();
    Deno.exit(0);
  }

  const rawVenues = flags["venues-created"];
  const venuesCreated = rawVenues !== undefined ? Number(rawVenues) : NaN;

  const options: RecordSweepOptions = {
    metro: flags.metro || "",
    sweptAt: flags["swept-at"] || "",
    pubName: flags["pub-name"] || "",
    pubUrl: flags["pub-url"] || "",
    pubApi: flags["pub-api"],
    pubType: flags["pub-type"],
    venuesCreated,
    coverageArea: parseList(flags["coverage-area"]),
    excludeKeywords: parseList(flags["exclude-keywords"]),
    notes: flags.notes,
    backendUrl: flags["backend-url"],
    token: flags.token,
  };

  const result = await recordSweep(options);

  if (result.status === "recorded") {
    console.log(
      `\nSweep recorded: successfully saved sweep for metro '${options.metro}' (${options.sweptAt}) with ${options.venuesCreated} venues created.`,
    );
    if (result.inherited?.length) {
      console.log(`Carried forward from the previous sweep: ${result.inherited.join(", ")}`);
    }
    Deno.exit(0);
  }

  if (result.status === "already_recorded") {
    console.error(
      `\nalready recorded, not saved twice: sweep for metro '${options.metro}' on date '${options.sweptAt}' already exists in database.`,
    );
    Deno.exit(1);
  }

  console.error(`\nNOT recorded: ${result.error || "Failed to save sweep record."}`);
  console.error(`\nRetry command:\n  ${result.retryCommand}\n`);
  Deno.exit(1);
}
