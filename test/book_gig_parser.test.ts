// test/book_gig_parser.test.ts — Dedicated unit tests for /book-gig date & location parsing

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  DEFAULT_SEARCH_CITIES,
  FAMILY_CITIES,
  getDefaultLocation,
  matchesVenueFilter,
  parseBookGigArgs,
  parseLocation,
  parseTargetWeekend,
} from "../src/book-gig/parser.ts";
import { filterAndRankCandidates } from "../src/book-gig/candidates.ts";
import type { CandidateVenue } from "../src/book-gig/types.ts";

Deno.test("parseBookGigArgs: splits CLI arguments without splitting numeric 4-digit years into location", () => {
  // Acceptance criterion 1: ["Oct", "16-18", "2026"]
  const res1 = parseBookGigArgs(["Oct", "16-18", "2026"]);
  assertEquals(res1.mode, "preview");
  assertEquals(res1.weekend?.year, 2026);
  assertEquals(res1.weekend?.start, "2026-10-16");
  assertEquals(res1.weekend?.end, "2026-10-18");
  assertEquals(res1.location, undefined);

  // Acceptance criterion 1: ["Oct 16-18 2026"]
  const res2 = parseBookGigArgs(["Oct 16-18 2026"]);
  assertEquals(res2.mode, "preview");
  assertEquals(res2.weekend?.year, 2026);
  assertEquals(res2.weekend?.start, "2026-10-16");
  assertEquals(res2.weekend?.end, "2026-10-18");
  assertEquals(res2.location, undefined);

  // Natural full name: ["October 16-18, 2026"]
  const res3 = parseBookGigArgs(["October 16-18, 2026"]);
  assertEquals(res3.weekend?.year, 2026);
  assertEquals(res3.weekend?.start, "2026-10-16");
  assertEquals(res3.location, undefined);

  // Weekend with location tokens: ["Oct", "16-18", "2026", "Lynchburg,", "VA"]
  const res4 = parseBookGigArgs(["Oct", "16-18", "2026", "Lynchburg,", "VA"]);
  assertEquals(res4.weekend?.year, 2026);
  assertEquals(res4.weekend?.start, "2026-10-16");
  assertEquals(res4.location?.city, "Lynchburg");
  assertEquals(res4.location?.state, "VA");

  // Single compound string: ["Oct 16-18 2026 Lynchburg, VA"]
  const res5 = parseBookGigArgs(["Oct 16-18 2026 Lynchburg, VA"]);
  assertEquals(res5.weekend?.year, 2026);
  assertEquals(res5.location?.city, "Lynchburg");

  // ISO date with 5-digit zip: ["2026-10-16", "24502"]
  const res6 = parseBookGigArgs(["2026-10-16", "24502"]);
  assertEquals(res6.weekend?.year, 2026);
  assertEquals(res6.weekend?.start, "2026-10-16");
  assertEquals(res6.location?.zip, "24502");
  assertEquals(res6.location?.city, "Lynchburg");
});

Deno.test("parseBookGigArgs: parses explicit flags and options", () => {
  // --send flag
  const res1 = parseBookGigArgs(["--send", "Oct 16-18 2026", "--location", "Salem, VA"]);
  assertEquals(res1.mode, "send");
  assertEquals(res1.weekend?.year, 2026);
  assertEquals(res1.location?.city, "Salem");

  // --replies flag
  const res2 = parseBookGigArgs(["--replies", "Oct 16-18 2026"]);
  assertEquals(res2.mode, "replies");
  assertEquals(res2.weekend?.year, 2026);
  assertEquals(res2.location, undefined);

  // --no-open and venue filters
  const res3 = parseBookGigArgs([
    "--send",
    "Oct 16-18 2026",
    "--no-open",
    "--venues",
    "v1,v2",
    "--skip",
    "v3",
  ]);
  assertEquals(res3.mode, "send");
  assertEquals(res3.noOpen, true);
  assertEquals(res3.includeVenues, ["v1", "v2"]);
  assertEquals(res3.excludeVenues, ["v3"]);
});

Deno.test("parseBookGigArgs: parses --venue as single target alias in --send mode", () => {
  const res = parseBookGigArgs(["--send", "Oct 16-18 2026", "--venue", "Twin Creeks"]);
  assertEquals(res.mode, "send");
  assertEquals(res.includeVenues, ["Twin Creeks"]);
});

