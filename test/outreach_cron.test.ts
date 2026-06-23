import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type AdvanceResult,
  backendConfig,
  easternHour,
  main,
  runAtNineEastern,
  triggerAdvance,
} from "../src/outreach-cron/advance_cadence.ts";

// Swap globalThis.fetch for the duration of fn, restoring it after. Returns the
// recorded calls so a test can assert URL / method / headers.
async function withFetch(
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  fn: (calls: { url: string; init?: RequestInit }[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return impl(input, init);
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const okResult: AdvanceResult = { processed: 2, sent: 1, called: 1, parked: 0, skipped: 0 };
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function withToken(token: string | null, base: string | null, fn: () => void | Promise<void>) {
  const prevToken = Deno.env.get("WEB_JAM_LLM_TOKEN");
  const prevBase = Deno.env.get("WEB_JAM_BACK_URL");
  if (token === null) Deno.env.delete("WEB_JAM_LLM_TOKEN");
  else Deno.env.set("WEB_JAM_LLM_TOKEN", token);
  if (base === null) Deno.env.delete("WEB_JAM_BACK_URL");
  else Deno.env.set("WEB_JAM_BACK_URL", base);
  const restore = () => {
    if (prevToken === undefined) Deno.env.delete("WEB_JAM_LLM_TOKEN");
    else Deno.env.set("WEB_JAM_LLM_TOKEN", prevToken);
    if (prevBase === undefined) Deno.env.delete("WEB_JAM_BACK_URL");
    else Deno.env.set("WEB_JAM_BACK_URL", prevBase);
  };
  const out = fn();
  return out instanceof Promise ? out.finally(restore) : (restore(), out);
}

Deno.test("backendConfig throws without a token", () => {
  withToken(null, null, () => {
    let threw = false;
    try {
      backendConfig();
    } catch (e) {
      threw = true;
      assertStringIncludes((e as Error).message, "WEB_JAM_LLM_TOKEN");
    }
    assert(threw, "expected backendConfig to throw without a token");
  });
});

Deno.test("backendConfig defaults the backend URL and keeps the token", () => {
  withToken("tok-123", null, () => {
    const cfg = backendConfig();
    assertEquals(cfg.baseUrl, "https://webjamsalem.herokuapp.com");
    assertEquals(cfg.token, "tok-123");
  });
});

Deno.test("backendConfig honors WEB_JAM_BACK_URL and trims a trailing slash", () => {
  withToken("tok", "https://staging.example.com/", () => {
    assertEquals(backendConfig().baseUrl, "https://staging.example.com");
  });
});

Deno.test("triggerAdvance POSTs /outreach/advance with the bearer token", async () => {
  await withToken("tok-xyz", null, async () => {
    await withFetch(() => Promise.resolve(jsonResponse(okResult)), async (calls) => {
      const result = await triggerAdvance();
      assertEquals(result, okResult);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].url, "https://webjamsalem.herokuapp.com/outreach/advance");
      assertEquals(calls[0].init?.method, "POST");
      assertEquals(
        (calls[0].init?.headers as Record<string, string>).Authorization,
        "Bearer tok-xyz",
      );
    });
  });
});

Deno.test("triggerAdvance throws on a non-ok response", async () => {
  await withToken("tok", null, async () => {
    await withFetch(() => Promise.resolve(jsonResponse({ message: "nope" }, 401)), async () => {
      await assertRejects(() => triggerAdvance(), Error, "outreach advance: 401");
    });
  });
});

Deno.test("easternHour converts UTC to Eastern in both DST seasons", () => {
  // 13:00 UTC in summer = 09:00 EDT (UTC-4)
  assertEquals(easternHour(new Date("2026-06-15T13:00:00Z")), 9);
  // 14:00 UTC in winter = 09:00 EST (UTC-5)
  assertEquals(easternHour(new Date("2026-01-15T14:00:00Z")), 9);
  // 13:00 UTC in winter = 08:00 EST — the off-season hour that must no-op
  assertEquals(easternHour(new Date("2026-01-15T13:00:00Z")), 8);
});

Deno.test("runAtNineEastern is a no-op when it isn't 09:00 Eastern", async () => {
  await withToken("tok", null, async () => {
    await withFetch(() => Promise.resolve(jsonResponse(okResult)), async (calls) => {
      await runAtNineEastern(new Date("2026-01-15T13:00:00Z")); // 08:00 EST
      assertEquals(calls.length, 0);
    });
  });
});

Deno.test("runAtNineEastern advances when it is 09:00 Eastern", async () => {
  await withToken("tok", null, async () => {
    await withFetch(() => Promise.resolve(jsonResponse(okResult)), async (calls) => {
      await runAtNineEastern(new Date("2026-06-15T13:00:00Z")); // 09:00 EDT
      assertEquals(calls.length, 1);
      assertStringIncludes(calls[0].url, "/outreach/advance");
    });
  });
});

Deno.test("main advances once and returns 0 (the local/manual entry)", async () => {
  await withToken("tok", null, async () => {
    await withFetch(() => Promise.resolve(jsonResponse(okResult)), async (calls) => {
      const code = await main();
      assertEquals(code, 0);
      assertEquals(calls.length, 1);
      assertStringIncludes(calls[0].url, "/outreach/advance");
    });
  });
});
