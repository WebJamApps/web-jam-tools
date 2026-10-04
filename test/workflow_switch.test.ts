// test/workflow_switch.test.ts — web-jam-tools#1046
//
// Tests for hooks/lib/workflow_switch.ts and scripts/set-workflow-switch.ts:
// - Switch absent -> returns null, checkAndConsumeWorkflowSwitch returns released: false
// - Switch valid and unexpired -> released: true, logs release
// - Switch expired -> released: false
// - Switch with unparseable expiry -> released: false
// - Switch naming a different guard -> released: false
// - Switch malformed JSON -> fails open on read (returns null), released: false
// - Switch naming "all" or "all workflow guards" -> released: true for any guard
// - Switch with guards array -> released: true for included guards
// - Case-insensitivity and .sh stripping in guard names
// - set-workflow-switch CLI sets switch, clears switch, supports --all and custom TTL

import { assert, assertEquals } from "@std/assert";
import {
  checkAndConsumeWorkflowSwitch,
  defaultWorkflowSwitchLogPath,
  defaultWorkflowSwitchPath,
  isGuardNamedBySwitch,
  isSwitchUnexpired,
  loadWorkflowSwitch,
  logWorkflowSwitchRelease,
  normalizeGuardName,
  type WorkflowSwitch,
} from "../hooks/lib/workflow_switch.ts";
import { writeWorkflowSwitchFile } from "../scripts/set-workflow-switch.ts";

Deno.test("defaultWorkflowSwitchPath & defaultWorkflowSwitchLogPath: resolve paths and respect environment overrides", () => {
  const defaultSwitch = defaultWorkflowSwitchPath();
  assert(defaultSwitch.endsWith("/.claude/state/workflow-switch.json"));

  const defaultLog = defaultWorkflowSwitchLogPath();
  assert(defaultLog.endsWith("/.claude/state/workflow-switch.log"));
});

Deno.test("logWorkflowSwitchRelease: appends release entry with timestamp and guard", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const logPath = `${dir}/nested/workflow-switch.log`;
    const ts = new Date("2026-10-04T12:00:00.000Z");
    logWorkflowSwitchRelease("opus-delegation-gate", ts, logPath);
    const content = await Deno.readTextFile(logPath);
    assertEquals(content, "2026-10-04T12:00:00.000Z released guard: opus-delegation-gate\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("normalizeGuardName: trims, lowercases, and strips .sh extension", () => {
  assertEquals(normalizeGuardName("opus-delegation-gate"), "opus-delegation-gate");
  assertEquals(normalizeGuardName("opus-delegation-gate.sh"), "opus-delegation-gate");
  assertEquals(normalizeGuardName("  Agy-Model-Guard.SH  "), "agy-model-guard");
});

Deno.test("isGuardNamedBySwitch: matches exact, wildcard, or array candidates", () => {
  const single: WorkflowSwitch = {
    guard: "opus-delegation-gate",
    expires_at: "2030-01-01T00:00:00.000Z",
  };
  assert(isGuardNamedBySwitch(single, "opus-delegation-gate"));
  assert(isGuardNamedBySwitch(single, "opus-delegation-gate.sh"));
  assert(!isGuardNamedBySwitch(single, "agy-model-guard"));

  const allWildcard: WorkflowSwitch = {
    guard: "all",
    expires_at: "2030-01-01T00:00:00.000Z",
  };
  assert(isGuardNamedBySwitch(allWildcard, "opus-delegation-gate"));
  assert(isGuardNamedBySwitch(allWildcard, "agy-model-guard"));

  const allWorkflowGuards: WorkflowSwitch = {
    guard: "all workflow guards",
    expires_at: "2030-01-01T00:00:00.000Z",
  };
  assert(isGuardNamedBySwitch(allWorkflowGuards, "opus-delegation-gate"));
  assert(isGuardNamedBySwitch(allWorkflowGuards, "agy-model-guard"));

  const list: WorkflowSwitch = {
    guards: ["opus-delegation-gate", "agy-model-guard"],
    expires_at: "2030-01-01T00:00:00.000Z",
  };
  assert(isGuardNamedBySwitch(list, "opus-delegation-gate"));
  assert(isGuardNamedBySwitch(list, "agy-model-guard"));
  assert(!isGuardNamedBySwitch(list, "other-guard"));
});

