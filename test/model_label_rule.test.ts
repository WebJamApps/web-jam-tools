import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  loadModelLabels,
  modelLabelViolation,
  readPlanModelLabels,
} from "../src/shared/model_label_rule.ts";
import { MODEL_LABEL_CASES, MODEL_LABEL_NAMES } from "./support/model_label_cases.ts";

const tiers = new Set(MODEL_LABEL_NAMES);

for (const { labels, reason, error } of MODEL_LABEL_CASES) {
  Deno.test(`model-label rule: ${JSON.stringify(labels)}, reason ${JSON.stringify(reason)}`, () => {
    const result = modelLabelViolation(labels, tiers, reason);
    if (error) assertStringIncludes(result ?? "", error);
    else assertEquals(result, undefined);
  });
}

Deno.test("model-label vocabulary fails closed for a missing or damaged sidecar", async () => {
  const directory = await Deno.makeTempDir();
  const file = `${directory}/model-labels.json`;
  try {
    assertThrows(() => loadModelLabels(file), Error, file);
    for (const text of ["{", "null", "{}", '{"modelLabels":[]}', '{"modelLabels":[false]}']) {
      await Deno.writeTextFile(file, text);
      assertThrows(() => loadModelLabels(file), Error, file);
    }
    await Deno.writeTextFile(file, JSON.stringify({ modelLabels: ["FutureModel"] }));
    const vocabulary = loadModelLabels(file);
    assertEquals(modelLabelViolation(["FutureModel"], vocabulary), undefined);
    assertEquals(modelLabelViolation(["Terra"], vocabulary), "no model label");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

const cellCases: Array<[string, string[] | string]> = [
  ["Sol", ["Sol"]],
  ["Sonnet", ["Sonnet"]],
  ["Argon", ["Argon"]],
  ["Hydrogen", ["Hydrogen"]],
  ["Terra / Sonnet", ["Terra", "Sonnet"]],
  ["Sonnet/Terra", ["Sonnet", "Terra"]],
  ["Terra  /  Sonnet", ["Terra", "Sonnet"]],
  ["**Terra / Sonnet**", ["Terra", "Sonnet"]],
  ["Sol / Argon", ["Sol", "Argon"]],
  ["Sol / Hydrogen", ["Sol", "Hydrogen"]],
  ["Argon / Hydrogen", ["Argon", "Hydrogen"]],
  ["Sol / Argon / Hydrogen", ["Sol", "Argon", "Hydrogen"]],
  ["Terra", ["Terra"]],
  ["Josh", ["Josh"]],
  ["Opus / Fable", ["Opus", "Fable"]],
  ["Fable", ["Fable"]],
  ["Sonnet / Sol", ["Sonnet", "Sol"]],
  ["Flash", "Flash"],
  ["Sonnet / Bogus", "Bogus"],
  ["Sonnet / ", "empty name"],
  ["", "tier is missing"],
];
for (const [cell, expected] of cellCases) {
  Deno.test(`plan-cell reader: ${JSON.stringify(cell)}`, () => {
    if (typeof expected === "string") {
      assertThrows(() => readPlanModelLabels(cell, tiers), Error, expected);
    } else {
      assertEquals(readPlanModelLabels(cell, tiers), expected);
    }
  });
}

Deno.test("plan lint checks label combinations without requiring a reason column", () => {
  for (
    const allowedCell of [
      "Sol",
      "Sonnet",
      "Argon",
      "Hydrogen",
      "Terra / Sonnet",
      "Sonnet/Terra",
      "Terra  /  Sonnet",
      "**Terra / Sonnet**",
      "Sol / Argon",
      "Sol / Hydrogen",
      "Argon / Hydrogen",
      "Sol / Argon / Hydrogen",
      "Terra",
      "Josh",
      "Opus / Fable",
      "Fable",
    ]
  ) {
    assertEquals(
      modelLabelViolation(readPlanModelLabels(allowedCell, tiers), tiers, undefined, false),
      undefined,
      allowedCell,
    );
  }
  assertStringIncludes(
    modelLabelViolation(readPlanModelLabels("Sonnet / Sol", tiers), tiers, undefined, false)!,
    "forbidden model-label combination",
  );
});

Deno.test("retired Flash is unknown to the canonical label vocabulary", () => {
  const vocabulary = loadModelLabels();
  assertEquals(modelLabelViolation(["Flash"], vocabulary), "no model label");
  assertThrows(() => readPlanModelLabels("Flash", vocabulary), Error, 'Unknown model tier "Flash"');
  for (const name of ["Argon", "Terra", "Hydrogen", "Fable"]) {
    assertEquals(vocabulary.has(name), true);
  }
});
