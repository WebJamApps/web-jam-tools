// skills_validation.test.ts — web-jam-tools#133
//
// The laptop installs skills by symlinking this repo's skills/*/SKILL.md
// (deno task install-skills). A malformed frontmatter or a dir/name mismatch
// silently breaks skill loading with no CI signal. This test walks every
// skills/*/ directory and asserts:
//   - a SKILL.md exists
//   - its leading YAML frontmatter parses
//   - frontmatter has non-empty `name` + `description`
//   - `name` matches the containing directory name
// It also parses skills/venue-mining/sources.yaml (@std/yaml) and asserts its
// expected top-level shape (a `metros` array of metro records), since a bad
// edit there breaks the next venue-mining run with no CI signal either.
//
// Runs automatically as a normal Deno test under test/, picked up by the
// existing `coverage:check` step — no wiring needed beyond adding this file.

import { assert, assertEquals, assertExists } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";

const SKILLS_DIR = new URL("../skills/", import.meta.url).pathname;

/** Split a SKILL.md's contents into { frontmatter, body }. */
function extractFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    throw new Error("no leading '---' YAML frontmatter block found");
  }
  return match[1];
}

function listSkillDirs(): string[] {
  const dirs: string[] = [];
  for (const entry of Deno.readDirSync(SKILLS_DIR)) {
    if (entry.isDirectory) dirs.push(entry.name);
  }
  return dirs;
}

const skillDirs = listSkillDirs();

Deno.test("skills/ directory has at least one skill", () => {
  assert(skillDirs.length > 0, "expected at least one skills/*/ directory");
});

for (const dirName of skillDirs) {
  Deno.test(`skills/${dirName}/SKILL.md has valid frontmatter`, async () => {
    const skillMdPath = `${SKILLS_DIR}${dirName}/SKILL.md`;

    let text: string;
    try {
      text = await Deno.readTextFile(skillMdPath);
    } catch (err) {
      throw new Error(`skills/${dirName}/SKILL.md is missing or unreadable: ${err}`);
    }

    const frontmatterText = extractFrontmatter(text);
    // deno-lint-ignore no-explicit-any
    const frontmatter = parseYaml(frontmatterText) as Record<string, any>;

    assertExists(frontmatter, `skills/${dirName}/SKILL.md: frontmatter did not parse`);
    assert(
      typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0,
      `skills/${dirName}/SKILL.md: frontmatter "name" must be a non-empty string`,
    );
    assert(
      typeof frontmatter.description === "string" && frontmatter.description.trim().length > 0,
      `skills/${dirName}/SKILL.md: frontmatter "description" must be a non-empty string`,
    );
    assertEquals(
      frontmatter.name,
      dirName,
      `skills/${dirName}/SKILL.md: frontmatter "name" (${frontmatter.name}) must match its directory name (${dirName})`,
    );
  });
}

Deno.test("skills/venue-mining/sources.yaml parses with the expected top-level shape", async () => {
  const sourcesPath = `${SKILLS_DIR}venue-mining/sources.yaml`;
  const text = await Deno.readTextFile(sourcesPath);
  // deno-lint-ignore no-explicit-any
  const parsed = parseYaml(text) as Record<string, any>;

  assertExists(parsed, "sources.yaml did not parse");
  assert(Array.isArray(parsed.metros), "sources.yaml: expected a top-level `metros` array");
  assert(parsed.metros.length > 0, "sources.yaml: expected at least one metro entry");

  for (const metro of parsed.metros) {
    assert(
      typeof metro.slug === "string" && metro.slug.trim().length > 0,
      "sources.yaml: every metro entry needs a non-empty `slug`",
    );
    assert(
      typeof metro.label === "string" && metro.label.trim().length > 0,
      `sources.yaml: metro "${metro.slug}" needs a non-empty \`label\``,
    );
    assert(
      "publication" in metro,
      `sources.yaml: metro "${metro.slug}" needs a \`publication\` key (null or an object)`,
    );
    assert(
      "lastSwept" in metro,
      `sources.yaml: metro "${metro.slug}" needs a \`lastSwept\` key (null or a date)`,
    );
  }
});

Deno.test("skills/file-issue/SKILL.md contains the hook and skill both-surfaces rule", async () => {
  const fileIssuePath = `${SKILLS_DIR}file-issue/SKILL.md`;
  const text = await Deno.readTextFile(fileIssuePath);

  assert(
    text.includes("Hook and Skill Issues Must Target Both Claude Code and agy/Antigravity"),
    "skills/file-issue/SKILL.md must contain the numbered rule 'Hook and Skill Issues Must Target Both Claude Code and agy/Antigravity' in the Before you file section",
  );
});
