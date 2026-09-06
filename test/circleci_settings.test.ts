// circleci_settings.test.ts — Unit tests for CircleCI project settings standard and drift checker
// (web-jam-tools#697)

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import {
  CIRCLECI_API_BASE,
  fetchProjectSettings,
  getCircleCiToken,
  updateProjectSettings,
} from "../src/circleci-settings/api.ts";
import { HELP_TEXT, main } from "../src/circleci-settings/cli.ts";
import { applySettings, checkDrift } from "../src/circleci-settings/sync.ts";
import { type Logger, WEBJAMAPPS_CIRCLECI_PROJECTS } from "../src/circleci-settings/types.ts";

function createMockLogger(): Logger & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
  };
}

Deno.test("getCircleCiToken: returns token when set", () => {
  const env = {
    get: (key: string) => (key === "CIRCLECI_TOKEN" ? "  test-token-12345  " : undefined),
  };
  const token = getCircleCiToken(env);
  assertEquals(token, "test-token-12345");
});

Deno.test("getCircleCiToken: throws when unset or blank", () => {
  const envUnset = { get: () => undefined };
  assertThrows(
    () => getCircleCiToken(envUnset),
    Error,
    "Missing CIRCLECI_TOKEN",
  );

  const envBlank = { get: () => "   " };
  assertThrows(
    () => getCircleCiToken(envBlank),
    Error,
    "Missing CIRCLECI_TOKEN",
  );
});

Deno.test("fetchProjectSettings: sends correct headers and parses autocancel_builds", async () => {
  let capturedUrl = "";
  let capturedHeaders: HeadersInit | undefined;
  let capturedMethod = "";

  const mockFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    capturedUrl = input.toString();
    capturedMethod = init?.method ?? "GET";
    capturedHeaders = init?.headers;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          advanced: {
            autocancel_builds: true,
          },
        }),
        { status: 200 },
      ),
    );
  };

  const settings = await fetchProjectSettings(
    "web-jam-tools",
    "dummy-token",
    mockFetch as typeof fetch,
  );
  assertEquals(capturedUrl, `${CIRCLECI_API_BASE}/web-jam-tools/settings`);
  assertEquals(capturedMethod, "GET");
  assertEquals((capturedHeaders as Record<string, string>)["Circle-Token"], "dummy-token");
  assertEquals((capturedHeaders as Record<string, string>)["Accept"], "application/json");
  assertEquals(settings.autocancel_builds, true);
});

Deno.test("fetchProjectSettings: handles false autocancel_builds and missing advanced object", async () => {
  const mockFetchFalse = (): Promise<Response> => {
    return Promise.resolve(
      new Response(
        JSON.stringify({ advanced: { autocancel_builds: false } }),
        { status: 200 },
      ),
    );
  };
  const settingsFalse = await fetchProjectSettings(
    "JaMmusic",
    "dummy-token",
    mockFetchFalse as typeof fetch,
  );
  assertEquals(settingsFalse.autocancel_builds, false);

  const mockFetchEmpty = (): Promise<Response> => {
    return Promise.resolve(
      new Response(
        JSON.stringify({}),
        { status: 200 },
      ),
    );
  };
  const settingsEmpty = await fetchProjectSettings(
    "AppersonAuto",
    "dummy-token",
    mockFetchEmpty as typeof fetch,
  );
  assertEquals(settingsEmpty.autocancel_builds, false);
});

Deno.test("fetchProjectSettings: throws sanitized error on non-OK response", async () => {
  const mockFetch401 = (): Promise<Response> => {
    return Promise.resolve(
      new Response("Unauthorized", { status: 401 }),
    );
  };

  await assertRejects(
    () => fetchProjectSettings("web-jam-tools", "secret-token", mockFetch401 as typeof fetch),
    Error,
    "GET web-jam-tools/settings failed with HTTP 401: Unauthorized",
  );
});

Deno.test("updateProjectSettings: sends PATCH with correct body and headers", async () => {
  let capturedUrl = "";
  let capturedHeaders: HeadersInit | undefined;
  let capturedMethod = "";
  let capturedBody = "";

  const mockFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    capturedUrl = input.toString();
    capturedMethod = init?.method ?? "GET";
    capturedHeaders = init?.headers;
    capturedBody = init?.body as string;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          advanced: {
            autocancel_builds: true,
          },
        }),
        { status: 200 },
      ),
    );
  };

  const res = await updateProjectSettings(
    "web-jam-tools",
    { advanced: { autocancel_builds: true } },
    "dummy-token",
    mockFetch as typeof fetch,
  );

  assertEquals(capturedUrl, `${CIRCLECI_API_BASE}/web-jam-tools/settings`);
  assertEquals(capturedMethod, "PATCH");
  assertEquals((capturedHeaders as Record<string, string>)["Circle-Token"], "dummy-token");
  assertEquals((capturedHeaders as Record<string, string>)["Content-Type"], "application/json");
  assertEquals(JSON.parse(capturedBody), { advanced: { autocancel_builds: true } });
  assertEquals(res.autocancel_builds, true);
});

