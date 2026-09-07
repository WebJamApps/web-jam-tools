// test/book_gig_gate1.test.ts — Unit tests for /book-gig Gate 1 venue-set approval
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { runBookGigCli } from "../src/book-gig/cli.ts";
import { parseBookGigArgs } from "../src/book-gig/parser.ts";
import { fetchGate1Approval, recordGate1Approval } from "../src/book-gig/outreach_api.ts";
import type { TargetWeekend } from "../src/book-gig/types.ts";

/**
 * Runs a test action with HOME pointed to an isolated temporary directory
 * to prevent test runs from writing into live Dropbox outreach run logs.
 */
async function withIsolatedHome<T>(
  fn: (tempHome: string) => Promise<T>,
): Promise<T> {
  const originalHome = Deno.env.get("HOME");
  const tempHome = await Deno.makeTempDir();
  try {
    Deno.env.set("HOME", tempHome);
    return await fn(tempHome);
  } finally {
    if (originalHome !== undefined) {
      Deno.env.set("HOME", originalHome);
    } else {
      Deno.env.delete("HOME");
    }
    await Deno.remove(tempHome, { recursive: true }).catch(() => {});
  }
}

Deno.test("recordGate1Approval: throws if venueIds is empty or not an array", async () => {
  await assertRejects(
    async () => {
      await recordGate1Approval({
        weekend: "2026-10-16-to-2026-10-18",
        venueIds: [],
      });
    },
    Error,
    "venueIds must be a non-empty array of venue IDs",
  );
});

Deno.test("recordGate1Approval: throws on unparseable weekend string", async () => {
  await assertRejects(
    async () => {
      await recordGate1Approval({
        weekend: "invalid-weekend-xyz",
        venueIds: ["64a111111111111111111111"],
      });
    },
    Error,
    'Unable to parse target weekend from: "invalid-weekend-xyz"',
  );
});

