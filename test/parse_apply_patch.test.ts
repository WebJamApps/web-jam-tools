// parse_apply_patch.test.ts — web-jam-tools#1138
//
// Unit tests for hooks/lib/parse_apply_patch.ts.

import { assertEquals } from "@std/assert";
import { parseApplyPatchFilePaths } from "../hooks/lib/parse_apply_patch.ts";

const SCRIPT_PATH = new URL(
  "../hooks/lib/parse_apply_patch.ts",
  import.meta.url,
).pathname;

Deno.test("parseApplyPatchFilePaths extracts Add File path", () => {
  const patch = "*** Add File: probe.txt\n+line 1\n";
  assertEquals(parseApplyPatchFilePaths(patch), ["probe.txt"]);
});

Deno.test("parseApplyPatchFilePaths extracts Update File path", () => {
  const patch = "*** Update File: /tmp/x/probe.txt\n--- a/probe.txt\n+++ b/probe.txt\n";
  assertEquals(parseApplyPatchFilePaths(patch), ["/tmp/x/probe.txt"]);
});

Deno.test("parseApplyPatchFilePaths extracts Delete File path", () => {
  const patch = "*** Delete File: ../outside.txt\n-old line\n";
  assertEquals(parseApplyPatchFilePaths(patch), ["../outside.txt"]);
});

Deno.test("parseApplyPatchFilePaths extracts Move to path alongside Update File", () => {
  const patch = "*** Update File: a.txt\n*** Move to: /home/joshua/.ssh/b\n";
  assertEquals(parseApplyPatchFilePaths(patch), ["a.txt", "/home/joshua/.ssh/b"]);
});

Deno.test("parseApplyPatchFilePaths extracts all paths from multi-file patch", () => {
  const patch = `*** Add File: in-tree.txt
+new content
*** Update File: /tmp/out-of-tree.txt
-old
+new
`;
  assertEquals(parseApplyPatchFilePaths(patch), ["in-tree.txt", "/tmp/out-of-tree.txt"]);
});

Deno.test("parseApplyPatchFilePaths trims whitespace and strips quotes", () => {
  const patch = `*** Add File:   "src/path with spaces/file.ts"   \r
*** Update File: 'another/file.txt'
`;
  assertEquals(parseApplyPatchFilePaths(patch), [
    "src/path with spaces/file.ts",
    "another/file.txt",
  ]);
});

Deno.test("parseApplyPatchFilePaths deduplicates paths in order of occurrence", () => {
  const patch = `*** Update File: file1.ts
*** Update File: file2.ts
*** Update File: file1.ts
`;
  assertEquals(parseApplyPatchFilePaths(patch), ["file1.ts", "file2.ts"]);
});

Deno.test("parseApplyPatchFilePaths returns empty array on empty or malformed patch", () => {
  assertEquals(parseApplyPatchFilePaths(""), []);
  assertEquals(parseApplyPatchFilePaths("diff --git a/foo b/foo"), []);
  assertEquals(parseApplyPatchFilePaths("*** Add File:   "), []);
  assertEquals(parseApplyPatchFilePaths("echo hello world"), []);
});

Deno.test("CLI: prints parsed paths and exits 0 on valid JSON apply_patch payload", async () => {
  const input = JSON.stringify({
    tool_name: "apply_patch",
    tool_input: {
      command: "*** Add File: probe.txt\n+hello\n",
    },
  });
  const cmd = new Deno.Command("deno", {
    args: ["run", "--no-config", SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stdout } = await child.output();
  assertEquals(code, 0);
  assertEquals(new TextDecoder().decode(stdout).trim(), "probe.txt");
});

Deno.test("CLI: fails closed with exit 2 on malformed apply_patch payload", async () => {
  const input = JSON.stringify({
    tool_name: "apply_patch",
    tool_input: {
      command: "not a patch",
    },
  });
  const cmd = new Deno.Command("deno", {
    args: ["run", "--no-config", SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code } = await child.output();
  assertEquals(code, 2);
});
