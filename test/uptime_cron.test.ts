import { assertEquals } from "@std/assert";
import { handleHttpReq, runCronCheck, runDailyHeartbeatCheck } from "../src/uptime/cron.ts";
import type { CheckResult, UptimeCheckConfig } from "../src/uptime/monitor.ts";

const dummyTarget: UptimeCheckConfig = {
  name: "Dummy Target",
  url: "https://example.com",
};

Deno.test("runCronCheck logs success when all targets pass", async () => {
  let emailSent = false;
  const mockRunAll = () =>
    Promise.resolve([
      { config: dummyTarget, success: true, status: 200 },
    ]);
  const mockSendMail = () => {
    emailSent = true;
    return Promise.resolve();
  };

  await runCronCheck(mockRunAll, mockSendMail);
  assertEquals(emailSent, false);
});

Deno.test("runCronCheck dispatches email alert when a check fails", async () => {
  let emailSent = false;
  let receivedFailures: CheckResult[] = [];
  const mockRunAll = () =>
    Promise.resolve([
      { config: dummyTarget, success: false, status: 503, error: "HTTP 503" },
    ]);
  const mockSendMail = (failures: CheckResult[]) => {
    emailSent = true;
    receivedFailures = failures;
    return Promise.resolve();
  };

  await runCronCheck(mockRunAll, mockSendMail);
  assertEquals(emailSent, true);
  assertEquals(receivedFailures.length, 1);
  assertEquals(receivedFailures[0].status, 503);
});

Deno.test("runDailyHeartbeatCheck dispatches daily status email", async () => {
  let heartbeatSent = false;
  let receivedResults: CheckResult[] = [];
  const mockRunAll = () =>
    Promise.resolve([
      { config: dummyTarget, success: true, status: 200 },
    ]);
  const mockSendHeartbeat = (results: CheckResult[]) => {
    heartbeatSent = true;
    receivedResults = results;
    return Promise.resolve();
  };

  await runDailyHeartbeatCheck(mockRunAll, mockSendHeartbeat);
  assertEquals(heartbeatSent, true);
  assertEquals(receivedResults.length, 1);
  assertEquals(receivedResults[0].success, true);
});

Deno.test("handleHttpReq responds to /test-heartbeat endpoint", async () => {
  let called = false;
  const mockHeartbeat = () => {
    called = true;
    return Promise.resolve();
  };
  const req = new Request("https://example.com/test-heartbeat");
  const res = await handleHttpReq(req, mockHeartbeat);
  assertEquals(res.status, 200);
  assertEquals(called, true);
  assertEquals(await res.text(), "Heartbeat email dispatched successfully!");
});

Deno.test("handleHttpReq handles /test-heartbeat failure with 500", async () => {
  const mockHeartbeat = () => Promise.reject(new Error("SMTP Connection Failed"));
  const req = new Request("https://example.com/test-heartbeat");
  const res = await handleHttpReq(req, mockHeartbeat);
  assertEquals(res.status, 500);
  assertEquals(await res.text(), "Heartbeat email failed: SMTP Connection Failed");
});

Deno.test("handleHttpReq responds to /test-check endpoint", async () => {
  let called = false;
  const mockCronCheck = () => {
    called = true;
    return Promise.resolve();
  };
  const req = new Request("https://example.com/test-check");
  const res = await handleHttpReq(req, undefined, mockCronCheck);
  assertEquals(res.status, 200);
  assertEquals(called, true);
  assertEquals(await res.text(), "Uptime check completed successfully!");
});

Deno.test("handleHttpReq handles /test-check failure with 500", async () => {
  const mockCronCheck = () => Promise.reject(new Error("Check Failed"));
  const req = new Request("https://example.com/test-check");
  const res = await handleHttpReq(req, undefined, mockCronCheck);
  assertEquals(res.status, 500);
  assertEquals(await res.text(), "Uptime check failed: Check Failed");
});

Deno.test("handleHttpReq returns default 200 response for root path", async () => {
  const req = new Request("https://example.com/");
  const res = await handleHttpReq(req);
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "WebJam Uptime Monitor active 24/7");
});
