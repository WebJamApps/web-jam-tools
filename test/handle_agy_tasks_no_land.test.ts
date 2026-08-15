// handle_agy_tasks_no_land.test.ts — web-jam-tools#513
//
// Tests for --no-land flag in scripts/handle-agy-tasks.sh

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL("../scripts/handle-agy-tasks.sh", import.meta.url).pathname;

const FAKE_GH_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "issue" ] && [ "\${2:-}" = "view" ]; then
  jq -n --arg title "Test issue for no land" --arg body "Spec body" '{title: $title, body: $body, comments: []}'
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "list" ]; then
  for arg in "$@"; do
    if [ "$arg" = "--head" ]; then
      echo "123"
      exit 0
    fi
  done
  echo ""
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "view" ]; then
  echo "Closes #513\\n\\n🤖 Work by agy — Gemini 3.7 Flash (High)"
  exit 0
fi
echo "unstubbed gh invocation: $*" >&2
exit 1
`;

const FAKE_AGY_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
# Make a commit to move HEAD so handle-agy-tasks sees real progress
git commit --allow-empty -m "feat: test commit from agy stub" >/dev/null 2>&1 || true
exit 0
`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  mainCloneBranch: string;
}

async function setupFakeRepo(webjamRoot: string, repoName: string): Promise<string> {
  const repoDir = `${webjamRoot}/${repoName}`;
  await Deno.mkdir(repoDir, { recursive: true });

  await new Deno.Command("git", {
    args: ["init", "-b", "dev"],
    cwd: repoDir,
  }).output();

  await new Deno.Command("git", {
    args: ["config", "user.name", "Test User"],
    cwd: repoDir,
  }).output();
  await new Deno.Command("git", {
    args: ["config", "user.email", "test@example.com"],
    cwd: repoDir,
  }).output();

  await Deno.writeTextFile(`${repoDir}/README.md`, `# ${repoName}`);
  await new Deno.Command("git", { args: ["add", "."], cwd: repoDir }).output();
  await new Deno.Command("git", { args: ["commit", "-m", "initial commit"], cwd: repoDir })
    .output();

  // Set up origin remote pointing to self
  await new Deno.Command("git", { args: ["remote", "add", "origin", repoDir], cwd: repoDir })
    .output();

  return repoDir;
}

async function runScript(args: string[]): Promise<RunResult> {
  const binDir = await Deno.makeTempDir({ prefix: "wjt513-bin-" });

  const fakeGhPath = `${binDir}/gh`;
  await Deno.writeTextFile(fakeGhPath, FAKE_GH_SCRIPT);
  await Deno.chmod(fakeGhPath, 0o755);

  const fakeAgyPath = `${binDir}/agy`;
  await Deno.writeTextFile(fakeAgyPath, FAKE_AGY_SCRIPT);
  await Deno.chmod(fakeAgyPath, 0o755);

  const webjamRoot = await Deno.makeTempDir({ prefix: "wjt513-webjam-" });
  const repoDir = await setupFakeRepo(webjamRoot, "web-jam-tools");

  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH, ...args],
    env: {
      ...Deno.env.toObject(),
      PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
      AGY_WEBJAM_ROOT: webjamRoot,
    },
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await cmd.output();
  const textDecoder = new TextDecoder();

  const branchCmd = new Deno.Command("git", {
    args: ["branch", "--show-current"],
    cwd: repoDir,
    stdout: "piped",
  });
  const branchOut = await branchCmd.output();
  const mainCloneBranch = textDecoder.decode(branchOut.stdout).trim();

  return {
    code,
    stdout: textDecoder.decode(stdout),
    stderr: textDecoder.decode(stderr),
    mainCloneBranch,
  };
}

Deno.test("headless run with --no-land skips main clone branch checkout", async () => {
  const res = await runScript(["--headless", "--no-land", "web-jam-tools#513"]);
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "(--no-land specified — skipped checkout into main clone");
  assertStringIncludes(res.stdout, "draft PR #123 open");
  assertEquals(res.mainCloneBranch, "dev");
});

Deno.test("headless run without --no-land checks out branch into main clone", async () => {
  const res = await runScript(["--headless", "web-jam-tools#513"]);
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "Checked out");
  assertStringIncludes(res.stdout, "into main clone");
  assertEquals(res.mainCloneBranch, "agy/513-test-issue-for-no-land");
});
