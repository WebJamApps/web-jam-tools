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

Deno.test("skills/file-issue/SKILL.md contains the three-outcomes guard rule, pointer, and purely additive rule", async () => {
  const fileIssuePath = `${SKILLS_DIR}file-issue/SKILL.md`;
  const text = await Deno.readTextFile(fileIssuePath);

  // Item 2 pointer to Item 15
  assert(
    text.includes("See item 15 below for the three-outcome specification and model floor"),
    "skills/file-issue/SKILL.md item 2 must contain a pointer sentence to item 15",
  );

  // Item 15: A Guard Has Three Outcomes, Not Two
  assert(
    text.includes("A Guard Has Three Outcomes, Not Two"),
    "skills/file-issue/SKILL.md must contain the numbered rule 'A Guard Has Three Outcomes, Not Two' in the Before you file section",
  );
  assert(
    text.includes(
      "the lookup errors, the API times out, the file is missing, or the field is absent",
    ),
    "skills/file-issue/SKILL.md item 15 must name lookup errors, API timeout, missing file, and absent field failure cases",
  );
  assert(
    text.includes("refuses") && text.includes("proceeds"),
    "skills/file-issue/SKILL.md item 15 must use the vocabulary of whether the system refuses or proceeds",
  );
  assert(
    text.includes("`Flash High` floor"),
    "skills/file-issue/SKILL.md item 15 must specify the Flash High floor",
  );

  // Item 16: Guardrail and Rules Edits Must Be Purely Additive
  assert(
    text.includes("Guardrail and Rules Edits Must Be Purely Additive"),
    "skills/file-issue/SKILL.md must contain the numbered rule 'Guardrail and Rules Edits Must Be Purely Additive' in the Before you file section",
  );
  assert(
    text.includes("purely additive"),
    "skills/file-issue/SKILL.md item 16 must specify purely additive rule edits",
  );
  assert(
    text.includes("AGENTS.md") && text.includes("docs/cross-ai-rules.md"),
    "skills/file-issue/SKILL.md item 16 must name AGENTS.md, docs/cross-ai-rules.md, and skill body",
  );
});

