import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CheckResult,
  DEFAULT_TARGETS,
  formatAlertEmail,
  type MailTransporter,
  runAllChecks,
  runCheck,
  sendAlertEmail,
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
    name: "Failing Site",
    url: "https://example.com/fail",
    expectedStatus: [200],
  };

  const mockFetch = (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return Promise.resolve(new Response("Internal Error", { status: 500 }));
  };

  const result = await runCheck(target, mockFetch);
  assertEquals(result.success, false);
  assertEquals(result.status, 500);
  assertStringIncludes(result.error ?? "", "Expected status [200], got 500");
});

Deno.test("runCheck validates content keyword matching", async () => {
  const target: UptimeCheckConfig = {
    name: "Music Page",
    url: "https://example.com/music",
    expectedStatus: [200],
    contentKeywords: ["music", "gig"],
  };

  const mockFetchSuccess = (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(
      new Response("<html><body>Welcome to music and gig page</body></html>", {
        status: 200,
      }),
    );
  };

  const successResult = await runCheck(target, mockFetchSuccess);
  assertEquals(successResult.success, true);

  const mockFetchMissing = (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(
      new Response("<html><body>Blank Page</body></html>", { status: 200 }),
    );
  };

  const failResult = await runCheck(target, mockFetchMissing);
  assertEquals(failResult.success, false);
  assertStringIncludes(
    failResult.error ?? "",
    "Missing required content element(s): music, gig",
  );
});

Deno.test("runCheck handles network fetch exceptions", async () => {
  const target: UptimeCheckConfig = {
    name: "Down Site",
    url: "https://offline.example.com",
  };

  const mockFetch = (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return Promise.reject(new Error("Connection refused"));
  };

  const result = await runCheck(target, mockFetch);
  assertEquals(result.success, false);
  assertStringIncludes(result.error ?? "", "Fetch error: Connection refused");
});

Deno.test("runAllChecks evaluates multiple targets", async () => {
  const targets: UptimeCheckConfig[] = [
    { name: "Site 1", url: "https://site1.com", expectedStatus: [200] },
    { name: "Site 2", url: "https://site2.com", expectedStatus: [200] },
  ];

  const mockFetch = (url: string | URL | Request): Promise<Response> => {
    const urlStr = String(url);
    if (urlStr.includes("site1")) {
      return Promise.resolve(new Response("OK", { status: 200 }));
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  const results = await runAllChecks(targets, mockFetch);
  assertEquals(results.length, 2);
  assertEquals(results[0].success, true);
  assertEquals(results[1].success, false);
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
  assertEquals(sentOptions["to"], "joshua.v.sherman@gmail.com");
  assertStringIncludes(String(sentOptions["from"]), "testuser@gmail.com");
  assertStringIncludes(String(sentOptions["subject"]), "Production Service Failure");
});