Deno.test("recordGate1Approval: posts payload to /outreach/approval/venue-set and returns record", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: Record<string, unknown> = {};

  const mockFetch: typeof fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const method = init?.method || "GET";
    if (method === "GET") {
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }

    capturedUrl = typeof input === "string" ? input : input.toString();
    capturedMethod = method;
    capturedHeaders = (init?.headers || {}) as Record<string, string>;
    capturedBody = JSON.parse((init?.body as string) || "{}");

    return Promise.resolve(
      new Response(
        JSON.stringify({
          _id: "approval-doc-123",
          batchId: capturedBody.batchId,
          weekend: capturedBody.weekend,
          targetWeekend: capturedBody.targetWeekend,
          venueIds: capturedBody.venueIds,
          approver: capturedBody.approver,
          notes: capturedBody.notes,
          approvedAt: "2026-09-07T12:00:00.000Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const sampleWeekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const record = await recordGate1Approval(
    {
      backendUrl: "https://test-backend.example.com",
      token: "secret-token-xyz",
      weekend: sampleWeekend,
      venueIds: ["64a111111111111111111111", "64a222222222222222222222"],
      approver: "Josh",
      notes: "approved 2 venues",
      metadata: { source: "cli" },
    },
    mockFetch,
  );

  assertEquals(capturedUrl, "https://test-backend.example.com/outreach/approval/venue-set");
  assertEquals(capturedMethod, "POST");
  assertEquals(capturedHeaders["Authorization"], "Bearer secret-token-xyz");
  assertEquals(capturedBody.batchId, "2026-10-16-to-2026-10-18");
  assertEquals(capturedBody.weekend, "2026-10-16-to-2026-10-18");
  assertEquals(capturedBody.approver, "Josh");
  assertEquals(capturedBody.notes, "approved 2 venues");
  assertEquals(capturedBody.venueIds, [
    "64a111111111111111111111",
    "64a222222222222222222222",
  ]);
  assertEquals(record._id, "approval-doc-123");
  assertEquals(record.approver, "Josh");
});

Deno.test("recordGate1Approval: handles string weekend and defaults approver to Josh", async () => {
  let capturedBody: Record<string, unknown> = {};

  const mockFetch: typeof fetch = (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (!init?.method || init.method === "GET") {
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }
    capturedBody = JSON.parse((init?.body as string) || "{}");
    return Promise.resolve(
      new Response(JSON.stringify(capturedBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  await recordGate1Approval(
    {
      backendUrl: "https://test.example.com",
      weekend: "2026-10-16-to-2026-10-18",
      venueIds: ["64a111111111111111111111"],
    },
    mockFetch,
  );

  assertEquals(capturedBody.batchId, "2026-10-16-to-2026-10-18");
  assertEquals(capturedBody.weekend, "2026-10-16-to-2026-10-18");
  assertEquals(capturedBody.approver, "Josh");
});

Deno.test("recordGate1Approval: throws when backend returns HTTP error status", async () => {
  const mockFetch: typeof fetch = (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }
    return Promise.resolve(
      new Response("Unauthorized", { status: 401 }),
    );
  };

  await assertRejects(
    async () => {
      await recordGate1Approval(
        {
          backendUrl: "https://test.example.com",
          weekend: "2026-10-16-to-2026-10-18",
          venueIds: ["64a111111111111111111111"],
        },
        mockFetch,
      );
    },
    Error,
    "Gate 1 venue-set approval returned HTTP 401: Unauthorized",
  );
});

Deno.test("fetchGate1Approval: returns record on HTTP 200 and null on HTTP 404", async () => {
  const mockFetch200: typeof fetch = () => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          _id: "rec-1",
          batchId: "b1",
          venueIds: ["v1"],
          approver: "Josh",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const rec = await fetchGate1Approval("b1", { backendUrl: "https://test.com" }, mockFetch200);
  assertEquals(rec?._id, "rec-1");
  assertEquals(rec?.batchId, "b1");

  const mockFetch404: typeof fetch = () => {
    return Promise.resolve(
      new Response("Not found", { status: 404 }),
    );
  };

  const notFound = await fetchGate1Approval("b1", { backendUrl: "https://test.com" }, mockFetch404);
  assertEquals(notFound, null);
});

Deno.test("parseBookGigArgs: parses --record-gate1 and --gate1 flags and parameters", () => {
  const parsed1 = parseBookGigArgs([
    "--record-gate1",
    "Oct 16-18 2026",
    "Lynchburg, VA",
    "--venues",
    "64a1,64a2",
    "--approver",
    "Josh",
    "--notes",
    "approved list",
  ]);

  assertEquals(parsed1.mode, "gate1");
  assertEquals(parsed1.weekend?.start, "2026-10-16");
  assertEquals(parsed1.location?.city, "Lynchburg");
  assertEquals(parsed1.includeVenues, ["64a1", "64a2"]);
  assertEquals(parsed1.approver, "Josh");
  assertEquals(parsed1.notes, "approved list");

  const parsed2 = parseBookGigArgs([
    "--gate1",
    "Oct 16-18 2026",
    "--approver=Maria",
    "--notes=all venues",
    "--batch-id=batch-custom-99",
  ]);

  assertEquals(parsed2.mode, "gate1");
  assertEquals(parsed2.approver, "Maria");
  assertEquals(parsed2.notes, "all venues");
  assertEquals(parsed2.batchId, "batch-custom-99");
});

Deno.test("runBookGigCli: records Gate 1 approval and strictly never calls batch dispatch (isolated HOME)", async () => {
  await withIsolatedHome(async () => {
    let gate1Recorded = false;
    let batchDispatched = false;
    let capturedApprovalBody: Record<string, unknown> = {};

    const mockFetch: typeof fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
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
                _id: "64a111111111111111111111",
                name: "Olde Salem Brewing",
                city: "Salem",
                usState: "VA",
                email: "booking@oldesalembrewing.com",
                outreachEligible: true,
                isExcluded: false,
              },
              {
                _id: "64a222222222222222222222",
                name: "Parkway Brewing",
                city: "Salem",
                usState: "VA",
                email: "info@parkway.com",
                outreachEligible: true,
                isExcluded: false,
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      if (urlStr.includes("/outreach/approval/venue-set")) {
        if (!init?.method || init.method === "GET") {
          return Promise.resolve(new Response("Not found", { status: 404 }));
        }
        gate1Recorded = true;
        capturedApprovalBody = JSON.parse((init?.body as string) || "{}");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              _id: "gate1-approval-doc-abc",
              batchId: capturedApprovalBody.batchId,
              weekend: capturedApprovalBody.weekend,
              venueIds: capturedApprovalBody.venueIds,
              approver: capturedApprovalBody.approver,
              approvedAt: "2026-09-07T12:00:00.000Z",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      if (urlStr.includes("/outreach/batch")) {
        batchDispatched = true;
        return Promise.resolve(
          new Response(JSON.stringify({ requested: 1, sent: 1, skipped: [], records: [] }), {
            status: 200,
          }),
        );
      }

      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const result = await runBookGigCli(
      ["--record-gate1", "Oct 16-18 2026", "Salem, VA"],
      mockFetch,
    );

    assertEquals(result.mode, "gate1");
    assertEquals(gate1Recorded, true, "Gate 1 approval endpoint should have been called");
    assertEquals(batchDispatched, false, "Batch dispatch must NEVER be called by Gate 1 approval");
    assertEquals(result.gate1Record?._id, "gate1-approval-doc-abc");
    assertEquals(result.gate1Record?.approver, "Josh");
    assertEquals(
      (capturedApprovalBody.venueIds as string[]).length,
      2,
      "Both eligible candidates should be approved in Gate 1 record",
    );
    assertStringIncludes(capturedApprovalBody.batchId as string, "2026-10-16");
  });
});

Deno.test("runBookGigCli: filters candidates by --venues in Gate 1 mode (isolated HOME)", async () => {
  await withIsolatedHome(async () => {
    let capturedVenueIds: string[] = [];

    const mockFetch: typeof fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
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
                _id: "64a111111111111111111111",
                name: "Olde Salem Brewing",
                city: "Salem",
                usState: "VA",
                email: "booking@oldesalembrewing.com",
                outreachEligible: true,
                isExcluded: false,
              },
              {
                _id: "64a222222222222222222222",
                name: "Parkway Brewing",
                city: "Salem",
                usState: "VA",
                email: "info@parkway.com",
                outreachEligible: true,
                isExcluded: false,
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      if (urlStr.includes("/outreach/approval/venue-set")) {
        if (!init?.method || init.method === "GET") {
          return Promise.resolve(new Response("Not found", { status: 404 }));
        }
        const body = JSON.parse((init?.body as string) || "{}");
        capturedVenueIds = body.venueIds || [];
        return Promise.resolve(
          new Response(JSON.stringify({ _id: "doc-1", ...body }), { status: 201 }),
        );
      }

      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const result = await runBookGigCli(
      [
        "--record-gate1",
        "Oct 16-18 2026",
        "Salem, VA",
        "--venues",
        "64a111111111111111111111",
        "--approver",
        "Josh Sherman",
      ],
      mockFetch,
    );

    assertEquals(result.mode, "gate1");
    assertEquals(capturedVenueIds, ["64a111111111111111111111"]);
    assertEquals(result.gate1Record?.approver, "Josh Sherman");
  });
});

Deno.test("runBookGigCli: Gate 1 mode fails closed when no weekend provided", async () => {
  await withIsolatedHome(async () => {
    await assertRejects(
      async () => {
        await runBookGigCli(["--record-gate1"]);
      },
      Error,
      "Missing target weekend argument for Gate 1 approval",
    );
  });
});

Deno.test("runBookGigCli: Gate 1 mode fails closed when --venues matches no eligible candidate by name", async () => {
  await withIsolatedHome(async () => {
    let gate1Recorded = false;
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
                _id: "64a111111111111111111111",
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

      if (urlStr.includes("/outreach/approval/venue-set")) {
        gate1Recorded = true;
        return Promise.resolve(
          new Response(JSON.stringify({ _id: "gate1-doc" }), { status: 201 }),
        );
      }

      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    await assertRejects(
      async () => {
        await runBookGigCli(
          [
            "--record-gate1",
            "Oct 16-18 2026",
            "Salem, VA",
            "--venues",
            "Nonexistent Venue",
          ],
          mockFetch,
        );
      },
      Error,
      "No eligible candidate venues matched --venues filter: Nonexistent Venue",
    );

    assertEquals(
      gate1Recorded,
      false,
      "recordGate1Approval must not be called when --venues filter matches zero candidates",
    );
  });
});

Deno.test("runBookGigCli: Gate 1 mode fails closed when --venues contains unmatched 24-hex ObjectId not in candidate set", async () => {
  await withIsolatedHome(async () => {
    let gate1Recorded = false;
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
                _id: "64a111111111111111111111",
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

      if (urlStr.includes("/outreach/approval/venue-set")) {
        gate1Recorded = true;
        return Promise.resolve(
          new Response(JSON.stringify({ _id: "gate1-doc" }), { status: 201 }),
        );
      }

      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    await assertRejects(
      async () => {
        await runBookGigCli(
          [
            "--record-gate1",
            "Oct 16-18 2026",
            "Salem, VA",
            "--venues",
            "507f1f77bcf86cd799439011",
          ],
          mockFetch,
        );
      },
      Error,
      "No eligible candidate venues matched --venues filter: 507f1f77bcf86cd799439011",
    );

    assertEquals(
      gate1Recorded,
      false,
      "recordGate1Approval must not be called when --venues contains unmatched ObjectId",
    );
  });
});

Deno.test("runBookGigCli: Gate 1 mode excludes candidate venues without email address", async () => {
  await withIsolatedHome(async () => {
    let capturedVenueIds: string[] = [];

    const mockFetch: typeof fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
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
                _id: "64a111111111111111111111",
                name: "Has Email",
                city: "Salem",
                usState: "VA",
                email: "booking@hasemail.com",
                outreachEligible: true,
                isExcluded: false,
              },
              {
                _id: "64a222222222222222222222",
                name: "No Email",
                city: "Salem",
                usState: "VA",
                email: "",
                outreachEligible: true,
                isExcluded: false,
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      if (urlStr.includes("/outreach/approval/venue-set")) {
        if (!init?.method || init.method === "GET") {
          return Promise.resolve(new Response("Not found", { status: 404 }));
        }
        const body = JSON.parse((init?.body as string) || "{}");
        capturedVenueIds = body.venueIds || [];
        return Promise.resolve(
          new Response(JSON.stringify({ _id: "doc-1", ...body }), { status: 201 }),
        );
      }

      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const result = await runBookGigCli(
      ["--record-gate1", "Oct 16-18 2026", "Salem, VA"],
      mockFetch,
    );

    assertEquals(result.mode, "gate1");
    assertEquals(
      capturedVenueIds,
      ["64a111111111111111111111"],
      "Venue without email must be excluded from Gate 1 approval",
    );
  });
});

Deno.test("recordGate1Approval: throws when an existing approval for the batch has a different venue set", async () => {
  let postCalled = false;

  const mockFetch: typeof fetch = (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "existing-approval-1",
            batchId: "2026-10-16-to-2026-10-18",
            venueIds: ["64a111111111111111111111"],
            approver: "Josh",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    postCalled = true;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  await assertRejects(
    async () => {
      await recordGate1Approval(
        {
          backendUrl: "https://test.example.com",
          weekend: "2026-10-16-to-2026-10-18",
          venueIds: ["64a111111111111111111111", "64a222222222222222222222"],
        },
        mockFetch,
      );
    },
    Error,
    "Gate 1 venue-set approval already exists for batch '2026-10-16-to-2026-10-18' with a different venue set",
  );

  assertEquals(
    postCalled,
    false,
    "POST /outreach/approval/venue-set must not be called when an existing approval's venue set differs",
  );
});

Deno.test("recordGate1Approval: succeeds as a no-op when re-recording the identical venue set", async () => {
  let capturedBody: Record<string, unknown> = {};

  const mockFetch: typeof fetch = (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (!init?.method || init.method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "existing-approval-1",
            batchId: "2026-10-16-to-2026-10-18",
            venueIds: ["64a222222222222222222222", "64a111111111111111111111"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    capturedBody = JSON.parse((init?.body as string) || "{}");
    return Promise.resolve(
      new Response(JSON.stringify({ _id: "updated-doc", ...capturedBody }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const record = await recordGate1Approval(
    {
      backendUrl: "https://test.example.com",
      weekend: "2026-10-16-to-2026-10-18",
      // Same set as the existing approval, different order — must still be treated as identical.
      venueIds: ["64a111111111111111111111", "64a222222222222222222222"],
    },
    mockFetch,
  );

  assertEquals(record._id, "updated-doc");
  assertEquals(capturedBody.venueIds, [
    "64a111111111111111111111",
    "64a222222222222222222222",
  ]);
});

Deno.test("runBookGigCli: Gate 1 mode fails closed on partially unmatched --venues filter with specific unmatched names", async () => {
  await withIsolatedHome(async () => {
    let gate1Recorded = false;

    const mockFetch: typeof fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
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
                _id: "64a111111111111111111111",
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

      if (urlStr.includes("/outreach/approval/venue-set")) {
        if (!init?.method || init.method === "GET") {
          return Promise.resolve(new Response("Not found", { status: 404 }));
        }
        gate1Recorded = true;
        return Promise.resolve(
          new Response(JSON.stringify({ _id: "gate1-doc" }), { status: 201 }),
        );
      }

      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    await assertRejects(
      async () => {
        await runBookGigCli(
          [
            "--record-gate1",
            "Oct 16-18 2026",
            "Salem, VA",
            "--venues",
            "Olde Salem Brewing, Typo Venue",
          ],
          mockFetch,
        );
      },
      Error,
      "No eligible candidate venues matched --venues filter: Typo Venue",
    );

    assertEquals(
      gate1Recorded,
      false,
      "recordGate1Approval must not be called when --venues contains partially unmatched venue",
    );
  });
});

Deno.test("runBookGigCli: Gate 1 mode refuses to silently overwrite an existing approval with a different venue set", async () => {
  await withIsolatedHome(async () => {
    let gate1Recorded = false;

    const mockFetch: typeof fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
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
                _id: "64a111111111111111111111",
                name: "Olde Salem Brewing",
                city: "Salem",
                usState: "VA",
                email: "booking@oldesalembrewing.com",
                outreachEligible: true,
                isExcluded: false,
              },
              {
                _id: "64a222222222222222222222",
                name: "Second Venue",
                city: "Salem",
                usState: "VA",
                email: "booking@secondvenue.com",
                outreachEligible: true,
                isExcluded: false,
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      if (urlStr.includes("/outreach/approval/venue-set")) {
        if (!init?.method || init.method === "GET") {
          // A prior run already approved only the first venue.
          return Promise.resolve(
            new Response(
              JSON.stringify({
                _id: "existing-gate1-doc",
                batchId: "2026-10-16-to-2026-10-18",
                venueIds: ["64a111111111111111111111"],
                approver: "Josh",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        gate1Recorded = true;
        return Promise.resolve(
          new Response(JSON.stringify({ _id: "gate1-doc" }), { status: 201 }),
        );
      }

      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    // This run approves BOTH venues — a wider set than the existing approval.
    await assertRejects(
      async () => {
        await runBookGigCli(
          ["--record-gate1", "Oct 16-18 2026", "Salem, VA"],
          mockFetch,
        );
      },
      Error,
      "Gate 1 venue-set approval already exists for batch '2026-10-16-to-2026-10-18' with a different venue set",
    );

    assertEquals(
      gate1Recorded,
      false,
      "recordGate1Approval POST must not be called when an existing approval's venue set differs from the requested one",
    );
  });
});

Deno.test("runBookGigCli: Gate 1 mode allows a no-op re-run when the existing approval already covers the identical venue set", async () => {
  await withIsolatedHome(async () => {
    let gate1Recorded = false;
    let capturedBody: Record<string, unknown> = {};

    const mockFetch: typeof fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
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
                _id: "64a111111111111111111111",
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

      if (urlStr.includes("/outreach/approval/venue-set")) {
        if (!init?.method || init.method === "GET") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                _id: "existing-gate1-doc",
                batchId: "2026-10-16-to-2026-10-18",
                venueIds: ["64a111111111111111111111"],
                approver: "Josh",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        gate1Recorded = true;
        capturedBody = JSON.parse((init?.body as string) || "{}");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              _id: "existing-gate1-doc",
              batchId: capturedBody.batchId,
              venueIds: capturedBody.venueIds,
              approver: capturedBody.approver,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    // Same single venue as the existing approval — must succeed as a harmless no-op.
    const result = await runBookGigCli(
      ["--record-gate1", "Oct 16-18 2026", "Salem, VA"],
      mockFetch,
    );

    assertEquals(result.mode, "gate1");
    assertEquals(gate1Recorded, true);
    assertEquals(capturedBody.venueIds, ["64a111111111111111111111"]);
  });
});
