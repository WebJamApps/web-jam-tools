// handle_agy_tasks_target_repo.test.ts — web-jam-tools#517
//
// Tests for target repository override (--repo / AGY_TARGET_REPO) in scripts/handle-agy-tasks.sh

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL("../scripts/handle-agy-tasks.sh", import.meta.url).pathname;

const FAKE_GH_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "issue" ] && [ "\${2:-}" = "view" ]; then
  jq -n --arg title "Test multi-repo issue" --arg body "Feature spec" '{title: $title, body: $body, comments: []}'
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "list" ]; then
  exit 0
fi
echo "unstubbed gh invocation: $*" >&2
exit 1
`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function setupFakeRepo(webjamRoot: string, repoName: string): Promise<string> {
  const repoDir = `${webjamRoot}/${repoName}`;
  await Deno.mkdir(repoDir, { recursive: true });

  const initCmd = new Deno.Command("git", {
    args: ["init", "-b", "dev"],
    cwd: repoDir,
    stdout: "piped",
    stderr: "piped",
  });
  await initCmd.output();

  // Set local dummy git user
  await new Deno.Command("git", {
    args: ["config", "user.name", "Test User"],
    cwd: repoDir,
  }).output();
  await new Deno.Command("git", {
    args: ["config", "user.email", "test@example.com"],
    cwd: repoDir,
  }).output();

  // Create initial commit on dev
  await Deno.writeTextFile(`${repoDir}/README.md`, `# ${repoName}`);
  await new Deno.Command("git", { args: ["add", "."], cwd: repoDir }).output();
  await new Deno.Command("git", { args: ["commit", "-m", "initial commit"], cwd: repoDir })
    .output();

  // Set up origin remote pointing to self so `git fetch origin dev` works
  await new Deno.Command("git", { args: ["remote", "add", "origin", repoDir], cwd: repoDir })
    .output();

  return repoDir;
}

async function runScript(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<RunResult> {
  const binDir = await Deno.makeTempDir({ prefix: "wjt517-bin-" });
  const fakeGhPath = `${binDir}/gh`;
  await Deno.writeTextFile(fakeGhPath, FAKE_GH_SCRIPT);
  await Deno.chmod(fakeGhPath, 0o755);

  const webjamRoot = await Deno.makeTempDir({ prefix: "wjt517-webjam-" });
  await setupFakeRepo(webjamRoot, "web-jam-tools");
  await setupFakeRepo(webjamRoot, "JaMmusic");

  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH, ...args],
    env: {
      ...Deno.env.toObject(),
      PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
      AGY_WEBJAM_ROOT: webjamRoot,
      ...envOverrides,
    },
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await cmd.output();
  const textDecoder = new TextDecoder();
  return {
    code,
    stdout: textDecoder.decode(stdout),
    stderr: textDecoder.decode(stderr),
  };
}

Deno.test("--repo flag overrides working repository for multi-repo issue", async () => {
  const res = await runScript(["--dry-run", "--repo", "JaMmusic", "web-jam-tools#505"]);
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "JaMmusic");
  assertStringIncludes(res.stdout, "REPO_DIR: /tmp/agy-worktrees/JaMmusic-agy-505-");
  assertStringIncludes(res.stdout, "You are working in the JaMmusic repo on branch agy/505-");
});

Deno.test("--repo=Name flag syntax overrides working repository", async () => {
  const res = await runScript(["--dry-run", "--repo=JaMmusic", "web-jam-tools#505"]);
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "REPO_DIR: /tmp/agy-worktrees/JaMmusic-agy-505-");
});

Deno.test("AGY_TARGET_REPO environment variable overrides working repository", async () => {
  const res = await runScript(["--dry-run", "web-jam-tools#505"], {
    AGY_TARGET_REPO: "JaMmusic",
  });
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "REPO_DIR: /tmp/agy-worktrees/JaMmusic-agy-505-");
  assertStringIncludes(res.stdout, "You are working in the JaMmusic repo on branch agy/505-");
});

Deno.test("default (no override) uses issue repo prefix as working repository", async () => {
  const res = await runScript(["--dry-run", "web-jam-tools#505"]);
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "REPO_DIR: /tmp/agy-worktrees/web-jam-tools-agy-505-");
  assertStringIncludes(res.stdout, "You are working in the web-jam-tools repo on branch agy/505-");
});

Deno.test("non-existent target repo directory exits non-zero with error message", async () => {
  const res = await runScript(["--dry-run", "--repo", "NonExistentRepo", "web-jam-tools#505"]);
  assertEquals(res.code, 1);
  assertStringIncludes(res.stderr, "ERROR: repo folder not found:");
  assertStringIncludes(res.stderr, "NonExistentRepo");
});
