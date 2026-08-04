import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  extractHardRulesBlock,
  formatWrappedBlock,
  isAgentsMdInSync,
  START_MARKER,
  syncCrossAiRules,
  updateAgentsMdContent,
} from "../scripts/sync-cross-ai-rules.ts";

Deno.test("extractHardRulesBlock - extracts section correctly", () => {
  const sampleDoc = `
# Title

Intro text...

## OPERATIONAL HARD RULES (apply to any AI taking action on Josh's behalf)

- Rule 1: Always check state.
- Rule 2: No remote deletions.

## DESIGN CLAIMS MUST CARRY RECEIPTS

- Receipt rule 1.
`;

  const extracted = extractHardRulesBlock(sampleDoc);
  assertEquals(
    extracted,
    `## OPERATIONAL HARD RULES (apply to any AI taking action on Josh's behalf)\n\n- Rule 1: Always check state.\n- Rule 2: No remote deletions.`,
  );
});

Deno.test("extractHardRulesBlock - throws when section missing", () => {
  const sampleDoc = `
# Title

## OTHER SECTION
- Nothing here
`;
  assertThrows(
    () => extractHardRulesBlock(sampleDoc),
    Error,
    "Could not find ## OPERATIONAL HARD RULES section",
  );
});

Deno.test("updateAgentsMdContent - injects before first section when markers absent", () => {
  const existing = `# AGENTS.md — TestRepo\n\nIntro guidance.\n\n## What this is\n\nSome detail.`;
  const canonical = `## OPERATIONAL HARD RULES\n\n- Rule 1`;
  const updated = updateAgentsMdContent(existing, canonical);

  assert(updated.includes(START_MARKER));
  assert(updated.includes("## OPERATIONAL HARD RULES\n\n- Rule 1"));
  assert(updated.indexOf(START_MARKER) < updated.indexOf("## What this is"));
});

Deno.test("updateAgentsMdContent - updates existing block when markers present", () => {
  const existing =
    `# Title\n\n<!-- CROSS-AI-HARD-RULES-START -->\nold rules\n<!-- CROSS-AI-HARD-RULES-END -->\n\n## Section`;
  const canonical = `## OPERATIONAL HARD RULES\n\n- Rule NEW`;
  const updated = updateAgentsMdContent(existing, canonical);

  assert(updated.includes("Rule NEW"));
  assert(!updated.includes("old rules"));
});

Deno.test("isAgentsMdInSync - detects sync state correctly", () => {
  const canonical = `## OPERATIONAL HARD RULES\n\n- Rule 1`;
  const syncedContent = `# Title\n\n${formatWrappedBlock(canonical)}\n\n## Section`;
  const driftedContent = `# Title\n\n${formatWrappedBlock("different rules")}\n\n## Section`;
  const missingMarkers = `# Title\n\n## Section`;

  assertEquals(isAgentsMdInSync(syncedContent, canonical), true);
  assertEquals(isAgentsMdInSync(driftedContent, canonical), false);
  assertEquals(isAgentsMdInSync(missingMarkers, canonical), false);
});

Deno.test("syncCrossAiRules - check and write workflow", () => {
  const tempDir = Deno.makeTempDirSync();
  try {
    const webJamToolsDir = join(tempDir, "web-jam-tools");
    const docsDir = join(webJamToolsDir, "docs");
    Deno.mkdirSync(docsDir, { recursive: true });

    const docPath = join(docsDir, "cross-ai-rules.md");
    Deno.writeTextFileSync(
      docPath,
      `# Cross-AI Rules\n\n## OPERATIONAL HARD RULES\n\n- Rule A\n- Rule B\n\n## NEXT SECTION\n`,
    );

    const targetRepo = join(tempDir, "TestRepo");
    Deno.mkdirSync(targetRepo, { recursive: true });
    const agentsMdPath = join(targetRepo, "AGENTS.md");
    Deno.writeTextFileSync(
      agentsMdPath,
      `# AGENTS.md — TestRepo\n\n## Commands\n\nnpm test\n`,
    );

    // Initial check -> should report drift
    const checkResult1 = syncCrossAiRules({
      check: true,
      docPath,
      targetFiles: [agentsMdPath],
    });
    assertEquals(checkResult1.success, false);
    assertEquals(checkResult1.driftCount, 1);

    // Write -> should update file
    const writeResult = syncCrossAiRules({
      write: true,
      docPath,
      targetFiles: [agentsMdPath],
    });
    assertEquals(writeResult.success, true);
    assertEquals(writeResult.updatedCount, 1);

    // Second check -> should succeed with 0 drift
    const checkResult2 = syncCrossAiRules({
      check: true,
      docPath,
      targetFiles: [agentsMdPath],
    });
    assertEquals(checkResult2.success, true);
    assertEquals(checkResult2.driftCount, 0);
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});