Deno.test("parseLocation: rejects numeric year and arbitrary non-zip numbers (Acceptance Criterion 2)", () => {
  assertEquals(parseLocation("2026"), null);
  assertEquals(parseLocation("2027"), null);
  assertEquals(parseLocation("123"), null);
  assertEquals(parseLocation("999999"), null);
  assertEquals(parseLocation("2026-10-16"), null);
  assertEquals(parseLocation(""), null);
  assertEquals(parseLocation("   "), null);
  assertEquals(parseLocation(undefined), null);
});

Deno.test("parseLocation: parses valid 5-digit zipcodes and known metros", () => {
  const loc1 = parseLocation("24502");
  assertEquals(loc1?.zip, "24502");
  assertEquals(loc1?.city, "Lynchburg");
  assertEquals(loc1?.state, "VA");
  assertEquals(loc1?.metroSlug, "lynchburg");

  const loc2 = parseLocation("24153");
  assertEquals(loc2?.zip, "24153");
  assertEquals(loc2?.city, "Salem");
  assertEquals(loc2?.state, "VA");

  // Newly mapped towns: Pembroke, Pulaski, Wirtz, Huddleston
  const locPembroke = parseLocation("24136");
  assertEquals(locPembroke?.city, "Pembroke");
  assertEquals(locPembroke?.metroSlug, "blacksburg-christiansburg");

  const locPulaski = parseLocation("24301");
  assertEquals(locPulaski?.city, "Pulaski");
  assertEquals(locPulaski?.metroSlug, "blacksburg-christiansburg");

  const locWirtz = parseLocation("24184");
  assertEquals(locWirtz?.city, "Wirtz");
  assertEquals(locWirtz?.metroSlug, "roanoke-salem");

  const locHuddleston = parseLocation("24104");
  assertEquals(locHuddleston?.city, "Huddleston");
  assertEquals(locHuddleston?.metroSlug, "roanoke-salem");

  // Unknown zip returns zip object without metro mapping
  const loc3 = parseLocation("90210");
  assertEquals(loc3?.zip, "90210");
  assertEquals(loc3?.city, undefined);
});

Deno.test("parseLocation: parses City, State and multi-city expressions", () => {
  const loc1 = parseLocation("Lynchburg, VA");
  assertEquals(loc1?.city, "Lynchburg");
  assertEquals(loc1?.state, "VA");
  assertEquals(loc1?.metroSlug, "lynchburg");

  const loc2 = parseLocation(
    "Lynchburg, Blacksburg, Martinsville, Salem, Roanoke, and surrounding areas",
  );
  assert(loc2 !== null);
  assertEquals(loc2.cities, ["Lynchburg", "Blacksburg", "Martinsville", "Salem", "Roanoke"]);
  assertEquals(loc2.includeSurrounding, true);
  assert(loc2.surroundingCities !== undefined);
  assert(loc2.surroundingCities.includes("Forest"));
  assert(loc2.surroundingCities.includes("Floyd"));
  assert(loc2.surroundingCities.includes("Radford"));
  assert(loc2.surroundingCities.includes("Christiansburg"));
  assert(loc2.surroundingCities.includes("Pembroke"));
  assert(loc2.surroundingCities.includes("Pulaski"));
  assert(loc2.surroundingCities.includes("Giles"));
  assert(loc2.surroundingCities.includes("Wirtz"));
  assert(loc2.surroundingCities.includes("Huddleston"));
  assert(loc2.surroundingCities.includes("Axton"));
  assert(loc2.surroundingCities.includes("Ridgeway"));
  assert(loc2.surroundingCities.includes("Fieldale"));
  assertEquals(loc2.surroundingCities.includes("Marion"), false);

  // Dynamic multi-city in NC
  const loc3 = parseLocation("Charlotte, Gastonia, Belmont");
  assert(loc3 !== null);
  assertEquals(loc3.cities, ["Charlotte", "Gastonia", "Belmont"]);
  assertEquals(loc3.city, "Charlotte");

  // Dynamic multi-city in Shenandoah
  const loc4 = parseLocation("Harrisonburg, Staunton, Charlottesville");
  assert(loc4 !== null);
  assertEquals(loc4.cities, ["Harrisonburg", "Staunton", "Charlottesville"]);
  assertEquals(loc4.city, "Harrisonburg");
});