Deno.test("skills/file-issue/SKILL.md item 14 splits both-surfaces acceptance criteria by change kind and bans the hooks/lib path", async () => {
  const fileIssuePath = `${SKILLS_DIR}file-issue/SKILL.md`;
  const text = await Deno.readTextFile(fileIssuePath);

  // Structural change kind still names an installer per surface
  assert(
    text.includes("Structural change: one acceptance criterion per surface, naming the installer."),
    "skills/file-issue/SKILL.md item 14 must keep the structural-change bullet naming an installer per surface",
  );

  // Content-only change kind names the resolution check instead of an installer
  assert(
    text.includes(
      "Content-only change: one acceptance criterion per surface, naming the resolution check, not an installer.",
    ),
    "skills/file-issue/SKILL.md item 14 must add the content-only-change bullet naming the resolution check",
  );
  assert(
    text.includes("needs no installer: `git pull` on `dev` makes it live on both surfaces"),
    "skills/file-issue/SKILL.md item 14 must state that a content-only change needs no installer",
  );

  // A new supporting file inside an already-installed skill directory is content-only
  assert(
    text.includes(
      "a new or existing supporting file inside an already-installed skill directory (e.g. adding `skills/fix-labels/labels.yaml` to the already-installed `fix-labels` skill)",
    ),
    "skills/file-issue/SKILL.md item 14 must classify a new supporting file in an already-installed skill directory as content-only",
  );

  // A brand-new hooks/lib/*.ts module consumed by an already-installed hook is content-only, not structural
  assert(
    text.includes(
      "A brand-new `hooks/lib/*.ts` module consumed by an already-installed hook is **not** a new hook under this bullet",
    ),
    "skills/file-issue/SKILL.md item 14's structural bullet must disclaim a new hooks/lib/*.ts module as not a new hook",
  );
  assert(
    text.includes(
      "a new or existing shared `hooks/lib/*.ts` module consumed by an already-installed hook",
    ),
    "skills/file-issue/SKILL.md item 14's content-only bullet must classify a new hooks/lib/*.ts module as content-only",
  );

  // Skill case: two genuinely distinct symlinks, one criterion per surface as before
  assert(
    text.includes(
      "For a **skill**, `~/.claude/skills/<skill>` and `~/.gemini/config/plugins/webjam-tasks/skills/<skill>` are two genuinely distinct symlinks, so the `## Acceptance criteria` section asserts, per surface, that the installed symlink still resolves into the canonical clone.",
    ),
    "skills/file-issue/SKILL.md item 14 must keep the skill content-only case as two distinct symlink assertions",
  );

  // Hook case: only one hook symlink, so the agy criterion asserts the hooks.json shim registration, not a second symlink
  assert(
    text.includes(
      "For a **hook or a `hooks/lib/*.ts` module**, there is only one hook symlink (`~/.claude/hooks/<hook>.sh`)",
    ),
    "skills/file-issue/SKILL.md item 14 must state that a hook or hooks/lib/*.ts module has only one hook symlink",
  );
  assert(
    text.includes(
      "for a `PreToolUse` or `PostToolUse` hook, which carries a `~/.gemini/config/hooks.json` shim registration, the agy criterion asserts that registration still targets that same `$HOME/.claude/hooks/` path",
    ),
    "skills/file-issue/SKILL.md item 14 must state the agy criterion for a PreToolUse/PostToolUse hook content-only change asserts the hooks.json shim registration",
  );

  // Hook case: a SessionStart/Stop lifecycle hook carries NO agy registration at all (registering
  // one there disables agy's entire hooks config), so the agy criterion asserts that absence as a
  // deliberate fact rather than inventing a path or registration to assert instead.
  assert(
    text.includes(
      "for a `SessionStart` or `Stop` hook, `~/.gemini/config/hooks.json` carries no registration for it at all and never can",
    ),
    "skills/file-issue/SKILL.md item 14 must state that a SessionStart/Stop hook carries no agy hooks.json registration at all",
  );
  assert(
    text.includes(
      "registering either lifecycle event silently disables agy's entire hooks config (`docs/agy-hooks.md` finding 9)",
    ),
    "skills/file-issue/SKILL.md item 14 must cite docs/agy-hooks.md finding 9 for why lifecycle hooks are never registered with agy",
  );
  assert(
    text.includes(
      "so the agy criterion asserts that fact plainly: the hook has no `~/.gemini/config/hooks.json` registration, and the content change has no agy-side effect",
    ),
    "skills/file-issue/SKILL.md item 14 must state the no-registration agy criterion wording for a SessionStart/Stop hook",
  );
  assert(
    text.includes(
      "Never invent an agy-side path or registration for a `SessionStart`/`Stop` hook to satisfy this criterion.",
    ),
    "skills/file-issue/SKILL.md item 14 must prohibit inventing an agy-side path or registration for a SessionStart/Stop hook",
  );

  // agy-only hooks: the mirror case on the Claude Code side. These are symlinked into
  // ~/.claude/hooks/ like every other hook but are never registered in Claude Code's
  // settings.json, so a bare symlink-resolution criterion would be true while implying a
  // Claude-Code-side effect that cannot occur.
  assert(
    text.includes(
      "except for a hook listed in `scripts/install-hooks.sh`'s `AGY_ONLY_PRE_TOOL_USE_HOOKS` array (`hooks/agy-model-guard.sh`, `hooks/block-agy-gmail-send-delete.sh`)",
    ),
    "skills/file-issue/SKILL.md item 14 must carve out the AGY_ONLY_PRE_TOOL_USE_HOOKS hooks from the Claude Code symlink-resolution criterion",
  );
  assert(
    text.includes(
      "is deliberately never registered in Claude Code's `settings.json`, because it depends on agy-native payload fields Claude Code's hook payload does not carry",
    ),
    "skills/file-issue/SKILL.md item 14 must state why an agy-only hook carries no Claude Code settings.json registration",
  );
  assert(
    text.includes(
      "asserting only that the symlink resolves would be a true statement implying a Claude-Code-side effect that cannot occur",
    ),
    "skills/file-issue/SKILL.md item 14 must state why a bare symlink assertion is hollow for an agy-only hook",
  );
  assert(
    text.includes(
      "the Claude Code criterion instead asserts that fact plainly: the hook has no Claude Code `settings.json` registration, and the content change has no Claude-Code-side effect",
    ),
    "skills/file-issue/SKILL.md item 14 must state the no-registration Claude Code criterion wording for an agy-only hook",
  );
  assert(
    text.includes(
      "Never invent a Claude Code registration for an agy-only hook to satisfy this criterion.",
    ),
    "skills/file-issue/SKILL.md item 14 must prohibit inventing a Claude Code registration for an agy-only hook",
  );

  // Explicit prohibition on asserting a ~/.claude/hooks/lib/ path
  assert(
    text.includes("Never assert a `~/.claude/hooks/lib/` path."),
    "skills/file-issue/SKILL.md item 14 must prohibit asserting a ~/.claude/hooks/lib/ path",
  );
  assert(
    text.includes(
      "`hooks/lib/` is never installed by `scripts/install-hooks.sh`, so that path does not exist",
    ),
    "skills/file-issue/SKILL.md item 14 must state that hooks/lib/ is never installed and the path does not exist",
  );
});