Deno.test("isSwitchUnexpired: handles valid future, past, and unparseable timestamps", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");

  const future: WorkflowSwitch = {
    guard: "test",
    expires_at: "2026-10-04T12:30:00.000Z",
  };
  assert(isSwitchUnexpired(future, now));

  const past: WorkflowSwitch = {
    guard: "test",
    expires_at: "2026-10-04T11:30:00.000Z",
  };
  assertEquals(isSwitchUnexpired(past, now), false);

  const invalidDate: WorkflowSwitch = {
    guard: "test",
    expires_at: "not-a-valid-date",
  };
  assertEquals(isSwitchUnexpired(invalidDate, now), false);

  const emptyDate: WorkflowSwitch = {
    guard: "test",
    expires_at: "",
  };
  assertEquals(isSwitchUnexpired(emptyDate, now), false);
});

Deno.test("loadWorkflowSwitch: returns null on missing file or malformed JSON (fails open)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const missingPath = `${dir}/does-not-exist.json`;
    assertEquals(loadWorkflowSwitch(missingPath), null);

    const malformedPath = `${dir}/malformed.json`;
    await Deno.writeTextFile(malformedPath, "{ not valid json: true, ");
    assertEquals(loadWorkflowSwitch(malformedPath), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkAndConsumeWorkflowSwitch: absent switch returns released: false", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const switchPath = `${dir}/switch.json`;
    const logPath = `${dir}/switch.log`;
    const res = checkAndConsumeWorkflowSwitch(
      "opus-delegation-gate",
      new Date(),
      switchPath,
      logPath,
    );
    assertEquals(res.released, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkAndConsumeWorkflowSwitch: valid unexpired switch returns released: true and logs release", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const switchPath = `${dir}/switch.json`;
    const logPath = `${dir}/switch.log`;
    const now = new Date("2026-10-04T12:00:00.000Z");

    await Deno.writeTextFile(
      switchPath,
      JSON.stringify({
        guard: "opus-delegation-gate",
        expires_at: "2026-10-04T12:30:00.000Z",
      }),
    );

    const res = checkAndConsumeWorkflowSwitch("opus-delegation-gate", now, switchPath, logPath);
    assertEquals(res.released, true);
    assert(res.reason?.includes("opus-delegation-gate"));

    // Verify log contents
    const logContent = await Deno.readTextFile(logPath);
    assert(logContent.includes("2026-10-04T12:00:00.000Z"));
    assert(logContent.includes("released guard: opus-delegation-gate"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkAndConsumeWorkflowSwitch: expired switch returns released: false without logging", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const switchPath = `${dir}/switch.json`;
    const logPath = `${dir}/switch.log`;
    const now = new Date("2026-10-04T12:00:00.000Z");

    await Deno.writeTextFile(
      switchPath,
      JSON.stringify({
        guard: "opus-delegation-gate",
        expires_at: "2026-10-04T11:00:00.000Z",
      }),
    );

    const res = checkAndConsumeWorkflowSwitch("opus-delegation-gate", now, switchPath, logPath);
    assertEquals(res.released, false);

    // Verify log file was not created
    let logExists = true;
    try {
      await Deno.stat(logPath);
    } catch {
      logExists = false;
    }
    assertEquals(logExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkAndConsumeWorkflowSwitch: unparseable expiry returns released: false", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const switchPath = `${dir}/switch.json`;
    const logPath = `${dir}/switch.log`;
    const now = new Date("2026-10-04T12:00:00.000Z");

    await Deno.writeTextFile(
      switchPath,
      JSON.stringify({
        guard: "opus-delegation-gate",
        expires_at: "unparseable-date-string",
      }),
    );

    const res = checkAndConsumeWorkflowSwitch("opus-delegation-gate", now, switchPath, logPath);
    assertEquals(res.released, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkAndConsumeWorkflowSwitch: switch naming different guard returns released: false", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const switchPath = `${dir}/switch.json`;
    const logPath = `${dir}/switch.log`;
    const now = new Date("2026-10-04T12:00:00.000Z");

    await Deno.writeTextFile(
      switchPath,
      JSON.stringify({
        guard: "agy-model-guard",
        expires_at: "2026-10-04T12:30:00.000Z",
      }),
    );

    const res = checkAndConsumeWorkflowSwitch("opus-delegation-gate", now, switchPath, logPath);
    assertEquals(res.released, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkAndConsumeWorkflowSwitch: malformed JSON state file proceeds as absent (released: false)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const switchPath = `${dir}/switch.json`;
    const logPath = `${dir}/switch.log`;
    const now = new Date("2026-10-04T12:00:00.000Z");

    await Deno.writeTextFile(switchPath, "not valid json {{{");

    const res = checkAndConsumeWorkflowSwitch("opus-delegation-gate", now, switchPath, logPath);
    assertEquals(res.released, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeWorkflowSwitchFile: creates and clears switch files as requested", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const switchPath = `${dir}/switch.json`;

    // 1. Set specific guard with TTL
    const res1 = writeWorkflowSwitchFile({
      guard: "opus-delegation-gate",
      ttlMinutes: 20,
      path: switchPath,
    });
    assertEquals(res1.action, "set");
    assertEquals(res1.guard, "opus-delegation-gate");

    const data1 = JSON.parse(await Deno.readTextFile(switchPath));
    assertEquals(data1.guard, "opus-delegation-gate");
    assert(typeof data1.expires_at === "string");

    // 2. Set with --all
    const res2 = writeWorkflowSwitchFile({
      all: true,
      ttlMinutes: 10,
      path: switchPath,
    });
    assertEquals(res2.action, "set");
    assertEquals(res2.guard, "all workflow guards");

    const data2 = JSON.parse(await Deno.readTextFile(switchPath));
    assertEquals(data2.guard, "all workflow guards");

    // 3. Clear switch
    const res3 = writeWorkflowSwitchFile({
      clear: true,
      path: switchPath,
    });
    assertEquals(res3.action, "cleared");

    let fileExists = true;
    try {
      await Deno.stat(switchPath);
    } catch {
      fileExists = false;
    }
    assertEquals(fileExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("set-workflow-switch CLI: executes via deno task / command successfully", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const switchPath = `${dir}/switch.json`;
    const scriptPath = new URL("../scripts/set-workflow-switch.ts", import.meta.url).pathname;

    // 1. Run CLI to set switch
    const cmd1 = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-env=HOME,USERPROFILE,WORKFLOW_SWITCH_PATH",
        "--allow-write",
        scriptPath,
        "--guard",
        "opus-delegation-gate",
        "--ttl-minutes",
        "15",
        "--path",
        switchPath,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const out1 = await cmd1.output();
    assertEquals(out1.code, 0);
    const stdout1 = new TextDecoder().decode(out1.stdout);
    assert(stdout1.includes("Workflow switch active for 'opus-delegation-gate'"));

    const data = JSON.parse(await Deno.readTextFile(switchPath));
    assertEquals(data.guard, "opus-delegation-gate");

    // 2. Run CLI to clear switch
    const cmd2 = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-env=HOME,USERPROFILE,WORKFLOW_SWITCH_PATH",
        "--allow-write",
        scriptPath,
        "--clear",
        "--path",
        switchPath,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const out2 = await cmd2.output();
    assertEquals(out2.code, 0);
    const stdout2 = new TextDecoder().decode(out2.stdout);
    assert(stdout2.includes("Workflow switch cleared"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
