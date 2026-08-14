// block_out_of_tree_write_hook.test.ts — web-jam-tools#511
//
// Tests for hooks/block-out-of-tree-write.sh and hooks/lib/check_out_of_tree_write.ts

import { assert, assertEquals } from "@std/assert";
import {
  expandHome,
  getRepoRoot,
  isAllowlisted,
  isInsideTree,
} from "../hooks/lib/check_out_of_tree_write.ts";

const SCRIPT_PATH = new URL(
  "../hooks/block-out-of-tree-write.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stderr: string;
}

async function runHook(
  payload: Record<string, unknown>,
  cwd?: string,
): Promise<RunResult> {
  const input = JSON.stringify(payload);
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    cwd: cwd || Deno.cwd(),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stderr } = await child.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

// --- Library function unit tests ---

Deno.test("expandHome expands ~ to HOME environment variable", () => {
  const home = Deno.env.get("HOME") || "/home/joshua";
  assertEquals(expandHome("~/.claude/CLAUDE.md"), `${home}/.claude/CLAUDE.md`);
  assertEquals(expandHome("~"), home);
  assertEquals(expandHome("relative/path.ts"), "relative/path.ts");
});

Deno.test("isAllowlisted recognizes /tmp and session scratchpad paths", () => {
  assert(isAllowlisted("/tmp"));
  assert(isAllowlisted("/tmp/test.txt"));
  assert(isAllowlisted("/tmp/claude-1000/scratchpad/notes.txt"));
  assert(isAllowlisted("/var/tmp/scratch.txt"));
  assert(!isAllowlisted("/home/joshua/.claude/CLAUDE.md"));
  assert(!isAllowlisted("/home/joshua/WebJamApps/web-jam-tools/src/index.ts"));
});

Deno.test("isInsideTree correctly identifies in-tree, out-of-tree, and allowlisted paths", () => {
  const repoRoot = "/home/joshua/WebJamApps/web-jam-tools";

  // In-tree
  assert(isInsideTree("src/index.ts", repoRoot, repoRoot));
  assert(isInsideTree(`${repoRoot}/hooks/test.ts`, repoRoot, repoRoot));

  // Allowlisted (/tmp)
  assert(isInsideTree("/tmp/foo.txt", repoRoot, repoRoot));
  assert(isInsideTree("/tmp/claude-user/scratchpad/test.md", repoRoot, repoRoot));

  // Out-of-tree
  assert(!isInsideTree("~/.claude/CLAUDE.md", repoRoot, repoRoot));
  assert(!isInsideTree("../other-repo/file.ts", repoRoot, repoRoot));
  assert(!isInsideTree("/etc/passwd", repoRoot, repoRoot));
});

Deno.test("getRepoRoot resolves git repository top-level and returns null for non-git dir", async () => {
  const root = getRepoRoot(Deno.cwd());
  assert(root !== null);
  assert(root.length > 0);
  assert(!root.endsWith("/"));

  const tempDir = await Deno.makeTempDir();
  try {
    const nonGitRoot = getRepoRoot(tempDir);
    assertEquals(nonGitRoot, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("isInsideTree denies non-allowlisted writes when repoRoot is null (non-git CWD)", () => {
  const nonGitDir = "/home/joshua";
  assert(!isInsideTree("~/.claude/CLAUDE.md", null, nonGitDir));
  assert(!isInsideTree("file.txt", null, nonGitDir));
  // /tmp is still allowlisted
  assert(isInsideTree("/tmp/scratch.txt", null, nonGitDir));
});

// --- Hook Integration End-to-End Tests ---

Deno.test("write to ~/.claude/CLAUDE.md is DENIED (exit code 2)", async () => {
  const res = await runHook({
    tool_name: "Write",
    tool_input: { file_path: "~/.claude/CLAUDE.md" },
  });
  assertEquals(res.code, 2);
  assert(res.stderr.includes("BLOCKED"));
  assert(res.stderr.includes("out-of-tree write guard"));
  assert(res.stderr.includes("CLAUDE.md"));
  assert(res.stderr.includes("invisible to gh pr diff"));
});

Deno.test("write outside working tree (e.g. /etc/passwd) is DENIED", async () => {
  const res = await runHook({
    tool_name: "Edit",
    tool_input: { target_file: "/etc/passwd" },
  });
  assertEquals(res.code, 2);
  assert(res.stderr.includes("BLOCKED"));
});

Deno.test("write inside working tree is ALLOWED (exit code 0)", async () => {
  const res = await runHook({
    tool_name: "Write",
    tool_input: { file_path: "src/some-file.ts" },
  });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("write to /tmp is ALLOWED (exit code 0)", async () => {
  const res = await runHook({
    tool_name: "Write",
    tool_input: { file_path: "/tmp/scratch-test.txt" },
  });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("write to session scratchpad under /tmp is ALLOWED", async () => {
  const res = await runHook({
    tool_name: "NotebookEdit",
    tool_input: { notebook_path: "/tmp/claude-1000/abcd-1234/scratchpad/test.ipynb" },
  });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("write to ~/.claude/CLAUDE.md from a non-git CWD is DENIED (PR #538 review regression test)", async () => {
  const tempNonGitDir = await Deno.makeTempDir();
  try {
    const res = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "~/.claude/CLAUDE.md" },
    }, tempNonGitDir);
    assertEquals(res.code, 2);
    assert(res.stderr.includes("BLOCKED"));
  } finally {
    await Deno.remove(tempNonGitDir, { recursive: true });
  }
});

Deno.test("write to /tmp from a non-git CWD is ALLOWED", async () => {
  const tempNonGitDir = await Deno.makeTempDir();
  try {
    const res = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/tmp/scratch.txt" },
    }, tempNonGitDir);
    assertEquals(res.code, 0, res.stderr);
  } finally {
    await Deno.remove(tempNonGitDir, { recursive: true });
  }
});

Deno.test("missing file_path passes through (exit code 0)", async () => {
  const res = await runHook({
    tool_name: "Write",
    tool_input: {},
  });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("hook header comment contains required agy coverage limit statement", async () => {
  const scriptContent = await Deno.readTextFile(SCRIPT_PATH);
  const tsContent = await Deno.readTextFile(
    new URL("../hooks/lib/check_out_of_tree_write.ts", import.meta.url).pathname,
  );

  for (const content of [scriptContent, tsContent]) {
    assert(content.includes("fences Claude Code sessions and subagents only"));
    assert(content.includes("does not fence agy"));
    assert(content.includes("web-jam-tools#432"));
  }
});
