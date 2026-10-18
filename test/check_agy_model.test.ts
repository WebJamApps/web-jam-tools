// test/check_agy_model.test.ts — web-jam-tools#1018
//
// Automated unit tests for hooks/lib/check_agy_model.ts.
// Exercises isAllowedModelSlug, checkAgyModel, and CLI flag outputs,
// explicitly testing the -tiered slug across all conditions and the >= 3.7 floor.

import { assert, assertEquals } from "@std/assert";
import {
  ALLOWED_AGY_MODELS,
  ALLOWED_SESSION_SLUGS,
  checkAgyModel,
  DEFAULT_AGY_MODELS,
  deriveSessionSlugs,
  isAllowedModelSlug,
} from "../hooks/lib/check_agy_model.ts";

const SCRIPT_PATH = new URL("../hooks/lib/check_agy_model.ts", import.meta.url).pathname;

Deno.test("isAllowedModelSlug: accepts valid Flash slugs including -tiered at or above 3.7 floor", () => {
  // Current generation (3.8)
  assert(isAllowedModelSlug("gemini-3.8-flash-tiered"));
  assert(isAllowedModelSlug("gemini-3.8-flash-high"));
  assert(!isAllowedModelSlug("gemini-3.8-flash-medium")); // retired, web-jam-tools#1202

  // Floor generation (3.7)
  assert(isAllowedModelSlug("gemini-3.7-flash-tiered"));
  assert(isAllowedModelSlug("gemini-3.7-flash-high"));
  assert(!isAllowedModelSlug("gemini-3.7-flash-medium"));

  // Future major / minor versions
  assert(isAllowedModelSlug("gemini-3.9-flash-tiered"));
  assert(isAllowedModelSlug("gemini-4.0-flash-tiered"));
  assert(isAllowedModelSlug("gemini-4.0-flash-high"));
});

Deno.test("isAllowedModelSlug: rejects below-floor, flash-low, and non-Flash slugs", () => {
  // Below 3.7 floor
  assert(!isAllowedModelSlug("gemini-3.6-flash-tiered"));
  assert(!isAllowedModelSlug("gemini-3.6-flash-high"));
  assert(!isAllowedModelSlug("gemini-3.6-flash-medium"));
  assert(!isAllowedModelSlug("gemini-3.5-flash-tiered"));
  assert(!isAllowedModelSlug("gemini-3.0-flash-tiered"));

  // Forbidden tier variants (flash-low is explicitly blocked)
  assert(!isAllowedModelSlug("gemini-3.8-flash-low"));
  assert(!isAllowedModelSlug("gemini-3.7-flash-low"));

  // Non-Flash / other models
  assert(!isAllowedModelSlug("gemini-3.1-pro"));
  assert(!isAllowedModelSlug("claude-sonnet-4-6"));
  assert(!isAllowedModelSlug("claude-opus-4-6-thinking"));
  assert(!isAllowedModelSlug("gpt-oss-120b-medium"));
  assert(!isAllowedModelSlug(""));
  assert(!isAllowedModelSlug("flash"));
});

Deno.test("checkAgyModel: permits agy invocations using gemini-3.8-flash-tiered", () => {
  assertEquals(checkAgyModel("agy --model gemini-3.8-flash-tiered"), "OK");
  assertEquals(checkAgyModel("agy --model=gemini-3.8-flash-tiered"), "OK");
  assertEquals(checkAgyModel("agy --model gemini-3.8-flash-tiered -i 'hello'"), "OK");
  assertEquals(checkAgyModel("agy --model gemini-3.7-flash-tiered"), "OK");
  assertEquals(checkAgyModel("AGY_MODELS=gemini-3.8-flash-tiered agy"), "OK");
  assertEquals(
    checkAgyModel("AGY_MODELS='gemini-3.8-flash-high|gemini-3.8-flash-tiered' agy"),
    "OK",
  );
});

Deno.test("checkAgyModel: blocks agy invocations using below-floor, flash-low, or non-Flash models", () => {
  assertEquals(
    checkAgyModel("agy --model gemini-3.6-flash-tiered"),
    "BLOCK_MODEL:gemini-3.6-flash-tiered",
  );
  assertEquals(
    checkAgyModel("agy --model gemini-3.8-flash-low"),
    "BLOCK_MODEL:gemini-3.8-flash-low",
  );
  assertEquals(
    checkAgyModel("agy --model=claude-opus-4-6-thinking"),
    "BLOCK_MODEL:claude-opus-4-6-thinking",
  );
  assertEquals(
    checkAgyModel("AGY_MODELS=gemini-3.6-flash-tiered agy"),
    "BLOCK_ENV:gemini-3.6-flash-tiered",
  );
  assertEquals(
    checkAgyModel("AGY_MODELS=gemini-3.8-flash-low agy"),
    "BLOCK_ENV:gemini-3.8-flash-low",
  );
  assertEquals(
    checkAgyModel("AGY_MODELS=claude-opus-4-6-thinking agy"),
    "BLOCK_ENV:claude-opus-4-6-thinking",
  );
});

