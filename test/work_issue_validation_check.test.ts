/**
 * test/work_issue_validation_check.test.ts
 *
 * Unit tests verifying completion detection, merged-PR regex widening,
 * and three-outcome post-merge acceptance criteria validation in
 * skills/work-issue/SKILL.md across all surfaces (web-jam-tools#1489).
 */

import { assert, assertFalse, assertMatch, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const WORK_ISSUE_PATH = `${REPO_ROOT}skills/work-issue/SKILL.md`;

Deno.test("skills/work-issue/SKILL.md: open PR and Signal 1 regexes match repo-qualified and bare citations, rejecting cross-repo citations", async () => {
  const text = await Deno.readTextFile(WORK_ISSUE_PATH);

  // Extract the open PR jq command in section 3
  const section3Match = text.match(
    /3\. \*\*Not already in flight[\s\S]*?```bash([\s\S]*?)```/,
  );
  assert(section3Match, "Section 3 open PR check must exist");
  const openPrCmd = section3Match[1];

  // Extract the Signal 1 merged PR jq command in section 4
  const signal1SectionMatch = text.match(
    /Signal 1 \(Merged or closed PR\)[\s\S]*?```bash([\s\S]*?)```/,
  );
  assert(signal1SectionMatch, "Signal 1 merged PR section must exist");
  const mergedPrCmd = signal1SectionMatch[1];

  // Both commands must use the scoped repo-matching regex
  const expectedPatternInDoc =
    `test("(?i)(closes|part of)\\\\s+(?:(?:WebJamApps/)?<Repo>)?#<num>([^0-9]|$)")`;
  assertStringIncludes(openPrCmd, expectedPatternInDoc);
  assertStringIncludes(mergedPrCmd, expectedPatternInDoc);

  // Dynamically extract the pattern from SKILL.md and construct a RegExp for <Repo> = web-jam-tools, <num> = 1051
  const patternExtractMatch = signal1SectionMatch[1].match(/test\("([^"]+)"\)/);
  assert(patternExtractMatch, "Pattern must be extracted from Signal 1 command");
  const extractedRawPattern = patternExtractMatch[1];

  // Unescape backslashes from jq string literal and parameterize <Repo> and <num>
  const parameterizedPattern = extractedRawPattern
    .replace(/\\\\s\+/g, "\\s+")
    .replaceAll("<Repo>", "web-jam-tools")
    .replaceAll("<num>", "1051");
  const re = new RegExp(parameterizedPattern.replace("(?i)", ""), "i");

  // Matches Part of <repo>#<num>
  assertMatch('Part of web-jam-tools#1051 "hooks/block-raw-gh-write"', re);
  assertMatch("part of web-jam-tools#1051", re);

  // Matches Part of <owner>/<repo>#<num>
  assertMatch('Part of WebJamApps/web-jam-tools#1051 "title"', re);
  assertMatch("part of WebJamApps/web-jam-tools#1051", re);

  // Matches bare Part of #<num> and Closes #<num>
  assertMatch("Part of #1051", re);
  assertMatch("part of #1051\n", re);
  assertMatch("Closes #1051", re);
  assertMatch("closes #1051", re);
  assertMatch("Closes web-jam-tools#1051", re);
  assertMatch("Closes WebJamApps/web-jam-tools#1051", re);

  // Negative tests: rejects citations for other repositories (cross-repo matching prevention)
  assertFalse(re.test("Part of JaMmusic#1051"));
  assertFalse(re.test("Closes JaMmusic#1051"));
  assertFalse(re.test("Part of AppersonAuto#1051"));
  assertFalse(re.test("Closes OtherOrg/web-jam-tools#1051"));

  // Negative tests: does not match unrelated issue numbers or non-matching prefixes
  assertFalse(re.test("Part of #10510"));
  assertFalse(re.test("Closes #10510"));
  assertFalse(re.test("Part of web-jam-tools#10510"));
  assertFalse(re.test("Part of #999"));
  assertFalse(re.test("Discussion on #1051 without closes or part of"));
  assertFalse(re.test("Relates to web-jam-tools#1051"));
});

Deno.test("skills/work-issue/SKILL.md: specifies three-outcome post-merge acceptance criteria validation and non-mutating bounds", async () => {
  const text = await Deno.readTextFile(WORK_ISSUE_PATH);

  // Must include post-merge validation section header
  assertStringIncludes(
    text,
    "Post-merge acceptance criteria validation (Three outcomes)",
  );

  // Non-mutating verification bounds
  assertStringIncludes(text, "Non-mutating verification bounds");
  assertStringIncludes(
    text,
    "Only deterministic, non-mutating validation commands are executed",
  );
  assertStringIncludes(
    text,
    "NEVER execute commands with external side-effects",
  );
  assertStringIncludes(text, "no `git push`");
  assertStringIncludes(text, "no deleting branches");
  assertStringIncludes(text, "no sending network writes");

  // Outcome 1: all AC hold -> edit-issue checks off checkboxes and post-issue-comment posts comment
  assertStringIncludes(text, "Outcome 1 (All acceptance criteria pass validation):");
  assertStringIncludes(text, "`- [ ]` → `- [x]`");
  assertStringIncludes(
    text,
    'deno task edit-issue --repo WebJamApps/<Repo> --issue <num> --body-file <path> --author "<tool — model>"',
  );
  assertStringIncludes(
    text,
    "deno task post-issue-comment --repo WebJamApps/<Repo> --issue <num> --body-file <path>",
  );
  assertStringIncludes(text, "updating the `🤖 Authored by` footer");
  assertStringIncludes(
    text,
    "Stops and leaves the issue for Josh to review and close",
  );

  // Outcome 2: one or more AC fail -> refuse to check off and report failure
  assertStringIncludes(text, "Outcome 2 (One or more acceptance criteria fail validation):");
  assertStringIncludes(
    text,
    "refuses to check off the failing criterion (`- [ ]` remains unchecked)",
  );
  assertStringIncludes(text, "stops without closing the issue");

  // Outcome 3: unable to determine / error / unreadable -> fail closed, leave unchecked
  assertStringIncludes(
    text,
    "Outcome 3 (Unable to determine whether an acceptance criterion holds):",
  );
  assertStringIncludes(text, "**refuses** (fails closed on validation)");
  assertStringIncludes(text, "leaves that criterion's checkbox unchecked (`- [ ]`)");
  assertStringIncludes(text, "does not claim validation passed");
});

Deno.test("skills/work-issue/SKILL.md: retains hard safety bounds (never close autonomously, no worklist/label edits)", async () => {
  const text = await Deno.readTextFile(WORK_ISSUE_PATH);

  // Hard safety bounds heading
  assertStringIncludes(text, "Hard safety bounds on completion detection");

  // Never close an issue autonomously
  assertStringIncludes(text, "Never close an issue autonomously");
  assertStringIncludes(
    text,
    "Agents are strictly forbidden from running `gh issue close` autonomously without Josh's explicit authorization",
  );

  // No label or worklist edits
  assertStringIncludes(text, "No label or worklist edits");
  assertStringIncludes(text, "gh issue edit --add-label");
  assertStringIncludes(text, "never writes to `haiku-issues.md`");
});

Deno.test("skills/work-issue/SKILL.md: surface symlinks resolve to canonical repository SKILL.md", async () => {
  const home = (await Deno.permissions.query({ name: "env", variable: "HOME" })).state === "granted"
    ? Deno.env.get("HOME") ?? "/home/joshua"
    : "/home/joshua";

  const surfacePaths = [
    { name: "Claude Code", path: `${home}/.claude/skills/work-issue/SKILL.md` },
    {
      name: "agy/Antigravity",
      path: `${home}/.gemini/config/plugins/webjam-tasks/skills/work-issue/SKILL.md`,
    },
    { name: "Codex", path: `${home}/.codex/skills/work-issue/SKILL.md` },
  ];

  for (const { name, path } of surfacePaths) {
    try {
      const target = await Deno.realPath(path);
      assert(
        target.endsWith("skills/work-issue/SKILL.md"),
        `${name} path ${path} must resolve to skills/work-issue/SKILL.md, got ${target}`,
      );
      // Canonical target path: resolves to main clone on laptop or repository SKILL.md
      const repoSkillPath = await Deno.realPath(
        new URL("../skills/work-issue/SKILL.md", import.meta.url).pathname,
      );
      const isCanonical =
        target === `${home}/WebJamApps/web-jam-tools/skills/work-issue/SKILL.md` ||
        target === repoSkillPath;
      assert(
        isCanonical,
        `${name} path ${path} must resolve to canonical repository SKILL.md, got ${target}`,
      );
    } catch (e) {
      // In CI environments without user home directories, skip if the path does not exist
      if (e instanceof Deno.errors.NotFound) {
        continue;
      }
      throw e;
    }
  }
});
