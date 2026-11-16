// Exact agy model allowlist and command regression cases.
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

Deno.test("session slugs are exact: no inferred version or helper variants", () => {
  assertEquals(ALLOWED_SESSION_SLUGS, [
    "gemini-4-hydrogen-high",
    "gemini-4-argon-high",
    "claude-sonnet-5-5-high",
  ]);
  assertEquals(deriveSessionSlugs([{ slug: "gemini-5-hydrogen-high", displayName: "future" }]), [
    "gemini-5-hydrogen-high",
  ]);
  for (
    const slug of [
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-tiered",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-tiered",
      "gemini-3.9-flash-high",
      "gemini-4-flash-high",
      "gemini-4.0-flash-tiered",
      "gemini-3.8-flash-medium",
      "gemini-4-hydrogen-tiered",
      "gemini-5-hydrogen-high",
      "",
      "flash",
    ]
  ) {
    assertEquals(isAllowedModelSlug(slug), false, slug);
  }
});

for (const flag of ["--allowed-slugs", "--default-models"]) {
  Deno.test("model CLI " + flag + " prints only the configured exact values", async () => {
    const result = await new Deno.Command("deno", {
      args: ["run", "--no-config", SCRIPT_PATH, flag],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertEquals(
      new TextDecoder().decode(result.stdout).trim(),
      flag === "--allowed-slugs"
        ? "gemini-4-hydrogen-high or gemini-4-argon-high or claude-sonnet-5-5-high"
        : "Gemini 4 Hydrogen (High)",
    );
  });
}
Deno.test("default retry chain contains only Hydrogen", () => {
  assertEquals(DEFAULT_AGY_MODELS.map((model) => model.displayName), ["Gemini 4 Hydrogen (High)"]);
});

// --- Gemini 4 Argon at high, and agy behind another command (tier-order design 1.5.0) ---

Deno.test("ALLOWED_AGY_MODELS lists Hydrogen, Argon and Sonnet high and nothing else", () => {
  assertEquals(ALLOWED_AGY_MODELS.map((m) => [m.slug, m.displayName]), [
    ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
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
  `agy --model gemini-4-hydrogen-high -p="x"`,
  `agy --model "Gemini 4 Hydrogen (High)" -p="x"`,
  `AGY_MODELS='Gemini 4 Hydrogen (High)' scripts/handle-agy-tasks.sh --headless "web-jam-tools#fixture"`,
  `timeout 180 agy --model gemini-4-hydrogen-high -p="x"`,
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
  `agy --model gemini-4-hydrogen-high -p="x"`,
  `agy -p="x"`,
  `AGY_MODELS='Gemini 4 Argon (High)|Gemini 4 Hydrogen (High)' agy -p="x"`,
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
  `agy --model gemini-4-hydrogen-low -p="x"`,
  `agy --model gemini-4-hydrogen-medium -p="x"`,
  `agy --model gemini-4-hydrogen-xhigh -p="x"`,
  `agy --model "Gemini 4 Hydrogen (XHigh)" -p="x"`,
  `agy --model gemini-3.8-flash-high -p="x"`,
  `agy --model gemini-3.8-flash-tiered -p="x"`,
  `AGY_MODELS='Gemini 3.8 Flash (High)' agy -p="x"`,
  `agy --model gemini-pro-orchestrator-g1-pro -p="x"`,
  `nohup agy --model gemini-3.8-flash-high -p="x"`,
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
  assert(checkAgyModel(`agy --model "gemini-4-hydrogen-high -p=x`).startsWith("BLOCK_PARSE:"));
  assert(checkAgyModel(`bash -c 'agy --model "gemini-4-hydrogen-high'`).startsWith("BLOCK_PARSE:"));
  // Wrappers nested beyond the shared recursion cap.
  let deep = `agy --model gemini-4-hydrogen-high`;
  for (let i = 0; i < 8; i++) deep = `bash -c '${deep.replaceAll("'", "'\\''")}'`;
  assert(checkAgyModel(deep).startsWith("BLOCK_PARSE:"));
});

Deno.test("checkAgyModel: an unparseable command that never mentions agy is not this guard's business", () => {
  assertEquals(checkAgyModel(`echo "it's unterminated`), "OK");
});
