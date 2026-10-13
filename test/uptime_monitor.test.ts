import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CheckResult,
  DEFAULT_TARGETS,
  formatAlertEmail,
  formatHeartbeatEmail,
  runAllChecks,
  runCheck,
  sendAlertEmail,
  sendHeartbeatEmail,
  type UptimeCheckConfig,
} from "../src/uptime/monitor.ts";

Deno.test("DEFAULT_TARGETS contains all required production URLs and check parameters", () => {
  assertEquals(DEFAULT_TARGETS.length, 5);

  const urls = DEFAULT_TARGETS.map((t) => t.url);
  assert(urls.includes("https://joshandmariamusic.com"));
  assert(urls.includes("https://www.joshandmariamusic.com"));
  assert(urls.includes("https://web-jam.com"));
  assert(urls.includes("https://web-jam.com/music"));
  assert(urls.includes("https://collegelutheran.org"));

  const musicTarget = DEFAULT_TARGETS.find((t) => t.url === "https://web-jam.com/music");
  assert(musicTarget);
  assertEquals(musicTarget.contentKeywords, ["music"]);
});

Deno.test("runCheck succeeds on status 200", async () => {
  const target: UptimeCheckConfig = {
    name: "Test Site",
    url: "https://example.com",
    expectedStatus: [200],
  };

  const mockFetch = (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return Promise.resolve(new Response("OK", { status: 200 }));
  };

  const result = await runCheck(target, mockFetch);
  assertEquals(result.success, true);
  assertEquals(result.status, 200);
});

Deno.test("runCheck fails on unexpected status code", async () => {
  const target: UptimeCheckConfig = {
    name: "Test Site",
    url: "https://example.com",
    expectedStatus: [200],
  };

  const mockFetch = (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
  };

  const result = await runCheck(target, mockFetch);
  assertEquals(result.success, false);
  assertEquals(result.status, 503);
  assertStringIncludes(result.error ?? "", "Expected status [200], got 503");
});

Deno.test("runCheck validates content keyword matching", async () => {
  const target: UptimeCheckConfig = {
    name: "Test Music Page",
    url: "https://example.com/music",
    expectedStatus: [200],
    contentKeywords: ["gigs", "album"],
  };

  const mockFetchMissing = (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(
      new Response("<html><body>Welcome to Example</body></html>", { status: 200 }),
    );
  };

  const resultMissing = await runCheck(target, mockFetchMissing);
  assertEquals(resultMissing.success, false);
  assertStringIncludes(
    resultMissing.error ?? "",
    "Missing required content element(s): gigs, album",
  );

  const mockFetchSuccess = (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(
      new Response("<html><body>See our gigs and new album!</body></html>", { status: 200 }),
    );
  };

  const resultSuccess = await runCheck(target, mockFetchSuccess);
  assertEquals(resultSuccess.success, true);
});

Deno.test("runCheck handles network fetch exceptions", async () => {
  const target: UptimeCheckConfig = {
    name: "Test Site",
    url: "https://example.com",
  };

  const mockFetchFail = (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return Promise.reject(new Error("DNS resolution failed"));
  };

  const result = await runCheck(target, mockFetchFail);
  assertEquals(result.success, false);
  assertStringIncludes(result.error ?? "", "Fetch error: DNS resolution failed");
});

Deno.test("runAllChecks evaluates multiple targets", async () => {
  const mockFetch = (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return Promise.resolve(new Response("music content", { status: 200 }));
  };

  const results = await runAllChecks(DEFAULT_TARGETS, mockFetch);
  assertEquals(results.length, 5);
  assert(results.every((r) => r.success));
});

Deno.test("formatAlertEmail formats subject and body correctly", () => {
  const failedResults: CheckResult[] = [
    {
      config: { name: "Site A", url: "https://sitea.com" },
      success: false,
      status: 502,
      error: "Bad Gateway",
    },
  ];

  const email = formatAlertEmail(failedResults);
  assertStringIncludes(email.subject, "[Uptime Alert]");
  assertStringIncludes(email.subject, "1 check failed");
  assertStringIncludes(email.text, "Site A (https://sitea.com)");
  assertStringIncludes(email.text, "Error: Bad Gateway");
  assertStringIncludes(email.html, "<li><strong>Site A</strong>");
});

Deno.test("formatHeartbeatEmail formats daily status email correctly", () => {
  const results: CheckResult[] = [
    {
      config: { name: "Site A", url: "https://sitea.com" },
      success: true,
      status: 200,
    },
  ];

  const email = formatHeartbeatEmail(results);
  assertStringIncludes(email.subject, "Daily Heartbeat: All 1 Production Services Healthy");
  assertStringIncludes(email.text, "Site A (https://sitea.com)");
  assertStringIncludes(email.html, "Site A");
});