Deno.test("skills/file-issue/SKILL.md contains the issue titles rule for PM audience, skill/feature prefix, and Epic citation (#869)", async () => {
  const fileIssuePath = `${SKILLS_DIR}file-issue/SKILL.md`;
  const text = await Deno.readTextFile(fileIssuePath);

  assert(
    text.includes(
      "Issue Titles for Project Manager Audience with Skill/Feature Prefix and Epic Citation",
    ),
    "skills/file-issue/SKILL.md must contain the numbered rule 'Issue Titles for Project Manager Audience with Skill/Feature Prefix and Epic Citation' in Before you file",
  );
  assert(
    text.includes("Written for a Project Manager Audience"),
    "skills/file-issue/SKILL.md must require titles written for a project manager audience",
  );
  assert(
    text.includes("Skill or Feature Scope Prefix"),
    "skills/file-issue/SKILL.md must require skill or feature prefix where applicable",
  );
  assert(
    text.includes("Link/Cite Parent Epic"),
    "skills/file-issue/SKILL.md must require linking and citing parent Epic where applicable",
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

Deno.test("skills/pr-review/SKILL.md clarifies AGENTS.md scope exemption and Antigravity-specific /learn command (#867)", async () => {
  const prReviewPath = `${SKILLS_DIR}pr-review/SKILL.md`;
  const text = await Deno.readTextFile(prReviewPath);

  assertStringIncludes(
    text,
    "**Exception — `AGENTS.md` and `docs/cross-ai-rules.md` updates are never a scope violation.**",
  );
  assertStringIncludes(
    text,
    "`/learn` is a Google Antigravity-native command",
  );
  assertStringIncludes(
    text,
    "never expect or flag a missing `/learn` invocation",
  );
});

Deno.test("skills/design-issue/SKILL.md contains absolute standing rule that skill never dispatches", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(
    text,
    '**ABSOLUTE STANDING RULE:** The skill **NEVER dispatches.** It ends at "the issues exist". It never spawns a build agent, hands work to a lane, starts a worktree, or runs `/work-issue`.',
  );
  assertStringIncludes(
    text,
    "| **dispatch — spawn a build agent, hand work to a lane, start a worktree, run `/work-issue`** | absolute standing rule |",
  );
  assertStringIncludes(
    text,
    "| offer dispatch as a next step in the same breath as reporting what it filed | same rule, quieter failure |",
  );
});

Deno.test("skills/design-issue/SKILL.md contains Sized for Flash High rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(text, "### Sized for Flash High");
  assertStringIncludes(
    text,
    "Non-epic issues default to **`Flash High`** as the implementation tier. Sizing is governed by the reviewer's burden in one sitting (Josh's per-sitting review burden) rather than raw file count.",
  );
  assertStringIncludes(text, "- one repo;");
  assertStringIncludes(text, "- one layer — frontend or backend, not both;");
  assertStringIncludes(
    text,
    "- roughly 600 changed lines or fewer (additions + deletions), excluding lockfiles and generated files;",
  );
  assertStringIncludes(text, "- no schema or data migration;");
  assertStringIncludes(
    text,
    "- acceptance criteria provable by running that repo's own test / lint / build commands.",
  );
  assertStringIncludes(
    text,
    "Anything over the line is split into multiple issues, and **every split carries its dependencies** — linked natively via GitHub issue dependencies (`blocked_by`), without adding the redundant `Blocked` label.",
  );
});

Deno.test("skills/design-issue/SKILL.md contains Decision-Readiness rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(text, "### Decision-Readiness Rule");
  assertStringIncludes(
    text,
    "A decision is not ready to put to Josh until these conditions are met:",
  );
  assertStringIncludes(
    text,
    "1. **Exactly ONE decision per turn** — present one focused question per turn, with enough detail for Josh to decide it on its own.",
  );
  assertStringIncludes(
    text,
    "2. **The mechanism is explained** in Josh's terms before the question — every component the question turns on, described plainly, including machinery discovered mid-session that Josh has never seen.",
  );
  assertStringIncludes(
    text,
    "3. **Every option carries what it actually costs** — what happens in this session, what work it creates, what it collides with, what it risks, and what it gives up.",
  );
  assertStringIncludes(
    text,
    "4. **The recommendation comes last** — after both the mechanism and the options' costs, never instead of them and never before them.",
  );
  assertStringIncludes(
    text,
    'The test is Josh\'s reply: if it comes back as *"I need more details to decide"* or *"I am confused"*, the question was defective, and the repair belongs in the question rather than in a follow-up patching around it.',
  );
});

