// src/venue-mining/seed_sweep_history.ts
// Seed historical completed metro sweeps into the backend sweep history database (web-jam-tools#1045).
import { parseArgs } from "@std/cli/parse-args";
import { buildHeaders, resolveBackendConfig } from "../book-gig/outreach_api.ts";

export interface SeedSweepRecord {
  metroSlug: string;
  sweptAt: string;
  publication: {
    name: string;
    url: string;
    api?: string;
    type?: string;
  };
  venuesCreatedCount: number;
  coverageArea?: string[];
  excludeKeywords?: string[];
  notes?: string;
}

export const SEED_SWEEP_RECORDS: SeedSweepRecord[] = [
  {
    metroSlug: "roanoke-salem",
    sweptAt: "2026-07-02",
    publication: {
      name: "The Roanoke Rambler (Happenings archive)",
      url: "https://www.roanokerambler.com",
    },
    venuesCreatedCount: 14,
    notes:
      "Run 1 (12-mo sweep) = +14 venues, 7 pitched. Covers Vinton, Rocky Mount, Floyd spillover. Use www. URLs — bare domain redirects flakily.",
  },
  {
    metroSlug: "rock-hill-sc",
    sweptAt: "2026-07-02",
    publication: {
      name: "Rock Hill Connection (events calendar)",
      url: "https://rockhillconnection.com/events/",
    },
    venuesCreatedCount: 6,
    notes:
      "Run 2 = +6 venues (3 eligible). Metro is heavily FB-only; venue-site corroboration required. Covers Fort Mill, Tega Cay, York, Clover. Shallow archive — supplement w/ visityorkcounty.com + venue sites; heraldonline.com 403s.",
  },
  {
    metroSlug: "gastonia",
    sweptAt: "2026-07-03",
    publication: {
      name: "Go Gaston NC (tourism directory + events)",
      url: "https://gogastonnc.org",
    },
    venuesCreatedCount: 3,
    notes:
      'Run 3 = +3 venues, all pitched. Covers Belmont, Mt Holly, Cramerton, Lowell NC, Cherryville. Watch geo-traps (a "Lowell" hit was Lowell MA). Directory strong, archive shallow; runner-up source charlotteonthecheap.com.',
  },
  {
    metroSlug: "lynchburg",
    sweptAt: "2026-07-18",
    publication: {
      name: "Downtown Lynchburg Association",
      url: "https://www.downtownlynchburg.com/calendar",
    },
    venuesCreatedCount: 6,
    notes:
      "Run 4 = +6 venues created (1 email-eligible). Small-venue scene is FB-only; 2 rejected as too-large. Incident: first POST for Starr Hill On Main (shared email info@starrhill.com) overwrote Starr Hill Pilot Brewery (Roanoke) record; restored via PATCH.",
  },
  {
    metroSlug: "charlottesville",
    sweptAt: "2026-09-16",
    publication: {
      name: "C-VILLE Weekly (SceneThink calendar)",
      url: "http://events.c-ville.com",
      api: "http://events.c-ville.com/cville/search.json?category=13",
      type: "scenethink",
    },
    venuesCreatedCount: 12,
    coverageArea: [
      "charlottesville",
      "crozet",
      "keswick",
      "scottsville",
      "earlysville",
      "north garden",
      "ivy",
      "free union",
      "barboursville",
      "palmyra",
      "albemarle",
    ],
    excludeKeywords: [
      "scrappy elephant",
      "monticello",
      "downtown mall",
      "hall 107",
      "hall 229a",
      "campbell hall",
      "nau hall",
      "bryan hall",
      "jaba",
      "wtju",
    ],
    notes:
      "Run 5 = swept 12 pages (~1,200 events) via C-VILLE Weekly SceneThink JSON API. +12 candidate venues created in live DB with verified addresses and emails; 4 phone/web-form leads; 3 rejected as too-large.",
  },
];

export interface SeedSweepHistoryOptions {
  confirm?: boolean;
  backendUrl?: string;
  token?: string;
  fetchFn?: typeof fetch;
}

export interface SeedSweepItemResult {
  metroSlug: string;
  sweptAt: string;
  status: "dry_run" | "created" | "already_present" | "failed";
  statusCode?: number;
  message?: string;
}

export interface SeedSweepHistoryResult {
  dryRun: boolean;
  total: number;
  created: number;
  alreadyPresent: number;
  failed: number;
  records: SeedSweepItemResult[];
}

