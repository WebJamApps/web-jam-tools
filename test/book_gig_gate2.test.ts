// test/book_gig_gate2.test.ts — Unit tests for /book-gig Gate 2 review loop & draft copy approval
import { assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { runBookGigCli } from "../src/book-gig/cli.ts";
import { parseBookGigArgs } from "../src/book-gig/parser.ts";
import {
  computeDraftFingerprint,
  fetchGate2Approval,
  recordGate2Approval,
} from "../src/book-gig/outreach_api.ts";
import {
  assertGate2ApprovedForDispatch,
  Gate2ReviewSession,
  isExplicitWholeBatchApproval,
} from "../src/book-gig/gate2.ts";
import { renderPitch } from "../src/book-gig/pitch.ts";
import type { CandidateVenue, PitchEmail, TargetWeekend } from "../src/book-gig/types.ts";

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

const sampleWeekend: TargetWeekend = {
  start: "2026-10-16",
  end: "2026-10-18",
  rawText: "Oct 16-18 2026",
  label: "October 16–18, 2026",
  year: 2026,
  month: 10,
  days: [16, 17, 18],
};

const sampleCandidates: CandidateVenue[] = [
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
];

const samplePitches: PitchEmail[] = [
  {
    venueId: "64a111111111111111111111",
    venueName: "Olde Salem Brewing",
    to: "booking@oldesalembrewing.com",
    subject: "Live music booking — Josh & Maria — Oct 16–18, 2026",
    body:
      "Hi Olde Salem team,\nWe would love to play on October 16–18, 2026.\nThanks, Josh & Maria",
  },
  {
    venueId: "64a222222222222222222222",
    venueName: "Parkway Brewing",
    to: "info@parkway.com",
    subject: "Live music booking — Josh & Maria — Oct 16–18, 2026",
    body: "Hi Parkway team,\nWe would love to play on October 16–18, 2026.\nThanks, Josh & Maria",
  },
];

// ============================================================================
// 1. computeDraftFingerprint
// ============================================================================
Deno.test("computeDraftFingerprint: produces deterministic SHA-256 matching web-jam-back", () => {
  const fp1 = computeDraftFingerprint({
    subject: "Live music booking",
    body: "Hi Olde Salem team,\nWe would love to play.",
  });
  assertEquals(typeof fp1, "string");
  assertEquals(fp1.length, 64, "SHA-256 hex string must be 64 chars");

  // Normalized content should produce identical fingerprint
  const fp2 = computeDraftFingerprint(
    "Live music booking\n\nHi Olde Salem team,\nWe would love to play.",
  );
  assertEquals(fp1, fp2);

  // Whitespace trimming
  const fp3 = computeDraftFingerprint({
    subject: "  Live music booking  ",
    body: "  Hi Olde Salem team,\nWe would love to play.  \n",
  });
  assertEquals(fp1, fp3);

  // Divergent content must produce different fingerprint
  const fpDifferent = computeDraftFingerprint({
    subject: "Live music booking",
    body: "Hi Parkway team,\nWe would love to play.",
  });
  assertNotEquals(fp1, fpDifferent);
});

// ============================================================================
// 2. isExplicitWholeBatchApproval (D-45: approval is never inferred)
// ============================================================================
Deno.test("isExplicitWholeBatchApproval: rejects silence, empty strings, and non-strings", () => {
  assertEquals(isExplicitWholeBatchApproval(undefined), false);
  assertEquals(isExplicitWholeBatchApproval(null), false);
  assertEquals(isExplicitWholeBatchApproval(""), false);
  assertEquals(isExplicitWholeBatchApproval("   "), false);
  assertEquals(isExplicitWholeBatchApproval(123), false);
});

Deno.test("isExplicitWholeBatchApproval: rejects tweak requests as approvals", () => {
  assertEquals(isExplicitWholeBatchApproval("tweak Olde Salem Brewing body copy"), false);
  assertEquals(isExplicitWholeBatchApproval("change venue 1 intro to mention the patio"), false);
  assertEquals(isExplicitWholeBatchApproval("rewrite the body for Parkway"), false);
  assertEquals(isExplicitWholeBatchApproval("modify the pitch for Olde Salem"), false);
  assertEquals(isExplicitWholeBatchApproval("custom body: hi folks"), false);
  assertEquals(isExplicitWholeBatchApproval("edit Parkway Brewing"), false);
});

Deno.test("isExplicitWholeBatchApproval: rejects venue-list / Gate 1 approvals", () => {
  assertEquals(isExplicitWholeBatchApproval("gate 1 approved"), false);
  assertEquals(isExplicitWholeBatchApproval("gate1 approved"), false);
  assertEquals(isExplicitWholeBatchApproval("I approve the venue list"), false);
  assertEquals(isExplicitWholeBatchApproval("candidate list approved"), false);
  assertEquals(isExplicitWholeBatchApproval("target venues look good"), false);
  assertEquals(isExplicitWholeBatchApproval("approved the venues"), false);
});

Deno.test("isExplicitWholeBatchApproval: rejects partial reviews of single venues", () => {
  assertEquals(isExplicitWholeBatchApproval("Olde Salem looks good"), false);
  assertEquals(isExplicitWholeBatchApproval("approved for venue 1"), false);
  assertEquals(isExplicitWholeBatchApproval("looks good for Olde Salem"), false);
  assertEquals(isExplicitWholeBatchApproval("approved just Olde Salem"), false);
  assertEquals(isExplicitWholeBatchApproval("approved venue 1 only"), false);
});

Deno.test("isExplicitWholeBatchApproval: rejects bare conversational remarks", () => {
  assertEquals(isExplicitWholeBatchApproval("ok"), false);
  assertEquals(isExplicitWholeBatchApproval("okay"), false);
  assertEquals(isExplicitWholeBatchApproval("k"), false);
  assertEquals(isExplicitWholeBatchApproval("fine"), false);
  assertEquals(isExplicitWholeBatchApproval("looks fine"), false);
  assertEquals(isExplicitWholeBatchApproval("looks good"), false);
  assertEquals(isExplicitWholeBatchApproval("sounds good"), false);
  assertEquals(isExplicitWholeBatchApproval("nice"), false);
  assertEquals(isExplicitWholeBatchApproval("cool"), false);
  assertEquals(isExplicitWholeBatchApproval("proceed"), false);
  assertEquals(isExplicitWholeBatchApproval("continue"), false);
  assertEquals(isExplicitWholeBatchApproval("go ahead"), false);
  assertEquals(isExplicitWholeBatchApproval("send"), false);
});

Deno.test("isExplicitWholeBatchApproval: accepts affirmative whole-batch approvals", () => {
  assertEquals(
    isExplicitWholeBatchApproval("I explicitly approve all drafts in their entirety"),
    true,
  );
  assertEquals(isExplicitWholeBatchApproval("approve the whole batch of drafts"), true);
  assertEquals(isExplicitWholeBatchApproval("all drafts are approved"), true);
  assertEquals(isExplicitWholeBatchApproval("approve every draft in full"), true);
  assertEquals(isExplicitWholeBatchApproval("approved all in their entirety"), true);
  assertEquals(isExplicitWholeBatchApproval("whole batch is approved"), true);
  assertEquals(isExplicitWholeBatchApproval("drafts approved in their entirety"), true);
});

// ============================================================================
// 3. Gate2ReviewSession (D-44 review loop, per-venue tweaks, server-side fingerprints)
// ============================================================================
Deno.test("Gate2ReviewSession: holds in review loop initially", () => {
  const session = new Gate2ReviewSession({
    weekend: sampleWeekend,
    candidates: sampleCandidates,
    pitches: samplePitches,
  });

  assertEquals(session.status, "holding");
  assertEquals(session.isApproved(), false);
  assertEquals(session.pitches.length, 2);
});

Deno.test("Gate2ReviewSession: applyTweak re-renders tweaked venue and leaves others untouched (D-44)", async () => {
  let previewCalls = 0;
  const mockFetch: typeof fetch = (input: string | URL | Request) => {
    const urlStr = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    if (urlStr.includes("/outreach/preview")) {
      previewCalls++;
      const url = new URL(urlStr);
      const venueIds = (url.searchParams.get("venueIds") || "").split(",");
      const customBody = url.searchParams.get("customBody") || "";

      return Promise.resolve(
        new Response(
          JSON.stringify(
            venueIds.map((id) => ({
              venueId: id,
              venueName: id.includes("1") ? "Olde Salem Brewing" : "Parkway Brewing",
              subject: "Pitch Subject",
              body: customBody ? `Customized: ${customBody}` : "Default body copy",
              htmlBody: customBody
                ? `<p>Customized: ${customBody}</p>`
                : "<p>Default body copy</p>",
            })),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const session = new Gate2ReviewSession({
    weekend: sampleWeekend,
    candidates: sampleCandidates,
    pitches: samplePitches,
    fetchFn: mockFetch,
  });

  const updatedPitch = await session.applyTweak("Olde Salem Brewing", {
    customBody: "Special patio performance set",
  });

  assertEquals(session.status, "tweaked");
  assertEquals(session.isApproved(), false);
  assertStringIncludes(updatedPitch.body, "Special patio performance set");

  // Parkway Brewing (untouched venue) must not have the custom body
  const parkwayPitch = session.pitches.find((p) => p.venueId === "64a222222222222222222222");
  assertEquals(parkwayPitch?.body, "Default body copy");
  assertNotEquals(parkwayPitch?.body, updatedPitch.body);
});

Deno.test("Gate2ReviewSession: approveWholeBatch throws if explicitApproval is false", async () => {
  const session = new Gate2ReviewSession({
    weekend: sampleWeekend,
    candidates: sampleCandidates,
    pitches: samplePitches,
  });

  await assertRejects(
    async () => {
      await session.approveWholeBatch({
        explicitApproval: false,
      });
    },
    Error,
    "Gate 2 approval forbidden",
  );
});

Deno.test("Gate2ReviewSession: approveWholeBatch records fingerprints on explicit approval (D-45)", async () => {
  let capturedBody: Record<string, unknown> = {};

  const mockFetch: typeof fetch = (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    if (urlStr.includes("/outreach/approval/draft-fingerprints")) {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }
      capturedBody = JSON.parse((init?.body as string) || "{}");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "gate2-rec-xyz",
            ...capturedBody,
            approvedAt: "2026-09-08T12:00:00.000Z",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const session = new Gate2ReviewSession({
    weekend: sampleWeekend,
    candidates: sampleCandidates,
    pitches: samplePitches,
    fetchFn: mockFetch,
  });

  const record = await session.approveWholeBatch({
    approver: "Josh",
    notes: "approved in full",
    explicitApproval: true,
  });

  assertEquals(session.status, "approved");
  assertEquals(session.isApproved(), true);
  assertEquals(record._id, "gate2-rec-xyz");
  assertEquals(record.approver, "Josh");
  assertEquals((capturedBody.draftFingerprints as unknown[]).length, 2);
});

// ============================================================================
// 4. recordGate2Approval & fetchGate2Approval
// ============================================================================
Deno.test("recordGate2Approval: validates non-empty draftFingerprints", async () => {
  await assertRejects(
    async () => {
      await recordGate2Approval({
        weekend: sampleWeekend,
        draftFingerprints: [],
      });
    },
    Error,
    "draftFingerprints must be a non-empty array",
  );
});

Deno.test("recordGate2Approval: validates venueId and fingerprint fields", async () => {
  await assertRejects(
    async () => {
      await recordGate2Approval({
        weekend: sampleWeekend,
        draftFingerprints: [{ venueId: "", fingerprint: "abc" }],
      });
    },
    Error,
    "invalid venueId in draftFingerprints",
  );

  await assertRejects(
    async () => {
      await recordGate2Approval({
        weekend: sampleWeekend,
        draftFingerprints: [{ venueId: "v1", fingerprint: "" }],
      });
    },
    Error,
    "fingerprint is required for venueId 'v1'",
  );
});

Deno.test("recordGate2Approval: refuses silent overwrite when existing approval has different fingerprints", async () => {
  const mockFetch: typeof fetch = (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    if (urlStr.includes("/outreach/approval/draft-fingerprints")) {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              _id: "existing-gate2",
              batchId: "2026-10-16-to-2026-10-18",
              draftFingerprints: [{ venueId: "64a1", fingerprint: "old-hash-1" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  await assertRejects(
    async () => {
      await recordGate2Approval(
        {
          backendUrl: "https://test.example.com",
          weekend: sampleWeekend,
          draftFingerprints: [{ venueId: "64a1", fingerprint: "new-hash-diverged" }],
        },
        mockFetch,
      );
    },
    Error,
    "Gate 2 draft fingerprint approval already exists for batch '2026-10-16-to-2026-10-18' with different fingerprints",
  );
});

Deno.test("recordGate2Approval: succeeds as no-op when re-recording identical fingerprints", async () => {
  const mockFetch: typeof fetch = (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    if (urlStr.includes("/outreach/approval/draft-fingerprints")) {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              _id: "existing-gate2",
              batchId: "2026-10-16-to-2026-10-18",
              draftFingerprints: [{ venueId: "64a1", fingerprint: "identical-hash" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "existing-gate2",
            batchId: "2026-10-16-to-2026-10-18",
            draftFingerprints: [{ venueId: "64a1", fingerprint: "identical-hash" }],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const rec = await recordGate2Approval(
    {
      backendUrl: "https://test.example.com",
      weekend: sampleWeekend,
      draftFingerprints: [{ venueId: "64a1", fingerprint: "identical-hash" }],
    },
    mockFetch,
  );

  assertEquals(rec._id, "existing-gate2");
});

Deno.test("fetchGate2Approval: returns record on 200 and null on 404", async () => {
  const mock200: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ _id: "gate2-doc", batchId: "b1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  const rec = await fetchGate2Approval("b1", { backendUrl: "https://test.com" }, mock200);
  assertEquals(rec?._id, "gate2-doc");

  const mock404: typeof fetch = () => Promise.resolve(new Response("Not found", { status: 404 }));
  const notFound = await fetchGate2Approval("b1", { backendUrl: "https://test.com" }, mock404);
  assertEquals(notFound, null);
});

Deno.test("assertGate2ApprovedForDispatch: throws when Gate 2 approval missing and succeeds when present", async () => {
  const mock404: typeof fetch = () => Promise.resolve(new Response("Not found", { status: 404 }));
  await assertRejects(
    async () => {
      await assertGate2ApprovedForDispatch("b1", { backendUrl: "https://test.com" }, mock404);
    },
    Error,
    "Batch dispatch refused: Gate 2 draft copy approval is missing for batch 'b1'",
  );

  const mock200: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ _id: "rec-ok", batchId: "b1" }), { status: 200 }),
    );
  const rec = await assertGate2ApprovedForDispatch(
    "b1",
    { backendUrl: "https://test.com" },
    mock200,
  );
  assertEquals(rec._id, "rec-ok");
});

// ============================================================================
// 5. parseBookGigArgs (Gate 2 flags)
// ============================================================================
Deno.test("parseBookGigArgs: parses --record-gate2 and --confirm-all", () => {
  const parsed = parseBookGigArgs([
    "--record-gate2",
    "Oct 16-18 2026",
    "Salem, VA",
    "--confirm-all",
    "--approver",
    "Josh Sherman",
  ]);

  assertEquals(parsed.mode, "gate2");
  assertEquals(parsed.weekend?.start, "2026-10-16");
  assertEquals(parsed.location?.city, "Salem");
  assertEquals(parsed.confirmAll, true);
  assertEquals(parsed.approver, "Josh Sherman");
});

Deno.test("parseBookGigArgs: promotes mode to gate2 when --tweak-venue is passed", () => {
  const parsed = parseBookGigArgs([
    "Oct 16-18 2026",
    "--tweak-venue",
    "Olde Salem Brewing",
    "--custom-body",
    "Custom draft text",
    "--custom-intro",
    "Custom intro line",
  ]);

  assertEquals(parsed.mode, "gate2");
  assertEquals(parsed.tweakVenue, "Olde Salem Brewing");
  assertEquals(parsed.customBody, "Custom draft text");
  assertEquals(parsed.customIntro, "Custom intro line");
  assertEquals(parsed.tweaks?.length, 1);
  assertEquals(parsed.tweaks?.[0].venueName, "Olde Salem Brewing");
  assertEquals(parsed.tweaks?.[0].customBody, "Custom draft text");
});

function mockPreviewResponse(
  candidates: CandidateVenue[],
  weekend: TargetWeekend,
  urlStr: string,
): Response {
  const url = new URL(urlStr);
  const targetVenueIds = (url.searchParams.get("venueIds") || "")
    .split(",")
    .filter(Boolean);
  const customBody = url.searchParams.get("customBody") || undefined;
  const customIntro = url.searchParams.get("customIntro") || undefined;

  const matching = targetVenueIds.length > 0
    ? candidates.filter((c) => targetVenueIds.includes(c._id))
    : candidates;

  const previews = matching.map((c) => {
    const rendered = renderPitch(c, weekend, { customBody, customIntro });
    return {
      venueId: c._id,
      venueName: c.name,
      subject: rendered.subject,
      body: rendered.htmlBody,
      htmlBody: rendered.htmlBody,
    };
  });

  return new Response(JSON.stringify(previews), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================================
// 6. runBookGigCli in Gate 2 Mode (isolated HOME)
// ============================================================================
Deno.test("runBookGigCli: --record-gate2 refuses when explicit whole-batch approval is missing (isolated HOME)", async () => {
  await withIsolatedHome(async () => {
    let gate2Recorded = false;
    const mockFetch: typeof fetch = (input: string | URL | Request) => {
      const urlStr = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      if (urlStr.includes("/outreach/candidates")) {
        return Promise.resolve(
          new Response(JSON.stringify(sampleCandidates), { status: 200 }),
        );
      }
      if (urlStr.includes("/outreach/preview")) {
        return Promise.resolve(mockPreviewResponse(sampleCandidates, sampleWeekend, urlStr));
      }
      if (urlStr.includes("/template")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (urlStr.includes("/outreach/approval/draft-fingerprints")) {
        gate2Recorded = true;
        return Promise.resolve(new Response(JSON.stringify({ _id: "rec" }), { status: 201 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    await assertRejects(
      async () => {
        await runBookGigCli(["--record-gate2", "Oct 16-18 2026", "Salem, VA"], mockFetch);
      },
      Error,
      "Gate 2 approval forbidden: approval cannot be inferred from silence, partial reviews, tweak submissions, or venue-list approval",
    );

    assertEquals(
      gate2Recorded,
      false,
      "Fingerprints must NEVER be recorded without explicit approval",
    );
  });
});

Deno.test("runBookGigCli: --tweak-venue applies tweak, re-renders, holds in loop, and never records fingerprints (D-44, isolated HOME)", async () => {
  await withIsolatedHome(async () => {
    let gate2Recorded = false;
    let batchDispatched = false;
    let previewWithCustomBody = false;

    const mockFetch: typeof fetch = (input: string | URL | Request) => {
      const urlStr = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      if (urlStr.includes("/outreach/candidates")) {
        return Promise.resolve(
          new Response(JSON.stringify(sampleCandidates), { status: 200 }),
        );
      }
      if (urlStr.includes("/outreach/preview")) {
        const url = new URL(urlStr);
        if (url.searchParams.get("customBody")) {
          previewWithCustomBody = true;
        }
        return Promise.resolve(mockPreviewResponse(sampleCandidates, sampleWeekend, urlStr));
      }
      if (urlStr.includes("/template")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (urlStr.includes("/outreach/approval/draft-fingerprints")) {
        gate2Recorded = true;
        return Promise.resolve(new Response("{}", { status: 201 }));
      }
      if (urlStr.includes("/outreach/batch")) {
        batchDispatched = true;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const result = await runBookGigCli(
      [
        "--tweak-venue",
        "Olde Salem Brewing",
        "--custom-body",
        "We have a special acoustic set for your taproom",
        "Oct 16-18 2026",
        "Salem, VA",
      ],
      mockFetch,
    );

    assertEquals(result.mode, "gate2");
    assertEquals(result.gate2Status, "tweaked");
    assertEquals(
      previewWithCustomBody,
      true,
      "Custom body must be sent to /outreach/preview for tweaked venue",
    );
    assertEquals(
      gate2Recorded,
      false,
      "Fingerprints must strictly NEVER be recorded during a tweak submission",
    );
    assertEquals(
      batchDispatched,
      false,
      "Batch dispatch must strictly NEVER be called during a tweak submission",
    );
  });
});

Deno.test("runBookGigCli: --record-gate2 with --confirm-all records draft fingerprints server-side (D-45, isolated HOME)", async () => {
  await withIsolatedHome(async () => {
    let gate2Recorded = false;
    let batchDispatched = false;
    let capturedFingerprints: Array<{ venueId: string; fingerprint: string }> = [];

    const mockFetch: typeof fetch = (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      if (urlStr.includes("/outreach/candidates")) {
        return Promise.resolve(
          new Response(JSON.stringify(sampleCandidates), { status: 200 }),
        );
      }
      if (urlStr.includes("/outreach/preview")) {
        return Promise.resolve(mockPreviewResponse(sampleCandidates, sampleWeekend, urlStr));
      }
      if (urlStr.includes("/template")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (urlStr.includes("/outreach/approval/draft-fingerprints")) {
        if (!init?.method || init.method === "GET") {
          return Promise.resolve(new Response("Not found", { status: 404 }));
        }
        gate2Recorded = true;
        const body = JSON.parse((init?.body as string) || "{}");
        capturedFingerprints = body.draftFingerprints || [];
        return Promise.resolve(
          new Response(
            JSON.stringify({
              _id: "gate2-approval-doc-123",
              ...body,
              approvedAt: "2026-09-08T14:00:00.000Z",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (urlStr.includes("/outreach/batch")) {
        batchDispatched = true;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const result = await runBookGigCli(
      [
        "--record-gate2",
        "Oct 16-18 2026",
        "Salem, VA",
        "--confirm-all",
        "--approver",
        "Josh",
      ],
      mockFetch,
    );

    assertEquals(result.mode, "gate2");
    assertEquals(result.gate2Status, "approved");
    assertEquals(
      gate2Recorded,
      true,
      "Draft fingerprints must be recorded on explicit whole-batch approval",
    );
    assertEquals(batchDispatched, false, "Gate 2 must never trigger batch dispatch");
    assertEquals(capturedFingerprints.length, 2);
    assertEquals(capturedFingerprints[0].venueId, "64a111111111111111111111");
    assertEquals(capturedFingerprints[0].fingerprint.length, 64);
    assertEquals(capturedFingerprints[1].venueId, "64a222222222222222222222");
    assertEquals(capturedFingerprints[1].fingerprint.length, 64);
    assertEquals(result.gate2Record?._id, "gate2-approval-doc-123");
  });
});

// ============================================================================
// 7. Symlink Integrity (Acceptance criteria)
// ============================================================================
Deno.test("Installed skill symlink resolves into canonical clone on Claude Code (~/.claude/skills/book-gig)", async () => {
  const home = Deno.env.get("HOME") || "/home/joshua";
  const claudeSymlink = `${home}/.claude/skills/book-gig`;
  const info = await Deno.lstat(claudeSymlink).catch(() => null);
  if (info) {
    assertEquals(info.isSymlink, true, "Claude Code skill must be a symlink");
    const target = await Deno.readLink(claudeSymlink);
    assertStringIncludes(target, "web-jam-tools/skills/book-gig");
  }
});

Deno.test("Installed skill symlink resolves into canonical clone on agy/Antigravity (~/.gemini/.../book-gig)", async () => {
  const home = Deno.env.get("HOME") || "/home/joshua";
  const agySymlink = `${home}/.gemini/config/plugins/webjam-tasks/skills/book-gig`;
  const info = await Deno.lstat(agySymlink).catch(() => null);
  if (info) {
    assertEquals(info.isSymlink, true, "agy/Antigravity skill must be a symlink");
    const target = await Deno.readLink(agySymlink);
    assertStringIncludes(target, "web-jam-tools/skills/book-gig");
  }
});