Deno.test("skills/design-issue/SKILL.md contains Edit-Reconciliation rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(text, "### Edit-Reconciliation Rule");
  assertStringIncludes(
    text,
    "Replacing a paragraph is not the complete edit. An edit is finished only when the text around it has been re-read and reconciled:",
  );
  assertStringIncludes(
    text,
    "- After any replacement, read the paragraph before and the paragraph after in full.",
  );
  assertStringIncludes(
    text,
    "- Confirm the passage makes each point exactly once, contains no duplicate conclusions, and still argues in one consistent direction.",
  );
  assertStringIncludes(
    text,
    "- A patch applied without reading its neighboring paragraphs is not done.",
  );
});

Deno.test("skills/design-issue/SKILL.md contains Epic or Flat rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(text, "### Epic or Flat");
  assertStringIncludes(
    text,
    "Propose an **epic with children** when the work spans more than one repo, needs more than three issues, or has halves proved by different kinds of evidence. Otherwise propose a **flat set**, or a single issue.",
  );
  assertStringIncludes(
    text,
    "Never propose an epic that is only a container. The heuristic test is whether there is a shared artifact the children point at (not whether the children share a cause).",
  );
  assertStringIncludes(
    text,
    "If the only thing an epic would add is a title, the plan is a flat set.",
  );
});

Deno.test("skills/design-issue/SKILL.md contains Closeable, Always rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(text, "### Closeable, Always");
  assertStringIncludes(
    text,
    "Every issue must be closeable. A non-epic closes when its work is done; **an epic closes when its children close.** Epics are not implementable but they are closeable when their sub-issues are done. Perpetual trackers remain banned.",
  );
});

Deno.test("skills/design-issue/SKILL.md contains Proved by Something rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(text, "### Proved by Something");
  assertStringIncludes(
    text,
    "The `Tests` column states what proves each issue — unit tests, a Playwright e2e spec, a full-stack run, or none — and why. The skill proposes; Josh rules per issue at GATE 2. It never silently drops coverage and never forces it.",
  );
  assertStringIncludes(
    text,
    "Regression matters as much as the new feature, and a full-stack test must be runnable locally, not only in CircleCI.",
  );
});

Deno.test("skills/design-issue/SKILL.md contains Manual Steps & Verification Pairs rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(text, "## Manual Steps & Verification Pairs");
  assertStringIncludes(
    text,
    "Every manual step handed to Josh — whether handed over interactively in chat or filed as a GitHub issue, and whether occurring before or after Gate 1 — **must always have a numbered runbook file** created at:",
  );
  assertStringIncludes(
    text,
    "~/Dropbox/web-jam-llms/<Theme>/<topic>-manual-steps-<YYYY-MM-DD>.md",
  );
  assertStringIncludes(
    text,
    "There are **no carve-outs** for steps handed over in chat rather than filed as issues, and **no carve-outs** for steps that occur before Gate 1.",
  );
  assertStringIncludes(
    text,
    "**Every manual step is a pair:**",
  );
  assertStringIncludes(
    text,
    "Manual steps never live inside an agent's execution issue.",
  );
});

