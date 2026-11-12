import { assertEquals } from "@std/assert";
import {
  handleHttpReq,
  registerCronJobs,
  runCronCheck,
  runDailyHeartbeatCheck,
} from "../src/uptime/cron.ts";
import type { CheckResult, UptimeCheckConfig } from "../src/uptime/monitor.ts";
import { runBackupCheck } from "../src/uptime/backup_check.ts";

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
  let backupCalls = 0;
  const backupSummary = "Backup: newest good run is 25.0 hours old.";
  const mockRunAll = () =>
    Promise.resolve([
      { config: dummyTarget, success: true, status: 200 },
    ]);
  const mockSendHeartbeat = (results: CheckResult[], summary: string) => {
    assertEquals(summary, backupSummary);
    heartbeatSent = true;
    receivedResults = results;
    return Promise.resolve();
  };

  await runDailyHeartbeatCheck(mockRunAll, mockSendHeartbeat, () => {
    backupCalls++;
    return Promise.resolve({ state: "healthy", ageHours: 25, summary: backupSummary });
  });
  assertEquals(backupCalls, 1);
  assertEquals(heartbeatSent, true);
  assertEquals(receivedResults.length, 1);
  assertEquals(receivedResults[0].success, true);
});

Deno.test("cron schedules invoke backup work only at noon and midnight", async () => {
  const handlers = new Map<string, () => Promise<void>>();
  const calls: string[] = [];
  registerCronJobs((_name, schedule, handler) => {
    handlers.set(schedule, handler);
  }, {
    uptime: () => {
      calls.push("sites");
      return Promise.resolve();
    },
    daily: () => {
      calls.push("daily with backup");
      return Promise.resolve();
    },
    backup: () => {
      calls.push("backup only");
      return Promise.resolve();
    },
  });
  assertEquals([...handlers.keys()], ["*/30 * * * *", "0 12 * * *", "0 0 * * *"]);
  await handlers.get("*/30 * * * *")!();
  assertEquals(calls, ["sites"]);
  await handlers.get("0 12 * * *")!();
  await handlers.get("0 0 * * *")!();
  assertEquals(calls, ["sites", "daily with backup", "backup only"]);
});

Deno.test("noon sends a missing-backup warning and reuses its single read in the heartbeat", async () => {
  let reads = 0;
  const warnings: string[] = [];
  const heartbeats: string[] = [];
  const fetchFn: typeof fetch = () => {
    reads++;
    return Promise.resolve(Response.json({ newestGoodRun: "none", lastRunFailed: true }));
  };
  await runDailyHeartbeatCheck(
    () => Promise.resolve([]),
    (_results, summary) => {
      heartbeats.push(summary);
      return Promise.resolve();
    },
    () =>
      runBackupCheck(fetchFn, (result) => {
        warnings.push(result.summary);
        return Promise.resolve();
      }),
  );
  assertEquals(reads, 1);
  assertEquals(warnings, ["Backup: no good run exists."]);
  assertEquals(heartbeats, warnings);
});

Deno.test("noon sends heartbeat even if backup warning email fails to send", async () => {
  let heartbeatSent = false;
  let receivedSummary = "";
  const mockRunAll = () =>
    Promise.resolve([
      { config: dummyTarget, success: true, status: 200 },
    ]);
  const mockSendHeartbeat = (_results: CheckResult[], summary: string) => {
    heartbeatSent = true;
    receivedSummary = summary;
    return Promise.resolve();
  };

  const failingBackupCheck = () =>
    runBackupCheck(
      () => Promise.resolve(Response.json({ newestGoodRun: "none" })),
      () => Promise.reject(new Error("Gmail API 500")),
    );

  await runDailyHeartbeatCheck(mockRunAll, mockSendHeartbeat, failingBackupCheck);
  assertEquals(heartbeatSent, true);
  assertEquals(receivedSummary, "Backup: no good run exists.");
});