Deno.test("parseTargetWeekend: parses valid weekend formats and throws on invalid", () => {
  const w1 = parseTargetWeekend("Oct 16-18 2026");
  assertEquals(w1.year, 2026);
  assertEquals(w1.month, 10);
  assertEquals(w1.start, "2026-10-16");
  assertEquals(w1.end, "2026-10-18");

  const w2 = parseTargetWeekend("2026-10-16 to 2026-10-18");
  assertEquals(w2.year, 2026);
  assertEquals(w2.start, "2026-10-16");
  assertEquals(w2.end, "2026-10-18");

  // Throws on non-date or extra trailing text
  assertThrows(() => parseTargetWeekend("2026"));
  assertThrows(() => parseTargetWeekend(""));
  assertThrows(() => parseTargetWeekend("Oct 16-18 2026 Lynchburg, VA"));
});

Deno.test("matchesVenueFilter: matches by id or name case-insensitively", () => {
  const venue: CandidateVenue = {
    _id: "v123",
    name: "Olde Salem Brewing Company",
    city: "Salem",
    usState: "VA",
  };

  assertEquals(matchesVenueFilter(venue, ["v123"]), true);
  assertEquals(matchesVenueFilter(venue, ["V123"]), true);
  assertEquals(matchesVenueFilter(venue, ["Olde Salem Brewing Company"]), true);
  assertEquals(matchesVenueFilter(venue, ["olde salem brewing company"]), true);
  assertEquals(matchesVenueFilter(venue, ["oldesalembrewingcompany"]), true);
  assertEquals(matchesVenueFilter(venue, ["other-venue"]), false);
  assertEquals(matchesVenueFilter(venue, []), false);
});

Deno.test("FAMILY_CITIES and DEFAULT_SEARCH_CITIES: export family cities and default regional metros", () => {
  assertEquals(FAMILY_CITIES, [
    "Salem",
    "Roanoke",
    "Martinsville",
    "Lynchburg",
    "Gastonia",
    "Rock Hill",
    "Harrisonburg",
  ]);

  assertEquals(DEFAULT_SEARCH_CITIES, [
    "Salem",
    "Roanoke",
    "Martinsville",
    "Lynchburg",
    "Blacksburg",
    "Christiansburg",
    "Gastonia",
    "Rock Hill",
    "Harrisonburg",
  ]);
});

Deno.test("getDefaultLocation: returns default regional location with family cities and surrounding areas", () => {
  const loc = getDefaultLocation();
  assertEquals(loc.raw, "All Regional Metros (~3.5h drive)");
  assertEquals(loc.includeSurrounding, true);
  assertEquals(loc.cities, Array.from(DEFAULT_SEARCH_CITIES));
  assert(loc.surroundingCities !== undefined);

  // Core surrounding neighbors from METRO_SURROUNDING
  assert(loc.surroundingCities.includes("Vinton"));
  assert(loc.surroundingCities.includes("Bedford"));
  assert(loc.surroundingCities.includes("Floyd"));
  assert(loc.surroundingCities.includes("Radford"));
  assert(loc.surroundingCities.includes("Pembroke"));
  assert(loc.surroundingCities.includes("Pulaski"));
  assert(loc.surroundingCities.includes("Wirtz"));
  assert(loc.surroundingCities.includes("Huddleston"));

  // Neighbors from family cities (Gastonia, Rock Hill, Harrisonburg)
  assert(loc.surroundingCities.includes("Belmont"));
  assert(loc.surroundingCities.includes("Fort Mill"));
  assert(loc.surroundingCities.includes("Bridgewater"));

  // Out-of-bounds cities excluded from surrounding cities
  assertEquals(loc.surroundingCities.includes("Marion"), false);
  assertEquals(loc.surroundingCities.includes("Bristol"), false);
  assertEquals(loc.surroundingCities.includes("Charlottesville"), false);
  assertEquals(loc.surroundingCities.includes("Richmond"), false);
  assertEquals(loc.surroundingCities.includes("Danville"), false);
});

