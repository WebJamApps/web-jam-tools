// fix_labels_model_labels_parity.test.ts — web-jam-tools#265 CI fix
//
// The generated sidecar skills/fix-labels/model-labels.json is what
// hooks/require-model-label-on-issue-create.sh actually reads (stdlib json,
// no PyYAML — the CircleCI image doesn't have it). labels.yaml stays the
// hand-edited source of truth. This test is the drift guard between them:
// it loads the REAL labels.yaml, recomputes the model-label list the same
// way the generator does, and asserts it exactly matches the committed
// JSON. Edit labels.yaml's modelTier entries without re-running
// `deno task fix-labels:generate-model-labels` and this test fails — that
// is the point, not a bug to work around.

import { assertEquals } from "@std/assert";
import { computeModelLabels, DEFAULT_SCHEMA_PATH, loadSchema } from "../src/fix-labels/diff.ts";

const MODEL_LABELS_JSON_PATH =
  new URL("../skills/fix-labels/model-labels.json", import.meta.url).pathname;

Deno.test("model-labels.json exactly matches labels.yaml's modelTier: true entries", async () => {
  const schema = await loadSchema(DEFAULT_SCHEMA_PATH);
  const expected = computeModelLabels(schema);

  const raw = await Deno.readTextFile(MODEL_LABELS_JSON_PATH);
  const parsed = JSON.parse(raw);

  assertEquals(
    parsed.modelLabels,
    expected,
    "skills/fix-labels/model-labels.json is out of date — run " +
      "`deno task fix-labels:generate-model-labels` to regenerate it from labels.yaml.",
  );
});

Deno.test("model-labels.json is sorted and has no duplicates", async () => {
  const raw = await Deno.readTextFile(MODEL_LABELS_JSON_PATH);
  const parsed = JSON.parse(raw);
  const sorted = [...parsed.modelLabels].sort();
  assertEquals(parsed.modelLabels, sorted);
  assertEquals(new Set(parsed.modelLabels).size, parsed.modelLabels.length);
});
