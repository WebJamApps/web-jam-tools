import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  easternHour,
  fetchGodPause,
  gmailSecrets,
  main,
  refreshAccessToken,
  runAtSixEastern,
  sendEmail,
  todayInEastern,
} from "../src/devotional/send_daily_devotional.ts";

// --- mock harness: stub `fetch` by URL and set/restore env, around one test ---

type Route = { status?: number; body: string };

const ENV = {
  GMAIL_CLIENT_ID: "cid",
  GMAIL_CLIENT_SECRET: "csecret",
  GMAIL_REFRESH_TOKEN: "rtoken",
} as const;

async function withMocks(
  opts: { routes?: Record<string, Route>; env?: Record<string, string | undefined> },
  fn: () => void | Promise<void>,
): Promise<void> {
  const savedFetch = globalThis.fetch;
  const envKeys = Object.keys(opts.env ?? {});
  const savedEnv = new Map(envKeys.map((k) => [k, Deno.env.get(k)]));
  try {
    if (opts.routes) {
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        const r = opts.routes![url];
        if (!r) return Promise.resolve(new Response("not found", { status: 404 }));
        return Promise.resolve(new Response(r.body, { status: r.status ?? 200 }));
      }) as typeof fetch;
    }
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await fn();
  } finally {
    globalThis.fetch = savedFetch;
    for (const [k, v] of savedEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

// --- easternHour: the DST guard that keeps it to exactly one 06:00 ET send/day ---

Deno.test("easternHour maps UTC to Eastern across DST (one 06:00 ET send/day)", () => {
  // EDT (summer, UTC-4): the 10:00 UTC cron is 06:00 ET (sends); 11:00 UTC is 07:00 (no-op).
  assertEquals(easternHour(new Date("2026-07-15T10:00:00Z")), 6);
  assertEquals(easternHour(new Date("2026-07-15T11:00:00Z")), 7);
  // EST (winter, UTC-5): the 11:00 UTC cron is 06:00 ET (sends); 10:00 UTC is 05:00 (no-op).
  assertEquals(easternHour(new Date("2026-01-15T11:00:00Z")), 6);
  assertEquals(easternHour(new Date("2026-01-15T10:00:00Z")), 5);
});

// --- gmailSecrets: env-var sourcing + validation ---

Deno.test("gmailSecrets returns the trio when all vars are present", async () => {
  await withMocks({ env: ENV }, () => {
    assertEquals(gmailSecrets(), {
      clientId: "cid",
      clientSecret: "csecret",
      refreshToken: "rtoken",
    });
  });
});

Deno.test("gmailSecrets throws when a secret is missing", async () => {
  await withMocks({ env: { ...ENV, GMAIL_REFRESH_TOKEN: undefined } }, () => {
    assertThrows(() => gmailSecrets(), Error, "Missing Gmail OAuth secrets");
  });
});

// --- refreshAccessToken: OAuth refresh-token grant ---

Deno.test("refreshAccessToken returns the minted access token", async () => {
  await withMocks({
    env: ENV,
    routes: {
      "https://oauth2.googleapis.com/token": { body: JSON.stringify({ access_token: "AT123" }) },
    },
  }, async () => {
    assertEquals(await refreshAccessToken(), "AT123");
  });
});

Deno.test("refreshAccessToken throws on a non-OK token response", async () => {
  await withMocks({
    env: ENV,
    routes: { "https://oauth2.googleapis.com/token": { status: 400, body: "bad" } },
  }, async () => {
    await assertRejects(() => refreshAccessToken(), Error, "token refresh");
  });
});

// --- sendEmail: refresh then Gmail send ---

Deno.test("sendEmail refreshes a token, posts to Gmail, and returns the message id", async () => {
  await withMocks({
    env: ENV,
    routes: {
      "https://oauth2.googleapis.com/token": { body: JSON.stringify({ access_token: "AT" }) },
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send": {
        body: JSON.stringify({ id: "MID9" }),
      },
    },
  }, async () => {
    assertEquals(await sendEmail("to@example.com", "Subj", "<p>hi</p>"), "MID9");
  });
});

Deno.test("sendEmail throws on a non-OK Gmail response", async () => {
  await withMocks({
    env: ENV,
    routes: {
      "https://oauth2.googleapis.com/token": { body: JSON.stringify({ access_token: "AT" }) },
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send": { status: 500, body: "boom" },
    },
  }, async () => {
    await assertRejects(
      () => sendEmail("to@example.com", "Subj", "<p>hi</p>"),
      Error,
      "gmail send",
    );
  });
});

// --- fetchGodPause: month-page link discovery + day-page parsing ---

const TODAY = { year: "2026", month: "06", day: "15", humanDate: "Monday, June 15, 2026" };
const MONTH_URL = "https://www.luthersem.edu/godpause/2026/06/";
const DAY_URL = "https://www.luthersem.edu/godpause/2026/06/15/12345/";
const DAY_HTML = `
  <div class="godpause-verse"><h2>Matthew 9:35</h2><p>Then Jesus went about all the cities.</p></div>
  <div class="godpause-devo"><p>A devotion paragraph.</p></div>
  <div class="godpause-prayer"><p>A short prayer.</p></div>
  <div class="godpause-author">
    <span class="author-name">Jane Doe</span>
    <span class="godpause-author-info">Luther Seminary</span>
  </div>
`;

Deno.test("fetchGodPause parses the linked day page into a GodPause", async () => {
  await withMocks({
    routes: {
      [MONTH_URL]: { body: `<a href="${DAY_URL}">today</a>` },
      [DAY_URL]: { body: DAY_HTML },
    },
  }, async () => {
    const gp = await fetchGodPause(TODAY);
    assertEquals(gp?.url, DAY_URL);
    assertEquals(gp?.scriptureRef, "Matthew 9:35");
    assertStringIncludes(gp?.verseText ?? "", "Then Jesus went about");
    assertStringIncludes(gp?.devotion ?? "", "A devotion paragraph.");
    assertStringIncludes(gp?.prayer ?? "", "A short prayer.");
    assertEquals(gp?.author, "Jane Doe, Luther Seminary");
  });
});

Deno.test("fetchGodPause returns null when no devotion is linked for the day", async () => {
  await withMocks({
    routes: { [MONTH_URL]: { body: `<a href="/godpause/2026/06/14/999/">yesterday</a>` } },
  }, async () => {
    assertEquals(await fetchGodPause(TODAY), null);
  });
});

Deno.test("fetchGodPause throws when the month page fetch is not ok", async () => {
  await withMocks({
    routes: { [MONTH_URL]: { status: 500, body: "boom" } },
  }, async () => {
    await assertRejects(() => fetchGodPause(TODAY), Error, "god pause month fetch");
  });
});

Deno.test("fetchGodPause throws when the day page fetch is not ok", async () => {
  await withMocks({
    routes: {
      [MONTH_URL]: { body: `<a href="${DAY_URL}">today</a>` },
      [DAY_URL]: { status: 500, body: "boom" },
    },
  }, async () => {
    await assertRejects(() => fetchGodPause(TODAY), Error, "god pause day fetch");
  });
});

Deno.test("fetchGodPause returns null when the day link's id segment doesn't parse", async () => {
  await withMocks({
    // href matches the day prefix but what follows isn't `<digits>/"` — idMatch fails.
    routes: { [MONTH_URL]: { body: `<a href="${DAY_URL.replace(/\d+\/$/, "abc/")}">today</a>` } },
  }, async () => {
    assertEquals(await fetchGodPause(TODAY), null);
  });
});

Deno.test("fetchGodPause returns null when devotion and prayer are both empty", async () => {
  const emptyHtml = `
    <div class="godpause-verse"><h2>Matthew 9:35</h2><p>Verse text.</p></div>
    <div class="godpause-devo"></div>
    <div class="godpause-prayer"></div>
  `;
  await withMocks({
    routes: {
      [MONTH_URL]: { body: `<a href="${DAY_URL}">today</a>` },
      [DAY_URL]: { body: emptyHtml },
    },
  }, async () => {
    assertEquals(await fetchGodPause(TODAY), null);
  });
});

// --- todayInEastern: shape check (format-only — value depends on the real clock) ---

Deno.test("todayInEastern returns a well-formed year/month/day/humanDate", () => {
  const t = todayInEastern();
  assertMatch(t.year, /^\d{4}$/);
  assertMatch(t.month, /^\d{2}$/);
  assertMatch(t.day, /^\d{2}$/);
  assertMatch(t.humanDate, /^[A-Za-z]+, [A-Za-z]+ \d{1,2}, \d{4}$/);
});

// --- main / runAtSixEastern: end-to-end orchestration ---
// These compute the "today" routes from the REAL current clock (same as
// production code does internally) rather than hardcoding a date, since main()
// isn't given an injectable "now" for its God Pause fetch.

function todayRoutes(dayHtml: string) {
  const today = todayInEastern();
  const monthUrl = `https://www.luthersem.edu/godpause/${today.year}/${today.month}/`;
  const todayPrefix =
    `https://www.luthersem.edu/godpause/${today.year}/${today.month}/${today.day}/`;
  const dayUrl = `${todayPrefix}99999/`;
  return {
    [monthUrl]: { body: `<a href="${dayUrl}">today</a>` },
    [dayUrl]: { body: dayHtml },
  };
}

Deno.test("main sends the devotion end-to-end and returns 0", async () => {
  await withMocks({
    env: ENV,
    routes: {
      ...todayRoutes(DAY_HTML),
      "https://oauth2.googleapis.com/token": { body: JSON.stringify({ access_token: "AT" }) },
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send": {
        body: JSON.stringify({ id: "MID-MAIN" }),
      },
    },
  }, async () => {
    assertEquals(await main(), 0);
  });
});

