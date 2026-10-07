// test/skills/venue-mining.test.ts
// Unit tests for venue-mining Step 4 verification/enrichment, venueType inference,
// Step 5 proposal table rendering, and Step 6 POST /venue payload generation.
// References: Decision D-78 in ~/Dropbox/web-jam-llms/gig-outreach/gig-outreach-design-2026-09-18.md
import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import {
  buildCreateVenuePayload,
  CANONICAL_VENUE_TYPES,
  classifyVenueCandidate,
  formatProposalTable,
  inferVenueType,
  isCanonicalVenueType,
  type MinedVenueCandidate,
} from "../../skills/venue-mining/venue-mining-core.ts";
import {
  checkSizeFit,
  determineOutreachEligibility,
  verifyAndEnrichCandidates,
  verifyAndEnrichVenue,
} from "../../skills/venue-mining/verify.ts";

Deno.test("CANONICAL_VENUE_TYPES contains the three backend enums", () => {
  assertEquals(CANONICAL_VENUE_TYPES, [
    "PubFestivalBrewery",
    "MidRangeCafeBar",
    "Originals",
  ]);
  assertEquals(isCanonicalVenueType("PubFestivalBrewery"), true);
  assertEquals(isCanonicalVenueType("MidRangeCafeBar"), true);
  assertEquals(isCanonicalVenueType("Originals"), true);
  assertEquals(isCanonicalVenueType("Unknown"), false);
  assertEquals(isCanonicalVenueType(null), false);
  assertEquals(isCanonicalVenueType(undefined), false);
});

Deno.test("Step 4 heuristic rules: infers PubFestivalBrewery from name keywords", () => {
  const candidates: Array<{ name: string; keyword: string }> = [
    { name: "Twin Creeks Brewing Company", keyword: "brewing" },
    { name: "Olde Salem Brewery", keyword: "brewery" },
    { name: "Golden Cactus Beer Co", keyword: "beer" },
    { name: "Big Lick Ciderworks", keyword: "ciderworks" },
    { name: "Flying Mouse Tavern", keyword: "tavern" },
    { name: "Parkway Taphouse", keyword: "taphouse" },
    { name: "Mac & Bob's Pub", keyword: "pub" },
    { name: "Chateau Morrisette Winery", keyword: "winery" },
    { name: "Valhalla Vineyards", keyword: "vineyard" },
    { name: "Franklin County Distilling", keyword: "distilling" },
    { name: "Floyd Music Festival", keyword: "festival" },
    { name: "Roanoke Farmers Market", keyword: "market" },
    { name: "Blue Ridge Biergarten", keyword: "biergarten" },
  ];

  for (const { name } of candidates) {
    const candidate: MinedVenueCandidate = { name, city: "Roanoke", usState: "VA" };
    const result = inferVenueType(candidate);
    assertEquals(
      result.venueType,
      "PubFestivalBrewery",
      `Expected "${name}" to be classified as PubFestivalBrewery, got ${result.venueType}`,
    );
    assertEquals(result.isFallback, false);
    assertEquals(result.confidence, "high");
  }
});

Deno.test("Step 4 heuristic rules: infers MidRangeCafeBar from name keywords", () => {
  const candidates = [
    "Sweet Donkey Coffee",
    "Roanoke Valley Cafe",
    "Mill Mountain Coffeehouse",
    "Downtown Bistro",
    "Corner Bar & Grill",
    "Village Grill",
    "River and Rail Restaurant",
    "City Center Diner",
    "Breadcraft Bakery",
    "Blue Apron Kitchen",
    "Benny Adelina's Pizzeria",
    "Montano's International Restaurant",
    "Sidecar Lounge",
  ];

  for (const name of candidates) {
    const candidate: MinedVenueCandidate = { name, city: "Roanoke", usState: "VA" };
    const result = inferVenueType(candidate);
    assertEquals(
      result.venueType,
      "MidRangeCafeBar",
      `Expected "${name}" to be classified as MidRangeCafeBar, got ${result.venueType}`,
    );
    assertEquals(result.isFallback, false);
    assertEquals(result.confidence, "high");
  }
});