Deno.test("noon sends heartbeat even if backup check throws generic error", async () => {
  let heartbeatSent = false;
  let receivedSummary = "";
  const mockRunAll = () =>
    Promise.resolve([
      { config: dummyTarget, success: true, status: 200 },
    ]);
  const mockSendHeartbeat = (_results: CheckResult[], summary: string) => {
    heartbeatSent = true;
    receivedSummary = summary;
    return Promise.resolve();
  };

  const genericFailingCheck = () => Promise.reject(new Error("unexpected error"));

  await runDailyHeartbeatCheck(mockRunAll, mockSendHeartbeat, genericFailingCheck);
  assertEquals(heartbeatSent, true);
  assertEquals(receivedSummary, "Backup: status check failed.");
});

function makeRequest(url: string, headers?: Record<string, string>): Request {
  return new Request(url, headers ? { headers } : undefined);
}

Deno.test("handleHttpReq responds to /test-heartbeat endpoint when authenticated", async () => {
  Deno.env.set("UPTIME_TEST_KEY", "s3cret-key");
  try {
    let called = false;
    const mockHeartbeat = () => {
      called = true;
      return Promise.resolve();
    };
    const req = makeRequest("https://example.com/test-heartbeat", { "x-test-key": "s3cret-key" });
    const res = await handleHttpReq(req, mockHeartbeat);
    assertEquals(res.status, 200);
    assertEquals(called, true);
    assertEquals(await res.text(), "Heartbeat email dispatched successfully!");
  } finally {
    Deno.env.delete("UPTIME_TEST_KEY");
  }
});

Deno.test("handleHttpReq handles /test-heartbeat failure with 500 when authenticated", async () => {
  Deno.env.set("UPTIME_TEST_KEY", "s3cret-key");
  try {
    const mockHeartbeat = () => Promise.reject(new Error("SMTP Connection Failed"));
    const req = makeRequest("https://example.com/test-heartbeat", { "x-test-key": "s3cret-key" });
    const res = await handleHttpReq(req, mockHeartbeat);
    assertEquals(res.status, 500);
    assertEquals(await res.text(), "Heartbeat email failed: SMTP Connection Failed");
  } finally {
    Deno.env.delete("UPTIME_TEST_KEY");
  }
});

Deno.test("handleHttpReq responds to /test-check endpoint when authenticated", async () => {
  Deno.env.set("UPTIME_TEST_KEY", "s3cret-key");
  try {
    let called = false;
    const mockCronCheck = () => {
      called = true;
      return Promise.resolve();
    };
    const req = makeRequest("https://example.com/test-check", { "x-test-key": "s3cret-key" });
    const res = await handleHttpReq(req, undefined, mockCronCheck);
    assertEquals(res.status, 200);
    assertEquals(called, true);
    assertEquals(await res.text(), "Uptime check completed successfully!");
  } finally {
    Deno.env.delete("UPTIME_TEST_KEY");
  }
});

Deno.test("handleHttpReq handles /test-check failure with 500 when authenticated", async () => {
  Deno.env.set("UPTIME_TEST_KEY", "s3cret-key");
  try {
    const mockCronCheck = () => Promise.reject(new Error("Check Failed"));
    const req = makeRequest("https://example.com/test-check", { "x-test-key": "s3cret-key" });
    const res = await handleHttpReq(req, undefined, mockCronCheck);
    assertEquals(res.status, 500);
    assertEquals(await res.text(), "Uptime check failed: Check Failed");
  } finally {
    Deno.env.delete("UPTIME_TEST_KEY");
  }
});

Deno.test("handleHttpReq returns default 200 response for root path", async () => {
  const req = new Request("https://example.com/");
  const res = await handleHttpReq(req);
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "WebJam Uptime Monitor active 24/7");
});