Deno.test("main returns 0 without sending when no devotion is published today", async () => {
  const today = todayInEastern();
  const monthUrl = `https://www.luthersem.edu/godpause/${today.year}/${today.month}/`;
  await withMocks({
    routes: { [monthUrl]: { body: `<a href="/godpause/other/day/">nope</a>` } },
  }, async () => {
    assertEquals(await main(), 0);
  });
});

Deno.test("runAtSixEastern is a no-op when it isn't 06:00 Eastern", async () => {
  // 2026-07-15T11:00:00Z is 07:00 EDT — not 06:00. Empty route table: if this
  // wrongly fell through to main(), the resulting fetch would 404 and throw,
  // failing this test — so "no throw" also proves main() was never called.
  await withMocks({ routes: {} }, async () => {
    await runAtSixEastern(new Date("2026-07-15T11:00:00Z"));
  });
});

Deno.test("runAtSixEastern sends the devotion when it is 06:00 Eastern", async () => {
  // 2026-01-15T11:00:00Z is 06:00 EST.
  await withMocks({
    env: ENV,
    routes: {
      ...todayRoutes(DAY_HTML),
      "https://oauth2.googleapis.com/token": { body: JSON.stringify({ access_token: "AT" }) },
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send": {
        body: JSON.stringify({ id: "MID-CRON" }),
      },
    },
  }, async () => {
    await runAtSixEastern(new Date("2026-01-15T11:00:00Z"));
  });
});
