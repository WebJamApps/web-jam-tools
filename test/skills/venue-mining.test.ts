// test/skills/venue-mining.test.ts
// Unit tests for venue-mining Step 4 verification/enrichment, venueType inference,
// Step 5 proposal table rendering, and Step 6 POST /venue payload generation.
// References: Decision D-78 in ~/Dropbox/web-jam-llms/gig-outreach/gig-outreach-design-2026-09-18.md
import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { installSkills } from "../../src/install-skills/lib.ts";
import {
  buildCreateVenuePayload,
  CANONICAL_VENUE_TYPES,
  classifyVenueCandidate,
  formatProposalTable,
  inferVenueType,
  isCanonicalVenueType,
  isUsableStreetAddress,
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

Deno.test("isUsableStreetAddress validates physical addresses and rejects placeholders or PO boxes", () => {
  // Valid physical addresses
  assertEquals(isUsableStreetAddress("111 S Pollard St"), true);
  assertEquals(isUsableStreetAddress("2108 Broadway Ave SW"), true);
  assertEquals(isUsableStreetAddress("20 W Main St, Salem, VA 24153"), true);

  // Missing or non-string
  assertEquals(isUsableStreetAddress(""), false);
  assertEquals(isUsableStreetAddress("   "), false);
  assertEquals(isUsableStreetAddress(null), false);
  assertEquals(isUsableStreetAddress(undefined), false);
  assertEquals(isUsableStreetAddress(123), false);

  // Placeholders
  assertEquals(isUsableStreetAddress("TBD"), false);
  assertEquals(isUsableStreetAddress("tbd"), false);
  assertEquals(isUsableStreetAddress("N/A"), false);
  assertEquals(isUsableStreetAddress("n/a"), false);
  assertEquals(isUsableStreetAddress("NA"), false);
  assertEquals(isUsableStreetAddress("None"), false);
  assertEquals(isUsableStreetAddress("unknown"), false);
  assertEquals(isUsableStreetAddress("pending"), false);
  assertEquals(isUsableStreetAddress("-"), false);

  // PO Boxes
  assertEquals(isUsableStreetAddress("PO Box 42"), false);
  assertEquals(isUsableStreetAddress("P.O. Box 123"), false);
  assertEquals(isUsableStreetAddress("P.O. Box 123, Roanoke, VA"), false);
  assertEquals(isUsableStreetAddress("Post Office Box 789"), false);

  // Downtown without street address
  assertEquals(isUsableStreetAddress("Downtown Roanoke"), false);
  assertEquals(isUsableStreetAddress("downtown Salem, VA"), false);
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

  // 3. Ambiguous without resolver or fallback remains unresolved (D-78)
  const unresolvedResult = inferVenueType({ name: "Brewery and Cafe" });
  assertEquals(unresolvedResult.venueType, undefined);
  assertEquals(unresolvedResult.confidence, "unresolved");
  assertEquals(unresolvedResult.isFallback, false);
});

Deno.test("Step 4 fallback handling: unmatched venue names remain unresolved without resolver", () => {
  const unmatchedCandidate: MinedVenueCandidate = {
    name: "The Dark Room Studio",
  };
  const match = classifyVenueCandidate(unmatchedCandidate);
  assertEquals(match.type, null);
  assertMatch(match.reason, /no keyword match/i);

  const unresolvedResult = inferVenueType(unmatchedCandidate);
  assertEquals(unresolvedResult.venueType, undefined);
  assertEquals(unresolvedResult.confidence, "unresolved");
  assertEquals(unresolvedResult.isFallback, false);
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

  const table = formatProposalTable(candidates, { detailed: false });

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

Deno.test("Step 5 proposal table: detailed mode includes address and email source by default", () => {
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

  const detailedTable = formatProposalTable(candidates);
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

Deno.test("Step 6 buildCreateVenuePayload: throws when required fields are missing or invalid", () => {
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

  // Placeholder street address rejected
  assertThrows(
    () =>
      buildCreateVenuePayload({ name: "The Pub", city: "Roanoke", usState: "VA", address: "TBD" }),
    Error,
    "valid physical street address is required",
  );
  assertThrows(
    () =>
      buildCreateVenuePayload({ name: "The Pub", city: "Roanoke", usState: "VA", address: "N/A" }),
    Error,
    "valid physical street address is required",
  );

  // PO Box rejected
  assertThrows(
    () =>
      buildCreateVenuePayload({
        name: "The Pub",
        city: "Roanoke",
        usState: "VA",
        address: "PO Box 42",
      }),
    Error,
    "valid physical street address is required",
  );
  assertThrows(
    () =>
      buildCreateVenuePayload({
        name: "The Pub",
        city: "Roanoke",
        usState: "VA",
        address: "P.O. Box 100",
      }),
    Error,
    "valid physical street address is required",
  );

  // Unresolved venueType throws without silent fallback (D-78)
  assertThrows(
    () =>
      buildCreateVenuePayload({
        name: "The Dark Room Studio",
        city: "Roanoke",
        usState: "VA",
        address: "123 Main St",
      }),
    Error,
    "venueType' is required and could not be resolved",
  );

  // Preserves explicit venueType even on name without keyword match
  const explicitPayload = buildCreateVenuePayload({
    name: "The Dark Room Studio",
    city: "Roanoke",
    usState: "VA",
    address: "123 Main St",
    venueType: "Originals",
  });
  assertEquals(explicitPayload.venueType, "Originals");
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

  // Probed domain containing "website" without identity evidence MUST NOT bypass gate
  const probedWithWebsite = determineOutreachEligibility({
    name: "Cafe Website",
    email: "booking@cafewebsite.com",
    emailSource: "Probed domain (cafewebsite.com)",
  });
  assertEquals(probedWithWebsite.outreachEligible, false);
  assertEquals(probedWithWebsite.reason, "Probed domain requires verified venue identity");

  // Probed domain containing "website" with identity evidence -> true
  const probedWebsiteConfirmed = determineOutreachEligibility({
    name: "Cafe Website",
    email: "booking@cafewebsite.com",
    emailSource: "Probed domain (cafewebsite.com)",
    notes: "name+city match confirmed",
  });
  assertEquals(probedWebsiteConfirmed.outreachEligible, true);
  assertEquals(probedWebsiteConfirmed.reason, "Probed domain with confirmed identity");

  // Unknown or unverified email provenance -> false
  const unverified = determineOutreachEligibility({
    name: "Unknown Provenance",
    email: "music@unknown.com",
    emailSource: "unverified-scrape",
  });
  assertEquals(unverified.outreachEligible, false);
  assertMatch(unverified.reason, /requires verified source evidence/i);

  // Missing emailSource -> false
  const missingSource = determineOutreachEligibility({
    name: "No Source",
    email: "music@nosource.com",
  });
  assertEquals(missingSource.outreachEligible, false);
  assertMatch(missingSource.reason, /requires verified source evidence/i);

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

  // Placeholder address candidate ("TBD") -> skipped_missing_address
  const tbdResult = verifyAndEnrichVenue({
    name: "Twin Creeks Brewing",
    city: "Vinton",
    usState: "VA",
    address: "TBD",
    email: "booking@twincreeksbrewing.com",
    emailSource: "Venue website",
  });
  assertEquals(tbdResult.status, "skipped_missing_address");
  assertEquals(tbdResult.candidate.status, "Missing Address");
  assertMatch(tbdResult.skippedReason || "", /placeholder or PO Box/i);

  // PO Box address candidate -> skipped_missing_address
  const poBoxResult = verifyAndEnrichVenue({
    name: "Twin Creeks Brewing",
    city: "Vinton",
    usState: "VA",
    address: "PO Box 42",
    email: "booking@twincreeksbrewing.com",
    emailSource: "Venue website",
  });
  assertEquals(poBoxResult.status, "skipped_missing_address");
  assertEquals(poBoxResult.candidate.status, "Missing Address");
  assertMatch(poBoxResult.skippedReason || "", /placeholder or PO Box/i);

  // Unfit size candidate -> unfit_size
  const unfitResult = verifyAndEnrichVenue({
    name: "Roanoke Civic Center",
    address: "710 Williamson Rd",
  });
  assertEquals(unfitResult.status, "unfit_size");
  assertEquals(unfitResult.candidate.status, "Unfit Size");

  // Unmatched venueType with valid address is marked Ready with undefined venueType
  const unmatchedReady = verifyAndEnrichVenue({
    name: "The Dark Room Studio",
    city: "Roanoke",
    usState: "VA",
    address: "123 Main St",
    email: "info@darkroomstudio.com",
    emailSource: "Venue website",
  });
  assertEquals(unmatchedReady.status, "ready");
  assertEquals(unmatchedReady.venueType, undefined);
  assertEquals(unmatchedReady.candidate.status, "Ready");
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
      website: "https://twincreeksbrewing.com",
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

  // Evidence columns required by Step 5
  assertMatch(result.proposalTable, /Address/);
  assertMatch(result.proposalTable, /Email Source/);
  assertMatch(result.proposalTable, /Website/);
  assertMatch(result.proposalTable, /111 S Pollard St/);
  assertMatch(result.proposalTable, /Venue website/);
  assertMatch(result.proposalTable, /https:\/\/twincreeksbrewing\.com/);
});

Deno.test("Acceptance Criterion 5: skill symlinks install and resolve across Claude Code and agy surfaces in isolation", async () => {
  const repoDir = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
  const tempDir = await Deno.makeTempDir({ prefix: "venue_mining_symlink_test_" });
  try {
    const claudeDest = join(tempDir, "claude-skills");
    const agyDest = join(tempDir, "agy-skills");
    const claudeBackupDest = join(tempDir, "claude-backups");
    const agyBackupDest = join(tempDir, "agy-backups");

    await installSkills({
      repoDir,
      claudeDest,
      agyDest,
      claudeBackupDest,
      agyBackupDest,
      allowNonCanonical: true,
      allowUnsafeForTesting: true,
      quiet: true,
    });

    const claudeSymlink = join(claudeDest, "venue-mining");
    const claudeStat = Deno.lstatSync(claudeSymlink);
    assertEquals(claudeStat.isSymlink, true, `Expected ${claudeSymlink} to be a symlink`);
    const claudeTarget = Deno.readLinkSync(claudeSymlink);
    assertMatch(claudeTarget, /skills\/venue-mining/);

    const agySymlink = join(agyDest, "venue-mining");
    const agyStat = Deno.lstatSync(agySymlink);
    assertEquals(agyStat.isSymlink, true, `Expected ${agySymlink} to be a symlink`);
    const agyTarget = Deno.readLinkSync(agySymlink);
    assertMatch(agyTarget, /skills\/venue-mining/);
  } finally {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
});
