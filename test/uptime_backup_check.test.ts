import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { Buffer } from "node:buffer";
import {
  checkBackupStatus,
  runBackupCheck,
  sendBackupWarning,
} from "../src/uptime/backup_check.ts";
import { PRODUCTION_BACKEND_URL } from "../src/uptime/monitor.ts";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const answer = (body: unknown, status = 200): typeof fetch => () =>
  Promise.resolve(Response.json(body, { status }));

Deno.test("backup ages: 25 and exactly 26 hours are healthy, older than 26 warns once", async () => {
  for (const hours of [0, 25, 26, 26.001, 27]) {
    const warnings: string[] = [];
    const result = await runBackupCheck(
      answer({ newestGoodRun: hoursAgo(hours), lastRunFailed: true }),
      (warning) => {
        warnings.push(warning.summary);
        return Promise.resolve();
      },
      NOW,
    );
    assertEquals(result.state, hours > 26 ? "stale" : "healthy");
    assertEquals(warnings.length, hours > 26 ? 1 : 0);
    assertStringIncludes(result.summary, `${hours.toFixed(1)} hours old`);
    if (hours > 26) assertStringIncludes(warnings[0], "overdue");
  }
});

Deno.test("backup absence, backend errors and no answer send distinct warnings", async () => {
  const cases: Array<{ fetchFn: typeof fetch; state: string; message: string }> = [
    { fetchFn: answer({ newestGoodRun: "none" }), state: "none", message: "no good run exists" },
    { fetchFn: answer({ message: "cannot tell" }, 500), state: "unknown", message: "HTTP 500" },
    { fetchFn: answer({}, 503), state: "unknown", message: "HTTP 503" },
    {
      fetchFn: () => Promise.reject(new TypeError("network unavailable")),
      state: "unreachable",
      message: "did not answer",
    },
    {
      fetchFn: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      state: "unreachable",
      message: "timed out",
    },
  ];
  for (const item of cases) {
    const warnings: string[] = [];
    const result = await runBackupCheck(item.fetchFn, (warning) => {
      warnings.push(warning.summary);
      return Promise.resolve();
    }, NOW);
    assertEquals(result.state, item.state);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], item.message);
  }
});

Deno.test("backup status reads production's public GET with a bounded abort signal", async () => {
  const fetchFn: typeof fetch = (input, init) => {
    assertEquals(String(input), `${PRODUCTION_BACKEND_URL}/backup/status`);
    assertEquals(init?.method ?? "GET", "GET");
    assert(init?.signal instanceof AbortSignal);
    assertEquals(init.signal.aborted, false);
    assertEquals(init.headers, undefined);
    return Promise.resolve(Response.json({ newestGoodRun: hoursAgo(25) }));
  };
  assertEquals((await checkBackupStatus(fetchFn, NOW)).state, "healthy");
});

Deno.test("invalid or future backup status never becomes a healthy run", async () => {
  const invalidBodies = [null, {}, { newestGoodRun: 123 }, { newestGoodRun: "invalid" }, {
    newestGoodRun: hoursAgo(-1),
  }];
  for (const body of invalidBodies) {
    const result = await checkBackupStatus(answer(body), NOW);
    assertEquals(result.state, "unknown");
    assertStringIncludes(result.summary, "cannot determine age");
  }
  const invalidJson: typeof fetch = () => Promise.resolve(new Response("not JSON"));
  assertEquals((await checkBackupStatus(invalidJson, NOW)).state, "unknown");
});

Deno.test("backup warning send failures surface to the cron caller", async () => {
  let thrown: unknown;
  await assertRejects(
    () =>
      runBackupCheck(
        answer({ newestGoodRun: "none" }),
        () => Promise.reject(new Error("mail failed")),
        NOW,
      ).catch((err) => {
        thrown = err;
        throw err;
      }),
    Error,
    "mail failed",
  );
  assert(typeof thrown === "object" && thrown !== null && "backupResult" in thrown);
  assertEquals((thrown as { backupResult: { state: string } }).backupResult.state, "none");
});

Deno.test("an errored response body does not suppress the backend status warning", async () => {
  const fetchFn: typeof fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("body failed"));
          },
        }),
        { status: 500 },
      ),
    );
  const result = await checkBackupStatus(fetchFn, NOW);
  assertEquals(result.state, "unknown");
  assertStringIncludes(result.summary, "HTTP 500");
});

Deno.test("backup warning uses the shared Gmail API sender and existing recipients", async () => {
  const keys = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"];
  const saved = keys.map((key) => Deno.env.get(key));
  try {
    for (const key of keys) Deno.env.set(key, "test-value");
    const calls: string[] = [];
    const fetchFn: typeof fetch = (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(Response.json({ access_token: "test-access" }));
      }
      assertEquals(url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
      const payload = JSON.parse(String(init?.body));
      const raw = Buffer.from(payload.raw, "base64url").toString("utf8");
      assertStringIncludes(raw, "To: joshua.v.sherman@gmail.com, chemmariasherman@gmail.com");
      assertStringIncludes(raw, "Subject: [Uptime Alert] MongoDB backup warning");
      const html = Buffer.from(raw.split("\r\n\r\n")[1], "base64").toString("utf8");
      assertStringIncludes(html, "no good run exists");
      return Promise.resolve(Response.json({ id: "test-message" }));
    };
    const result = await checkBackupStatus(answer({ newestGoodRun: "none" }), NOW);
    assertEquals(await sendBackupWarning(result, fetchFn), "test-message");
    assertEquals(calls.length, 2);
  } finally {
    keys.forEach((key, index) => {
      const value = saved[index];
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    });
  }
});