Deno.test("skills/design-issue/SKILL.md contains Separate Verification Surfaces rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(
    text,
    "### Separate Verification Surfaces (No Composite Manual Issues)",
  );
  assertStringIncludes(
    text,
    "Manual artifact / documentation / UI inspection (e.g., verifying generated Markdown/HTML or live web UIs in Google Chrome) and live demonstration / procedure walkthroughs (e.g., executing real-world instructional steps with a learner or external party) are fundamentally distinct verification surfaces with different execution contexts, timelines, and acceptance criteria.",
  );
  assertStringIncludes(
    text,
    "- **NEVER combine artifact/doc/UI inspection and live procedure walkthroughs into a single composite `Josh` issue.**",
  );
  assertStringIncludes(
    text,
    "- They must always be planned and filed as separate, standalone `Josh` manual verification issues, each with its own distinct runbook path and close criteria.",
  );
});

Deno.test("skills/design-issue/SKILL.md contains Runbook Format Requirements rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(text, "### Runbook Format Requirements");
  assertStringIncludes(
    text,
    "Every runbook file must follow this exact format:",
  );
  assertStringIncludes(
    text,
    "- **Professional, role-agnostic title:** Never include personal names",
  );
  assertStringIncludes(
    text,
    '- **Sequential step numbering:** Steps must be explicitly numbered sequentially (`## STEP 1`, `## STEP 2`, ...), or against a known total ("Step 2 of 6").',
  );
  assertStringIncludes(
    text,
    "- **Detailed, literal commands:** Every shell command, script invocation, or path must be written out completely as a literal, copy-pasteable command snippet with real values/flags filled in",
  );
  assertStringIncludes(
    text,
    "- **What each step proves:** Explain explicitly what each step tests or proves.",
  );
  assertStringIncludes(
    text,
    "- **What a correct result looks like:** State clearly the exact expected output, exit status, or visible behavior confirming success.",
  );
  assertStringIncludes(
    text,
    "- **One action per step, one surface per step:** A step is ONE action/click/command per message/step",
  );
  assertStringIncludes(
    text,
    "- **Fully self-contained steps:** Each step must be self-contained — never tell the reader to scroll up or hunt for earlier content.",
  );
  assertStringIncludes(
    text,
    '- **No vague verbs:** Never use vague verbs like "paste the block in" / "set that" / "add it there".',
  );
});

Deno.test("skills/design-issue/SKILL.md contains Writing Style rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(text, "### Writing Style");
  assertStringIncludes(
    text,
    "- **The document states what the thing IS.** Present tense, design first. A reader who has never seen the conversation should be able to read it top to bottom and know what is being built.",
  );
  assertStringIncludes(
    text,
    "- **The decision history goes in an appendix**, as one row per decision with its outcome — never interleaved with the design.",
  );
  assertStringIncludes(
    text,
    "- **The document never records the skill's own process state.**",
  );
  assertStringIncludes(
    text,
    '- **Never a bare label in the body.** No "per D-7" or "R-39"; labels exist so the decision table has stable row names, and nowhere else.',
  );
  assertStringIncludes(
    text,
    "- **Josh's own words are preserved where they are load-bearing** — his ruling is the authority, and a paraphrase is weaker than his actual sentence.",
  );
  assertStringIncludes(
    text,
    "- **A design document proves its own premises, and the gate will not open without them.**",
  );
  assertStringIncludes(
    text,
    "- **Consolidation happens BEFORE Gate 1, never after.**",
  );
});

