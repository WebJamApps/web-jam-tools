// test/memory_index.test.ts — web-jam-tools#440
// Unit tests for memory index generator and CLI

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  archiveDoneCheckpoints,
  generateMemoryIndex,
  parseMemoryFile,
  scanMemoryDirectory,
} from "../src/memory-index/generator.ts";
import { runCli } from "../src/memory-index/cli.ts";

Deno.test("parseMemoryFile: parses valid frontmatter", () => {
  const content = `---
name: test-slug
description: "Test description"
metadata:
  type: feedback
  status: live
---
Body text
`;
  const result = parseMemoryFile(content, "test-slug.md");
  assert(result !== null);
  assertEquals(result.slug, "test-slug");
  assertEquals(result.type, "feedback");
  assertEquals(result.status, "live");
  assertEquals(result.description, "Test description");
  assertEquals(result.isCheckpoint, false);
});

Deno.test("parseMemoryFile: defaults type to project when missing", () => {
  const content = `---
name: test-slug
description: "Test description"
---
Body text
`;
  const result = parseMemoryFile(content, "test-slug.md");
  assert(result !== null);
  assertEquals(result.type, "project");
  assertEquals(result.isCheckpoint, false);
});

Deno.test("parseMemoryFile: identifies session checkpoint files", () => {
  const content = `---
name: session-checkpoint-test
description: "Checkpoint desc"
metadata:
  status: done
---
Body text
`;
  const result = parseMemoryFile(content, "session-checkpoint-test.md");
  assert(result !== null);
  assertEquals(result.isCheckpoint, true);
  assertEquals(result.status, "done");
});

Deno.test("generateMemoryIndex: groups by type, sorts slugs alphabetically, formats live checkpoints", () => {
  const entries = [
    {
      filename: "beta.md",
      slug: "beta",
      type: "feedback" as const,
      description: "Beta desc",
      isCheckpoint: false,
    },
    {
      filename: "alpha.md",
      slug: "alpha",
      type: "feedback" as const,
      description: "Alpha desc",
      isCheckpoint: false,
    },
    {
      filename: "user-pref.md",
      slug: "user-pref",
      type: "user" as const,
      description: "User desc",
      isCheckpoint: false,
    },
    {
      filename: "session-checkpoint-live.md",
      slug: "session-checkpoint-live",
      type: "project" as const,
      status: "live",
      description: "Live checkpoint desc",
      isCheckpoint: true,
    },
  ];

  const output = generateMemoryIndex(entries);

  assert(output.includes("# Memory Index"));
  assert(output.includes("## User"));
  assert(output.includes("## Feedback"));
  assert(output.includes("## Reference"));
  assert(output.includes("## Project"));

  // Alpha comes before beta
  assert(output.includes("alpha · beta"));
  assert(
    output.includes(
      "- [session-checkpoint-live](session-checkpoint-live.md) — Live checkpoint desc",
    ),
  );
});

Deno.test("archiveDoneCheckpoints: moves done checkpoints to archive directory", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const liveCheckpoint = "session-checkpoint-live.md";
    const doneCheckpoint = "session-checkpoint-done.md";
    const normalFile = "normal-memory.md";

    await Deno.writeTextFile(
      join(tempDir, liveCheckpoint),
      `---\nmetadata:\n  type: project\n  status: live\n---\n`,
    );
    await Deno.writeTextFile(
      join(tempDir, doneCheckpoint),
      `---\nmetadata:\n  type: project\n  status: done\n---\n`,
    );
    await Deno.writeTextFile(
      join(tempDir, normalFile),
      `---\nmetadata:\n  type: feedback\n---\n`,
    );

    const entries = await scanMemoryDirectory(tempDir);
    const { remaining, archivedCount } = await archiveDoneCheckpoints(tempDir, entries);

    assertEquals(archivedCount, 1);
    assertEquals(remaining.length, 2);

    // Verify file moved to archive/
    const archivePath = join(tempDir, "archive", doneCheckpoint);
    const archiveStat = await Deno.stat(archivePath);
    assert(archiveStat.isFile);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runCli: write and --check flags", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "memory-a.md"),
      `---\ndescription: "A"\nmetadata:\n  type: feedback\n---\n`,
    );

    // Write mode
    const writeCode = await runCli(["--dir", tempDir]);
    assertEquals(writeCode, 0);

    const memoryMdPath = join(tempDir, "MEMORY.md");
    const content = await Deno.readTextFile(memoryMdPath);
    assert(content.includes("memory-a"));

    // Check mode should pass
    const checkPassCode = await runCli(["--dir", tempDir, "--check"]);
    assertEquals(checkPassCode, 0);

    // Modify MEMORY.md on disk -> check mode should fail
    await Deno.writeTextFile(memoryMdPath, content + "\n# Extra edit\n");
    const checkFailCode = await runCli(["--dir", tempDir, "--check"]);
    assertEquals(checkFailCode, 1);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("real memory directory index generation budget check (<= 6500 bytes)", async () => {
  const realDir = "/home/joshua/.claude/projects/-home-joshua/memory";
  try {
    const stat = await Deno.stat(realDir);
    if (!stat.isDirectory) return;
  } catch {
    return; // Skip if path not present on test runner
  }

  const entries = await scanMemoryDirectory(realDir);
  const activeEntries = entries.filter((e) => !(e.isCheckpoint && e.status === "done"));
  const output = generateMemoryIndex(activeEntries);
  const byteCount = new TextEncoder().encode(output).length;

  assert(
    byteCount <= 6500,
    `Memory index size (${byteCount} bytes) exceeds budget of 6,500 bytes`,
  );
});
