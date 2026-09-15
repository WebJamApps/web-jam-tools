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
  isAllowedModelSlug,
} from "../hooks/lib/check_agy_model.ts";

const SCRIPT_PATH = new URL("../hooks/lib/check_agy_model.ts", import.meta.url).pathname;

Deno.test("isAllowedModelSlug: accepts valid Flash slugs including -tiered at or above 3.7 floor", () => {
  // Current generation (3.8)
  assert(isAllowedModelSlug("gemini-3.8-flash-tiered"));
  assert(isAllowedModelSlug("gemini-3.8-flash-high"));
  assert(isAllowedModelSlug("gemini-3.8-flash-medium"));

  // Floor generation (3.7)
  assert(isAllowedModelSlug("gemini-3.7-flash-tiered"));
  assert(isAllowedModelSlug("gemini-3.7-flash-high"));
  assert(isAllowedModelSlug("gemini-3.7-flash-medium"));

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

Deno.test("ALLOWED_SESSION_SLUGS contains gemini-3.8-flash-tiered", () => {
  assert(ALLOWED_SESSION_SLUGS.includes("gemini-3.8-flash-tiered"));
  assert(ALLOWED_SESSION_SLUGS.includes("gemini-3.8-flash-high"));
  assert(ALLOWED_SESSION_SLUGS.includes("gemini-3.8-flash-medium"));
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
  assert(outStr.includes("gemini-3.8-flash-medium"));
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
  assertEquals(outStr, ALLOWED_AGY_MODELS.map((m) => m.displayName).join("|"));
  assertEquals(outStr, "Gemini 3.8 Flash (High)|Gemini 3.8 Flash (Medium)");
});
