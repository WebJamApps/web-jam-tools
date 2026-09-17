// test/sweep_cville.test.ts
import { assertEquals } from "@std/assert";
import {
  dedupeVenues,
  fetchCvilleMusicEvents,
  type HarvestedVenue,
  isLargeHallOrTheater,
  isLocalCvilleArea,
  isNonMusicEntity,
} from "../src/venue-mining/sweep_cville.ts";

Deno.test("isNonMusicEntity correctly classifies non-venues", () => {
  assertEquals(isNonMusicEntity("The Scrappy Elephant"), true);
  assertEquals(isNonMusicEntity("Jefferson Madison Central Library"), true);
  assertEquals(isNonMusicEntity("Monticello Loop Park"), true);
  assertEquals(isNonMusicEntity("RSWA Ivy Solid Waste Recycling Center"), true);

  assertEquals(isNonMusicEntity("Eastwood Farm and Winery"), false);
  assertEquals(isNonMusicEntity("Dürty Nelly's"), false);
  assertEquals(isNonMusicEntity("Three Notch'd Craft Kitchen & Brewery"), false);
  assertEquals(isNonMusicEntity("The Bebedero"), false);
});

Deno.test("isLargeHallOrTheater identifies TSM leads", () => {
  assertEquals(isLargeHallOrTheater("The Paramount Theater"), true);
  assertEquals(isLargeHallOrTheater("The Jefferson Theater"), true);
  assertEquals(isLargeHallOrTheater("Ting Pavilion"), true);
  assertEquals(isLargeHallOrTheater("John Paul Jones Arena"), true);

  assertEquals(isLargeHallOrTheater("Albemarle Ciderworks"), false);
  assertEquals(isLargeHallOrTheater("Firefly"), false);
  assertEquals(isLargeHallOrTheater("Pro Re Nata Farm Brewery"), false);
});

Deno.test("isLocalCvilleArea correctly filters geographic bounds", () => {
  assertEquals(isLocalCvilleArea("Charlottesville", "VA"), true);
  assertEquals(isLocalCvilleArea("Crozet", "VA"), true);
  assertEquals(isLocalCvilleArea("Keswick", "VA"), true);
  assertEquals(isLocalCvilleArea("North Garden", "VA"), true);
  assertEquals(isLocalCvilleArea("Earlysville", "VA"), true);
  assertEquals(isLocalCvilleArea("Scottsville", "VA"), true);

  assertEquals(isLocalCvilleArea("Richmond", "VA"), false);
  assertEquals(isLocalCvilleArea("Washington", "DC"), false);
  assertEquals(isLocalCvilleArea("Charlottesville", "NC"), false);
});

Deno.test("dedupeVenues excludes existing DB venues by name", () => {
  const harvested: HarvestedVenue[] = [
    { name: "The Southern Cafe & Music Hall", eventCount: 10, events: [] },
    { name: "Eastwood Farm and Winery", eventCount: 5, events: [] },
    { name: "Dürty Nelly's", eventCount: 8, events: [] },
  ];

  const dbNames = ["The Southern Cafe & Music Hall", "Pale Fire Brewing Co."];
  const result = dedupeVenues(harvested, dbNames);

  assertEquals(result.length, 2);
  assertEquals(result.map((v) => v.name), ["Eastwood Farm and Winery", "Dürty Nelly's"]);
});

Deno.test("fetchCvilleMusicEvents aggregates events from mocked JSON API", async () => {
  const mockPayload = {
    pages: 1,
    events: [
      {
        _source: {
          name: "Bluegrass Friday",
          starttime: "2026-09-20T18:00:00.000-04:00",
          venue: {
            name: "Mock Brewery",
            address: "123 Main St",
            city: "Charlottesville",
            state: "VA",
            zip: "22902",
            phone: "434-555-0100",
            url: "https://mockbrewery.com",
          },
        },
      },
      {
        _source: {
          name: "Acoustic Saturday",
          starttime: "2026-09-21T19:00:00.000-04:00",
          venue: {
            name: "Mock Brewery",
            address: "123 Main St",
            city: "Charlottesville",
            state: "VA",
            zip: "22902",
            phone: "434-555-0100",
            url: "https://mockbrewery.com",
          },
        },
      },
    ],
  };

  const mockFetch = (_url: string | URL | Request) => {
    return Promise.resolve(new Response(JSON.stringify(mockPayload), { status: 200 }));
  };

  const venues = await fetchCvilleMusicEvents(mockFetch as unknown as typeof fetch, 1);
  assertEquals(venues.length, 1);
  assertEquals(venues[0].name, "Mock Brewery");
  assertEquals(venues[0].eventCount, 2);
  assertEquals(venues[0].events.length, 2);
  assertEquals(venues[0].events[0].title, "Bluegrass Friday");
});
