import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  extractAddress,
  extractEmails,
  extractFromJsonLd,
  extractVenueContact,
  extractVisibleText,
  findContactLinks,
  hasMeaningfulText,
} from "../src/venue-contact/extract_venue_contact.ts";

// --- test fixtures --------------------------------------------------------

const STATIC_SITE = `
<html>
  <body>
    <header><nav>
      <a href="/">Home</a>
      <a href="/menu">Menu</a>
      <a href="/contact">Contact</a>
      <a href="/about-us">About</a>
    </nav></header>
    <main>
      <h1>The Tap Room</h1>
      <p>Live music every Friday night. Great food, great beer, great vibes.
      Come hang out with us downtown and catch a show from local artists.</p>
    </main>
    <footer>
      <p>123 Main Street, Roanoke, VA 24011</p>
      <a href="mailto:booking@taproom.example">booking@taproom.example</a>
    </footer>
  </body>
</html>`;

const CLIENT_RENDERED_SHELL = `
<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;

const RENDERED_HTML = `
<html>
  <body>
    <main>
      <h1>The Tap Room</h1>
      <p>Live music every Friday night. Great food, great beer, great vibes downtown.</p>
    </main>
    <footer>
      <p>123 Main Street, Roanoke, VA 24011</p>
      <a href="mailto:booking@taproom.example">booking@taproom.example</a>
    </footer>
  </body>
</html>`;

const NO_CONTACT_SITE = `
<html><body><main><h1>The Tap Room</h1>
<p>Live music every Friday night. Great food and great beer downtown for everyone in town.</p>
</main></body></html>`;

const CONTACT_PAGE = `
<html><body><main>
<h1>Contact The Tap Room</h1>
<p>Want to book a show or ask about our calendar? Reach our booking manager
at general@taproom.example and we'll get back to you within a couple of days.</p>
</main></body></html>`;

// --- fetch/render stub harness ---------------------------------------------

type Route = { status?: number; body: string };

function stubFetch(routes: Record<string, Route>): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes[url];
    if (!route) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(new Response(route.body, { status: route.status ?? 200 }));
  }) as typeof fetch;
}

function throwingFetch(message: string): typeof fetch {
  return (() => Promise.reject(new Error(message))) as unknown as typeof fetch;
}

function hangingFetchThatRespectsAbort(): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    });
  }) as typeof fetch;
}

// --- extractVisibleText / hasMeaningfulText --------------------------------

Deno.test("extractVisibleText strips script/style and collapses whitespace", () => {
  const html = "<html><body><script>var x=1;</script>  <p>Hello   world</p></body></html>";
  assertEquals(extractVisibleText(html), "Hello world");
});

Deno.test("hasMeaningfulText is false for a client-rendered shell", () => {
  assertEquals(hasMeaningfulText(CLIENT_RENDERED_SHELL), false);
});

Deno.test("hasMeaningfulText is true for a page with real body copy", () => {
  assertEquals(hasMeaningfulText(STATIC_SITE), true);
});

// --- extractEmails ----------------------------------------------------------

Deno.test("extractEmails finds a mailto: link and a plain-text address, deduped", () => {
  const html = `<a href="mailto:Booking@Venue.com">Email us</a><p>or booking@venue.com</p>`;
  assertEquals(extractEmails(html), ["booking@venue.com"]);
});

Deno.test("extractEmails filters out denylisted tracking/boilerplate domains", () => {
  const html = `<p>real@venue.com and noreply@sentry.io and x@schema.org</p>`;
  assertEquals(extractEmails(html), ["real@venue.com"]);
});

Deno.test("extractEmails returns empty array, never invents a value, when none present", () => {
  assertEquals(extractEmails(NO_CONTACT_SITE), []);
});

// --- extractFromJsonLd -------------------------------------------------------

Deno.test("extractFromJsonLd extracts email from a single schema.org object", () => {
  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "MusicVenue",
            "name": "Test Venue",
            "email": "hi@venue.example"
          }
        </script>
      </head>
      <body></body>
    </html>`;
  const { emails, phones } = extractFromJsonLd(html);
  assertEquals(emails, ["hi@venue.example"]);
  assertEquals(phones, []);
});

