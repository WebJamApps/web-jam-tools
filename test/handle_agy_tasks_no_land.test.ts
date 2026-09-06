// handle_agy_tasks_no_land.test.ts — web-jam-tools#513, web-jam-tools#686
//
// Tests for UI-repo-conditional landing and --land / --no-land flags in scripts/handle-agy-tasks.sh

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL("../scripts/handle-agy-tasks.sh", import.meta.url).pathname;

const FAKE_GH_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "issue" ] && [ "\${2:-}" = "view" ]; then
  jq -n --arg title "Test issue for landing" --arg body "Spec body" '{title: $title, body: $body, comments: []}'
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
  # web-jam-tools#912 — the footer create-draft-pr.sh is actually able to
  # write: its ROSTER is unversioned, so it refuses a version-qualified author
  # outright. This fixture previously carried the version-qualified spelling,
  # which no real PR body can ever have.
  echo "Closes #686\\n\\n🤖 Work by agy — Gemini Flash (High)"
  exit 0
fi
if [ "\${1:-}" = "api" ]; then
  printf '%s' "[]"
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

async function runScript(args: string[], repoName = "web-jam-tools"): Promise<RunResult> {
  const binDir = await Deno.makeTempDir({ prefix: "wjt686-bin-" });

  const fakeGhPath = `${binDir}/gh`;
  await Deno.writeTextFile(fakeGhPath, FAKE_GH_SCRIPT);
  await Deno.chmod(fakeGhPath, 0o755);

  const fakeAgyPath = `${binDir}/agy`;
  await Deno.writeTextFile(fakeAgyPath, FAKE_AGY_SCRIPT);
  await Deno.chmod(fakeAgyPath, 0o755);

  const webjamRoot = await Deno.makeTempDir({ prefix: "wjt686-webjam-" });
  const repoDir = await setupFakeRepo(webjamRoot, repoName);

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

Deno.test("headless run targeting non-UI repo without flags skips main clone branch checkout", async () => {
  const res = await runScript(["--headless", "web-jam-tools#686"], "web-jam-tools");
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "(Non-UI repo web-jam-tools — skipped checkout into main clone");
  assertStringIncludes(res.stdout, "draft PR #123 open");
  assertEquals(res.mainCloneBranch, "dev");
});

Deno.test("headless run targeting non-UI repo with --land checks out branch into main clone", async () => {
  const res = await runScript(["--headless", "--land", "web-jam-tools#686"], "web-jam-tools");
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "Checked out");
  assertStringIncludes(res.stdout, "into main clone");
  assertEquals(res.mainCloneBranch, "agy/686-test-issue-for-landing");
});

Deno.test("headless run targeting UI repo without flags checks out branch into main clone", async () => {
  const res = await runScript(["--headless", "JaMmusic#686"], "JaMmusic");
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "Checked out");
  assertStringIncludes(res.stdout, "into main clone");
  assertEquals(res.mainCloneBranch, "agy/686-test-issue-for-landing");
});

Deno.test("headless run targeting UI repo with --no-land skips main clone branch checkout", async () => {
  const res = await runScript(["--headless", "--no-land", "JaMmusic#686"], "JaMmusic");
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "(--no-land specified — skipped checkout into main clone");
  assertStringIncludes(res.stdout, "draft PR #123 open");
  assertEquals(res.mainCloneBranch, "dev");
});

Deno.test("headless run targeting non-UI repo with both --land and --no-land skips checkout (--no-land wins)", async () => {
  const res = await runScript(
    ["--headless", "--land", "--no-land", "web-jam-tools#686"],
    "web-jam-tools",
  );
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "(--no-land specified — skipped checkout into main clone");
  assertEquals(res.mainCloneBranch, "dev");
});

Deno.test("headless run targeting UI repo with both --land and --no-land skips checkout (--no-land wins)", async () => {
  const res = await runScript(["--headless", "--land", "--no-land", "JaMmusic#686"], "JaMmusic");
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "(--no-land specified — skipped checkout into main clone");
  assertEquals(res.mainCloneBranch, "dev");
});
