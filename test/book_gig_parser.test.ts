// test/book_gig_parser.test.ts — Dedicated unit tests for /book-gig date & location parsing

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  matchesVenueFilter,
  parseBookGigArgs,
  parseLocation,
  parseTargetWeekend,
} from "../src/book-gig/parser.ts";
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
