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

Deno.test("parseMemoryFile: returns null and reports reason when front matter is missing", () => {
  let skipReason = "";
  const result = parseMemoryFile("Just body text\nno front matter\n", "broken.md", (r) => {
    skipReason = r;
  });
  assertEquals(result, null);
  assertEquals(skipReason, "no front matter block");
});

Deno.test("parseMemoryFile: returns null and reports reason on YAML parse error", () => {
  const content = `---
name: bad-yaml
description: unquoted: colon in description
---
`;
  let skipReason = "";
  const result = parseMemoryFile(content, "bad-yaml.md", (r) => {
    skipReason = r;
  });
  assertEquals(result, null);
  assert(skipReason.length > 0);
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
      filename: "ref-doc.md",
      slug: "ref-doc",
      type: "reference" as const,
      description: "Ref desc",
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
  assert(output.includes("ref-doc"));
  assert(
    output.includes(
      "- [session-checkpoint-live](session-checkpoint-live.md) — Live checkpoint desc",
    ),
  );
});

Deno.test("generateMemoryIndex: omits section headers for empty groups", () => {
  const entries = [
    {
      filename: "alpha.md",
      slug: "alpha",
      type: "feedback" as const,
      description: "Alpha desc",
      isCheckpoint: false,
    },
  ];

  const output = generateMemoryIndex(entries);
  assert(output.includes("## Feedback"));
  assertEquals(output.includes("## User"), false);
  assertEquals(output.includes("## Reference"), false);
  assertEquals(output.includes("## Project"), false);
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

    const { entries } = await scanMemoryDirectory(tempDir);
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

Deno.test("scanMemoryDirectory: collects parsed entries and skipped files with reasons", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "valid.md"),
      `---\nname: valid\ndescription: "Valid entry"\nmetadata:\n  type: feedback\n---\n`,
    );
    await Deno.writeTextFile(
      join(tempDir, "no-frontmatter.md"),
      `# Just markdown\nNo front matter block here.\n`,
    );
    await Deno.writeTextFile(
      join(tempDir, "bad-yaml.md"),
      `---\nname: bad-yaml\ndescription: unquoted: colon\n---\n`,
    );

    const { entries, skipped } = await scanMemoryDirectory(tempDir);
    assertEquals(entries.length, 1);
    assertEquals(entries[0].slug, "valid");

    assertEquals(skipped.length, 2);
    assertEquals(skipped[0].filename, "bad-yaml.md");
    assert(skipped[0].reason.length > 0);
    assertEquals(skipped[1].filename, "no-frontmatter.md");
    assertEquals(skipped[1].reason, "no front matter block");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runCli: write mode writes valid entries, reports skips, and returns exit code 1", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalError = console.error;
  const loggedErrors: string[] = [];
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map(String).join(" "));
  };
  try {
    await Deno.writeTextFile(
      join(tempDir, "valid-a.md"),
      `---\ndescription: "Valid A"\nmetadata:\n  type: feedback\n---\n`,
    );
    await Deno.writeTextFile(
      join(tempDir, "broken-no-fm.md"),
      `no front matter here\n`,
    );
    await Deno.writeTextFile(
      join(tempDir, "broken-bad-yaml.md"),
      `---\ndescription: unquoted: colon\n---\n`,
    );

    const exitCode = await runCli(["--dir", tempDir]);
    assertEquals(exitCode, 1);

    // Verify MEMORY.md was still written from valid entries (write-and-warn)
    const memoryMdPath = join(tempDir, "MEMORY.md");
    const content = await Deno.readTextFile(memoryMdPath);
    assert(content.includes("valid-a"));

    // Verify stderr output named skipped files and reasons
    assert(
      loggedErrors.some((e) =>
        e.includes("broken-no-fm.md") && e.includes("no front matter block")
      ),
    );
    assert(loggedErrors.some((e) => e.includes("broken-bad-yaml.md")));
  } finally {
    console.error = originalError;
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runCli: --check mode reports skips and returns exit code 1 even when MEMORY.md matches", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalError = console.error;
  const loggedErrors: string[] = [];
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map(String).join(" "));
  };
  try {
    await Deno.writeTextFile(
      join(tempDir, "valid-a.md"),
      `---\ndescription: "Valid A"\nmetadata:\n  type: feedback\n---\n`,
    );
    await Deno.writeTextFile(
      join(tempDir, "broken.md"),
      `no front matter here\n`,
    );

    // First generate MEMORY.md (write mode exits 1 due to skip)
    const writeCode = await runCli(["--dir", tempDir]);
    assertEquals(writeCode, 1);

    loggedErrors.length = 0;

    // Check mode should also exit 1 due to the skip, despite MEMORY.md matching the valid entries
    const checkCode = await runCli(["--dir", tempDir, "--check"]);
    assertEquals(checkCode, 1);

    assert(
      loggedErrors.some((e) => e.includes("broken.md") && e.includes("no front matter block")),
    );
  } finally {
    console.error = originalError;
    await Deno.remove(tempDir, { recursive: true });
  }
});

// P1-6 budget check: Derived budget function (Design 1C):
//   bytes(MEMORY.md) ≈ Σ len(slug) + group markup + live-checkpoint lines
// Evaluates to ~6.7KB currently; 7,500 bytes is the hard upper bound limit.
Deno.test("real memory directory index generation budget check (<= 7500 bytes)", async () => {
  const realDir = "/home/joshua/.claude/projects/-home-joshua/memory";
  try {
    const stat = await Deno.stat(realDir);
    if (!stat.isDirectory) return;
  } catch {
    return; // Skip if path not present on test runner
  }

  const { entries } = await scanMemoryDirectory(realDir);
  const activeEntries = entries.filter((e) => !(e.isCheckpoint && e.status === "done"));
  const output = generateMemoryIndex(activeEntries);
  const byteCount = new TextEncoder().encode(output).length;

  assert(
    byteCount <= 7500,
    `Memory index size (${byteCount} bytes) exceeds budget of 7,500 bytes`,
  );
});
