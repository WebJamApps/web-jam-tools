import { assert, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/pr-review/SKILL.md", import.meta.url).pathname;

Deno.test("skills/pr-review/SKILL.md defines test-file carve-outs for raw any and leftover debug output", async () => {
  let content: string;
  try {
    content = await Deno.readTextFile(SKILL_MD_PATH);
  } catch (err) {
    throw new Error(`skills/pr-review/SKILL.md is missing or unreadable: ${err}`);
  }

  assert(content.length > 0, "skills/pr-review/SKILL.md is empty");

  // Edit 1: Heading sentence
  assertStringIncludes(
    content,
    "**Raw `any` in a test file is a Suggestion, not a Must Fix** (Josh, 2026-10-02).",
  );

  // Edit 1: Five directory names and two filename patterns
  assertStringIncludes(content, "`*.test.*`");
  assertStringIncludes(content, "`*.spec.*`");
  assertStringIncludes(content, "`test/`");
  assertStringIncludes(content, "`tests/`");
  assertStringIncludes(content, "`__tests__/`");
  assertStringIncludes(content, "`__mocks__/`");
  assertStringIncludes(content, "`e2e/`");
  assertStringIncludes(
    content,
    "A test file is one named `*.test.*` or `*.spec.*`, or one that sits under a `test/`, `tests/`, `__tests__/`, `__mocks__/` or `e2e/` directory.",
  );

  // Edit 1: Fail-closed sentence for path that does not clearly match
  assertStringIncludes(
    content,
    "When a file's path does not clearly match the test-file description, treat it as non-test code: the finding stays a Must Fix.",
  );

  // Edit 2: Heading sentence
  assertStringIncludes(
    content,
    "**Leftover debug output in a test file is a Suggestion, not a Must Fix** (Josh, 2026-10-02).",
  );

  // Edit 2: Definition of debug output with its two examples
  assertStringIncludes(
    content,
    "Debug output is a statement whose only effect is to print something or to write a file that no test reads or asserts on, for example `console.log(...)` or `page.screenshot({ path: ... })`.",
  );

  // Edit 2: Fail-closed sentence
  assertStringIncludes(
    content,
    "When a file's path does not clearly match the test-file description, or it is not clear that the statement only prints or writes an unread file, this carve-out does not apply.",
  );

  // Edit 3: Verdict sentence
  assertStringIncludes(
    content,
    "A raw-`any`-in-a-test-file finding (Step 2 item 9) and a leftover-debug-output-in-a-test-file finding (Step 2 item 4) are always Suggestions, never Must Fix. Neither by itself produces `**🛑 Changes Requested**`, in this post or in Step 4's follow-up, and a post whose only findings are of these kinds carries `**✅ Approved**`.",
  );

  // Edit 4: Guardrails and Scope sentences in Checklist Verification
  assertStringIncludes(content, "The **Guardrails** and **Scope** rows are exceptions too.");
  assertStringIncludes(
    content,
    "Guardrails is prefixed 🟡 when its only finding is raw `any` in a test file (Step 2 item 9); Scope is prefixed 🟡 when its only finding is leftover debug output in a test file (Step 2 item 4).",
  );
  assertStringIncludes(
    content,
    "Each is prefixed 🛑 when it has any other finding of its own, and ✅ otherwise.",
  );

  // Edit 5: Heading
  assertStringIncludes(
    content,
    "**Raw `any` and leftover debug output in a test file belong here**:",
  );

  // Edit 6: Both bullets and four named exceptions
  assertStringIncludes(content, "with four named exceptions");
  assertStringIncludes(
    content,
    "Raw `any` introduced in a test file is a Suggestion, not a Must Fix, per Step 2 item 9 (Josh, 2026-10-02). The review still reports it, and the repos' own `AGENTS.md` rules still tell authors not to write it.",
  );
  assertStringIncludes(
    content,
    "Leftover debug output introduced in a test file is a Suggestion, not a Must Fix, per Step 2 item 4 (Josh, 2026-10-02). The review still reports it.",
  );
});

Deno.test("skills/pr-review/SKILL.md defines a missing version bump as a Suggestion (🟡) and never a Must Fix (🛑)", async () => {
  const content = await Deno.readTextFile(SKILL_MD_PATH);

  assertStringIncludes(
    content,
    "**Suggestion, not Must Fix (`🟡`, never `🛑`)**: any version-bump irregularity within the PR\n     under review — including a **missing version bump** (`package.json` unchanged in\n     the PR diff)",
  );
  assertStringIncludes(
    content,
    "A version-bump finding (Step 2 item 5 — including a missing version bump, a version that\n       fails to strictly exceed `origin/dev`, or a gratuitous double bump) is always a Suggestion,\n       never a Must Fix",
  );
  assertStringIncludes(
    content,
    "Exception: a missing, stale, or double semver version bump (Step 2 item 5) and `Version bump check (PR branches only)` failing (or unresolved) are never listed here — report them under Suggestions instead of under `### 🛑 Must Fix Items`",
  );
  assertStringIncludes(
    content,
    "that row is prefixed 🟡 whenever a version bump is missing, fails to strictly exceed `origin/dev`, or was gratuitously double-bumped, and prefixed ✅ otherwise — it is never prefixed with the Must-Fix stop-sign icon.",
  );
  assertStringIncludes(
    content,
    "Step 2 item 5 evaluates that PR's own commits and reports a missing version bump, a gratuitous double bump, or a version that fails to strictly exceed `origin/dev` as a Suggestion, never a Must Fix",
  );
  assertStringIncludes(
    content,
    "A version-bump irregularity within the PR under review — a missing version bump, a version that\n    fails to strictly exceed `origin/dev`, or a gratuitous double bump — is a Suggestion, not a Must\n    Fix, per Step 2 item 5.",
  );
});

// web-jam-tools#1954: "The version check" — web-jam-tools has no per-PR deno.json bump.
Deno.test("skills/pr-review/SKILL.md applies the version bump to package.json repositories only, and names the CI step without a line number", async () => {
  const content = await Deno.readTextFile(SKILL_MD_PATH);
  assertStringIncludes(
    content,
    '**`web-jam-tools` has no per-PR version bump.** Its `deno.json` `"version"` stays untouched on PR branches and its CI has no version step, so an unchanged `deno.json` version is never a finding there.',
  );
  assertStringIncludes(
    content,
    "Check `package.json` in the active Node repositories (CollegeLutheran, JaMmusic, TimShermanMusic, web-jam-back, WebJamSocketCluster)",
  );
  assert(!/config\.yml:\d/.test(content), "the skill names the CI step, never a line number");
  assert(!content.includes("(or `deno.json` for `web-jam-tools`)"));
});
