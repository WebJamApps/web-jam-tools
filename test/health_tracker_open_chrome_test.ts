// test/health_tracker_open_chrome_test.ts
// Unit tests for open_chrome.ts in src/health-tracker/ (web-jam-tools#1660).
// Tests display resolution, detached Chrome launch, fallback logging, and environment overrides.

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { openProgressSvgInChrome, resolveDisplayEnv } from "../src/health-tracker/open_chrome.ts";

Deno.test("resolveDisplayEnv uses DISPLAY and XAUTHORITY from environment when present", async () => {
  const origDisplay = Deno.env.get("DISPLAY");
  const origXauth = Deno.env.get("XAUTHORITY");
  try {
    Deno.env.set("DISPLAY", ":42.0");
    Deno.env.set("XAUTHORITY", "/tmp/fake-xauthority");
    const env = await resolveDisplayEnv();
    assertEquals(env.display, ":42.0");
    assertEquals(env.xauthority, "/tmp/fake-xauthority");
  } finally {
    if (origDisplay !== undefined) Deno.env.set("DISPLAY", origDisplay);
    else Deno.env.delete("DISPLAY");
    if (origXauth !== undefined) Deno.env.set("XAUTHORITY", origXauth);
    else Deno.env.delete("XAUTHORITY");
  }
});

Deno.test("resolveDisplayEnv falls back gracefully when DISPLAY is unset", async () => {
  const origDisplay = Deno.env.get("DISPLAY");
  try {
    Deno.env.delete("DISPLAY");
    const env = await resolveDisplayEnv();
    assert(typeof env.display === "string" && env.display.length > 0);
  } finally {
    if (origDisplay !== undefined) Deno.env.set("DISPLAY", origDisplay);
    else Deno.env.delete("DISPLAY");
  }
});

Deno.test("openProgressSvgInChrome returns early when HEALTH_REPORT_SKIP_CHROME=1", async () => {
  const origSkip = Deno.env.get("HEALTH_REPORT_SKIP_CHROME");
  try {
    Deno.env.set("HEALTH_REPORT_SKIP_CHROME", "1");
    // Should not throw or output anything
    await openProgressSvgInChrome("/tmp/nonexistent-graph.svg");
  } finally {
    if (origSkip !== undefined) Deno.env.set("HEALTH_REPORT_SKIP_CHROME", origSkip);
    else Deno.env.delete("HEALTH_REPORT_SKIP_CHROME");
  }
});

Deno.test("openProgressSvgInChrome runs custom bash command from HEALTH_REPORT_CHROME_CMD", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-chrome-cmd-" });
  const marker = path.join(tmpDir, "opened.txt");
  const origCmd = Deno.env.get("HEALTH_REPORT_CHROME_CMD");
  const origSkip = Deno.env.get("HEALTH_REPORT_SKIP_CHROME");
  try {
    Deno.env.delete("HEALTH_REPORT_SKIP_CHROME");
    Deno.env.set("HEALTH_REPORT_CHROME_CMD", `echo opened > "${marker}"`);
    await openProgressSvgInChrome("/tmp/test-graph.svg");
    // Give detached process a moment to execute
    await new Promise((resolve) => setTimeout(resolve, 50));
    const content = await Deno.readTextFile(marker);
    assertEquals(content.trim(), "opened");
  } finally {
    if (origCmd !== undefined) Deno.env.set("HEALTH_REPORT_CHROME_CMD", origCmd);
    else Deno.env.delete("HEALTH_REPORT_CHROME_CMD");
    if (origSkip !== undefined) Deno.env.set("HEALTH_REPORT_SKIP_CHROME", origSkip);
    else Deno.env.delete("HEALTH_REPORT_SKIP_CHROME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("openProgressSvgInChrome prints path when google-chrome cannot be opened", async () => {
  const origCmd = Deno.env.get("HEALTH_REPORT_CHROME_CMD");
  const origSkip = Deno.env.get("HEALTH_REPORT_SKIP_CHROME");
  const origPath = Deno.env.get("PATH");
  const emptyDir = await Deno.makeTempDir({ prefix: "health-no-chrome-" });
  try {
    Deno.env.delete("HEALTH_REPORT_SKIP_CHROME");
    Deno.env.delete("HEALTH_REPORT_CHROME_CMD");
    // Set PATH to empty directory so google-chrome is guaranteed not found
    Deno.env.set("PATH", emptyDir);

    // Capture console.log
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      await openProgressSvgInChrome("/tmp/my-health-progress.svg");
      const absPath = path.resolve("/tmp/my-health-progress.svg");
      assertEquals(logs, [absPath]);
    } finally {
      console.log = origLog;
    }
  } finally {
    if (origCmd !== undefined) Deno.env.set("HEALTH_REPORT_CHROME_CMD", origCmd);
    else Deno.env.delete("HEALTH_REPORT_CHROME_CMD");
    if (origSkip !== undefined) Deno.env.set("HEALTH_REPORT_SKIP_CHROME", origSkip);
    else Deno.env.delete("HEALTH_REPORT_SKIP_CHROME");
    if (origPath !== undefined) Deno.env.set("PATH", origPath);
    else Deno.env.delete("PATH");
    await Deno.remove(emptyDir, { recursive: true });
  }
});

Deno.test("openProgressSvgInChrome spawns detached google-chrome binary when present", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-mock-chrome-" });
  const marker = path.join(tmpDir, "chrome-launched.txt");
  const fakeBinDir = path.join(tmpDir, "bin");
  await Deno.mkdir(fakeBinDir);
  const mockChrome = path.join(fakeBinDir, "google-chrome");

  await Deno.writeTextFile(
    mockChrome,
    `#!/bin/sh\necho "$@" > "${marker}"\n`,
    { mode: 0o755 },
  );

  const origCmd = Deno.env.get("HEALTH_REPORT_CHROME_CMD");
  const origSkip = Deno.env.get("HEALTH_REPORT_SKIP_CHROME");
  const origPath = Deno.env.get("PATH");

  try {
    Deno.env.delete("HEALTH_REPORT_SKIP_CHROME");
    Deno.env.delete("HEALTH_REPORT_CHROME_CMD");
    Deno.env.set("PATH", `${fakeBinDir}:${origPath ?? ""}`);

    const targetSvg = path.join(tmpDir, "progress.svg");
    await Deno.writeTextFile(targetSvg, "<svg></svg>");

    await openProgressSvgInChrome(targetSvg);

    // Give detached process a short moment to write marker
    await new Promise((resolve) => setTimeout(resolve, 50));
    const content = await Deno.readTextFile(marker);
    assert(content.includes(`file://${targetSvg}`));
  } finally {
    if (origCmd !== undefined) Deno.env.set("HEALTH_REPORT_CHROME_CMD", origCmd);
    else Deno.env.delete("HEALTH_REPORT_CHROME_CMD");
    if (origSkip !== undefined) Deno.env.set("HEALTH_REPORT_SKIP_CHROME", origSkip);
    else Deno.env.delete("HEALTH_REPORT_SKIP_CHROME");
    if (origPath !== undefined) Deno.env.set("PATH", origPath);
    else Deno.env.delete("PATH");
    await Deno.remove(tmpDir, { recursive: true });
  }
});
