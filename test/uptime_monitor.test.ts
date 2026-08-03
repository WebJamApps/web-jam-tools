import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CheckResult,
  DEFAULT_TARGETS,
  formatAlertEmail,
  formatHeartbeatEmail,
  type MailTransporter,
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

Deno.test("sendAlertEmail validates environment variables", async () => {
  const failedResults: CheckResult[] = [
    {
      config: { name: "Site A", url: "https://sitea.com" },
      success: false,
      error: "Connection timeout",
    },
  ];

  await assertRejects(
    () => sendAlertEmail(failedResults, {}),
    Error,
    "Missing required environment variables GMAIL_USER or GMAIL_APP_PASSWORD",
  );
});

Deno.test("sendAlertEmail uses transporter to send mail", async () => {
  const failedResults: CheckResult[] = [
    {
      config: { name: "Site A", url: "https://sitea.com" },
      success: false,
      status: 500,
      error: "Internal Server Error",
    },
  ];

  let sentOptions: Record<string, unknown> | null = null;
  const mockTransporter: MailTransporter = {
    sendMail(options) {
      sentOptions = options;
      return Promise.resolve({ accepted: [options.to] });
    },
  };

  const env = {
    GMAIL_USER: "testuser@gmail.com",
    GMAIL_APP_PASSWORD: "app-password-secret",
  };

  await sendAlertEmail(failedResults, env, mockTransporter);

  assert(sentOptions);
  assertStringIncludes(String(sentOptions["to"]), "joshua.v.sherman@gmail.com");
  assertStringIncludes(String(sentOptions["to"]), "chemmariasherman@gmail.com");
  assertStringIncludes(String(sentOptions["from"]), "testuser@gmail.com");
  assertStringIncludes(String(sentOptions["subject"]), "Production Service Failure");
});

Deno.test("sendHeartbeatEmail uses transporter to send heartbeat mail", async () => {
  const results: CheckResult[] = [
    {
      config: { name: "Site A", url: "https://sitea.com" },
      success: true,
      status: 200,
    },
  ];

  let sentOptions: Record<string, unknown> | null = null;
  const mockTransporter: MailTransporter = {
    sendMail(options) {
      sentOptions = options;
      return Promise.resolve({ accepted: [options.to] });
    },
  };

  const env = {
    GMAIL_USER: "testuser@gmail.com",
    GMAIL_APP_PASSWORD: "app-password-secret",
  };

  await sendHeartbeatEmail(results, env, mockTransporter);

  assert(sentOptions);
  assertStringIncludes(String(sentOptions["to"]), "joshua.v.sherman@gmail.com");
  assertStringIncludes(String(sentOptions["to"]), "chemmariasherman@gmail.com");
  assertStringIncludes(String(sentOptions["subject"]), "Daily Heartbeat");
});
