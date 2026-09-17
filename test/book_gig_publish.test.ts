// test/book_gig_publish.test.ts — Unit tests for publishing outreach HTML reports to web-jam-back

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchOutreachReport,
  formatReportPayload,
  publishAndOpenReport,
  publishOutreachReport,
  WEB_JAM_REPORT_BASE_URL,
  writeScratchReportHtml,
} from "../src/book-gig/publish.ts";
import { runBookGigCli } from "../src/book-gig/cli.ts";
import type { BookGigResult, TargetWeekend } from "../src/book-gig/types.ts";

const sampleWeekend: TargetWeekend = {
  start: "2026-10-16",
  end: "2026-10-18",
  rawText: "Oct 16-18 2026",
  label: "October 16–18, 2026",
  year: 2026,
  month: 10,
  days: [16, 17, 18],
};

const sampleResult: BookGigResult = {
  mode: "preview",
  weekend: sampleWeekend,
  location: { raw: "Lynchburg, VA", city: "Lynchburg", state: "VA" },
  candidates: [
    {
      _id: "v1",
      name: "The Glass House",
      city: "Lynchburg",
      usState: "VA",
      email: "booking@glasshouse.com",
    },
    {
      _id: "v2",
      name: "Three Roads Brewing",
      city: "Lynchburg",
      usState: "VA",
      email: "music@3roads.com",
    },
  ],
  density: { count: 2, isSparse: false },
  pitches: [],
  batchDispatch: { requested: 2, sent: 2, skipped: [], records: [] },
};

Deno.test("formatReportPayload: formats weekend slug, title, candidate/dispatch counts and metadata", () => {
  const html = "<html><body><h1>Review</h1></body></html>";
  const payload = formatReportPayload(sampleResult, html);

  assertEquals(payload.weekend, "2026-10-16-to-2026-10-18");
  assertEquals(payload.title, "Gig Outreach Review: October 16–18, 2026");
  assertEquals(payload.htmlContent, html);
  assertEquals(payload.candidatesCount, 2);
  assertEquals(payload.dispatchedCount, 2);
  assertEquals(payload.metadata?.mode, "preview");
  assertEquals(payload.metadata?.location, "Lynchburg, VA");
  assert(typeof payload.metadata?.timestamp === "string");
});

Deno.test("formatReportPayload: handles fallback when weekend is undefined (replies mode)", () => {
  const repliesResult: BookGigResult = {
    mode: "replies",
    candidates: [],
    density: { count: 0, isSparse: false },
    pitches: [],
  };

  const payload = formatReportPayload(repliesResult, "<p>Replies</p>");
  assertStringIncludes(payload.weekend, "replies-");
  assertEquals(payload.title, "Gig Outreach Run Report");
  assertEquals(payload.candidatesCount, 0);
  assertEquals(payload.dispatchedCount, 0);
});

Deno.test("publishOutreachReport: successful POST returns canonical URL and status 201", async () => {
  const mockFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/outreach/report") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      assertEquals(body.weekend, "2026-10-16-to-2026-10-18");
      assertEquals(body.candidatesCount, 2);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            message: "Report saved successfully",
            report: { weekend: body.weekend, _id: "rep123" },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  };

  const res = await publishOutreachReport(
    sampleResult,
    "<html><body>Report</body></html>",
    { backendUrl: "https://mock-backend.web-jam.com", token: "test-token" },
    mockFetch,
  );

  assertEquals(res.success, true);
  assertEquals(res.url, `${WEB_JAM_REPORT_BASE_URL}/2026-10-16-to-2026-10-18`);
  assertEquals(res.weekend, "2026-10-16-to-2026-10-18");
  assertEquals(res.statusCode, 201);
});

