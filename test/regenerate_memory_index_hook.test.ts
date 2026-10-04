// test/regenerate_memory_index_hook.test.ts — web-jam-tools#1236
//
// Tests hooks/regenerate-memory-index.sh (PostToolUse hook on Write|Edit):
// 1. Regenerates MEMORY.md on writes into $HOME/.claude/projects/-home-joshua/memory/.
// 2. No action on writes outside the target memory folder.
// 3. Fails open (exit 0) with exactly one warning line when generator fails.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { generateMemoryIndex, scanMemoryDirectory } from "../src/memory-index/generator.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HOOK_PATH = path.join(REPO_ROOT, "hooks/regenerate-memory-index.sh");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHook(
  payload: string | Record<string, unknown>,
  env: Record<string, string>,
): Promise<RunResult> {
  const stdinText = typeof payload === "string" ? payload : JSON.stringify(payload);
  const command = new Deno.Command("bash", {
    args: [HOOK_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), ...env },
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdinText));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function setupMemoryFixture(homeDir: string): Promise<{
  memoryDir: string;
  memoryMdPath: string;
  handEditedContent: string;
}> {
  const memoryDir = path.join(homeDir, ".claude/projects/-home-joshua/memory");
  await Deno.mkdir(memoryDir, { recursive: true });

  const sampleNote = `---
type: reference
description: "A test reference note"
---
# Sample Note
Some reference content.
`;
  await Deno.writeTextFile(path.join(memoryDir, "sample-note.md"), sampleNote);

  const handEditedContent = "# HAND EDITED MEMORY INDEX\n- hand-written line\n";
  const memoryMdPath = path.join(memoryDir, "MEMORY.md");
  await Deno.writeTextFile(memoryMdPath, handEditedContent);

  return { memoryDir, memoryMdPath, handEditedContent };
}

// Literal trigger list paths from acceptance criteria that MUST regenerate
const REGENERATE_PATHS = [
  "/home/joshua/.claude/projects/-home-joshua/memory/some-new-memory.md",
  "/home/joshua/.claude/projects/-home-joshua/memory/MEMORY.md",
  "/home/joshua/.claude/projects/-home-joshua/memory/archive/old-checkpoint.md",
  "~/.claude/projects/-home-joshua/memory/some-new-memory.md",
];

for (const literalPath of REGENERATE_PATHS) {
  Deno.test(`regenerate: payload file_path "${literalPath}" regenerates MEMORY.md and exits 0`, async () => {
    const fixtureHome = await Deno.makeTempDir();
    try {
      const { memoryDir, memoryMdPath, handEditedContent } = await setupMemoryFixture(fixtureHome);

      const res = await runHook(
        {
          tool_input: { file_path: literalPath },
        },
        { HOME: fixtureHome },
      );

      assertEquals(res.code, 0, `expected exit code 0, stderr: ${res.stderr}`);
      assertEquals(res.stderr, "", `expected empty stderr, got: ${res.stderr}`);

      const contentAfter = await Deno.readTextFile(memoryMdPath);
      assert(
        contentAfter !== handEditedContent,
        `expected MEMORY.md to be regenerated, but it remained hand-edited`,
      );

      // Verify content matches what the generator produces
      const { entries } = await scanMemoryDirectory(memoryDir);
      const activeEntries = entries.filter((e) => !(e.isCheckpoint && e.status === "done"));
      const expectedOutput = generateMemoryIndex(activeEntries);
      assertEquals(contentAfter, expectedOutput);
    } finally {
      await Deno.remove(fixtureHome, { recursive: true });
    }
  });
}

