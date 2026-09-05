// agy_models_spelling.test.ts — web-jam-tools#918
//
// Regression coverage to pin literal AGY_MODELS commands documented in skills
// against ALLOWED_AGY_MODELS in hooks/lib/check_agy_model.ts.
//
// Prevents doc sweeps (such as web-jam-tools#550) from scrubbing version tokens
// out of load-bearing AGY_MODELS command examples, which breaks dispatch when
// passed to scripts/handle-agy-tasks.sh.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { ALLOWED_AGY_MODELS } from "../hooks/lib/check_agy_model.ts";

const DELEGATE_SKILL_PATH = new URL("../skills/delegate/SKILL.md", import.meta.url).pathname;
const FLASH_ISSUES_SKILL_PATH =
  new URL("../skills/flash-issues/SKILL.md", import.meta.url).pathname;

const ALLOWED_DISPLAY_NAMES = new Set(ALLOWED_AGY_MODELS.map((m) => m.displayName));

/**
 * Extracts literal AGY_MODELS='...' (or "...") values from a file's content.
 */
export function extractAgyModelsDeclarations(content: string): string[] {
  const matches: string[] = [];
  const re = /AGY_MODELS=['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

/**
 * Validates that all declarations contain only allowed pipe-separated displayNames.
 * Throws an AssertionError naming any offending string that is not recognized.
 */
export function validateAgyModelsDeclarations(
  declarations: string[],
  filePath: string,
  allowedDisplayNames: ReadonlySet<string> = ALLOWED_DISPLAY_NAMES,
): void {
  assert(
    declarations.length > 0,
    `Expected at least one literal AGY_MODELS='...' declaration in ${filePath}, but found none`,
  );
  for (const decl of declarations) {
    const models = decl.split("|");
    for (const model of models) {
      assert(
        allowedDisplayNames.has(model),
        `Offending AGY_MODELS display name '${model}' in ${filePath} is not allowed. Must match ALLOWED_AGY_MODELS displayName exactly (allowed: ${
          [...allowedDisplayNames].join(", ")
        })`,
      );
    }
  }
}

Deno.test("skills/delegate/SKILL.md documents only valid AGY_MODELS matching ALLOWED_AGY_MODELS", async () => {
  const content = await Deno.readTextFile(DELEGATE_SKILL_PATH);
  const declarations = extractAgyModelsDeclarations(content);
  assertEquals(
    declarations.length >= 2,
    true,
    `Expected at least 2 AGY_MODELS declarations in skills/delegate/SKILL.md, found ${declarations.length}`,
  );
  validateAgyModelsDeclarations(declarations, "skills/delegate/SKILL.md");
});

Deno.test("skills/flash-issues/SKILL.md documents only valid AGY_MODELS matching ALLOWED_AGY_MODELS", async () => {
  const content = await Deno.readTextFile(FLASH_ISSUES_SKILL_PATH);
  const declarations = extractAgyModelsDeclarations(content);
  assertEquals(
    declarations.length >= 1,
    true,
    `Expected at least 1 AGY_MODELS declaration in skills/flash-issues/SKILL.md, found ${declarations.length}`,
  );
  validateAgyModelsDeclarations(declarations, "skills/flash-issues/SKILL.md");
});

Deno.test("validateAgyModelsDeclarations fails and names offending string when version-scrubbed", () => {
  const offending = "Gemini Flash (High)";
  assertThrows(
    () => {
      validateAgyModelsDeclarations([offending], "test/dummy.md");
    },
    Error,
    `'${offending}'`,
  );

  const pipeOffending = "Gemini 3.7 Flash (High)|Gemini Flash (Medium)";
  assertThrows(
    () => {
      validateAgyModelsDeclarations([pipeOffending], "test/dummy.md");
    },
    Error,
    "'Gemini Flash (Medium)'",
  );
});