Deno.test("publishOutreachReport: handles HTTP error response gracefully without throwing", async () => {
  const mockFetch: typeof fetch = (_input, _init) => {
    return Promise.resolve(
      new Response(JSON.stringify({ message: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const res = await publishOutreachReport(
    sampleResult,
    "<html><body>Report</body></html>",
    { backendUrl: "https://mock-backend.web-jam.com" },
    mockFetch,
  );

  assertEquals(res.success, false);
  assertEquals(res.statusCode, 500);
  assert(res.error?.includes("500"));
});

Deno.test("publishOutreachReport: handles network throw gracefully without throwing", async () => {
  const mockFetch: typeof fetch = (_input, _init) => {
    return Promise.reject(new Error("Network connection refused"));
  };

  const res = await publishOutreachReport(
    sampleResult,
    "<html><body>Report</body></html>",
    { backendUrl: "https://mock-backend.web-jam.com" },
    mockFetch,
  );

  assertEquals(res.success, false);
  assertEquals(res.error, "Network connection refused");
});

Deno.test("fetchOutreachReport: returns the stored HTML on success", async () => {
  const mockFetch: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    assertStringIncludes(url, "/outreach/report/2026-10-16-to-2026-10-18");
    return Promise.resolve(
      new Response("<html><body>Prior report</body></html>", { status: 200 }),
    );
  };

  const read = await fetchOutreachReport(
    "2026-10-16-to-2026-10-18",
    { backendUrl: "https://mock-backend.web-jam.com" },
    mockFetch,
  );
  assertEquals(read.status, "found");
  assertStringIncludes(read.status === "found" ? read.html : "", "Prior report");
});

Deno.test("fetchOutreachReport: reports none on 404 (no report exists yet)", async () => {
  const mockFetch: typeof fetch = () => Promise.resolve(new Response("Not Found", { status: 404 }));
  const read = await fetchOutreachReport(
    "2026-10-16-to-2026-10-18",
    { backendUrl: "https://mock-backend.web-jam.com" },
    mockFetch,
  );
  assertEquals(read, { status: "none" });
});

Deno.test("fetchOutreachReport: reports failed (not none) on a non-404 HTTP error", async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(new Response("Server Error", { status: 500 }));
  const read = await fetchOutreachReport(
    "2026-10-16-to-2026-10-18",
    { backendUrl: "https://mock-backend.web-jam.com" },
    mockFetch,
  );
  assertEquals(read, { status: "failed", error: "HTTP 500" });
});

Deno.test("fetchOutreachReport: reports failed (never throws) when the fetch itself fails", async () => {
  const mockFetch: typeof fetch = () => Promise.reject(new Error("network down"));
  const read = await fetchOutreachReport(
    "2026-10-16-to-2026-10-18",
    { backendUrl: "https://mock-backend.web-jam.com" },
    mockFetch,
  );
  assertEquals(read, { status: "failed", error: "network down" });
});

Deno.test("publishAndOpenReport: never posts over the stored report when reading it fails", async () => {
  const failedReads: Array<[string, () => Promise<Response>]> = [
    ["HTTP 500", () => Promise.resolve(new Response("Server Error", { status: 500 }))],
    ["network error", () => Promise.reject(new Error("network down"))],
    [
      "no run data",
      () => Promise.resolve(new Response("<html><body>Maintenance</body></html>", { status: 200 })),
    ],
  ];
  for (const [label, readPriorReport] of failedReads) {
    const scratchDir = await Deno.makeTempDir({ prefix: "book_gig_scratch_fail_" });
    try {
      let posted = false;
      const mockFetch: typeof fetch = (input, init) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/outreach/report/") && (!init || init.method === "GET")) {
          return readPriorReport();
        }
        if (url.endsWith("/outreach/report") && init?.method === "POST") {
          posted = true;
          return Promise.resolve(
            new Response(JSON.stringify({ message: "Saved" }), { status: 201 }),
          );
        }
        return Promise.reject(new Error(`Unexpected fetch: ${url}`));
      };

      const { result, htmlPath } = await publishAndOpenReport(
        sampleResult,
        { backendUrl: "https://mock-backend.web-jam.com", scratchDir, noOpen: true },
        mockFetch,
      );

      assertEquals(posted, false, `${label}: must not POST over a stored report it could not read`);
      assertEquals(result.reportUrl, undefined, label);
      assert(htmlPath !== null, label);
      assertStringIncludes(await Deno.readTextFile(htmlPath!), "The Glass House");
    } finally {
      await Deno.remove(scratchDir, { recursive: true });
    }
  }
});

Deno.test("writeScratchReportHtml: reuses one fixed scratch directory so runs overwrite instead of piling up", async () => {
  const tmpRoot = await Deno.makeTempDir({ prefix: "book_gig_tmpdir_" });
  const originalTmpdir = Deno.env.get("TMPDIR");
  Deno.env.set("TMPDIR", tmpRoot);
  try {
    const first = await writeScratchReportHtml("<html>first</html>", "2026-10-16-to-2026-10-18");
    const second = await writeScratchReportHtml("<html>second</html>", "2026-10-16-to-2026-10-18");
    assertEquals(first, `${tmpRoot}/book-gig-review/book-gig-run-2026-10-16-to-2026-10-18.html`);
    assertEquals(second, first);
    assertEquals(await Deno.readTextFile(second), "<html>second</html>");
  } finally {
    if (originalTmpdir === undefined) Deno.env.delete("TMPDIR");
    else Deno.env.set("TMPDIR", originalTmpdir);
    await Deno.remove(tmpRoot, { recursive: true });
  }
});

Deno.test("publishAndOpenReport: writes a disposable scratch HTML file (never Dropbox) and includes the Web Report URL", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "book_gig_scratch_" });
  try {
    const mockFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/outreach/report/") && (!init || init.method === "GET")) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      if (url.endsWith("/outreach/report") && init?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ message: "Created" }), { status: 201 }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    };

    const { result, htmlPath } = await publishAndOpenReport(
      sampleResult,
      {
        backendUrl: "https://mock-backend.web-jam.com",
        scratchDir,
        noOpen: true,
      },
      mockFetch,
    );

    assertEquals(result.reportUrl, `${WEB_JAM_REPORT_BASE_URL}/2026-10-16-to-2026-10-18`);
    assert(htmlPath !== null);
    assertStringIncludes(htmlPath!, scratchDir);
    assert(!htmlPath!.includes("Dropbox"));

    const scratchContent = await Deno.readTextFile(htmlPath!);
    assertStringIncludes(scratchContent, "The Glass House");
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

Deno.test("publishAndOpenReport: a second dispatch batch for the same weekend accumulates into the stored report (#955)", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "book_gig_scratch2_" });
  try {
    let storedHtml: string | null = null;

    const mockFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/outreach/report/") && (!init || init.method === "GET")) {
        return Promise.resolve(
          storedHtml === null
            ? new Response("Not Found", { status: 404 })
            : new Response(storedHtml, { status: 200 }),
        );
      }
      if (url.endsWith("/outreach/report") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        storedHtml = body.htmlContent;
        return Promise.resolve(
          new Response(JSON.stringify({ message: "Saved" }), { status: 201 }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    };

    const batch1: BookGigResult = {
      mode: "send",
      weekend: sampleWeekend,
      candidates: [sampleResult.candidates[0]],
      density: { count: 1, isSparse: true },
      pitches: [],
      batchDispatch: { requested: 1, sent: 1, skipped: [], records: [{ venueId: "v1" }] },
    };
    const batch2: BookGigResult = {
      mode: "send",
      weekend: sampleWeekend,
      candidates: [sampleResult.candidates[1]],
      density: { count: 1, isSparse: true },
      pitches: [],
      batchDispatch: { requested: 1, sent: 1, skipped: [], records: [{ venueId: "v2" }] },
    };

    await publishAndOpenReport(
      batch1,
      { backendUrl: "https://mock-backend.web-jam.com", scratchDir, noOpen: true },
      mockFetch,
    );
    const { result: mergedResult } = await publishAndOpenReport(
      batch2,
      { backendUrl: "https://mock-backend.web-jam.com", scratchDir, noOpen: true },
      mockFetch,
    );

    assertEquals(mergedResult.candidates.length, 2);
    assertEquals(mergedResult.batchDispatch?.requested, 2);
    assertEquals(mergedResult.batchDispatch?.sent, 2);
    assert(storedHtml !== null);
    assertStringIncludes(storedHtml!, "The Glass House");
    assertStringIncludes(storedHtml!, "Three Roads Brewing");

    // Reading the merged result back from the stored report proves accumulation lives
    // in the database, not in a local file.
    const readBack = await fetchOutreachReport(
      "2026-10-16-to-2026-10-18",
      { backendUrl: "https://mock-backend.web-jam.com" },
      mockFetch,
    );
    const readBackHtml = readBack.status === "found" ? readBack.html : "";
    assertStringIncludes(readBackHtml, "The Glass House");
    assertStringIncludes(readBackHtml, "Three Roads Brewing");

    // Publishing an already-stored batch again must not inflate the tally: the stored report
    // keeps the batch history mergeWeekendRuns checks for duplicates (#876).
    const { result: republished } = await publishAndOpenReport(
      batch2,
      { backendUrl: "https://mock-backend.web-jam.com", scratchDir, noOpen: true },
      mockFetch,
    );
    assertEquals(republished.batchDispatch?.requested, 2);
    assertEquals(republished.batchDispatch?.sent, 2);
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

Deno.test("runBookGigCli: publishes HTML report and populates result.reportUrl", async () => {
  let reportPublished = false;

  const mockFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              _id: "v1",
              name: "The Glass House",
              city: "Lynchburg",
              usState: "VA",
              email: "booking@glasshouse.com",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url.includes("/template")) {
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.includes("/outreach/report/") && init?.method === "GET") {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }
    if (url.includes("/outreach/report") && init?.method === "POST") {
      reportPublished = true;
      return Promise.resolve(
        new Response(JSON.stringify({ message: "Created" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  };

  const res = await runBookGigCli(
    ["Oct 16-18 2026", "Lynchburg, VA", "--no-open"],
    mockFetch,
  );

  assertEquals(reportPublished, true);
  assertEquals(
    res.reportUrl,
    `${WEB_JAM_REPORT_BASE_URL}/2026-10-16-to-2026-10-18`,
  );
});

Deno.test("runBookGigCli: falls back cleanly without crashing when publish fails", async () => {
  const mockFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              _id: "v1",
              name: "The Glass House",
              city: "Lynchburg",
              usState: "VA",
              email: "booking@glasshouse.com",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url.includes("/template")) {
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.includes("/outreach/report") && init?.method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ message: "Upload failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  };

  const res = await runBookGigCli(
    ["Oct 16-18 2026", "Lynchburg, VA", "--no-open"],
    mockFetch,
  );

  assertEquals(res.reportUrl, undefined);
  assert(res.htmlPath !== undefined);
});
