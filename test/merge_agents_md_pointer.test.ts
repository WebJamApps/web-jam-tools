import { assert, assertEquals } from "@std/assert";
import {
  mergePointerContent,
  POINTER_BLOCK,
  POINTER_HEADER,
} from "../scripts/merge-agents-md-pointer.ts";

Deno.test("mergePointerContent adds pointer to empty content", () => {
  const result = mergePointerContent("");
  assert(result.changed);
  assertEquals(result.updated, `${POINTER_BLOCK}\n`);
});

Deno.test("mergePointerContent inserts pointer before first subheader", () => {
  const input = `# Global rules\n\nSome intro text.\n\n## The repos\n- item 1\n`;
  const result = mergePointerContent(input);
  assert(result.changed);
  assert(result.updated.includes(POINTER_BLOCK));
  assert(result.updated.includes("# Global rules"));
  assert(result.updated.includes("## The repos"));
  // Assert POINTER_BLOCK appears before ## The repos
  assert(result.updated.indexOf(POINTER_HEADER) < result.updated.indexOf("## The repos"));
});

Deno.test("mergePointerContent preserves pre-existing content outside the pointer", () => {
  const input =
    `# My Title\n\nIntro line 1\nIntro line 2\n\n## Section 1\nContent 1\n\n## Section 2\nContent 2\n`;
  const result = mergePointerContent(input);
  assert(result.changed);
  assert(result.updated.includes("Intro line 1"));
  assert(result.updated.includes("## Section 1"));
  assert(result.updated.includes("Content 2"));
});

Deno.test("mergePointerContent is idempotent when exact pointer already exists", () => {
  const initial = mergePointerContent("# Header\n\n## Section 1\n").updated;
  const second = mergePointerContent(initial);
  assertEquals(second.changed, false);
  assertEquals(second.updated, initial);
});

Deno.test("mergePointerContent replaces outdated pointer section with current block", () => {
  const oldContent =
    `# Header\n\n## Cross-AI hard rules\n\nOld outdated rules content.\n\n## Section 1\nContent 1\n`;
  const result = mergePointerContent(oldContent);
  assert(result.changed);
  assert(result.updated.includes(POINTER_BLOCK));
  assert(!result.updated.includes("Old outdated rules content"));
  assert(result.updated.includes("## Section 1"));
});