Deno.test("Step 4 heuristic rules: infers Originals from name keywords", () => {
  const candidates = [
    "The Spot Listening Room",
    "Harvester Acoustic Stage",
    "Jefferson Music Hall",
    "Songwriter Stage Roanoke",
    "Acoustic Showcase Room",
  ];

  for (const name of candidates) {
    const candidate: MinedVenueCandidate = { name, city: "Rocky Mount", usState: "VA" };
    const result = inferVenueType(candidate);
    assertEquals(
      result.venueType,
      "Originals",
      `Expected "${name}" to be classified as Originals, got ${result.venueType}`,
    );
    assertEquals(result.isFallback, false);
    assertEquals(result.confidence, "high");
  }
});

Deno.test("Step 4 heuristic rules: infers venueType from description, notes, and genre", () => {
  // Description matching PubFestivalBrewery
  // Description matching PubFestivalBrewery
  const breweryCandidate: MinedVenueCandidate = {
    name: "The Barrel Room",
    description: "Craft brewery with a rotating selection of local beers and ciders on tap.",
  };
  assertEquals(inferVenueType(breweryCandidate).venueType, "PubFestivalBrewery");

  // Notes matching MidRangeCafeBar
  const pureCafeCandidate: MinedVenueCandidate = {
    name: "Morning Glory",
    notes: "Local neighborhood cafe and bakery serving specialty roasts and pastries.",
  };
  assertEquals(inferVenueType(pureCafeCandidate).venueType, "MidRangeCafeBar");

  // Genre matching Originals
  const originalsCandidate: MinedVenueCandidate = {
    name: "The Alley Space",
    genre: ["Originals", "Acoustic"],
  };
  assertEquals(inferVenueType(originalsCandidate).venueType, "Originals");
});

Deno.test("Step 4 pre-set canonical venueType is preserved without modification", () => {
  const candidate: MinedVenueCandidate = {
    name: "Sweet Donkey Coffee",
    venueType: "PubFestivalBrewery", // intentionally pre-set differently
  };
  const result = inferVenueType(candidate);
  assertEquals(result.venueType, "PubFestivalBrewery");
  assertEquals(result.isFallback, false);
  assertEquals(result.confidence, "high");
});

Deno.test("Step 4 fallback handling: ambiguous / competing categories trigger fallback", () => {
  // Venue whose name matches both Cafe and Brewery
  const match1 = classifyVenueCandidate({ name: "Brewery and Cafe" });
  assertEquals(match1.type, null);
  assertMatch(match1.reason, /competing categories/i);

  // 1. With contextual LLM resolver
  const contextualResult = inferVenueType({ name: "Brewery and Cafe" }, {
    contextualResolver: (c) =>
      c.name.includes("Brewery") ? "PubFestivalBrewery" : "MidRangeCafeBar",
  });
  assertEquals(contextualResult.venueType, "PubFestivalBrewery");
  assertEquals(contextualResult.confidence, "contextual");
  assertEquals(contextualResult.isFallback, true);

  // 2. With configured fallbackType
  const configuredResult = inferVenueType({ name: "Brewery and Cafe" }, {
    fallbackType: "Originals",
  });
  assertEquals(configuredResult.venueType, "Originals");
  assertEquals(configuredResult.confidence, "fallback");
  assertEquals(configuredResult.isFallback, true);

  // 3. Default fallback: MidRangeCafeBar
  const defaultResult = inferVenueType({ name: "Brewery and Cafe" });
  assertEquals(defaultResult.venueType, "MidRangeCafeBar");
  assertEquals(defaultResult.confidence, "fallback");
  assertEquals(defaultResult.isFallback, true);
});

