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
    assertEquals(modelLabelViolation(["Flash"], vocabulary), "no model label");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

const cellCases: Array<[string, string[] | string]> = [
  ["Sonnet / Sol", ["Sonnet", "Sol"]],
  ["Sol / Sonnet", ["Sol", "Sonnet"]],
  ["Sonnet/Sol", ["Sonnet", "Sol"]],
  ["Sonnet  /  Sol", ["Sonnet", "Sol"]],
  ["**Sonnet / Sol**", ["Sonnet", "Sol"]],
  ["Flash", ["Flash"]],
  ["Josh", ["Josh"]],
  ["Sonnet / Flash", ["Sonnet", "Flash"]],
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
  assertEquals(
    modelLabelViolation(readPlanModelLabels("Sonnet / Sol", tiers), tiers, undefined, false),
    undefined,
  );
  assertStringIncludes(
    modelLabelViolation(readPlanModelLabels("Sonnet / Flash", tiers), tiers, undefined, false)!,
    "outside the allowed pair",
  );
});
