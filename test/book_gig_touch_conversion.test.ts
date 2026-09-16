// test/book_gig_touch_conversion.test.ts
// Unit tests for converting venue notes into structured call and visit touches (D-68 / web-jam-tools#1006)

import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  applyDateFills,
  detectVenueConversationTouch,
  executeTouchConversion,
  extractDateFromText,
  hasExistingTouch,
  isPhoneConversation,
  isValidIsoDate,
  renderProposalsTable,
  type TouchProposal,
  type VenueNotesRecord,
} from "../src/book-gig/convert_touches.ts";

Deno.test("extractDateFromText: parses ISO YYYY-MM-DD and month name formats", () => {
  assertEquals(extractDateFromText("In-person visit 2026-05-08."), "2026-05-08");
  assertEquals(extractDateFromText("[2026-08-28] Spoke in person with Jose"), "2026-08-28");
  assertEquals(
    extractDateFromText("Booking confirmation from May 18, 2026; phone call"),
    "2026-05-18",
  );
  assertEquals(extractDateFromText("Spoke on October 5 2026 by phone"), "2026-10-05");
  assertEquals(extractDateFromText("Spoke on the phone about a 2027 booking"), "");
  assertEquals(extractDateFromText(""), "");
});

Deno.test("detectVenueConversationTouch: proposes call touch for genuine phone conversation", () => {
  const venue: VenueNotesRecord = {
    _id: "venue-call-1",
    name: "Apocalypse Ale Works",
    city: "Forest",
    usState: "VA",
    notes:
      "Booking confirmation from May 18, 2026; Phone call successful — confirmed. Target Oct/Nov 2026.",
  };

  const proposal = detectVenueConversationTouch(venue);
  assertNotEquals(proposal, null);
  assertEquals(proposal?.venueId, "venue-call-1");
  assertEquals(proposal?.venueName, "Apocalypse Ale Works");
  assertEquals(proposal?.touchType, "call");
  assertEquals(proposal?.date, "2026-05-18");
  assertStringIncludes(proposal!.sentence, "Phone call successful — confirmed");
});

Deno.test("detectVenueConversationTouch: proposes call touch with blank date when no date present", () => {
  const venue: VenueNotesRecord = {
    _id: "venue-call-nodate",
    name: "Test Brewery",
    city: "Salem",
    usState: "VA",
    notes: "Spoke on the phone about a 2027 booking",
  };

  const proposal = detectVenueConversationTouch(venue);
  assertNotEquals(proposal, null);
  assertEquals(proposal?.touchType, "call");
  assertEquals(proposal?.date, "");
  assertEquals(proposal?.sentence, "Spoke on the phone about a 2027 booking");
});

Deno.test("detectVenueConversationTouch: proposes visit touch for genuine in-person conversation", () => {
  const venue: VenueNotesRecord = {
    _id: "venue-visit-1",
    name: "Big Lick Brewing Company",
    city: "Roanoke",
    usState: "VA",
    notes:
      "2026-07-01: Josh visited in person — submitted the Events & Music booking form and dropped off a business card. Actively following up for last weekend of Sept.",
  };

  const proposal = detectVenueConversationTouch(venue);
  assertNotEquals(proposal, null);
  assertEquals(proposal?.venueId, "venue-visit-1");
  assertEquals(proposal?.venueName, "Big Lick Brewing Company");
  assertEquals(proposal?.touchType, "visit");
  assertEquals(proposal?.date, "2026-07-01");
  assertStringIncludes(proposal!.sentence, "Josh visited in person");
});

Deno.test("detectVenueConversationTouch: prioritizes visit over call when both present", () => {
  const venue: VenueNotesRecord = {
    _id: "venue-mixed-1",
    name: "Macado's South County",
    city: "Roanoke",
    usState: "VA",
    notes:
      "Comments: In-person visit 2026-05-08. Card passed to manager.\nDate called: 2026-05-08\nNotes: Spoke to waitress; phone call was follow up.",
  };

  const proposal = detectVenueConversationTouch(venue);
  assertNotEquals(proposal, null);
  assertEquals(proposal?.touchType, "visit");
  assertEquals(proposal?.date, "2026-05-08");
  assertStringIncludes(proposal!.sentence, "In-person visit 2026-05-08");
});