Deno.test("ALLOWED_SESSION_SLUGS derives -tiered slug matching ALLOWED_AGY_MODELS versions", () => {
  const versions = Array.from(
    new Set(
      ALLOWED_AGY_MODELS.map((m) => m.slug.match(/^gemini-(\d+(?:\.\d+)*)-flash-/)?.[1]).filter(
        (v): v is string => Boolean(v),
      ),
    ),
  );
  assert(versions.length > 0, "Expected at least one version in ALLOWED_AGY_MODELS");
  for (const v of versions) {
    assert(
      ALLOWED_SESSION_SLUGS.includes(`gemini-${v}-flash-tiered`),
      `Expected ALLOWED_SESSION_SLUGS to include gemini-${v}-flash-tiered`,
    );
  }
  // Verify it contains no stale versions that are not present in ALLOWED_AGY_MODELS
  // Argon has no -tiered variant, so only Flash slugs carry a version token.
  for (const slug of ALLOWED_SESSION_SLUGS.filter((s) => s.includes("-flash-"))) {
    const v = slug.match(/^gemini-(\d+(?:\.\d+)*)-flash-/)?.[1];
    assert(v && versions.includes(v), `Unexpected version ${v} in ALLOWED_SESSION_SLUGS`);
  }
});

Deno.test("deriveSessionSlugs: derives tiered slug in lockstep with model versions on migration", () => {
  const syntheticModels = [
    { slug: "gemini-3.9-flash-high", displayName: "Gemini 3.9 Flash (High)" },
  ];
  const slugs = deriveSessionSlugs(syntheticModels);
  assertEquals(slugs, [
    "gemini-3.9-flash-high",
    "gemini-3.9-flash-tiered",
  ]);
});

Deno.test("check_agy_model.ts CLI --allowed-slugs includes gemini-3.8-flash-tiered", async () => {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--no-config", SCRIPT_PATH, "--allowed-slugs"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  const outStr = new TextDecoder().decode(stdout).trim();
  assert(outStr.includes("gemini-3.8-flash-tiered"));
  assert(outStr.includes("gemini-3.8-flash-high"));
  assert(!outStr.includes("gemini-3.8-flash-medium"));
});

Deno.test("check_agy_model.ts CLI --default-models preserves default chain display names", async () => {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--no-config", SCRIPT_PATH, "--default-models"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  const outStr = new TextDecoder().decode(stdout).trim();
  assertEquals(outStr, DEFAULT_AGY_MODELS.map((m) => m.displayName).join("|"));
  // Argon is allowed but is not in the default chain: it runs only when a dispatch names it.
  assert(ALLOWED_AGY_MODELS.some((m) => m.displayName === "Gemini 4 Argon (High)"));
  assert(!outStr.includes("Argon"));
  assert(!outStr.includes("Sonnet"));
  // web-jam-tools#1202: Gemini Flash runs at high effort only, so the medium level is not dispatched on.
  assertEquals(outStr, "Gemini 3.8 Flash (High)");
});

// --- Gemini 4 Argon at high, and agy behind another command (tier-order design 1.5.0) ---

Deno.test("ALLOWED_AGY_MODELS lists Flash, Argon and Sonnet high and nothing else", () => {
  assertEquals(ALLOWED_AGY_MODELS.map((m) => [m.slug, m.displayName]), [
    ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
    ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
    ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
  ]);
  assert(ALLOWED_SESSION_SLUGS.includes("gemini-4-argon-high"));
});

Deno.test("isAllowedModelSlug: accepts Argon at high only", () => {
  assert(isAllowedModelSlug("gemini-4-argon-high"));
  assert(!isAllowedModelSlug("gemini-4-argon-medium"));
  assert(!isAllowedModelSlug("gemini-4-argon-low"));
  assert(!isAllowedModelSlug("gemini-4-argon-tiered"));
  assert(!isAllowedModelSlug("gemini-5-argon-high"));
});

const OK_COMMANDS = [
  `agy --model claude-sonnet-5-5-high -p="x"`,
  `agy --model "Claude Sonnet 5.5 (High)" -p="x"`,
  `AGY_MODELS='Claude Sonnet 5.5 (High)' scripts/handle-agy-tasks.sh --headless "web-jam-tools#fixture"`,
  `timeout 180 agy --model claude-sonnet-5-5-high -p="x"`,
  `nohup agy --model "Claude Sonnet 5.5 (High)" -p="x"`,
  `time -p agy --model claude-sonnet-5-5-high -p=x`,
  `exec -a worker agy --model claude-sonnet-5-5-high -p=x`,
  `env AGY_MODELS=claude-sonnet-5-5-high timeout 180 agy -p=x`,
  `env AGY_MODELS=claude-sonnet-5-5-high bash -c "agy -p=x"`,
  `env AGY_MODELS=gemini-4-argon-low env AGY_MODELS=claude-sonnet-5-5-high agy`,
  `agy --model gemini-4-argon-high -p="x"`,
  `agy --model "Gemini 4 Argon (High)" -p="x"`,
  `AGY_MODELS='Gemini 4 Argon (High)' handle-agy-tasks.sh --headless "JaMmusic#1"`,
  `agy --model gemini-3.8-flash-high -p="x"`,
  `agy -p="x"`,
  `AGY_MODELS='Gemini 4 Argon (High)|Gemini 3.8 Flash (High)' agy -p="x"`,
  `timeout 180 agy --model gemini-4-argon-high -p="x"`,
  `bash -c 'agy --model "Gemini 4 Argon (High)" -p="x"'`,
  `echo "agy it's mentioned" > /dev/null`,
  `ls -la`,
];