Deno.test("filterAndRankCandidates: with no location argument returns candidates from family cities and excludes out-of-bounds locations", () => {
  const venues: CandidateVenue[] = [
    {
      _id: "v1",
      name: "Clementine Cafe",
      city: "Harrisonburg",
      usState: "VA",
      address: "153 S Main St, Harrisonburg, VA 22801",
      email: "booking@clementinecafe.com",
    },
    {
      _id: "v2",
      name: "Cavendish Brewing",
      city: "Gastonia",
      usState: "NC",
      address: "207 N Chester St, Gastonia, NC 28052",
      email: "info@cavendishbrewing.com",
    },
    {
      _id: "v3",
      name: "Slow Play Brewing",
      city: "Rock Hill",
      usState: "SC",
      address: "274 Columbia Ave, Rock Hill, SC 29730",
      email: "info@slowplaybrewing.com",
    },
    {
      _id: "v4",
      name: "Olde Salem Brewing",
      city: "Salem",
      usState: "VA",
      address: "21 E Main St, Salem, VA 24153",
      email: "booking@oldesalem.com",
    },
    {
      _id: "v5",
      name: "Starr Hill Brewery",
      city: "Roanoke",
      usState: "VA",
      address: "6 Old Whitmore Ave, Roanoke, VA 24016",
      email: "roanoke@starrhill.com",
    },
    {
      _id: "v6",
      name: "The Wooden Pickle",
      city: "Marion",
      usState: "VA",
      address: "102 E Main St, Marion, VA 24354",
      email: "info@thewoodenpickle.com",
    },
    {
      _id: "v7",
      name: "State Line Bar & Grill",
      city: "Bristol",
      usState: "VA",
      address: "State St, Bristol, VA 24201",
      email: "info@stateline.com",
    },
    {
      _id: "v8",
      name: "The Southern Cafe",
      city: "Charlottesville",
      usState: "VA",
      address: "103 S 1st St, Charlottesville, VA 22902",
      email: "booking@thesoutherncville.com",
    },
    {
      _id: "v9",
      name: "The National",
      city: "Richmond",
      usState: "VA",
      address: "708 E Broad St, Richmond, VA 23219",
      email: "booking@thenationalva.com",
    },
    {
      _id: "v10",
      name: "Ballad Brewing",
      city: "Danville",
      usState: "VA",
      address: "600 Craghead St, Danville, VA 24541",
      email: "info@balladbrewing.com",
    },
    {
      _id: "v11",
      name: "Primal Brewery",
      city: "Belmont",
      usState: "NC",
      address: "52 Ervin St, Belmont, NC 28012",
      email: "info@primalbrewery.com",
    },
    {
      _id: "v12",
      name: "Apocalypse Ale Works",
      city: "Forest",
      usState: "VA",
      address: "1257 Burnbridge Rd, Forest, VA 24551",
      email: "info@apocalypse.com",
    },
  ];

  // Call with no location argument (undefined)
  const filtered = filterAndRankCandidates(venues);

  // Exact matches: Cavendish Brewing, Clementine Cafe, Olde Salem Brewing, Slow Play Brewing, Starr Hill Brewery (5)
  // Surrounding matches: Apocalypse Ale Works (Forest, VA), Primal Brewery (Belmont, NC) (2)
  assertEquals(filtered.length, 7);

  // Exact matches appear first, sorted by name
  assertEquals(filtered[0].name, "Cavendish Brewing"); // Gastonia (exact)
  assertEquals(filtered[1].name, "Clementine Cafe"); // Harrisonburg (exact)
  assertEquals(filtered[2].name, "Olde Salem Brewing"); // Salem (exact)
  assertEquals(filtered[3].name, "Slow Play Brewing"); // Rock Hill (exact)
  assertEquals(filtered[4].name, "Starr Hill Brewery"); // Roanoke (exact)

  // Surrounding matches appear second, sorted by name
  assertEquals(filtered[5].name, "Apocalypse Ale Works"); // Forest (surrounding Lynchburg)
  assertEquals(filtered[6].name, "Primal Brewery"); // Belmont (surrounding Gastonia)

  // Excluded cities are NOT returned in default search
  assertEquals(filtered.some((v) => v.name === "The Wooden Pickle"), false); // Marion
  assertEquals(filtered.some((v) => v.name === "State Line Bar & Grill"), false); // Bristol
  assertEquals(filtered.some((v) => v.name === "The Southern Cafe"), false); // Charlottesville
  assertEquals(filtered.some((v) => v.name === "The National"), false); // Richmond
  assertEquals(filtered.some((v) => v.name === "Ballad Brewing"), false); // Danville
});