Deno.test("updateProjectSettings: throws sanitized error on non-OK response", async () => {
  const mockFetch500 = (): Promise<Response> => {
    return Promise.resolve(
      new Response("Internal Server Error", { status: 500 }),
    );
  };

  await assertRejects(
    () =>
      updateProjectSettings(
        "web-jam-tools",
        { advanced: { autocancel_builds: true } },
        "secret-token",
        mockFetch500 as typeof fetch,
      ),
    Error,
    "PATCH web-jam-tools/settings failed with HTTP 500: Internal Server Error",
  );
});

Deno.test("checkDrift: queries all projects and returns their statuses", async () => {
  const mockDb: Record<string, boolean> = {
    "web-jam-tools": true,
    "JaMmusic": false,
  };

  const mockFetch = (input: string | URL | Request): Promise<Response> => {
    const url = input.toString();
    const match = url.match(/\/WebJamApps\/([^/]+)\/settings/);
    const proj = match ? match[1] : "";
    const isAutocancel = mockDb[proj] ?? false;
    return Promise.resolve(
      new Response(
        JSON.stringify({ advanced: { autocancel_builds: isAutocancel } }),
        { status: 200 },
      ),
    );
  };

  const result = await checkDrift(
    ["web-jam-tools", "JaMmusic"],
    "token",
    mockFetch as typeof fetch,
  );
  assertEquals(result, [
    { project: "web-jam-tools", autocancel_builds: true },
    { project: "JaMmusic", autocancel_builds: false },
  ]);
});

Deno.test("applySettings: updates only drifted projects", async () => {
  const patchCalls: string[] = [];

  const mockFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    const match = url.match(/\/WebJamApps\/([^/]+)\/settings/);
    const proj = match ? match[1] : "";
    if (init?.method === "PATCH") {
      patchCalls.push(proj);
      return Promise.resolve(
        new Response(
          JSON.stringify({ advanced: { autocancel_builds: true } }),
          { status: 200 },
        ),
      );
    }
    // GET
    const isAutocancel = proj === "web-jam-back";
    return Promise.resolve(
      new Response(
        JSON.stringify({ advanced: { autocancel_builds: isAutocancel } }),
        { status: 200 },
      ),
    );
  };

  const result = await applySettings(
    ["web-jam-tools", "web-jam-back"],
    "token",
    mockFetch as typeof fetch,
  );

  assertEquals(patchCalls, ["web-jam-tools"]);
  assertEquals(result, [
    { project: "web-jam-tools", updated: true, autocancel_builds: true },
    { project: "web-jam-back", updated: false, autocancel_builds: true },
  ]);
});

Deno.test("CLI main: handles --help and -h flags", async () => {
  const logger = createMockLogger();
  const env = { get: () => "mock-token" };

  const code1 = await main(["--help"], fetch, env, logger);
  assertEquals(code1, 0);
  assertStringIncludes(logger.logs.join("\n"), HELP_TEXT);

  logger.logs.length = 0;
  const code2 = await main(["-h"], fetch, env, logger);
  assertEquals(code2, 0);
  assertStringIncludes(logger.logs.join("\n"), HELP_TEXT);
});

Deno.test("CLI main: fails cleanly with code 1 when CIRCLECI_TOKEN is missing", async () => {
  const logger = createMockLogger();
  const env = { get: () => undefined };

  const code = await main([], fetch, env, logger);
  assertEquals(code, 1);
  assertStringIncludes(logger.errors.join("\n"), "Missing CIRCLECI_TOKEN");
});

Deno.test("CLI main --check: returns 0 when all 8 projects are in sync", async () => {
  const logger = createMockLogger();
  const token = "secret-token-abc";
  const env = { get: () => token };

  const mockFetch = (): Promise<Response> => {
    return Promise.resolve(
      new Response(
        JSON.stringify({ advanced: { autocancel_builds: true } }),
        { status: 200 },
      ),
    );
  };

  const code = await main(["--check"], mockFetch as typeof fetch, env, logger);
  assertEquals(code, 0);
  const logOutput = logger.logs.join("\n");
  for (const proj of WEBJAMAPPS_CIRCLECI_PROJECTS) {
    assertStringIncludes(logOutput, `[${proj}] autocancel_builds: true (in sync)`);
  }
  assertStringIncludes(logOutput, "All 8 projects have autocancel_builds enabled (in sync).");
  // Ensure token was not logged
  assertEquals(logOutput.includes(token), false);
  assertEquals(logger.errors.length, 0);
});