for (const cmd of OK_COMMANDS) {
  Deno.test(`checkAgyModel: OK for ${cmd}`, () => {
    assertEquals(checkAgyModel(cmd), "OK");
  });
}

const REFUSED_COMMANDS = [
  `agy --model claude-sonnet-5-5-low -p="x"`,
  `agy --model claude-sonnet-5-5-medium -p="x"`,
  `agy --model "Claude Sonnet 5.5 (Medium)" -p="x"`,
  `agy --model claude-opus-5-5-high -p="x"`,
  `agy --model gpt-oss-120b-medium -p="x"`,
  `nice agy --model claude-sonnet-5-5-medium -p="x"`,
  `env FOO=1 agy --model claude-sonnet-5-5-low -p="x"`,
  `command agy --model claude-sonnet-5-5-low -p="x"`,
  `exec agy --model claude-sonnet-5-5-low -p="x"`,
  `time agy --model claude-sonnet-5-5-low -p="x"`,
  `sudo agy --model claude-sonnet-5-5-low -p="x"`,
  `bash -c 'agy --model claude-sonnet-5-5-low -p="x"'`,
  `sh -c "agy --model claude-sonnet-5-5-low -p=x"`,
  `/home/joshua/.local/bin/agy --model claude-sonnet-5-5-low -p="x"`,
  `time -p agy --model gemini-4-argon-low -p=x`,
  `exec -a worker agy --model gemini-4-argon-low -p=x`,
  `env AGY_MODELS=gemini-4-argon-low timeout 180 agy -p=x`,
  `env AGY_MODELS=gemini-4-argon-low bash -c "agy -p=x"`,
  `agy --model gemini-4-argon-medium -p="x"`,
  `agy --model gemini-4-argon-low -p="x"`,
  `agy --model "Gemini 4 Argon (Medium)" -p="x"`,
  `agy --model "Claude Opus 5.5 (High)" -p="x"`,
  `timeout 180 agy --model "Claude Opus 5.5 (High)" -p="x"`,
  `cd /tmp && timeout 180 agy --model gemini-4-argon-low -p="x"`,
  `nice agy --model gemini-3.8-flash-medium -p="x"`,
  `env FOO=1 agy --model gemini-4-argon-low -p="x"`,
  `command agy --model gemini-4-argon-low -p="x"`,
  `exec agy --model gemini-4-argon-low -p="x"`,
  `time agy --model gemini-4-argon-low -p="x"`,
  `sudo agy --model gemini-4-argon-low -p="x"`,
  `bash -c 'agy --model gemini-4-argon-low -p="x"'`,
  `sh -c "agy --model gemini-4-argon-low -p=x"`,
  `/home/joshua/.local/bin/agy --model gemini-4-argon-low -p="x"`,
  // Stacked wrappers, and wrappers around a shell payload.
  `sudo time nice agy --model gemini-4-argon-low -p="x"`,
  `timeout 5 bash -c 'nohup agy --model gemini-4-argon-low -p="x"'`,
  // AGY_MODELS on the agy command, or carried through env / a shell payload.
  `AGY_MODELS='Gemini 4 Argon (Medium)' agy -p="x"`,
  `env AGY_MODELS=claude-opus-4-6-thinking agy -p="x"`,
  `AGY_MODELS=claude-opus-4-6-thinking bash -c 'agy -p="x"'`,
];

for (const cmd of REFUSED_COMMANDS) {
  Deno.test(`checkAgyModel: refuses ${cmd}`, () => {
    const result = checkAgyModel(cmd);
    assert(
      result !== "OK" && result.startsWith("BLOCK_"),
      `expected a BLOCK_ result, got ${result}`,
    );
  });
}

Deno.test("checkAgyModel: a command that mentions agy and cannot be parsed fails closed", () => {
  assert(checkAgyModel(`agy --model "gemini-3.8-flash-high -p=x`).startsWith("BLOCK_PARSE:"));
  assert(checkAgyModel(`bash -c 'agy --model "gemini-3.8-flash-high'`).startsWith("BLOCK_PARSE:"));
  // Wrappers nested beyond the shared recursion cap.
  let deep = `agy --model gemini-3.8-flash-high`;
  for (let i = 0; i < 8; i++) deep = `bash -c '${deep.replaceAll("'", "'\\''")}'`;
  assert(checkAgyModel(deep).startsWith("BLOCK_PARSE:"));
});

Deno.test("checkAgyModel: an unparseable command that never mentions agy is not this guard's business", () => {
  assertEquals(checkAgyModel(`echo "it's unterminated`), "OK");
});