// Literal trigger list paths from acceptance criteria that MUST NOT regenerate (no action)
const NO_ACTION_CASES: Array<{
  name: string;
  payload: Record<string, unknown>;
}> = [
  {
    name: "/home/joshua/.claude/projects/-home-joshua-WebJamApps-CollegeLutheran/memory/note.md",
    payload: {
      tool_input: {
        file_path:
          "/home/joshua/.claude/projects/-home-joshua-WebJamApps-CollegeLutheran/memory/note.md",
      },
    },
  },
  {
    name: "/home/joshua/.claude/CLAUDE.md",
    payload: {
      tool_input: { file_path: "/home/joshua/.claude/CLAUDE.md" },
    },
  },
  {
    name: "/home/joshua/WebJamApps/web-jam-tools/README.md",
    payload: {
      tool_input: { file_path: "/home/joshua/WebJamApps/web-jam-tools/README.md" },
    },
  },
  {
    name: "memory/some-new-memory.md with cwd /home/joshua/WebJamApps/web-jam-tools",
    payload: {
      cwd: "/home/joshua/WebJamApps/web-jam-tools",
      tool_input: { file_path: "memory/some-new-memory.md" },
    },
  },
  {
    name: "a payload with no file_path",
    payload: {
      tool_input: {},
    },
  },
];

for (const { name, payload } of NO_ACTION_CASES) {
  Deno.test(`no action: ${name} leaves fixture MEMORY.md unchanged and exits 0`, async () => {
    const fixtureHome = await Deno.makeTempDir();
    try {
      const { memoryMdPath, handEditedContent } = await setupMemoryFixture(fixtureHome);

      const res = await runHook(payload, { HOME: fixtureHome });

      assertEquals(res.code, 0, `expected exit code 0, stderr: ${res.stderr}`);
      assertEquals(res.stderr, "", `expected empty stderr, got: ${res.stderr}`);

      const contentAfter = await Deno.readTextFile(memoryMdPath);
      assertEquals(
        contentAfter,
        handEditedContent,
        `expected MEMORY.md to remain unchanged for no-action payload`,
      );
    } finally {
      await Deno.remove(fixtureHome, { recursive: true });
    }
  });
}

Deno.test("generator failure: fails open (proceeds, exits 0) and prints exactly one warning line", async () => {
  const fixtureHome = await Deno.makeTempDir();
  try {
    const { memoryDir } = await setupMemoryFixture(fixtureHome);

    // Force generator failure by creating an invalid memory file with no frontmatter
    await Deno.writeTextFile(
      path.join(memoryDir, "broken.md"),
      "# No Frontmatter\nThis file is missing frontmatter\n",
    );

    const res = await runHook(
      {
        tool_input: {
          file_path: "/home/joshua/.claude/projects/-home-joshua/memory/some-new-memory.md",
        },
      },
      { HOME: fixtureHome },
    );

    assertEquals(res.code, 0, `expected hook to proceed with exit 0, got ${res.code}`);
    assertEquals(res.stdout, "", "expected empty stdout");

    const lines = res.stderr.trim().split("\n").filter(Boolean);
    assertEquals(
      lines.length,
      1,
      `expected exactly one warning line in stderr, got: ${JSON.stringify(lines)}`,
    );
    assertStringIncludes(
      lines[0],
      "warning: failed to regenerate memory index",
    );
  } finally {
    await Deno.remove(fixtureHome, { recursive: true });
  }
});

Deno.test("empty payload or missing input exits 0 with no action", async () => {
  const fixtureHome = await Deno.makeTempDir();
  try {
    const { memoryMdPath, handEditedContent } = await setupMemoryFixture(fixtureHome);

    const emptyRes = await runHook("", { HOME: fixtureHome });
    assertEquals(emptyRes.code, 0);
    assertEquals(emptyRes.stderr, "");

    const jsonRes = await runHook("{}", { HOME: fixtureHome });
    assertEquals(jsonRes.code, 0);
    assertEquals(jsonRes.stderr, "");

    const contentAfter = await Deno.readTextFile(memoryMdPath);
    assertEquals(contentAfter, handEditedContent);
  } finally {
    await Deno.remove(fixtureHome, { recursive: true });
  }
});
