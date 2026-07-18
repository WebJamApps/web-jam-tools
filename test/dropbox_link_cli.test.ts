import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import {
  createOrGetSharedLink,
  dropboxSecrets,
  main,
  refreshAccessToken,
  shareLinkForms,
  toAccountRelativePath,
} from "../src/dropbox-link/dropbox_link_cli.ts";

// --- mock harness: stub `fetch` by URL and set/restore env, around one test ---

type Route = { status?: number; body: string };

const ENV = {
  DROPBOX_APP_KEY: "key123",
  DROPBOX_APP_SECRET: "secret456",
  DROPBOX_REFRESH_TOKEN: "rtoken789",
} as const;

async function withMocks(
  opts: { routes?: Record<string, Route | Route[]>; env?: Record<string, string | undefined> },
  fn: () => void | Promise<void>,
): Promise<void> {
  const savedFetch = globalThis.fetch;
  const envKeys = Object.keys(opts.env ?? {});
  const savedEnv = new Map(envKeys.map((k) => [k, Deno.env.get(k)]));
  const callCounts = new Map<string, number>();
  try {
    if (opts.routes) {
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        const entry = opts.routes![url];
        if (!entry) return Promise.resolve(new Response("not found", { status: 404 }));
        if (Array.isArray(entry)) {
          const n = callCounts.get(url) ?? 0;
          callCounts.set(url, n + 1);
          const r = entry[Math.min(n, entry.length - 1)];
          return Promise.resolve(new Response(r.body, { status: r.status ?? 200 }));
        }
        return Promise.resolve(new Response(entry.body, { status: entry.status ?? 200 }));
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

// --- dropboxSecrets: env-var sourcing + validation ---

Deno.test("dropboxSecrets returns the trio when all vars are present", async () => {
  await withMocks({ env: ENV }, () => {
    assertEquals(dropboxSecrets(), {
      appKey: "key123",
      appSecret: "secret456",
      refreshToken: "rtoken789",
    });
  });
});

Deno.test("dropboxSecrets throws when a secret is missing", async () => {
  await withMocks({ env: { ...ENV, DROPBOX_REFRESH_TOKEN: undefined } }, () => {
    assertThrows(() => dropboxSecrets(), Error, "Missing Dropbox OAuth secrets");
  });
});

// --- refreshAccessToken: OAuth refresh-token grant (HTTP Basic auth) ---

Deno.test("refreshAccessToken returns the minted access token", async () => {
  await withMocks({
    env: ENV,
    routes: {
      "https://api.dropboxapi.com/oauth2/token": {
        body: JSON.stringify({ access_token: "AT123" }),
      },
    },
  }, async () => {
    assertEquals(await refreshAccessToken(), "AT123");
  });
});

Deno.test("refreshAccessToken throws on a non-OK token response", async () => {
  await withMocks({
    env: ENV,
    routes: { "https://api.dropboxapi.com/oauth2/token": { status: 400, body: "bad_grant" } },
  }, async () => {
    await assertRejects(() => refreshAccessToken(), Error, "dropbox token refresh");
  });
});

Deno.test("refreshAccessToken throws when the response has no access_token", async () => {
  await withMocks({
    env: ENV,
    routes: { "https://api.dropboxapi.com/oauth2/token": { body: JSON.stringify({}) } },
  }, async () => {
    await assertRejects(() => refreshAccessToken(), Error, "returned no access_token");
  });
});

// --- toAccountRelativePath: input auto-detection ---

Deno.test("toAccountRelativePath keeps an account-relative path as-is", () => {
  assertEquals(
    toAccountRelativePath("/joshandmariamusic/song.mp3"),
    "/joshandmariamusic/song.mp3",
  );
});

Deno.test("toAccountRelativePath maps a /home/<user>/Dropbox/... local path", () => {
  assertEquals(
    toAccountRelativePath("/home/joshua/Dropbox/joshandmariamusic/song.mp3"),
    "/joshandmariamusic/song.mp3",
  );
});

Deno.test("toAccountRelativePath expands ~ using the injected home dir and maps it", () => {
  assertEquals(
    toAccountRelativePath("~/Dropbox/joshandmariamusic/song.mp3", "/home/joshua"),
    "/joshandmariamusic/song.mp3",
  );
});

Deno.test("toAccountRelativePath trims surrounding whitespace (e.g. from stdin lines)", () => {
  assertEquals(toAccountRelativePath("  /a/b.mp3  "), "/a/b.mp3");
});

Deno.test("toAccountRelativePath throws for input it can't classify", () => {
  assertThrows(
    () => toAccountRelativePath("relative/no/leading/slash.mp3"),
    Error,
    "Cannot determine Dropbox path type",
  );
});

// --- shareLinkForms: single shared-link URL -> both labeled output forms ---

Deno.test("shareLinkForms produces the setlist (dl=0) and widget (dl=1) forms, preserving rlkey", () => {
  const forms = shareLinkForms(
    "https://www.dropbox.com/scl/fi/abc123/song.mp3?rlkey=xyz789&dl=0",
  );
  assertEquals(
    forms.setlistUrl,
    "https://www.dropbox.com/scl/fi/abc123/song.mp3?rlkey=xyz789&dl=0",
  );
  assertEquals(
    forms.widgetUrl,
    "https://dl.dropboxusercontent.com/scl/fi/abc123/song.mp3?rlkey=xyz789&dl=1",
  );
});

Deno.test("shareLinkForms forces dl regardless of the source link's dl value", () => {
  const forms = shareLinkForms(
    "https://www.dropbox.com/scl/fi/abc123/song.mp3?rlkey=xyz789&dl=1",
  );
  assertStringIncludes(forms.setlistUrl, "dl=0");
  assertStringIncludes(forms.widgetUrl, "dl=1");
});

Deno.test("shareLinkForms omits rlkey from the query when the source link has none", () => {
  const forms = shareLinkForms("https://www.dropbox.com/scl/fi/abc123/song.mp3?dl=0");
  assertEquals(forms.setlistUrl, "https://www.dropbox.com/scl/fi/abc123/song.mp3?dl=0");
  assertEquals(forms.widgetUrl, "https://dl.dropboxusercontent.com/scl/fi/abc123/song.mp3?dl=1");
});

// --- createOrGetSharedLink: create, or 409 fallback to list (idempotent) ---

Deno.test("createOrGetSharedLink returns the URL from a fresh create", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        body: JSON.stringify({ url: "https://www.dropbox.com/scl/fi/new/song.mp3?rlkey=k&dl=0" }),
      },
    },
  }, async () => {
    assertEquals(
      await createOrGetSharedLink("AT", "/a/song.mp3"),
      "https://www.dropbox.com/scl/fi/new/song.mp3?rlkey=k&dl=0",
    );
  });
});