Deno.test("skills/design-issue/SKILL.md contains Design Tiers and Delegation Rules for Filing", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(text, "## Which Model Runs What & Design Tiers");
  assertStringIncludes(text, "### Design Tiers");
  assertStringIncludes(
    text,
    "- **`Flash High` is the default design tier for a single genuinely simple `Bug` or `Task`.** A one-issue Bug or Task design is a contained judgment about one repo's own behavior.",
  );
  assertStringIncludes(
    text,
    "- **`Opus` keeps everything else:** new `Feature` issues, `Epic` designs, cross-repo work, multi-issue plans with dependency chains, and any `Bug` or `Task` whose scope is arguable.",
  );
  assertStringIncludes(text, "### Delegation Rules for Filing");
  assertStringIncludes(
    text,
    "- Filing delegates to a subagent **only when delegating moves the work down a tier**.",
  );
  assertStringIncludes(
    text,
    "- An **Opus** design session hands filing to a **Flash High** subagent.",
  );
  assertStringIncludes(
    text,
    "- An **agy** session already running on **Flash High** files the issues itself without delegating: spawning a subagent on the tier you are already running costs a cold start and re-derived context to save nothing.",
  );
});

Deno.test("skills/design-issue/SKILL.md contains installer-scope rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(text, "### Installing is for Structure, Never for Content");
  assertStringIncludes(
    text,
    "**Installing is for structure, never for content.**",
  );
  assertStringIncludes(
    text,
    "Skill bodies and hook scripts are symlinked into the canonical clone, and agy invokes those same Claude Code symlinks through `agy-hook-shim.sh` while symlinking the same skill sources into its own plugin directory.",
  );
  assertStringIncludes(
    text,
    "The installers exist for the two things a symlink cannot carry: a link that does not exist yet, and a registration entry.",
  );
});

Deno.test("skills/design-issue/SKILL.md contains load-bearing-premises rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(
    text,
    "**A design document proves its own premises, and the gate will not open without them.**",
  );
  assertStringIncludes(
    text,
    "Every design document carries a `## Load-bearing premises` section: one row per premise the design depends on, naming what was checked and what it showed.",
  );
  assertStringIncludes(
    text,
    "The document checker fails a document that omits the section, and fails any row whose proof is empty or hedged.",
  );
});

Deno.test("skills/design-issue/SKILL.md contains target-issue-body rule", async () => {
  const designIssuePath = `${SKILLS_DIR}design-issue/SKILL.md`;
  const text = await Deno.readTextFile(designIssuePath);

  assertStringIncludes(
    text,
    "**A target issue's body is read before anything else, and what it says is scope.**",
  );
  assertStringIncludes(
    text,
    "When the skill is invoked on a named issue, reading that issue's body in full is its first act — before the epic check, before the label checks, before its children are enumerated.",
  );
  assertStringIncludes(
    text,
    "Any directive there enters the run's scope and appears as a row in the Gate 2 plan table, where removing it costs Josh one word.",
  );
  assertStringIncludes(
    text,
    "The document's verbatim appendix carries the target issue's directive lines, and the checker fails a document that names a target issue while carrying none",
  );
});

Deno.test("skills/work-issue/SKILL.md contains external-only deliverables workflow rules", async () => {
  const workIssuePath = `${SKILLS_DIR}work-issue/SKILL.md`;
  const text = await Deno.readTextFile(workIssuePath);

  assertStringIncludes(
    text,
    "## External / Dropbox-only deliverables (Skip Git branch & PR setup)",
  );
  assertStringIncludes(
    text,
    "When an issue's deliverables are strictly external documents (such as manual verification runbooks in `~/Dropbox/web-jam-llms/Token_Savings/...` or docs outside tracked git repositories) with **no tracked files created or modified inside the repository**:",
  );
  assertStringIncludes(
    text,
    "1. **Do NOT create a git branch or isolated worktree.**",
  );
  assertStringIncludes(
    text,
    "2. **Do NOT bump `deno.json` or `package.json`.**",
  );
  assertStringIncludes(
    text,
    "3. **Do NOT call `create-draft-pr.sh` or open a PR.** Creating a git PR whose only change is an artificial version bump produces a hollow PR and causes merge/rebase confusion.",
  );
  assertStringIncludes(
    text,
    "Output the completed deliverable path, validation logs, and verification evidence directly in the chat session for human review and issue closure.",
  );
  assertStringIncludes(
    text,
    "**Mixed deliverables:** If an issue modifies *both* external files (e.g. Dropbox docs) *and* tracked repository files (e.g. code, tests, configs), it continues to follow the standard git worktree branch, test, and PR creation workflow.",
  );
});

