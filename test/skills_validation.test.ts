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

import { assert, assertEquals, assertExists, assertFalse, assertStringIncludes } from "@std/assert";
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

Deno.test("skills/design-issue/SKILL.md contains the both-surfaces rule and refusal table entry", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  // Both surfaces rule in prose
  assertStringIncludes(
    text,
    "Everything this skill designs works on both Claude Code and agy/Antigravity.",
  );
  assertStringIncludes(
    text,
    "surface-neutral paths are this repository's `deno task` entries, the `gh` CLI, and CI",
  );
  assertStringIncludes(
    text,
    "fails when depending on Claude-only hooks, Claude memory, or mcp__* tools",
  );

  // Design doc ## Both surfaces section requirement
  assertStringIncludes(
    text,
    "**Every design document carries a `## Both surfaces` section**",
  );
  assertStringIncludes(
    text,
    "`deno task design:lint-doc` fails a document that omits it",
  );

  // Matching row in What It Refuses to Do table
  assertStringIncludes(
    text,
    "| design a mechanism that works on only one agent surface (Claude Code or agy/Antigravity) without stopping for discussion |",
  );
});

Deno.test("skills/design-issue/SKILL.md uses <topic>-manual-steps-<YYYY-MM-DD>.md runbook naming convention with no josh-steps", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(
    text,
    "~/Dropbox/web-jam-llms/<Theme>/<topic>-manual-steps-<YYYY-MM-DD>.md",
  );
  assertStringIncludes(
    text,
    "Runbooks are named `<topic>-manual-steps-<YYYY-MM-DD>.md`.",
  );
  assertFalse(
    text.includes("josh-steps"),
    "skills/design-issue/SKILL.md must not contain any occurrences of 'josh-steps'",
  );
});

Deno.test("skills/design-issue/SKILL.md contains resume rule in Phase 1 step 1", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(
    text,
    "**Resume rather than restart:** Before creating a design document, look in the theme folder for an existing `<topic>-design-*.md` and continue from its decision record; a run that wants a fresh document says so.",
  );
});

Deno.test("skills/design-issue/SKILL.md specifies Phase 4 runs on Claude Code only and is skipped on agy", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(
    text,
    "### Phase 4 — End-of-Run Memory Consume/Delete (Claude Code only; skipped on agy)",
  );
  assertStringIncludes(
    text,
    "**Surface scope:** Phase 4 runs on Claude Code only. It reads Claude Code's private memory directory (`~/.claude/projects/-home-joshua/memory/`) to decide which rules move into a skill body, and agy has no such directory. On agy, Phase 4 is skipped entirely, rather than silently doing nothing.",
  );
});

Deno.test("skills/design-issue/SKILL.md has deleted the Consumed rules appendix", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertFalse(
    text.includes("## Consumed rules"),
    "skills/design-issue/SKILL.md must not contain the Consumed rules appendix heading",
  );
});

Deno.test("skills/design-issue/SKILL.md requires issue body and Needs Design label to be reconciled together", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  // Numbered step in Phase 2 adjoining Needs Design label-removal step
  assertStringIncludes(
    text,
    "11. **Reconcile stale issue bodies and `Needs Design` label removals together in the same run — never separately.**",
  );
  assertStringIncludes(
    text,
    "Removing the `Needs Design` label and rewriting the issue's stale body sections happen in the same run — never separately (striking questions the design document answers, repointing design references, and reconciling scope against the approved plan).",
  );

  // Extended Gate 2 four-part reason naming specific stale body sections
  assertStringIncludes(
    text,
    "2. **why the design work that label asked for is now done** — naming the design document, the issues filed from it, and the specific stale body sections being rewritten (striking questions the design document answers, repointing design references, and reconciling scope);",
  );

  // Points at deno task design:stale-bodies
  assertStringIncludes(
    text,
    "`deno task design:stale-bodies`",
  );
});

Deno.test("skills/pr-review/SKILL.md uses ### 🟡 Suggestions heading and not Actionable Feedback & Suggestions", async () => {
  const prReviewPath = `${SKILLS_DIR}pr-review/SKILL.md`;
  const text = await Deno.readTextFile(prReviewPath);

  assertStringIncludes(
    text,
    "- **Suggestions** (`### 🟡 Suggestions`):",
  );
  assertStringIncludes(
    text,
    "### 🟡 Suggestions",
  );
  assertFalse(
    text.includes("Actionable Feedback & Suggestions"),
    "skills/pr-review/SKILL.md must not contain the superseded 'Actionable Feedback & Suggestions' heading",
  );
});