Deno.test("CLI main --check: returns 1 when drift is detected", async () => {
  const logger = createMockLogger();
  const token = "secret-token-abc";
  const env = { get: () => token };

  const mockFetch = (input: string | URL | Request): Promise<Response> => {
    const url = input.toString();
    const isBack = url.includes("web-jam-back");
    return Promise.resolve(
      new Response(
        JSON.stringify({ advanced: { autocancel_builds: isBack } }),
        { status: 200 },
      ),
    );
  };

  const code = await main(["--check"], mockFetch as typeof fetch, env, logger);
  assertEquals(code, 1);
  const logOutput = logger.logs.join("\n");
  const errorOutput = logger.errors.join("\n");

  assertStringIncludes(logOutput, "[web-jam-tools] autocancel_builds: false (DRIFT)");
  assertStringIncludes(logOutput, "[web-jam-back] autocancel_builds: true (in sync)");
  assertStringIncludes(
    errorOutput,
    "Drift detected: 7 of 8 projects have autocancel_builds disabled. Run 'deno task circleci-settings' to sync.",
  );
  // Ensure token was not logged
  assertEquals(logOutput.includes(token), false);
  assertEquals(errorOutput.includes(token), false);
});

Deno.test("CLI main --check: handles API failure and returns 1", async () => {
  const logger = createMockLogger();
  const token = "secret-token-abc";
  const env = { get: () => token };

  const mockFetch = (): Promise<Response> => {
    return Promise.resolve(
      new Response("Unauthorized", { status: 401 }),
    );
  };

  const code = await main(["--check"], mockFetch as typeof fetch, env, logger);
  assertEquals(code, 1);
  const errorOutput = logger.errors.join("\n");
  assertStringIncludes(errorOutput, "Error checking CircleCI settings");
  assertStringIncludes(errorOutput, "HTTP 401");
  // Ensure token was not logged
  assertEquals(errorOutput.includes(token), false);
});

Deno.test("CLI main (apply mode): updates drifted projects and returns 0", async () => {
  const logger = createMockLogger();
  const token = "secret-token-abc";
  const env = { get: () => token };

  const patchedProjects: string[] = [];

  const mockFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    const match = url.match(/\/WebJamApps\/([^/]+)\/settings/);
    const proj = match ? match[1] : "";

    if (init?.method === "PATCH") {
      patchedProjects.push(proj);
      return Promise.resolve(
        new Response(
          JSON.stringify({ advanced: { autocancel_builds: true } }),
          { status: 200 },
        ),
      );
    }

    const isBack = proj === "web-jam-back";
    return Promise.resolve(
      new Response(
        JSON.stringify({ advanced: { autocancel_builds: isBack } }),
        { status: 200 },
      ),
    );
  };

  const code = await main([], mockFetch as typeof fetch, env, logger);
  assertEquals(code, 0);
  assertEquals(patchedProjects.length, 7);
  assertEquals(patchedProjects.includes("web-jam-back"), false);

  const logOutput = logger.logs.join("\n");
  assertStringIncludes(logOutput, "[web-jam-tools] enabled autocancel_builds");
  assertStringIncludes(logOutput, "[web-jam-back] autocancel_builds is already true (in sync)");
  assertStringIncludes(
    logOutput,
    "Successfully enabled autocancel_builds on 7 project(s). All 8 projects are now in sync.",
  );
  assertEquals(logger.errors.length, 0);
  // Ensure token was not logged
  assertEquals(logOutput.includes(token), false);
});

Deno.test("CLI main (apply mode): reports in-sync when all projects are already true", async () => {
  const logger = createMockLogger();
  const token = "secret-token-abc";
  const env = { get: () => token };

  const mockFetch = (): Promise<Response> => {
    return Promise.resolve(
      new Response(
        JSON.stringify({ advanced: { autocancel_builds: true } }),
        { status: 200 },
      ),
    );
  };

  const code = await main([], mockFetch as typeof fetch, env, logger);
  assertEquals(code, 0);

  const logOutput = logger.logs.join("\n");
  for (const proj of WEBJAMAPPS_CIRCLECI_PROJECTS) {
    assertStringIncludes(logOutput, `[${proj}] autocancel_builds is already true (in sync)`);
  }
  assertStringIncludes(
    logOutput,
    "All 8 projects are already in sync with autocancel_builds enabled.",
  );
  assertEquals(logger.errors.length, 0);
  // Ensure token was not logged
  assertEquals(logOutput.includes(token), false);
});

Deno.test("CLI main (apply mode): handles API failure and returns 1", async () => {
  const logger = createMockLogger();
  const token = "secret-token-abc";
  const env = { get: () => token };

  const mockFetch = (): Promise<Response> => {
    return Promise.resolve(
      new Response("Server Error", { status: 500 }),
    );
  };

  const code = await main([], mockFetch as typeof fetch, env, logger);
  assertEquals(code, 1);
  const errorOutput = logger.errors.join("\n");
  assertStringIncludes(errorOutput, "Error applying CircleCI settings");
  assertStringIncludes(errorOutput, "HTTP 500");
  // Ensure token was not logged
  assertEquals(errorOutput.includes(token), false);
});
