// test/memory_index.test.ts — web-jam-tools#440
// Unit tests for memory index generator and CLI

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  archiveDoneCheckpoints,
  generateMemoryIndex,
  isArchivable,
  parseMemoryFile,
  scanMemoryDirectory,
} from "../src/memory-index/generator.ts";
import { runCli } from "../src/memory-index/cli.ts";
import { loadLimits } from "../src/session-load/report.ts";

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

Deno.test("generateMemoryIndex: groups by type, sorts slugs alphabetically, formats checkpoints as slug lines", () => {
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
  assert(output.includes("session-checkpoint-live"));
  assertEquals(output.includes("- [session-checkpoint-live]"), false);
  assertEquals(output.includes("— Live checkpoint desc"), false);
});

Deno.test("generateMemoryIndex: lists a session-checkpoint-* fixture as a slug line with no state line", () => {
  const entries = [
    {
      filename: "session-checkpoint-task.md",
      slug: "session-checkpoint-task",
      type: "project" as const,
      status: "live",
      description: "Live checkpoint desc with state details",
      isCheckpoint: true,
    },
    {
      filename: "project-guidelines.md",
      slug: "project-guidelines",
      type: "project" as const,
      description: "Guidelines description",
      isCheckpoint: false,
    },
  ];

  const output = generateMemoryIndex(entries);
  assert(output.includes("## Project"));
  // Sorted alphabetically: project-guidelines before session-checkpoint-task
  assert(output.includes("project-guidelines · session-checkpoint-task"));
  assertEquals(output.includes("- [session-checkpoint-task]"), false);
  assertEquals(output.includes("— Live checkpoint desc with state details"), false);
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

Deno.test("isArchivable: returns false so done checkpoints are not archived", () => {
  const entry = {
    filename: "session-checkpoint-done.md",
    slug: "session-checkpoint-done",
    type: "project" as const,
    status: "done",
    description: "Done desc",
    isCheckpoint: true,
  };
  assertEquals(isArchivable(entry), false);
});

Deno.test("archiveDoneCheckpoints: does not archive done checkpoints", async () => {
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

    assertEquals(archivedCount, 0);
    assertEquals(remaining.length, 3);

    // Verify done checkpoint remains in place and was not moved to archive/
    const donePath = join(tempDir, doneCheckpoint);
    const doneStat = await Deno.stat(donePath);
    assert(doneStat.isFile);

    let archiveExists = false;
    try {
      await Deno.stat(join(tempDir, "archive"));
      archiveExists = true;
    } catch {
      archiveExists = false;
    }
    assertEquals(archiveExists, false);
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

Deno.test("real memory directory index generation succeeds on real data", async () => {
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
  assert(output.startsWith("# Memory Index"));
  assert(output.includes("## "));
  const byteCount = new TextEncoder().encode(output).length;
  assert(byteCount > 0, "Generated index must not be empty");
});

Deno.test("generateMemoryIndex: completes successfully when index exceeds overMark", async () => {
  const { overMark } = (await loadLimits()).memoryIndex;
  const entries = [];
  for (let i = 0; i < 300; i++) {
    entries.push({
      filename: `synthetic-memory-entry-slug-${i}.md`,
      slug: `synthetic-memory-entry-slug-${i}`,
      type: "project" as const,
      description:
        `Synthetic memory description for entry ${i} ensuring index byte count exceeds limit comfortably`,
      isCheckpoint: true,
      status: "live",
    });
  }
  const output = generateMemoryIndex(entries);
  const byteCount = new TextEncoder().encode(output).length;
  assert(byteCount > overMark, `Byte count (${byteCount}) should exceed overMark (${overMark})`);
  assert(output.startsWith("# Memory Index"));
  assert(output.includes("## Project"));
});

Deno.test("memory-index retains done checkpoints in memory index as slug lines", async () => {
  const dir = await Deno.makeTempDir({ prefix: "memory-index-protect-" });
  const checkpoint = (slug: string) =>
    `---\nname: ${slug}\ndescription: d\nmetadata:\n  type: project\n  status: done\n---\n\nBody.\n`;
  await Deno.writeTextFile(
    join(dir, "session-checkpoint-kept.md"),
    checkpoint("session-checkpoint-kept"),
  );
  await Deno.writeTextFile(
    join(dir, "session-checkpoint-other.md"),
    checkpoint("session-checkpoint-other"),
  );

  await runCli(["--dir", dir, "--protect", "session-checkpoint-kept"]);

  await Deno.stat(join(dir, "session-checkpoint-kept.md"));
  await Deno.stat(join(dir, "session-checkpoint-other.md"));
  const memoryMd = await Deno.readTextFile(join(dir, "MEMORY.md"));
  assert(memoryMd.includes("session-checkpoint-kept · session-checkpoint-other"));
  assertEquals(await runCli(["--dir", dir, "--protect", "session-checkpoint-kept", "--check"]), 0);
});

Deno.test("runCli: --help displays truthful help text", async () => {
  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const code = await runCli(["--help"]);
    assertEquals(code, 0);
    assert(logged.some((line) => line.includes("deprecated / no-op")));
  } finally {
    console.log = originalLog;
  }
});
