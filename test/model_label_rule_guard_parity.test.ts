import { assertEquals, assertThrows } from "@std/assert";
import {
  decide,
  loadModelLabels as loadGuardLabels,
} from "../hooks/lib/check_model_label_on_issue_create.ts";
import { loadModelLabels, modelLabelViolation } from "../src/shared/model_label_rule.ts";
import { MODEL_LABEL_CASES, MODEL_LABEL_NAMES } from "./support/model_label_cases.ts";

Deno.test("guard and shared label check agree on every Appendix D case", () => {
  const tiers = new Set(MODEL_LABEL_NAMES);
  for (const { labels, reason, error } of MODEL_LABEL_CASES) {
    const sharedPass = modelLabelViolation(labels, tiers, reason) === undefined;
    assertEquals(sharedPass, !error, JSON.stringify({ labels, reason }));
    for (const mode of ["cli", "mcp"] as const) {
      assertEquals(
        decide(labels, tiers, reason, undefined, mode) === "PASS",
        sharedPass,
        `${mode}: ${JSON.stringify({ labels, reason })}`,
      );
    }
  }
});

Deno.test("guard and shared vocabulary loaders both refuse a missing sidecar", async () => {
  const directory = await Deno.makeTempDir();
  const file = `${directory}/model-labels.json`;
  try {
    assertThrows(() => loadGuardLabels(file));
    assertThrows(() => loadModelLabels(file));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