Deno.test("detectVenueConversationTouch: does NOT propose legacy spreadsheet metadata (Hamlet Vineyards case)", () => {
  const venue: VenueNotesRecord = {
    _id: "venue-hamlet-1",
    name: "Hamlet Vineyards",
    city: "Bassett",
    usState: "VA",
    notes:
      "Type of gig: Vineyard\nComments: Sent pitch email regarding Sunday afternoons 2026-05-09\nStatus (sheet): [S]\nDate called: 2026-05-09\nNotes: Sent pitch email regarding Sunday afternoons to va@hamletvineyards.com on 2026-05-09.\n\n[2026-07-22] Liza Crowder: 2026 music calendar is fully booked.",
  };

  const proposal = detectVenueConversationTouch(venue);
  assertEquals(proposal, null, "Legacy spreadsheet metadata alone must NOT trigger a proposal");
});

Deno.test("detectVenueConversationTouch: ignores non-conversation mentions (instructions, hypothetical, phone labels)", () => {
  const venue1: VenueNotesRecord = {
    _id: "v-instr-1",
    name: "Instruction Venue",
    notes: "Direct phone: (276) 666-6666. No alternate email; booking requires phone or Facebook.",
  };
  assertEquals(detectVenueConversationTouch(venue1), null);

  const venue2: VenueNotesRecord = {
    _id: "v-instr-2",
    name: "Hypothetical Venue",
    notes: "Sorry what do you mean? Maybe a little phone call would be better.",
  };
  assertEquals(detectVenueConversationTouch(venue2), null);

  const venue3: VenueNotesRecord = {
    _id: "v-instr-3",
    name: "Todo Venue",
    notes: "Call to ask about live music.",
  };
  assertEquals(detectVenueConversationTouch(venue3), null);
});

Deno.test("detectVenueConversationTouch: ignores archived venues and empty notes", () => {
  const archived: VenueNotesRecord = {
    _id: "v-archived",
    name: "Archived Brewery",
    status: "archived",
    notes: "Spoke on the phone about a booking",
  };
  assertEquals(detectVenueConversationTouch(archived), null);

  const empty: VenueNotesRecord = {
    _id: "v-empty",
    name: "Empty Venue",
    notes: "   ",
  };
  assertEquals(detectVenueConversationTouch(empty), null);
});

Deno.test("hasExistingTouch: detects duplicate touch already present on venue", () => {
  const venue: VenueNotesRecord = {
    _id: "v-existing-1",
    name: "Existing Touch Venue",
    touches: [
      { type: "call", date: "2026-05-18T00:00:00.000Z" },
    ],
  };
  assertEquals(hasExistingTouch(venue, "call", "2026-05-18"), true);
  assertEquals(hasExistingTouch(venue, "call", "2026-05-19"), false);
  assertEquals(hasExistingTouch(venue, "visit", "2026-05-18"), false);
});

Deno.test("renderProposalsTable: renders aligned table and handles empty list", () => {
  const emptyOutput = renderProposalsTable([]);
  assertStringIncludes(emptyOutput, "No conversation touches proposed");

  const proposals: TouchProposal[] = [
    {
      venueId: "v1",
      venueName: "Apocalypse Ale Works",
      city: "Forest",
      usState: "VA",
      touchType: "call",
      date: "2026-05-18",
      sentence: "Phone call successful — confirmed.",
    },
    {
      venueId: "v2",
      venueName: "Big Lick Brewing Company",
      city: "Roanoke",
      usState: "VA",
      touchType: "visit",
      date: "2026-07-01",
      sentence: "Josh visited in person",
    },
  ];

  const tableOutput = renderProposalsTable(proposals);
  assertStringIncludes(tableOutput, "Apocalypse Ale Works");
  assertStringIncludes(tableOutput, "Forest, VA");
  assertStringIncludes(tableOutput, "call");
  assertStringIncludes(tableOutput, "2026-05-18");
  assertStringIncludes(tableOutput, "Big Lick Brewing Company");
  assertStringIncludes(tableOutput, "visit");
});

