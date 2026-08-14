// install_skills_script.test.ts — web-jam-tools#491
//
// Tests for scripts/install-skills.sh prune path and symlink creation.

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL("../scripts/install-skills.sh", import.meta.url).pathname;
const REPO_DIR = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("install-skills.sh prunes dangling symlinks to deleted skills and preserves *.bak-* dirs", async () => {
  const fakeHome = await Deno.makeTempDir({ prefix: "wjt491-home-" });

  const claudeSkills = `${fakeHome}/.claude/skills`;
  const agySkills = `${fakeHome}/.gemini/config/plugins/webjam-tasks/skills`;
  await Deno.mkdir(claudeSkills, { recursive: true });
  await Deno.mkdir(agySkills, { recursive: true });

  // 1. Create dangling symlink pointing into repo skills/
  const danglingTarget = `${REPO_DIR}/skills/does-not-exist-skill`;
  const danglingClaudeLink = `${claudeSkills}/does-not-exist-skill`;
  const danglingAgyLink = `${agySkills}/does-not-exist-skill`;

  await Deno.symlink(danglingTarget, danglingClaudeLink);
  await Deno.symlink(danglingTarget, danglingAgyLink);

  // 2. Create a *.bak-* directory alongside
  const bakDir = `${claudeSkills}/issue-design.bak-20260811-120000`;
  await Deno.mkdir(bakDir, { recursive: true });
  await Deno.writeTextFile(`${bakDir}/README.txt`, "backup data");

  // 3. Run scripts/install-skills.sh
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    env: {
      ...Deno.env.toObject(),
      HOME: fakeHome,
    },
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await cmd.output();
  const textDecoder = new TextDecoder();
  const stdoutStr = textDecoder.decode(stdout);
  const stderrStr = textDecoder.decode(stderr);

  assertEquals(code, 0, stderrStr);

  // 4. Assert dangling links were pruned
  assertStringIncludes(stdoutStr, "Claude: does-not-exist-skill: pruned stale symlink");
  assertStringIncludes(stdoutStr, "agy: does-not-exist-skill: pruned stale symlink");

  let claudeLinkExists = false;
  try {
    await Deno.lstat(danglingClaudeLink);
    claudeLinkExists = true;
  } catch {
    claudeLinkExists = false;
  }
  assertEquals(claudeLinkExists, false, "Dangling Claude symlink should be removed");

  let agyLinkExists = false;
  try {
    await Deno.lstat(danglingAgyLink);
    agyLinkExists = true;
  } catch {
    agyLinkExists = false;
  }
  assertEquals(agyLinkExists, false, "Dangling agy symlink should be removed");

  // 5. Assert *.bak-* dir remains untouched
  const bakDirStat = await Deno.stat(bakDir);
  assertEquals(bakDirStat.isDirectory, true, "*.bak-* directory should remain untouched");
  const bakContent = await Deno.readTextFile(`${bakDir}/README.txt`);
  assertEquals(bakContent, "backup data");

  // 6. Assert valid skills (like design-issue and file-issue) were linked
  const designIssueLink = await Deno.readLink(`${claudeSkills}/design-issue`);
  assertStringIncludes(designIssueLink, "skills/design-issue");
  const fileIssueLink = await Deno.readLink(`${claudeSkills}/file-issue`);
  assertStringIncludes(fileIssueLink, "skills/file-issue");
});