Deno.test("Step 4 fallback handling: unmatched venue names trigger fallback", () => {
  const unmatchedCandidate: MinedVenueCandidate = {
    name: "The Dark Room Studio",
  };
  const match = classifyVenueCandidate(unmatchedCandidate);
  assertEquals(match.type, null);
  assertMatch(match.reason, /no keyword match/i);

  const defaultResult = inferVenueType(unmatchedCandidate);
  assertEquals(defaultResult.venueType, "MidRangeCafeBar");
  assertEquals(defaultResult.confidence, "fallback");
  assertEquals(defaultResult.isFallback, true);
});

Deno.test("Step 5 proposal table: renders inferred venueType in dedicated column", () => {
  const candidates: MinedVenueCandidate[] = [
    {
      name: "Twin Creeks Brewing",
      city: "Vinton",
      usState: "VA",
      venueType: "PubFestivalBrewery",
      email: "booking@twincreeksbrewing.com",
      phone: "(540) 266-7999",
      address: "111 S Pollard St",
      status: "Ready",
    },
    {
      name: "Sweet Donkey Coffee",
      city: "Roanoke",
      usState: "VA",
      venueType: "MidRangeCafeBar",
      email: "music@sweetdonkeycoffee.com",
      phone: "(540) 581-1100",
      address: "2108 Broadway Ave SW",
      status: "Ready",
    },
  ];

  const table = formatProposalTable(candidates);

  // Checks header column
  assertMatch(
    table,
    /\| # \| Venue Name \| City, ST \| Type \| Booking Email \| Phone \| Status \|/,
  );
  // Checks venueType rows
  assertMatch(
    table,
    /\| 1 \| Twin Creeks Brewing \| Vinton, VA \| `PubFestivalBrewery` \| booking@twincreeksbrewing\.com \| \(540\) 266-7999 \| Ready \|/,
  );
  assertMatch(
    table,
    /\| 2 \| Sweet Donkey Coffee \| Roanoke, VA \| `MidRangeCafeBar` \| music@sweetdonkeycoffee\.com \| \(540\) 581-1100 \| Ready \|/,
  );
});

Deno.test("Step 5 proposal table: detailed mode includes address and email source", () => {
  const candidates: MinedVenueCandidate[] = [
    {
      name: "Twin Creeks Brewing",
      city: "Vinton",
      usState: "VA",
      address: "111 S Pollard St",
      venueType: "PubFestivalBrewery",
      email: "booking@twincreeksbrewing.com",
      emailSource: "Google Maps website",
      phone: "(540) 266-7999",
      website: "https://twincreeksbrewing.com",
      status: "Ready",
    },
  ];

  const detailedTable = formatProposalTable(candidates, { detailed: true });
  assertMatch(
    detailedTable,
    /\| # \| Venue Name \| City, ST \| Address \| Type \| Booking Email \| Email Source \| Phone \| Website \| Status \|/,
  );
  assertMatch(detailedTable, /111 S Pollard St/);
  assertMatch(detailedTable, /`PubFestivalBrewery`/);
  assertMatch(detailedTable, /Google Maps website/);
});

Deno.test("Step 6 buildCreateVenuePayload: successfully builds valid payload with venueType", () => {
  const candidate: MinedVenueCandidate = {
    name: "Twin Creeks Brewing",
    city: "Vinton",
    usState: "VA",
    address: "111 S Pollard St",
    email: "booking@twincreeksbrewing.com",
    phone: "(540) 266-7999",
    website: "https://twincreeksbrewing.com",
    venueType: "PubFestivalBrewery",
    outreachEligible: true,
    notes: "Mined via venue-mining metro sweep on 2026-09-24",
  };

  const payload = buildCreateVenuePayload(candidate);

  assertEquals(payload.name, "Twin Creeks Brewing");
  assertEquals(payload.city, "Vinton");
  assertEquals(payload.usState, "VA");
  assertEquals(payload.address, "111 S Pollard St");
  assertEquals(payload.venueType, "PubFestivalBrewery");
  assertEquals(payload.outreachEligible, true);
  assertEquals(payload.email, "booking@twincreeksbrewing.com");
  assertEquals(payload.phone, "(540) 266-7999");
  assertEquals(payload.website, "https://twincreeksbrewing.com");
  assertEquals(payload.notes, "Mined via venue-mining metro sweep on 2026-09-24");
});