Deno.test("extractFromJsonLd extracts email and telephone from JSON-LD", () => {
  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@type": "Restaurant",
            "email": "contact@restaurant.example",
            "telephone": "+1-555-123-4567"
          }
        </script>
      </head>
      <body></body>
    </html>`;
  const { emails, phones } = extractFromJsonLd(html);
  assertEquals(emails, ["contact@restaurant.example"]);
  assertEquals(phones, ["+1-555-123-4567"]);
});

Deno.test("extractFromJsonLd walks @graph array and extracts from all items", () => {
  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Organization",
                "name": "Venue",
                "email": "info@venue.example"
              },
              {
                "@type": "LocalBusiness",
                "email": "support@venue.example"
              }
            ]
          }
        </script>
      </head>
      <body></body>
    </html>`;
  const { emails, phones } = extractFromJsonLd(html);
  assertEquals(new Set(emails), new Set(["info@venue.example", "support@venue.example"]));
  assertEquals(phones, []);
});

Deno.test("extractFromJsonLd ignores malformed JSON-LD gracefully", () => {
  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          { broken json without closing brace
        </script>
      </head>
      <body></body>
    </html>`;
  const { emails, phones } = extractFromJsonLd(html);
  assertEquals(emails, []);
  assertEquals(phones, []);
});

Deno.test("extractEmails includes emails from JSON-LD blocks", () => {
  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@type": "MusicVenue",
            "email": "JsonLdEmail@venue.example"
          }
        </script>
      </head>
      <body>
        <a href="mailto:mailto@venue.example">Contact</a>
      </body>
    </html>`;
  const emails = extractEmails(html);
  assertEquals(new Set(emails), new Set(["jsonldemail@venue.example", "mailto@venue.example"]));
});

// --- extractAddress ----------------------------------------------------------

Deno.test("extractAddress finds a US street address in visible text", () => {
  assertEquals(extractAddress(STATIC_SITE), "123 Main Street, Roanoke, VA 24011");
});

Deno.test("extractAddress returns null when no address is present", () => {
  assertEquals(extractAddress(NO_CONTACT_SITE), null);
});

Deno.test("extractAddress prefers a match containing the cityHint", () => {
  const html =
    `<p>Mailing: 1 PO Box Rd, Bristol, VA 24201. Venue: 55 Show St, Roanoke, VA 24011.</p>`;
  assertEquals(extractAddress(html, "Roanoke"), "55 Show St, Roanoke, VA 24011");
});

// --- findContactLinks --------------------------------------------------------

Deno.test("findContactLinks picks contact-bearing internal links, ignores others", () => {
  const links = findContactLinks(STATIC_SITE, "https://taproom.example/", 4);
  assertEquals(links.sort(), [
    "https://taproom.example/about-us",
    "https://taproom.example/contact",
  ]);
});

Deno.test("findContactLinks is bounded by max even when more links match", () => {
  const html = `
    <a href="/contact">Contact</a>
    <a href="/about">About</a>
    <a href="/events">Events</a>
    <a href="/booking">Booking</a>
    <a href="/contact-us-alt">Contact Us Too</a>`;
  const links = findContactLinks(html, "https://venue.example/", 2);
  assertEquals(links.length, 2);
});

Deno.test("findContactLinks skips mailto/tel/hash/off-host links", () => {
  const html = `
    <a href="mailto:x@venue.example">Email</a>
    <a href="tel:+15551234567">Call</a>
    <a href="#contact">Jump</a>
    <a href="https://facebook.com/contact">Facebook contact</a>`;
  assertEquals(findContactLinks(html, "https://venue.example/", 4), []);
});

Deno.test("findContactLinks matches find us, visit, and location link text (case-insensitive)", () => {
  const html = `
    <a href="/findus">FIND US</a>
    <a href="/visit">Visit Us</a>
    <a href="/location">Location</a>
    <a href="/hours">Hours</a>`;
  const links = findContactLinks(html, "https://venue.example/", 4);
  assertEquals(links.sort(), [
    "https://venue.example/findus",
    "https://venue.example/location",
    "https://venue.example/visit",
  ]);
});

// --- extractVenueContact: plain-fetch path ----------------------------------

Deno.test("extractVenueContact: static site returns email + address via plain fetch, no extra pages needed for the answer", async () => {
  const result = await extractVenueContact("https://taproom.example/", {
    fetchImpl: stubFetch({ "https://taproom.example/": { body: STATIC_SITE } }),
    renderImpl: () => Promise.reject(new Error("renderImpl should not be called")),
  });
  assertEquals(result.fetchPath, "plain");
  assertEquals(result.error, null);
  assertEquals(result.address, "123 Main Street, Roanoke, VA 24011");
  assertEquals(result.emails, [
    { email: "booking@taproom.example", sourceUrl: "https://taproom.example/" },
  ]);
});

// --- extractVenueContact: Playwright fallback -------------------------------

Deno.test("extractVenueContact: falls back to Playwright when the plain fetch is a client-rendered shell", async () => {
  let renderCalls = 0;
  const result = await extractVenueContact("https://spa.example/", {
    fetchImpl: stubFetch({ "https://spa.example/": { body: CLIENT_RENDERED_SHELL } }),
    renderImpl: (url) => {
      renderCalls++;
      assertEquals(url, "https://spa.example/");
      return Promise.resolve(RENDERED_HTML);
    },
  });
  assertEquals(renderCalls, 1);
  assertEquals(result.fetchPath, "playwright");
  assertEquals(result.error, null);
  assertEquals(result.address, "123 Main Street, Roanoke, VA 24011");
  assertEquals(result.emails, [
    { email: "booking@taproom.example", sourceUrl: "https://spa.example/" },
  ]);
});

// --- extractVenueContact: empty/failure results -----------------------------

Deno.test("extractVenueContact: no contact info found returns a clean empty result, no crash", async () => {
  const result = await extractVenueContact("https://plain-venue.example/", {
    fetchImpl: stubFetch({ "https://plain-venue.example/": { body: NO_CONTACT_SITE } }),
    renderImpl: () => Promise.reject(new Error("renderImpl should not be called")),
  });
  assertEquals(result.emails, []);
  assertEquals(result.address, null);
  assertEquals(result.fetchPath, "plain");
  assertEquals(result.error, null);
});

Deno.test("extractVenueContact: dead host fails cleanly (fetchPath failed, no Playwright attempt)", async () => {
  let renderCalls = 0;
  const result = await extractVenueContact("https://dead-host.invalid/", {
    fetchImpl: throwingFetch("connection refused"),
    renderImpl: () => {
      renderCalls++;
      return Promise.resolve("<html></html>");
    },
  });
  assertEquals(renderCalls, 0);
  assertEquals(result.fetchPath, "failed");
  assertEquals(result.emails, []);
  assertEquals(result.address, null);
  assertStringIncludes(result.error ?? "", "plain fetch failed");
});

Deno.test("extractVenueContact: a slow/hanging host is aborted within its configured timeout", async () => {
  const result = await extractVenueContact("https://slow-host.example/", {
    fetchTimeoutMs: 25,
    fetchImpl: hangingFetchThatRespectsAbort(),
  });
  assertEquals(result.fetchPath, "failed");
  assertStringIncludes(result.error ?? "", "plain fetch failed");
});

Deno.test("extractVenueContact: Playwright failure after a shell detection also fails cleanly", async () => {
  const result = await extractVenueContact("https://spa-broken.example/", {
    fetchImpl: stubFetch({ "https://spa-broken.example/": { body: CLIENT_RENDERED_SHELL } }),
    renderImpl: () => Promise.reject(new Error("browser launch failed")),
  });
  assertEquals(result.fetchPath, "failed");
  assertEquals(result.emails, []);
  assertEquals(result.address, null);
  assertStringIncludes(result.error ?? "", "playwright render failed");
});

// --- extractVenueContact: bounded link-following ----------------------------

Deno.test("extractVenueContact: follows a contact-bearing link and merges its email with the right sourceUrl", async () => {
  const result = await extractVenueContact("https://taproom.example/", {
    fetchImpl: stubFetch({
      "https://taproom.example/": { body: STATIC_SITE },
      "https://taproom.example/contact": { body: CONTACT_PAGE },
      "https://taproom.example/about-us": { status: 404, body: "gone" },
    }),
    renderImpl: () => Promise.reject(new Error("renderImpl should not be called")),
  });
  assertEquals(result.fetchPath, "plain");
  assertEquals(result.pagesVisited, [
    "https://taproom.example/",
    "https://taproom.example/contact",
  ]);
  const emails = result.emails.map((e) => e.email).sort();
  assertEquals(emails, ["booking@taproom.example", "general@taproom.example"]);
  const contactHit = result.emails.find((e) => e.email === "general@taproom.example");
  assertEquals(contactHit?.sourceUrl, "https://taproom.example/contact");
});

Deno.test("extractVenueContact: a dead sub-link is skipped, does not fail the overall run", async () => {
  const result = await extractVenueContact("https://taproom.example/", {
    fetchImpl: stubFetch({
      "https://taproom.example/": { body: STATIC_SITE },
      // /contact and /about-us both 404 -> skipped, landing-page data still returned
    }),
    renderImpl: () => Promise.reject(new Error("renderImpl should not be called")),
  });
  assertEquals(result.error, null);
  assertEquals(result.pagesVisited, ["https://taproom.example/"]);
  assertEquals(result.emails, [
    { email: "booking@taproom.example", sourceUrl: "https://taproom.example/" },
  ]);
});

Deno.test("extractVenueContact: honors maxExtraPages, following none when set to 0", async () => {
  const result = await extractVenueContact("https://taproom.example/", {
    maxExtraPages: 0,
    fetchImpl: stubFetch({
      "https://taproom.example/": { body: STATIC_SITE },
      "https://taproom.example/contact": { body: CONTACT_PAGE },
    }),
    renderImpl: () => Promise.reject(new Error("renderImpl should not be called")),
  });
  assertEquals(result.pagesVisited, ["https://taproom.example/"]);
  assertEquals(result.emails, [
    { email: "booking@taproom.example", sourceUrl: "https://taproom.example/" },
  ]);
});

// --- extractVenueContact: JSON-LD and new link types -------------------------

Deno.test("extractVenueContact: extracts email from JSON-LD on contact page", async () => {
  const jsonLdContact = `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@type": "MusicVenue",
            "email": "hi@palmerahouse.example"
          }
        </script>
      </head>
      <body>
        <h1>Palmera House</h1>
        <p>We host live music events and special gatherings. Reach out to learn more about booking with us. Visit our venue for an unforgettable experience.</p>
      </body>
    </html>`;
  const result = await extractVenueContact("https://palmerahouse.example/contact", {
    fetchImpl: stubFetch({
      "https://palmerahouse.example/contact": { body: jsonLdContact },
    }),
    renderImpl: () => Promise.reject(new Error("renderImpl should not be called")),
  });
  assertEquals(result.fetchPath, "plain");
  assertEquals(result.error, null);
  assertEquals(result.emails, [
    { email: "hi@palmerahouse.example", sourceUrl: "https://palmerahouse.example/contact" },
  ]);
});

Deno.test("extractVenueContact: follows find us link and extracts email from target page", async () => {
  const homePage = `
    <html>
      <body>
        <nav>
          <a href="/findus">FIND US</a>
          <a href="/about">About</a>
        </nav>
        <h1>The Water Dog</h1>
        <p>Live music venue in downtown Lynchburg featuring the best local and touring bands. Come enjoy great food, drinks, and live performances every weekend.</p>
      </body>
    </html>`;
  const findUsPage = `
    <html>
      <body>
        <h1>Find Us</h1>
        <p>You can reach us at info@thewaterdog.example or call during business hours. We are located at 789 Riverside Ave, Lynchburg, VA 24504. Come visit us downtown.</p>
      </body>
    </html>`;
  const result = await extractVenueContact("https://thewaterdog.example/", {
    fetchImpl: stubFetch({
      "https://thewaterdog.example/": { body: homePage },
      "https://thewaterdog.example/findus": { body: findUsPage },
    }),
    renderImpl: () => Promise.reject(new Error("renderImpl should not be called")),
  });
  assertEquals(result.fetchPath, "plain");
  assertEquals(result.error, null);
  assertEquals(result.pagesVisited, [
    "https://thewaterdog.example/",
    "https://thewaterdog.example/findus",
  ]);
  const emails = result.emails.map((e) => e.email).sort();
  assertEquals(emails, ["info@thewaterdog.example"]);
  const waterDogHit = result.emails.find((e) => e.email === "info@thewaterdog.example");
  assertEquals(waterDogHit?.sourceUrl, "https://thewaterdog.example/findus");
});