Deno.test("executeTouchConversion: dry-run mode proposes without writing to POST /venue/:id/touch", async () => {
  const fixtureVenues: VenueNotesRecord[] = [
    {
      _id: "v1",
      name: "Apocalypse Ale Works",
      city: "Forest",
      usState: "VA",
      notes: "Phone call successful — confirmed.",
    },
    {
      _id: "v2",
      name: "Hamlet Vineyards",
      city: "Bassett",
      usState: "VA",
      notes: "Date called: 2026-05-09",
    },
  ];

  let postCalls = 0;
  const mockFetch: typeof fetch = (_input, init) => {
    if (init?.method === "POST") {
      postCalls++;
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  };

  const result = await executeTouchConversion(
    {
      apply: false,
      venues: fixtureVenues,
    },
    mockFetch,
  );

  assertEquals(result.proposals.length, 1);
  assertEquals(result.proposals[0].venueName, "Apocalypse Ale Works");
  assertEquals(result.applied.length, 0);
  assertEquals(postCalls, 0, "Dry run must NOT make any POST /venue/:id/touch calls");
  assertStringIncludes(result.summary, "Dry run");
});

Deno.test("executeTouchConversion: apply mode writes only approved proposals via POST /venue/:id/touch", async () => {
  const fixtureVenues: VenueNotesRecord[] = [
    {
      _id: "v1",
      name: "Apocalypse Ale Works",
      city: "Forest",
      usState: "VA",
      notes: "Booking confirmation from May 18, 2026; Phone call successful — confirmed.",
    },
    {
      _id: "v2",
      name: "Big Lick Brewing Company",
      city: "Roanoke",
      usState: "VA",
      notes: "2026-07-01: Josh visited in person to drop off card.",
    },
    {
      _id: "v3",
      name: "Hamlet Vineyards",
      city: "Bassett",
      usState: "VA",
      notes: "Date called: 2026-05-09",
    },
  ];

  const postedRequests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const mockFetch: typeof fetch = (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      postedRequests.push({ url, body });
      return Promise.resolve(new Response(JSON.stringify({ _id: "touch-id" }), { status: 201 }));
    }
    return Promise.resolve(new Response(JSON.stringify(fixtureVenues), { status: 200 }));
  };

  const result = await executeTouchConversion(
    {
      apply: true,
      venues: fixtureVenues,
      actor: "Josh",
    },
    mockFetch,
  );

  assertEquals(result.proposals.length, 2);
  assertEquals(result.applied.length, 2);
  assertEquals(result.applied[0].success, true);
  assertEquals(result.applied[1].success, true);

  assertEquals(postedRequests.length, 2);
  assertEquals(postedRequests[0].url, "https://webjamsalem.herokuapp.com/venue/v1/touch");
  assertEquals(postedRequests[0].body.type, "call");
  assertEquals(postedRequests[0].body.date, "2026-05-18T00:00:00.000Z");
  assertEquals(postedRequests[0].body.actor, "Josh");

  assertEquals(postedRequests[1].url, "https://webjamsalem.herokuapp.com/venue/v2/touch");
  assertEquals(postedRequests[1].body.type, "visit");
  assertEquals(postedRequests[1].body.date, "2026-07-01T00:00:00.000Z");
});

Deno.test("executeTouchConversion: supports filtering and skipping venues", async () => {
  const fixtureVenues: VenueNotesRecord[] = [
    {
      _id: "v1",
      name: "Apocalypse Ale Works",
      city: "Forest",
      usState: "VA",
      notes: "Phone call successful — confirmed.",
    },
    {
      _id: "v2",
      name: "Big Lick Brewing Company",
      city: "Roanoke",
      usState: "VA",
      notes: "Josh visited in person",
    },
  ];

  const result = await executeTouchConversion(
    {
      apply: false,
      venues: fixtureVenues,
      filterVenues: ["Apocalypse"],
    },
    () => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
  );

  assertEquals(result.proposals.length, 1);
  assertEquals(result.proposals[0].venueName, "Apocalypse Ale Works");

  const skipResult = await executeTouchConversion(
    {
      apply: false,
      venues: fixtureVenues,
      skipVenues: ["Apocalypse"],
    },
    () => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
  );

  assertEquals(skipResult.proposals.length, 1);
  assertEquals(skipResult.proposals[0].venueName, "Big Lick Brewing Company");
});

Deno.test("executeTouchConversion: fetches live venues when venues option is omitted", async () => {
  const venuesData = [
    {
      _id: "v-live",
      name: "Live Brewery",
      notes: "Spoke on the phone about a 2027 booking",
    },
  ];

  // Array response
  const result1 = await executeTouchConversion(
    { apply: false },
    () => Promise.resolve(new Response(JSON.stringify(venuesData), { status: 200 })),
  );
  assertEquals(result1.proposals.length, 1);
  assertEquals(result1.proposals[0].venueName, "Live Brewery");

  // Object response ({ venues: [...] })
  const result2 = await executeTouchConversion(
    { apply: false },
    () => Promise.resolve(new Response(JSON.stringify({ venues: venuesData }), { status: 200 })),
  );
  assertEquals(result2.proposals.length, 1);

  // Network/HTTP error
  await assertRejects(
    () =>
      executeTouchConversion(
        { apply: false },
        () => Promise.resolve(new Response("Internal error", { status: 500 })),
      ),
    Error,
    "Failed to fetch venues",
  );
});