Deno.test("Step 6 buildCreateVenuePayload: infers venueType if not pre-set", () => {
  const candidate: MinedVenueCandidate = {
    name: "Sweet Donkey Coffee",
    city: "Roanoke",
    usState: "VA",
    address: "2108 Broadway Ave SW",
  };

  const payload = buildCreateVenuePayload(candidate);
  assertEquals(payload.venueType, "MidRangeCafeBar");
});

Deno.test("Step 6 buildCreateVenuePayload: throws when required fields are missing", () => {
  // Missing name
  assertThrows(
    () =>
      buildCreateVenuePayload({ name: "", city: "Roanoke", usState: "VA", address: "123 Main St" }),
    Error,
    "name' is required",
  );

  // Missing city
  assertThrows(
    () =>
      buildCreateVenuePayload({ name: "The Pub", city: "", usState: "VA", address: "123 Main St" }),
    Error,
    "city' is required",
  );

  // Missing usState
  assertThrows(
    () =>
      buildCreateVenuePayload({
        name: "The Pub",
        city: "Roanoke",
        usState: "",
        address: "123 Main St",
      }),
    Error,
    "usState' is required",
  );

  // Missing street address (mandatory per SKILL.md)
  assertThrows(
    () => buildCreateVenuePayload({ name: "The Pub", city: "Roanoke", usState: "VA", address: "" }),
    Error,
    "street address is required",
  );
});

Deno.test("Candidate verification pipeline: checkSizeFit rejects unfit venues", () => {
  assertEquals(checkSizeFit({ name: "Berglund Center Coliseum" }).fit, false);
  assertEquals(checkSizeFit({ name: "Elmwood Park Amphitheater" }).fit, false);
  assertEquals(checkSizeFit({ name: "Salem Civic Center" }).fit, false);
  assertEquals(checkSizeFit({ name: "Salem Memorial Stadium" }).fit, false);
  assertEquals(checkSizeFit({ name: "Twin Creeks Brewing" }).fit, true);
});

Deno.test("Candidate verification pipeline: determineOutreachEligibility rules", () => {
  // Published link source -> true
  assertEquals(
    determineOutreachEligibility({
      name: "Twin Creeks",
      email: "booking@twincreeksbrewing.com",
      emailSource: "Google Maps website",
    }).outreachEligible,
    true,
  );

  // Wrong-purpose email -> false
  assertEquals(
    determineOutreachEligibility({
      name: "Twin Creeks",
      email: "catering@twincreeksbrewing.com",
      emailSource: "Google Maps website",
    }).outreachEligible,
    false,
  );

  // Probed domain without confirmed identity -> false
  assertEquals(
    determineOutreachEligibility({
      name: "Roanoke Taproom",
      email: "info@roanoketaproom.beer",
      emailSource: "Probed domain (roanoketaproom.beer)",
    }).outreachEligible,
    false,
  );

  // Probed domain with confirmed identity in notes -> true
  assertEquals(
    determineOutreachEligibility({
      name: "Roanoke Taproom",
      email: "info@roanoketaproom.beer",
      emailSource: "Probed domain (roanoketaproom.beer)",
      notes: "identity-confirmed via address match",
    }).outreachEligible,
    true,
  );

  // No email -> false
  assertEquals(
    determineOutreachEligibility({
      name: "Twin Creeks",
      email: "",
    }).outreachEligible,
    false,
  );
});

