// fix_labels_generate_model_labels.test.ts — web-jam-tools#265 CI fix
//
// Unit tests for src/fix-labels/generate-model-labels.ts's generate()
// function, using temp schema/output files so nothing touches the real
// skills/fix-labels/model-labels.json.

import { assertEquals } from "@std/assert";
import { generate } from "../src/fix-labels/generate-model-labels.ts";

const SCHEMA_YAML = `
repoClasses:
  frontend:
    - RepoA
  other:
    - RepoB
labels:
  - name: Zeta
    hex: "111111"
    repos: all
    modelTier: true
  - name: Alpha
    hex: "222222"
    repos: all
    modelTier: true
  - name: NotAModel
    hex: "333333"
    repos: all
keep: {}
`;

async function withTempPaths(
  fn: (schemaPath: string, outputPath: string) => Promise<void>,
): Promise<void> {
  const schemaPath = await Deno.makeTempFile({ suffix: ".yaml" });
  const outputPath = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(schemaPath, SCHEMA_YAML);
    await fn(schemaPath, outputPath);
  } finally {
    await Deno.remove(schemaPath);
    await Deno.remove(outputPath);
  }
}

Deno.test("generate: writes a sorted modelLabels JSON array and returns it", async () => {
  await withTempPaths(async (schemaPath, outputPath) => {
    const result = await generate(schemaPath, outputPath);
    assertEquals(result, ["Alpha", "Zeta"]);

    const written = JSON.parse(await Deno.readTextFile(outputPath));
    assertEquals(written, { modelLabels: ["Alpha", "Zeta"] });
  });
});

Deno.test("generate: excludes entries without modelTier: true", async () => {
  await withTempPaths(async (schemaPath, outputPath) => {
    const result = await generate(schemaPath, outputPath);
    assertEquals(result.includes("NotAModel"), false);
  });
});