// --- Tier-order pin (web-jam-tools#922) ---
//
// Flash High ranks ABOVE Sonnet as of 2026-09-05. This ordering is load-bearing
// in three separate places — the pr-review pairing matrix, the work-issue model
// chain, and the delegate skill's escalation direction — and a routine doc sweep
// that "tidies" any one of them back to the old Sonnet-over-Flash ordering would
// silently re-route work onto the constrained Anthropic budget with no CI signal.
// Pinned here, in the one existing home for skill-rule pins, rather than in three
// separate files (AGENTS.md: "Duplicate Pin-Test Locations for the Same Rule").

Deno.test("skills/pr-review/SKILL.md pairing matrix ranks Flash High above Sonnet", async () => {
  const text = await Deno.readTextFile("skills/pr-review/SKILL.md");

  assertStringIncludes(
    text,
    "**Tier order (weakest to strongest): Haiku → Flash Med → Sonnet → Flash High → Opus.**",
  );

  // The matrix rows themselves, in order: Sonnet reviews strictly below it,
  // Flash High may review Sonnet, Opus may review both.
  assertStringIncludes(text, "| Sonnet | Flash Medium, Haiku |");
  assertStringIncludes(text, "| Flash High | Sonnet, Flash Medium, Haiku |");
  assertStringIncludes(text, "| Opus | Flash High, Sonnet |");

  const sonnetRow = text.indexOf("| Sonnet | Flash Medium, Haiku |");
  const flashHighRow = text.indexOf("| Flash High | Sonnet, Flash Medium, Haiku |");
  const opusRow = text.indexOf("| Opus | Flash High, Sonnet |");
  assert(
    sonnetRow < flashHighRow && flashHighRow < opusRow,
    "matrix rows must run weakest reviewer to strongest: Sonnet, then Flash High, then Opus",
  );

  // The old ordering must not survive anywhere in the file.
  assertFalse(
    text.includes("| Sonnet | Flash High, Flash Medium, Haiku |"),
    "the superseded row granting Sonnet review of Flash High work must be gone",
  );
});

Deno.test("skills/work-issue/SKILL.md model chain ranks Gemini 3.8 Flash (High) above Sonnet", async () => {
  const text = await Deno.readTextFile("skills/work-issue/SKILL.md");

  assertStringIncludes(text, "2. `Gemini 3.8 Flash (High)`");
  assertStringIncludes(text, "3. `Claude Sonnet 4.6 (Thinking)`");

  const flashRung = text.indexOf("2. `Gemini 3.8 Flash (High)`");
  const sonnetRung = text.indexOf("3. `Claude Sonnet 4.6 (Thinking)`");
  assert(
    flashRung !== -1 && sonnetRung !== -1 && flashRung < sonnetRung,
    "Gemini 3.8 Flash (High) must sit above Claude Sonnet 4.6 (Thinking) on the model chain",
  );

  // Ordinary coding routes to Flash High, not Sonnet.
  assertStringIncludes(text, "* *Ordinary Coding*: → `Gemini 3.8 Flash (High)`.");

  // Version tokens are load-bearing in this picker list and must not be scrubbed.
  assertFalse(
    /`Gemini Flash \((?:High|Medium)\)`/.test(text),
    "work-issue's model chain must carry versioned Gemini display names, never version-scrubbed ones",
  );
});

Deno.test("skills/delegate/SKILL.md no longer escalates Flash High up to Sonnet", async () => {
  const text = await Deno.readTextFile("skills/delegate/SKILL.md");

  assertStringIncludes(
    text,
    "- **Delegating up (`Flash Med` → `Flash High` → `Opus`)**:",
  );
  assertStringIncludes(
    text,
    "Haiku → Flash Med → Sonnet → Flash High → Opus",
  );
  assertFalse(
    text.includes("**Delegating up (`Flash Med` → `Flash High` / `Sonnet` / `Opus`)**"),
    "the superseded escalation ladder placing Sonnet above Flash High must be gone",
  );
});