Deno.test("executeTouchConversion: handles touch write failure and network error in apply mode", async () => {
  const fixtureVenues: VenueNotesRecord[] = [
    {
      _id: "v-fail-http",
      name: "Fail Http Venue",
      notes: "2026-05-01: Phone call successful — confirmed.",
    },
    {
      _id: "v-fail-net",
      name: "Fail Network Venue",
      notes: "2026-05-02: Visited in person to drop off card.",
    },
  ];

  const mockFetch: typeof fetch = (input) => {
    const url = String(input);
    if (url.includes("v-fail-http")) {
      return Promise.resolve(new Response("DB Error", { status: 500 }));
    }
    if (url.includes("v-fail-net")) {
      return Promise.reject(new Error("Network connection dropped"));
    }
    return Promise.resolve(new Response(JSON.stringify(fixtureVenues), { status: 200 }));
  };

  const result = await executeTouchConversion(
    {
      apply: true,
      venues: fixtureVenues,
    },
    mockFetch,
  );

  assertEquals(result.applied.length, 2);
  assertEquals(result.applied[0].success, false);
  assertStringIncludes(result.applied[0].error!, "HTTP 500: DB Error");
  assertEquals(result.applied[1].success, false);
  assertStringIncludes(result.applied[1].error!, "Network connection dropped");
  assertStringIncludes(result.summary, "Successfully wrote 0 of 2");
});

Deno.test("detectVenueConversationTouch: skips proposal when venue already has identical touch", () => {
  const venueWithTouch: VenueNotesRecord = {
    _id: "v-has-touch",
    name: "Existing Ale Works",
    notes: "Booking confirmation from May 18, 2026; Phone call successful — confirmed.",
    touches: [
      {
        type: "call",
        date: "2026-05-18T00:00:00.000Z",
      },
    ],
  };

  const proposal = detectVenueConversationTouch(venueWithTouch);
  assertEquals(proposal, null, "Should not propose touch if already in venue.touches");
});

// --- Undated rows are never written (#1006 PR review) ---------------------

Deno.test("executeTouchConversion: apply mode never POSTs an undated row, reports it in skippedNoDate", async () => {
  const fixtureVenues: VenueNotesRecord[] = [
    {
      _id: "v-nodate",
      name: "No Date Brewery",
      notes: "Spoke on the phone about a 2027 booking",
    },
  ];

  let postCalls = 0;
  const mockFetch: typeof fetch = (_input, init) => {
    if (init?.method === "POST") postCalls++;
    return Promise.resolve(new Response(JSON.stringify(fixtureVenues), { status: 200 }));
  };

  const result = await executeTouchConversion(
    { apply: true, venues: fixtureVenues },
    mockFetch,
  );

  assertEquals(postCalls, 0, "An undated row must never be POSTed");
  assertEquals(result.applied.length, 0);
  assertEquals(result.skippedNoDate.length, 1);
  assertEquals(result.skippedNoDate[0].venueName, "No Date Brewery");
  assertStringIncludes(result.summary, "Skipped 1 undated row");
});

// --- --date <selector>=<YYYY-MM-DD> fills a missing date -------------------

Deno.test("executeTouchConversion: --date selector by venue id fills the date and writes on apply", async () => {
  const fixtureVenues: VenueNotesRecord[] = [
    {
      _id: "v-a",
      name: "A Brewery",
      notes: "Spoke on the phone about a 2027 booking",
    },
  ];

  const postedRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const mockFetch: typeof fetch = (input, init) => {
    if (init?.method === "POST") {
      postedRequests.push({ url: String(input), body: JSON.parse(String(init.body)) });
      return Promise.resolve(new Response(JSON.stringify({ _id: "touch-id" }), { status: 201 }));
    }
    return Promise.resolve(new Response(JSON.stringify(fixtureVenues), { status: 200 }));
  };

  const result = await executeTouchConversion(
    { apply: true, venues: fixtureVenues, dates: ["v-a=2026-06-01"] },
    mockFetch,
  );

  assertEquals(result.proposals[0].dateSuppliedByFlag, true);
  assertEquals(result.proposals[0].date, "2026-06-01");
  assertEquals(result.skippedNoDate.length, 0);
  assertEquals(postedRequests.length, 1);
  assertEquals(postedRequests[0].url, "https://webjamsalem.herokuapp.com/venue/v-a/touch");
  assertEquals(postedRequests[0].body.date, "2026-06-01T00:00:00.000Z");
});