Deno.test("createOrGetSharedLink falls back to list_shared_links on 409 shared_link_already_exists (idempotent re-run)", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        status: 409,
        body: JSON.stringify({
          error_summary: "shared_link_already_exists/...",
          error: { ".tag": "shared_link_already_exists" },
        }),
      },
      "https://api.dropboxapi.com/2/sharing/list_shared_links": {
        body: JSON.stringify({
          links: [{ url: "https://www.dropbox.com/scl/fi/existing/song.mp3?rlkey=k&dl=0" }],
        }),
      },
    },
  }, async () => {
    assertEquals(
      await createOrGetSharedLink("AT", "/a/song.mp3"),
      "https://www.dropbox.com/scl/fi/existing/song.mp3?rlkey=k&dl=0",
    );
  });
});

Deno.test("createOrGetSharedLink rethrows a 409 that is NOT shared_link_already_exists", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        status: 409,
        body: JSON.stringify({ error_summary: "some_other_conflict/..." }),
      },
    },
  }, async () => {
    await assertRejects(
      () => createOrGetSharedLink("AT", "/a/song.mp3"),
      Error,
      "dropbox create shared link: 409",
    );
  });
});

Deno.test("createOrGetSharedLink throws when the list fallback finds no existing link", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        status: 409,
        body: JSON.stringify({ error: { ".tag": "shared_link_already_exists" } }),
      },
      "https://api.dropboxapi.com/2/sharing/list_shared_links": {
        body: JSON.stringify({ links: [] }),
      },
    },
  }, async () => {
    await assertRejects(
      () => createOrGetSharedLink("AT", "/a/song.mp3"),
      Error,
      "no existing link found",
    );
  });
});

Deno.test("createOrGetSharedLink throws on a non-409 error status", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        status: 500,
        body: "boom",
      },
    },
  }, async () => {
    await assertRejects(() => createOrGetSharedLink("AT", "/a/song.mp3"), Error, "500");
  });
});

// --- main: batch mode end-to-end (token refresh once, then per-path resolve) ---

Deno.test("main resolves multiple paths (account-relative + local) and returns 0", async () => {
  await withMocks({
    env: ENV,
    routes: {
      "https://api.dropboxapi.com/oauth2/token": { body: JSON.stringify({ access_token: "AT" }) },
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        body: JSON.stringify({ url: "https://www.dropbox.com/scl/fi/x/song.mp3?rlkey=k&dl=0" }),
      },
    },
  }, async () => {
    const code = await main([
      "/joshandmariamusic/a.mp3",
      "/home/joshua/Dropbox/joshandmariamusic/b.mp3",
    ]);
    assertEquals(code, 0);
  });
});

Deno.test("main returns 1 and reports per-path when one path fails but others succeed", async () => {
  await withMocks({
    env: ENV,
    routes: {
      "https://api.dropboxapi.com/oauth2/token": { body: JSON.stringify({ access_token: "AT" }) },
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        body: JSON.stringify({ url: "https://www.dropbox.com/scl/fi/x/song.mp3?rlkey=k&dl=0" }),
      },
    },
  }, async () => {
    const code = await main(["/ok.mp3", "unclassifiable/path.mp3"]);
    assertEquals(code, 1);
  });
});

Deno.test("main returns 1 without a network call when no paths are given", async () => {
  await withMocks({ routes: {} }, async () => {
    assertEquals(await main([]), 1);
  });
});

Deno.test("main returns 1 when the token refresh itself fails", async () => {
  await withMocks({
    env: ENV,
    routes: { "https://api.dropboxapi.com/oauth2/token": { status: 401, body: "invalid_grant" } },
  }, async () => {
    assertEquals(await main(["/a.mp3"]), 1);
  });
});