Deno.test("handleHttpReq test endpoints authentication closed list", async () => {
  const endpoints = ["/test-check", "/test-heartbeat"] as const;

  for (const endpoint of endpoints) {
    const execute = async (
      req: Request,
      settingValue?: string | null,
    ): Promise<{ status: number; ran: boolean }> => {
      let ran = false;
      const prevSetting = Deno.env.get("UPTIME_TEST_KEY");
      try {
        if (settingValue === null || settingValue === undefined) {
          Deno.env.delete("UPTIME_TEST_KEY");
        } else {
          Deno.env.set("UPTIME_TEST_KEY", settingValue);
        }

        const mockHeartbeat = () => {
          ran = true;
          return Promise.resolve();
        };
        const mockCronCheck = () => {
          ran = true;
          return Promise.resolve();
        };

        const res = await handleHttpReq(req, mockHeartbeat, mockCronCheck);
        return { status: res.status, ran };
      } finally {
        if (prevSetting !== undefined) {
          Deno.env.set("UPTIME_TEST_KEY", prevSetting);
        } else {
          Deno.env.delete("UPTIME_TEST_KEY");
        }
      }
    };

    // Case 1: No x-test-key header: 404, nothing runs.
    {
      const req = makeRequest(`https://example.com${endpoint}`);
      const { status, ran } = await execute(req, "s3cret-key");
      assertEquals(status, 404);
      assertEquals(ran, false);
    }

    // Case 2: x-test-key: with an empty value: 404, nothing runs.
    {
      const req = makeRequest(`https://example.com${endpoint}`, { "x-test-key": "" });
      const { status, ran } = await execute(req, "s3cret-key");
      assertEquals(status, 404);
      assertEquals(ran, false);
    }

    // Case 3: x-test-key: wrong: 404, nothing runs.
    {
      const req = makeRequest(`https://example.com${endpoint}`, { "x-test-key": "wrong" });
      const { status, ran } = await execute(req, "s3cret-key");
      assertEquals(status, 404);
      assertEquals(ran, false);
    }

    // Case 4: x-test-key: S3CRET-KEY: 404, nothing runs.
    {
      const req = makeRequest(`https://example.com${endpoint}`, { "x-test-key": "S3CRET-KEY" });
      const { status, ran } = await execute(req, "s3cret-key");
      assertEquals(status, 404);
      assertEquals(ran, false);
    }

    // Case 5 note: Per HTTP/Fetch spec, Request and Headers normalize header
    // values by stripping leading and trailing whitespace ("s3cret-key " normalizes
    // to "s3cret-key"), meaning a trailing space cannot reach the handler over HTTP.
    // Document this normalization on real Request and assert separately on an
    // unnormalized stub that trailing space fails exact matching and yields 404.
    {
      const realReq = makeRequest(`https://example.com${endpoint}`, {
        "x-test-key": "s3cret-key ",
      });
      assertEquals(realReq.headers.get("x-test-key"), "s3cret-key");

      const stubReq = new Request(`https://example.com${endpoint}`);
      Object.defineProperty(stubReq, "headers", {
        value: {
          get: (name: string) => name.toLowerCase() === "x-test-key" ? "s3cret-key " : null,
        },
      });
      const { status, ran } = await execute(stubReq, "s3cret-key");
      assertEquals(status, 404);
      assertEquals(ran, false);
    }

    // Case 6: x-test-key: s3cret-key: the test runs.
    {
      const req = makeRequest(`https://example.com${endpoint}`, { "x-test-key": "s3cret-key" });
      const { status, ran } = await execute(req, "s3cret-key");
      assertEquals(status, 200);
      assertEquals(ran, true);
    }

    // Case 7: ?key=s3cret-key in the address with no header: 404, nothing runs.
    {
      const req = makeRequest(`https://example.com${endpoint}?key=s3cret-key`);
      const { status, ran } = await execute(req, "s3cret-key");
      assertEquals(status, 404);
      assertEquals(ran, false);
    }

    // Case 8: The setting absent and x-test-key: s3cret-key sent: 404, nothing runs.
    {
      const req = makeRequest(`https://example.com${endpoint}`, { "x-test-key": "s3cret-key" });
      const { status, ran } = await execute(req, null);
      assertEquals(status, 404);
      assertEquals(ran, false);
    }

    // Case 9: The setting present and empty and x-test-key: sent: 404, nothing runs.
    {
      const req = makeRequest(`https://example.com${endpoint}`, { "x-test-key": "" });
      const { status, ran } = await execute(req, "");
      assertEquals(status, 404);
      assertEquals(ran, false);
    }
  }

  // Case 10: / with no header: the plain "active" reply, as today.
  {
    const req = makeRequest("https://example.com/");
    const res = await handleHttpReq(req);
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "WebJam Uptime Monitor active 24/7");
  }
});