Deno.test("executeTouchConversion: --date selector by stable row number fills the date and writes on apply", async () => {
  const fixtureVenues: VenueNotesRecord[] = [
    {
      _id: "v-1",
      name: "First Venue",
      notes: "Spoke on the phone about a 2027 booking",
    },
    {
      _id: "v-2",
      name: "Second Venue",
      notes: "Visited in person to say hi.",
    },
  ];

  const postedRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const mockFetch: typeof fetch = (input, init) => {
    if (init?.method === "POST") {
      postedRequests.push({ url: String(input), body: JSON.parse(String(init.body)) });
      return Promise.resolve(new Response(JSON.stringify({ _id: "touch-id" }), { status: 201 }));
    }
    return Promise.resolve(new Response(JSON.stringify(fixtureVenues), { status: 200 }));
  };

  const result = await executeTouchConversion(
    { apply: true, venues: fixtureVenues, dates: ["2=2026-06-02"] },
    mockFetch,
  );

  // Row 1 (First Venue) remains undated and unwritten; row 2 (Second Venue) gets the fill.
  assertEquals(result.skippedNoDate.length, 1);
  assertEquals(result.skippedNoDate[0].venueName, "First Venue");
  assertEquals(postedRequests.length, 1);
  assertEquals(postedRequests[0].url, "https://webjamsalem.herokuapp.com/venue/v-2/touch");
  assertEquals(postedRequests[0].body.type, "visit");
  assertEquals(postedRequests[0].body.date, "2026-06-02T00:00:00.000Z");

  const secondProposal = result.proposals.find((p) => p.venueId === "v-2");
  assertEquals(secondProposal?.dateSuppliedByFlag, true);
});

Deno.test("applyDateFills: throws on malformed entry, impossible date, and unmatched selector", () => {
  const proposals: TouchProposal[] = [
    {
      index: 1,
      venueId: "v1",
      venueName: "A Brewery",
      city: "",
      usState: "",
      touchType: "call",
      date: "",
      sentence: "x",
    },
  ];

  assertThrows(
    () => applyDateFills(proposals, ["no-equals-sign"]),
    Error,
    "Invalid --date entry",
  );
  assertThrows(
    () => applyDateFills(proposals, ["v1=2026-02-31"]),
    Error,
    "Invalid --date value",
  );
  assertThrows(
    () => applyDateFills(proposals, ["no-such-venue=2026-05-01"]),
    Error,
    "matched no proposed row",
  );
});

Deno.test("isValidIsoDate: accepts real calendar dates only", () => {
  assertEquals(isValidIsoDate("2026-05-18"), true);
  assertEquals(isValidIsoDate("2026-02-31"), false);
  assertEquals(isValidIsoDate("05/18/2026"), false);
  assertEquals(isValidIsoDate("not-a-date"), false);
});

// --- "spoke to/with <Name>" is case-sensitive on the name ------------------

Deno.test("isPhoneConversation: 'spoke with <lowercase>' is not a phone conversation, 'Spoke with <Name>' is", () => {
  assertEquals(isPhoneConversation("spoke with the owner"), false);
  assertEquals(isPhoneConversation("Spoke with Liza"), true);
});

Deno.test("detectVenueConversationTouch: 'Spoke with the manager while I was there.' is not classified as a call", () => {
  const venue: VenueNotesRecord = {
    _id: "v-manager",
    name: "Manager Venue",
    notes: "Spoke with the manager while I was there.",
  };
  assertEquals(detectVenueConversationTouch(venue), null);
});

// --- Legacy metadata is discarded per sentence, not per line ---------------