Deno.test("Candidate verification pipeline: verifyAndEnrichVenue separates ready and skipped", () => {
  // Ready candidate with address
  const readyResult = verifyAndEnrichVenue({
    name: "Twin Creeks Brewing",
    city: "Vinton",
    usState: "VA",
    address: "111 S Pollard St",
    email: "booking@twincreeksbrewing.com",
    emailSource: "Venue website",
  });
  assertEquals(readyResult.status, "ready");
  assertEquals(readyResult.venueType, "PubFestivalBrewery");
  assertEquals(readyResult.outreachEligible, true);
  assertEquals(readyResult.candidate.status, "Ready");

  // Missing address candidate -> skipped
  const missingAddressResult = verifyAndEnrichVenue({
    name: "Twin Creeks Brewing",
    city: "Vinton",
    usState: "VA",
    email: "booking@twincreeksbrewing.com",
  });
  assertEquals(missingAddressResult.status, "skipped_missing_address");
  assertEquals(missingAddressResult.candidate.status, "Missing Address");
  assertMatch(missingAddressResult.skippedReason || "", /street address/i);

  // Unfit size candidate -> unfit_size
  const unfitResult = verifyAndEnrichVenue({
    name: "Roanoke Civic Center",
    address: "710 Williamson Rd",
  });
  assertEquals(unfitResult.status, "unfit_size");
  assertEquals(unfitResult.candidate.status, "Unfit Size");
});

Deno.test("Candidate verification pipeline: verifyAndEnrichCandidates batch processing", () => {
  const batch: MinedVenueCandidate[] = [
    {
      name: "Twin Creeks Brewing",
      city: "Vinton",
      usState: "VA",
      address: "111 S Pollard St",
      email: "booking@twincreeksbrewing.com",
      emailSource: "Venue website",
    },
    {
      name: "Sweet Donkey Coffee",
      city: "Roanoke",
      usState: "VA",
      address: "2108 Broadway Ave SW",
      email: "music@sweetdonkeycoffee.com",
      emailSource: "Venue website",
    },
    {
      name: "Skipped Venue Without Address",
      city: "Roanoke",
      usState: "VA",
      email: "info@skipped.com",
    },
  ];

  const result = verifyAndEnrichCandidates(batch);
  assertEquals(result.total, 3);
  assertEquals(result.ready.length, 2);
  assertEquals(result.skipped.length, 1);
  assertEquals(result.ready[0].venueType, "PubFestivalBrewery");
  assertEquals(result.ready[1].venueType, "MidRangeCafeBar");
  assertMatch(result.proposalTable, /Twin Creeks Brewing/);
  assertMatch(result.proposalTable, /`PubFestivalBrewery`/);
  assertMatch(result.proposalTable, /Sweet Donkey Coffee/);
  assertMatch(result.proposalTable, /`MidRangeCafeBar`/);
});

Deno.test("Acceptance Criterion 5: skill symlinks resolve across Claude Code and agy surfaces", () => {
  const home = Deno.env.get("HOME");
  if (!home) return;

  const claudeSymlink = `${home}/.claude/skills/venue-mining`;
  const agySymlink = `${home}/.gemini/config/plugins/webjam-tasks/skills/venue-mining`;

  try {
    const claudeStat = Deno.lstatSync(claudeSymlink);
    assertEquals(claudeStat.isSymlink, true, `Expected ${claudeSymlink} to be a symlink`);
    const claudeTarget = Deno.readLinkSync(claudeSymlink);
    assertMatch(claudeTarget, /skills\/venue-mining/);
  } catch (err: unknown) {
    throw new Error(`Claude Code skill symlink check failed: ${err}`);
  }

  try {
    const agyStat = Deno.lstatSync(agySymlink);
    assertEquals(agyStat.isSymlink, true, `Expected ${agySymlink} to be a symlink`);
    const agyTarget = Deno.readLinkSync(agySymlink);
    assertMatch(agyTarget, /skills\/venue-mining/);
  } catch (err: unknown) {
    throw new Error(`agy/Antigravity skill symlink check failed: ${err}`);
  }
});
