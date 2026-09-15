// test/book_gig_touch_conversion.test.ts
// Unit tests for converting venue notes into structured call and visit touches (D-68 / web-jam-tools#1006)

import { assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  detectVenueConversationTouch,
  executeTouchConversion,
  extractDateFromText,
  hasExistingTouch,
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
      notes: "Phone call successful — confirmed.",
    },
    {
      _id: "v-fail-net",
      name: "Fail Network Venue",
      notes: "Visited in person to drop off card.",
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
