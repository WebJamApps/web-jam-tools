// test/book-gig-send-confirmation.test.ts — Unit tests for /book-gig --send draft confirmation gate

import { assertEquals, assertRejects } from "@std/assert";
import { runBookGigCli } from "../src/book-gig/cli.ts";
import { parseBookGigArgs } from "../src/book-gig/parser.ts";

Deno.test("parseBookGigArgs: parses --confirm-drafts and --confirm flags", () => {
  const parsed1 = parseBookGigArgs([
    "--send",
    "Oct 16-18 2026",
    "Salem, VA",
    "--confirm-drafts",
  ]);
  assertEquals(parsed1.mode, "send");
  assertEquals(parsed1.confirmDrafts, true);

  const parsed2 = parseBookGigArgs([
    "--send",
    "Oct 16-18 2026",
    "Salem, VA",
    "--confirm",
  ]);
  assertEquals(parsed2.mode, "send");
  assertEquals(parsed2.confirmDrafts, true);

  const parsed3 = parseBookGigArgs([
    "--send",
    "Oct 16-18 2026",
    "--confirm-drafts=true",
  ]);
  assertEquals(parsed3.confirmDrafts, true);

  const parsed4 = parseBookGigArgs([
    "--send",
    "Oct 16-18 2026",
    "--confirm-drafts=false",
  ]);
  assertEquals(parsed4.confirmDrafts, undefined);

  const parsedDefault = parseBookGigArgs([
    "--send",
    "Oct 16-18 2026",
    "Salem, VA",
  ]);
  assertEquals(parsedDefault.confirmDrafts, undefined);
});

Deno.test("runBookGigCli: fails closed when --send is invoked without --confirm-drafts", async () => {
  let batchEndpointCalled = false;

  const mockFetch: typeof fetch = (input: string | URL | Request) => {
    const urlStr = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    if (urlStr.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              _id: "venue-1",
              name: "Olde Salem Brewing",
              city: "Salem",
              usState: "VA",
              email: "booking@oldesalembrewing.com",
              outreachEligible: true,
              isExcluded: false,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (urlStr.includes("/outreach/templates")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (urlStr.includes("/outreach/batch")) {
      batchEndpointCalled = true;
      return Promise.resolve(
        new Response(
          JSON.stringify({ requested: 1, sent: 1, skipped: [], records: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const mockOpener = () => Promise.resolve(true);

  // Invoking --send without --confirm-drafts must throw and fail closed
  await assertRejects(
    async () => {
      await runBookGigCli(
        ["--send", "Oct 16-18 2026", "Salem, VA"],
        mockFetch,
        mockOpener,
      );
    },
    Error,
    "Batch outreach dispatch requires explicit draft confirmation via --confirm-drafts.",
  );

  assertEquals(
    batchEndpointCalled,
    false,
    "POST /outreach/batch must NOT be called when confirmation is missing",
  );
});

Deno.test("runBookGigCli: dispatches successfully when --send is invoked with --confirm-drafts", async () => {
  let batchEndpointCalled = false;
  let dispatchedVenueIds: string[] = [];

  const mockFetch: typeof fetch = (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    if (urlStr.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              _id: "venue-1",
              name: "Olde Salem Brewing",
              city: "Salem",
              usState: "VA",
              email: "booking@oldesalembrewing.com",
              outreachEligible: true,
              isExcluded: false,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (urlStr.includes("/outreach/templates")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (urlStr.includes("/outreach/batch")) {
      batchEndpointCalled = true;
      if (init?.body) {
        const payload = JSON.parse(init.body as string);
        dispatchedVenueIds = payload.venueIds || [];
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ requested: 1, sent: 1, skipped: [], records: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const mockOpener = () => Promise.resolve(true);

  // Invoking --send WITH --confirm-drafts succeeds and dispatches
  const result = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm-drafts"],
    mockFetch,
    mockOpener,
  );

  assertEquals(result.mode, "send");
  assertEquals(result.confirmDrafts, true);
  assertEquals(
    batchEndpointCalled,
    true,
    "POST /outreach/batch should be called when --confirm-drafts is provided",
  );
  assertEquals(dispatchedVenueIds, ["venue-1"]);
  assertEquals(result.batchDispatch?.sent, 1);
});

Deno.test("runBookGigCli: dispatches successfully with --confirm alias", async () => {
  let batchEndpointCalled = false;

  const mockFetch: typeof fetch = (input: string | URL | Request) => {
    const urlStr = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    if (urlStr.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              _id: "venue-1",
              name: "Olde Salem Brewing",
              city: "Salem",
              usState: "VA",
              email: "booking@oldesalembrewing.com",
              outreachEligible: true,
              isExcluded: false,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (urlStr.includes("/outreach/templates")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (urlStr.includes("/outreach/batch")) {
      batchEndpointCalled = true;
      return Promise.resolve(
        new Response(
          JSON.stringify({ requested: 1, sent: 1, skipped: [], records: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const mockOpener = () => Promise.resolve(true);

  const result = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm"],
    mockFetch,
    mockOpener,
  );

  assertEquals(result.mode, "send");
  assertEquals(result.confirmDrafts, true);
  assertEquals(batchEndpointCalled, true);
});
