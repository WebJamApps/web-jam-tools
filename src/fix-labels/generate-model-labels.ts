// generate-model-labels.ts — web-jam-tools#265 CI fix
//
// Regenerates skills/fix-labels/model-labels.json, a committed JSON sidecar
// listing the model-label names (skills/fix-labels/labels.yaml entries with
// `modelTier: true`, sorted for a deterministic diff). hooks/
// require-model-label-on-issue-create.sh reads that sidecar with stdlib
// `json` instead of parsing labels.yaml itself, because the CircleCI image
// has no PyYAML and the hook must not depend on it.
//
// labels.yaml stays the single hand-edited source of truth; this script and
// test/fix_labels_model_labels_parity.test.ts exist so the sidecar can never
// silently drift from it — the test fails CI if someone edits labels.yaml's
// modelTier entries without re-running this generator.
//
// Run: deno task fix-labels:generate-model-labels

import { computeModelLabels, DEFAULT_SCHEMA_PATH, loadSchema } from "./diff.ts";

export const DEFAULT_OUTPUT_PATH =
  new URL("../../skills/fix-labels/model-labels.json", import.meta.url).pathname;

export async function generate(
  schemaPath: string = DEFAULT_SCHEMA_PATH,
  outputPath: string = DEFAULT_OUTPUT_PATH,
): Promise<string[]> {
  const schema = await loadSchema(schemaPath);
  const modelLabels = computeModelLabels(schema);
  const json = JSON.stringify({ modelLabels }, null, 2) + "\n";
  await Deno.writeTextFile(outputPath, json);
  return modelLabels;
}

if (import.meta.main) {
  const modelLabels = await generate();
  console.log(`wrote ${modelLabels.length} model labels to ${DEFAULT_OUTPUT_PATH}`);
}