function pad(s: string): string {
  return s + "=".repeat((4 - (s.length % 4)) % 4);
}
function b64ToUtf8(s: string): string {
  const bin = atob(pad(s.replace(/\r?\n/g, "")));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function b64urlToUtf8(s: string): string {
  return b64ToUtf8(s.replace(/-/g, "+").replace(/_/g, "/"));
}

Deno.test("sendAlertEmail validates environment variables and throws naming all three Gmail settings", async () => {
  const failedResults: CheckResult[] = [
    {
      config: { name: "Site A", url: "https://sitea.com" },
      success: false,
      error: "Connection timeout",
    },
  ];

  const origId = Deno.env.get("GMAIL_CLIENT_ID");
  const origSecret = Deno.env.get("GMAIL_CLIENT_SECRET");
  const origToken = Deno.env.get("GMAIL_REFRESH_TOKEN");

  try {
    Deno.env.delete("GMAIL_CLIENT_ID");
    Deno.env.delete("GMAIL_CLIENT_SECRET");
    Deno.env.delete("GMAIL_REFRESH_TOKEN");

    await assertRejects(
      () => sendAlertEmail(failedResults),
      Error,
      "Missing Gmail OAuth secrets: set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN",
    );
  } finally {
    if (origId) Deno.env.set("GMAIL_CLIENT_ID", origId);
    if (origSecret) Deno.env.set("GMAIL_CLIENT_SECRET", origSecret);
    if (origToken) Deno.env.set("GMAIL_REFRESH_TOKEN", origToken);
  }
});

Deno.test("sendAlertEmail makes one token request and one send request to Gmail API", async () => {
  const failedResults: CheckResult[] = [
    {
      config: { name: "Site A", url: "https://sitea.com" },
      success: false,
      status: 500,
      error: "Internal Server Error",
    },
  ];

  const origId = Deno.env.get("GMAIL_CLIENT_ID");
  const origSecret = Deno.env.get("GMAIL_CLIENT_SECRET");
  const origToken = Deno.env.get("GMAIL_REFRESH_TOKEN");

  try {
    Deno.env.set("GMAIL_CLIENT_ID", "test-client-id");
    Deno.env.set("GMAIL_CLIENT_SECRET", "test-client-secret");
    Deno.env.set("GMAIL_REFRESH_TOKEN", "test-refresh-token");

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlStr = String(url);
      calls.push({ url: urlStr, init });
      if (urlStr === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "test-token" }), { status: 200 }),
        );
      }
      if (urlStr === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        return Promise.resolve(
          new Response(JSON.stringify({ id: "alert-msg-123" }), { status: 200 }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
    };

    const res = await sendAlertEmail(failedResults, mockFetch);
    assertEquals(res, "alert-msg-123");
    assertEquals(calls.length, 2);

    // Verify token request
    assertEquals(calls[0].url, "https://oauth2.googleapis.com/token");
    assertEquals(calls[0].init?.method, "POST");

    // Verify send request
    assertEquals(calls[1].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    assertEquals(calls[1].init?.method, "POST");
    const sendPayload = JSON.parse(String(calls[1].init?.body));
    const decoded = b64urlToUtf8(sendPayload.raw);
    assertStringIncludes(decoded, "To: joshua.v.sherman@gmail.com, chemmariasherman@gmail.com");
    assertStringIncludes(
      decoded,
      "Subject: [Uptime Alert] Production Service Failure (1 check failed)",
    );
    const bodyPart = decoded.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    assertStringIncludes(b64ToUtf8(bodyPart), "Site A");
    assertStringIncludes(b64ToUtf8(bodyPart), "Internal Server Error");
  } finally {
    if (origId) Deno.env.set("GMAIL_CLIENT_ID", origId);
    else Deno.env.delete("GMAIL_CLIENT_ID");
    if (origSecret) Deno.env.set("GMAIL_CLIENT_SECRET", origSecret);
    else Deno.env.delete("GMAIL_CLIENT_SECRET");
    if (origToken) Deno.env.set("GMAIL_REFRESH_TOKEN", origToken);
    else Deno.env.delete("GMAIL_REFRESH_TOKEN");
  }
});

Deno.test("sendHeartbeatEmail makes one token request and one send request to Gmail API", async () => {
  const results: CheckResult[] = [
    {
      config: { name: "Site A", url: "https://sitea.com" },
      success: true,
      status: 200,
    },
  ];

  const origId = Deno.env.get("GMAIL_CLIENT_ID");
  const origSecret = Deno.env.get("GMAIL_CLIENT_SECRET");
  const origToken = Deno.env.get("GMAIL_REFRESH_TOKEN");

  try {
    Deno.env.set("GMAIL_CLIENT_ID", "test-client-id");
    Deno.env.set("GMAIL_CLIENT_SECRET", "test-client-secret");
    Deno.env.set("GMAIL_REFRESH_TOKEN", "test-refresh-token");

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlStr = String(url);
      calls.push({ url: urlStr, init });
      if (urlStr === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "test-token" }), { status: 200 }),
        );
      }
      if (urlStr === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        return Promise.resolve(
          new Response(JSON.stringify({ id: "heartbeat-msg-456" }), { status: 200 }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
    };

    const res = await sendHeartbeatEmail(results, mockFetch);
    assertEquals(res, "heartbeat-msg-456");
    assertEquals(calls.length, 2);

    // Verify token request
    assertEquals(calls[0].url, "https://oauth2.googleapis.com/token");
    assertEquals(calls[0].init?.method, "POST");

    // Verify send request
    assertEquals(calls[1].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    assertEquals(calls[1].init?.method, "POST");
    const sendPayload = JSON.parse(String(calls[1].init?.body));
    const decoded = b64urlToUtf8(sendPayload.raw);
    assertStringIncludes(decoded, "To: joshua.v.sherman@gmail.com, chemmariasherman@gmail.com");
    assertStringIncludes(
      decoded,
      "Subject: [Uptime Monitor] Daily Heartbeat: All 1 Production Services Healthy",
    );
    const bodyPart = decoded.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    assertStringIncludes(b64ToUtf8(bodyPart), "Site A");
  } finally {
    if (origId) Deno.env.set("GMAIL_CLIENT_ID", origId);
    else Deno.env.delete("GMAIL_CLIENT_ID");
    if (origSecret) Deno.env.set("GMAIL_CLIENT_SECRET", origSecret);
    else Deno.env.delete("GMAIL_CLIENT_SECRET");
    if (origToken) Deno.env.set("GMAIL_REFRESH_TOKEN", origToken);
    else Deno.env.delete("GMAIL_REFRESH_TOKEN");
  }
});
