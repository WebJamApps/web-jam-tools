// jscpd.test.ts — web-jam-tools#761
//
// Verifies .jscpd.json configuration and jscpd task definition in deno.json and CircleCI config.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const JSCPD_JSON_PATH = new URL("../.jscpd.json", import.meta.url).pathname;
const DENO_JSON_PATH = new URL("../deno.json", import.meta.url).pathname;
const CIRCLECI_CONFIG_PATH = new URL("../.circleci/config.yml", import.meta.url).pathname;

Deno.test(".jscpd.json exists and contains valid duplication settings", () => {
  const content = Deno.readTextFileSync(JSCPD_JSON_PATH);
  const config = JSON.parse(content);

  assertEquals(config.threshold, 5, "threshold must be 5%");
  assert(Array.isArray(config.reporters), "reporters must be an array");
  assert(config.reporters.includes("console"), "reporters must include console");
  assert(Array.isArray(config.ignore), "ignore must be an array");
  assert(config.ignore.includes("**/node_modules/**"), "ignore must include node_modules");
  assert(config.ignore.includes("**/coverage/**"), "ignore must include coverage");
});

Deno.test("deno.json defines the jscpd task correctly", () => {
  const content = Deno.readTextFileSync(DENO_JSON_PATH);
  const config = JSON.parse(content);

  assertEquals(
    config.tasks?.jscpd,
    "deno run -A npm:jscpd src/ test/",
    "jscpd task must run npm:jscpd across src/ and test/",
  );
});

Deno.test(".circleci/config.yml integrates deno task jscpd into CI gate", () => {
  const content = Deno.readTextFileSync(CIRCLECI_CONFIG_PATH);
  assertStringIncludes(
    content,
    "deno task jscpd",
    ".circleci/config.yml must run deno task jscpd in gate job",
  );
});