export async function seedSweepHistory(
  options: SeedSweepHistoryOptions = {},
): Promise<SeedSweepHistoryResult> {
  const isDryRun = !options.confirm;

  if (isDryRun) {
    const results: SeedSweepItemResult[] = SEED_SWEEP_RECORDS.map((rec) => ({
      metroSlug: rec.metroSlug,
      sweptAt: rec.sweptAt,
      status: "dry_run",
      message: `Would seed ${rec.metroSlug} (${rec.sweptAt})`,
    }));
    return {
      dryRun: true,
      total: SEED_SWEEP_RECORDS.length,
      created: 0,
      alreadyPresent: 0,
      failed: 0,
      records: results,
    };
  }

  const config = await resolveBackendConfig({
    backendUrl: options.backendUrl,
    token: options.token,
  });
  const fetchFn = options.fetchFn || fetch;
  const headers = buildHeaders(config.token);

  let createdCount = 0;
  let alreadyPresentCount = 0;
  let failedCount = 0;
  const records: SeedSweepItemResult[] = [];

  for (const record of SEED_SWEEP_RECORDS) {
    const targetUrl = `${config.baseUrl}/venue-mining/sweep`;
    try {
      const res = await fetchFn(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(record),
      });

      if (res.status === 201) {
        createdCount++;
        records.push({
          metroSlug: record.metroSlug,
          sweptAt: record.sweptAt,
          status: "created",
          statusCode: 201,
          message: "Created sweep record",
        });
      } else if (res.status === 409) {
        alreadyPresentCount++;
        records.push({
          metroSlug: record.metroSlug,
          sweptAt: record.sweptAt,
          status: "already_present",
          statusCode: 409,
          message: "Sweep record already present",
        });
      } else {
        failedCount++;
        const text = await res.text();
        records.push({
          metroSlug: record.metroSlug,
          sweptAt: record.sweptAt,
          status: "failed",
          statusCode: res.status,
          message: `Failed to create sweep record (${res.status}): ${text}`,
        });
      }
    } catch (err) {
      failedCount++;
      records.push({
        metroSlug: record.metroSlug,
        sweptAt: record.sweptAt,
        status: "failed",
        message: `Network error posting sweep record: ${(err as Error).message}`,
      });
    }
  }

  return {
    dryRun: false,
    total: SEED_SWEEP_RECORDS.length,
    created: createdCount,
    alreadyPresent: alreadyPresentCount,
    failed: failedCount,
    records,
  };
}

function printUsage() {
  console.log(`
venue-mining seed-sweep-history: Seed historical completed metro sweeps into the database.

Usage:
  deno task venue-mining:seed-sweep-history [options]

Options:
  --confirm              Actually post records to backend (default is dry-run)
  --backend-url <url>    Backend base URL (default: WEB_JAM_BACK_URL or production)
  --token <token>        Auth Bearer token (default: WEB_JAM_LLM_TOKEN or local file)
  -h, --help             Show this help message
`);
}

if (import.meta.main) {
  const flags = parseArgs(Deno.args, {
    boolean: ["confirm", "help"],
    string: ["backend-url", "token"],
    alias: { h: "help" },
  });

  if (flags.help) {
    printUsage();
    Deno.exit(0);
  }

  try {
    const result = await seedSweepHistory({
      confirm: flags.confirm,
      backendUrl: flags["backend-url"],
      token: flags.token,
    });

    if (result.dryRun) {
      console.log(
        `\n[DRY RUN] ${result.total} historical sweep records would be posted to POST /venue-mining/sweep:`,
      );
      for (const r of result.records) {
        console.log(`  - ${r.metroSlug.padEnd(20)} | sweptAt: ${r.sweptAt}`);
      }
      console.log("\nPass --confirm to actually post these records to the database.\n");
      Deno.exit(0);
    } else {
      console.log(`\nSeed completed:`);
      console.log(`  - Created:         ${result.created}`);
      console.log(`  - Already present: ${result.alreadyPresent}`);
      console.log(`  - Failed:          ${result.failed}`);
      for (const r of result.records) {
        console.log(
          `  - ${r.metroSlug.padEnd(20)} | ${r.sweptAt} | ${r.status} (${r.message || ""})`,
        );
      }
      console.log("");
      if (result.failed > 0) {
        console.error(
          `Error: failed to seed ${result.failed} of ${result.total} sweep records (see above).\n`,
        );
        Deno.exit(1);
      }
      Deno.exit(0);
    }
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}\n`);
    Deno.exit(1);
  }
}
