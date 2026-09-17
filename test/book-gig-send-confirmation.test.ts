// test/book-gig-send-confirmation.test.ts — Unit tests for /book-gig --send draft confirmation gate

import { assertEquals, assertRejects } from "@std/assert";
import { runBookGigCli } from "../src/book-gig/cli.ts";
import { parseBookGigArgs } from "../src/book-gig/parser.ts";

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

Deno.test("parseBookGigArgs: confirmation flag parsing and fail-closed default-deny", () => {
  // Affirmative forms evaluate to true
  const affirmatives = [
    ["--confirm-drafts"],
    ["--confirm-drafts=true"],
    ["--confirm-drafts=TRUE"],
    ["--confirm-drafts=yes"],
    ["--confirm-drafts=YES"],
    ["--confirm-drafts=1"],
  ];

  for (const flag of affirmatives) {
    const parsed = parseBookGigArgs([
      "--send",
      "Oct 16-18 2026",
      "Salem, VA",
      ...flag,
    ]);
    assertEquals(
      parsed.mode,
      "send",
      `Expected mode 'send' for flag ${flag.join(" ")}`,
    );
    assertEquals(
      parsed.confirmDrafts,
      true,
      `Expected confirmDrafts=true for affirmative flag ${flag.join(" ")}`,
    );
  }

  // Fail-closed / negative / malformed / dropped-alias forms evaluate to undefined
  const nonAffirmatives = [
    [], // default (no flag)
    ["--confirm-drafts=false"],
    ["--confirm-drafts=no"],
    ["--confirm-drafts=0"],
    ["--confirm-drafts=off"],
    ["--confirm-drafts="],
    ["--confirm-drafts=maybe"],
    ["--confirm-drafts=foo"],
    ["--confirm"], // dropped alias
    ["--confirm=true"], // dropped alias
    ["--confirm=yes"], // dropped alias
    ["--confirm=no"], // dropped alias
  ];

  for (const flag of nonAffirmatives) {
    const parsed = parseBookGigArgs([
      "--send",
      "Oct 16-18 2026",
      "Salem, VA",
      ...flag,
    ]);
    assertEquals(
      parsed.mode,
      "send",
      `Expected mode 'send' for flag ${flag.join(" ")}`,
    );
    assertEquals(
      parsed.confirmDrafts,
      undefined,
      `Expected confirmDrafts=undefined for non-affirmative flag ${flag.join(" ")}`,
    );
  }
});

Deno.test("runBookGigCli: fails closed early without network calls when --send lacks affirmative --confirm-drafts", async () => {
  await withIsolatedHome(async () => {
    const nonAffirmativeArgSets = [
      ["--send", "Oct 16-18 2026", "Salem, VA"],
      ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm-drafts=false"],
      ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm-drafts=no"],
      ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm-drafts=0"],
      ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm-drafts=off"],
      ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm-drafts="],
      ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm-drafts=maybe"],
      ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm"],
      ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm=true"],
    ];

    for (const args of nonAffirmativeArgSets) {
      let candidatesEndpointCalled = false;
      let batchEndpointCalled = false;

      const mockFetch: typeof fetch = (input: string | URL | Request) => {
        const urlStr = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;

        if (urlStr.includes("/outreach/candidates")) {
          candidatesEndpointCalled = true;
          return Promise.resolve(
            new Response(JSON.stringify([]), { status: 200 }),
          );
        }
        if (urlStr.includes("/outreach/batch")) {
          batchEndpointCalled = true;
          return Promise.resolve(
            new Response(
              JSON.stringify({ requested: 0, sent: 0, skipped: [], records: [] }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      };

      const mockOpener = () => Promise.resolve(true);

      await assertRejects(
        async () => {
          await runBookGigCli(args, mockFetch, mockOpener);
        },
        Error,
        "Batch outreach dispatch requires explicit draft confirmation via --confirm-drafts.",
      );

      assertEquals(
        candidatesEndpointCalled,
        false,
        `Early refusal must avoid candidates network call for args: ${args.join(" ")}`,
      );
      assertEquals(
        batchEndpointCalled,
        false,
        `Early refusal must avoid batch network call for args: ${args.join(" ")}`,
      );
    }
  });
});

Deno.test("runBookGigCli: dispatches successfully when --send is invoked with bare --confirm-drafts (isolated HOME)", async () => {
  await withIsolatedHome(async () => {
    let batchEndpointCalled = false;
    let dispatchedVenueIds: string[] = [];

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
                _id: "venue-1",
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

      if (urlStr.includes("/outreach/templates")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      if (urlStr.includes("/outreach/batch")) {
        batchEndpointCalled = true;
        if (init?.body) {
          const payload = JSON.parse(init.body as string);
          dispatchedVenueIds = payload.venueIds || [];
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ requested: 1, sent: 1, skipped: [], records: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const mockOpener = () => Promise.resolve(true);

    const result = await runBookGigCli(
      ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm-drafts"],
      mockFetch,
      mockOpener,
    );

    assertEquals(result.mode, "send");
    assertEquals(result.confirmDrafts, true);
    assertEquals(
      batchEndpointCalled,
      true,
      "POST /outreach/batch should be called when --confirm-drafts is provided",
    );
    assertEquals(dispatchedVenueIds, ["venue-1"]);
    assertEquals(result.batchDispatch?.sent, 1);
  });
});

Deno.test("runBookGigCli: dispatches successfully with affirmative --confirm-drafts=<value> (isolated HOME)", async () => {
  await withIsolatedHome(async () => {
    for (const flag of ["--confirm-drafts=true", "--confirm-drafts=yes", "--confirm-drafts=1"]) {
      let batchEndpointCalled = false;

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
                  _id: "venue-1",
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

        if (urlStr.includes("/outreach/templates")) {
          return Promise.resolve(
            new Response(
              JSON.stringify([]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }

        if (urlStr.includes("/outreach/batch")) {
          batchEndpointCalled = true;
          return Promise.resolve(
            new Response(
              JSON.stringify({ requested: 1, sent: 1, skipped: [], records: [] }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }

        return Promise.resolve(new Response("{}", { status: 200 }));
      };

      const mockOpener = () => Promise.resolve(true);

      const result = await runBookGigCli(
        ["--send", "Oct 16-18 2026", "Salem, VA", flag],
        mockFetch,
        mockOpener,
      );

      assertEquals(result.mode, "send");
      assertEquals(result.confirmDrafts, true);
      assertEquals(
        batchEndpointCalled,
        true,
        `POST /outreach/batch should be called for ${flag}`,
      );
      assertEquals(result.batchDispatch?.sent, 1);
    }
  });
});