Deno.test("detectVenueConversationTouch: keeps the conversation sentence when legacy metadata shares a line", () => {
  const venue: VenueNotesRecord = {
    _id: "v-mixed-line",
    name: "Mixed Line Venue",
    notes: "Date called: 2026-05-09. Spoke on the phone with Liza about Sunday afternoons.",
  };

  const proposal = detectVenueConversationTouch(venue);
  assertNotEquals(proposal, null);
  assertEquals(proposal?.touchType, "call");
  assertEquals(proposal?.date, "2026-05-09");
  assertStringIncludes(proposal!.sentence, "Spoke on the phone with Liza");

  // The Hamlet Vineyards legacy-only case (no real conversation sentence) still yields null.
  const hamlet: VenueNotesRecord = {
    _id: "venue-hamlet-1",
    name: "Hamlet Vineyards",
    city: "Bassett",
    usState: "VA",
    notes:
      "Type of gig: Vineyard\nComments: Sent pitch email regarding Sunday afternoons 2026-05-09\nStatus (sheet): [S]\nDate called: 2026-05-09\nNotes: Sent pitch email regarding Sunday afternoons to va@hamletvineyards.com on 2026-05-09.\n\n[2026-07-22] Liza Crowder: 2026 music calendar is fully booked.",
  };
  assertEquals(detectVenueConversationTouch(hamlet), null);
});

// --- Stable numbering under --venues / --skip ------------------------------

Deno.test("executeTouchConversion: proposal index is stable across --skip, and the table reflects it", async () => {
  const fixtureVenues: VenueNotesRecord[] = [
    {
      _id: "v1",
      name: "Venue One",
      notes: "Phone call successful — confirmed. 2026-05-01",
    },
    {
      _id: "v2",
      name: "Venue Two",
      notes: "2026-06-01: Josh visited in person to drop off card.",
    },
    {
      _id: "v3",
      name: "Venue Three",
      notes: "Phone call successful — confirmed. 2026-07-01",
    },
  ];

  const result = await executeTouchConversion(
    { apply: false, venues: fixtureVenues, skipVenues: ["1"] },
    () => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
  );

  assertEquals(result.proposals.length, 2);
  assertEquals(result.proposals[0].venueName, "Venue Two");
  assertEquals(result.proposals[0].index, 2);
  assertEquals(result.proposals[1].venueName, "Venue Three");
  assertEquals(result.proposals[1].index, 3);

  const table = renderProposalsTable(result.proposals);
  assertStringIncludes(table, `│ ${String(2).padEnd(3)} │`);
  assertStringIncludes(table, `│ ${String(3).padEnd(3)} │`);
});

Deno.test("executeTouchConversion: --venues and --skip together still address the numbers in the table", async () => {
  const fixtureVenues: VenueNotesRecord[] = [
    { _id: "v1", name: "Venue One", notes: "2026-05-01: Phone call successful — confirmed." },
    { _id: "v2", name: "Venue Two", notes: "2026-06-01: Josh visited in person to drop off card." },
    { _id: "v3", name: "Venue Three", notes: "2026-07-01: Phone call successful — confirmed." },
    {
      _id: "v4",
      name: "Venue Four",
      notes: "2026-08-01: Josh visited in person to drop off card.",
    },
  ];

  // Josh reads rows 1-4, keeps 2, 3 and 4, then drops 4. Before the stable index, --skip filtered
  // on the position within the already-filtered list, so "4" matched nothing and Venue Four was
  // written anyway — the numbers no longer meant what the table showed.
  const result = await executeTouchConversion(
    {
      apply: false,
      venues: fixtureVenues,
      filterVenues: ["2", "3", "4"],
      skipVenues: ["4"],
    },
    () => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
  );

  assertEquals(result.proposals.map((p) => p.venueName), ["Venue Two", "Venue Three"]);
  assertEquals(result.proposals.map((p) => p.index), [2, 3]);
});

// --- A row an existing touch already covers is reported, not dropped -------

Deno.test("executeTouchConversion: an undated row an existing touch already covers is reported in suppressed, never proposed or POSTed", async () => {
  const fixtureVenues: VenueNotesRecord[] = [
    {
      _id: "v-suppressed",
      name: "Already Touched Venue",
      notes: "Spoke on the phone about a 2027 booking",
      touches: [
        { type: "call", date: "2026-01-01T00:00:00.000Z" },
      ],
    },
  ];

  let postCalls = 0;
  const mockFetch: typeof fetch = (_input, init) => {
    if (init?.method === "POST") postCalls++;
    return Promise.resolve(new Response(JSON.stringify(fixtureVenues), { status: 200 }));
  };

  const result = await executeTouchConversion(
    { apply: true, venues: fixtureVenues },
    mockFetch,
  );

  assertEquals(result.proposals.length, 0);
  assertEquals(result.suppressed.length, 1);
  assertEquals(result.suppressed[0].venueName, "Already Touched Venue");
  assertStringIncludes(result.suppressed[0].suppressed!, "already has a call touch");
  assertEquals(postCalls, 0);
});
