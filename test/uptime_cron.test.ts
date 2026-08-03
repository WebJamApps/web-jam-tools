import { assertEquals } from "@std/assert";
import { runCronCheck } from "../src/uptime/cron.ts";
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
