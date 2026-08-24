// test/design_issue_lint_runbook.test.ts — web-jam-tools#743
//
// Unit and integration tests for runbook format linter: H1 title without personal names,
// sequentially numbered ## STEP N headings starting at 1, literal commands without placeholders,
// statement of what each step proves, statement of what a correct result looks like, and single action/surface per step.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  lintRunbook,
  lintRunbookFile,
  runLintRunbookCli,
} from "../src/design-issue/lint_runbook.ts";
import { runCli } from "../src/design-issue/cli.ts";

const FIXTURES_DIR = path.resolve(
  new URL("../test/fixtures/design-issue", import.meta.url).pathname,
);

Deno.test("lintRunbook returns valid for compliant runbook", () => {
  const validMarkdown = `# Manual Verification Runbook: Verify Feature Deployment

This runbook verifies feature deployment.

## STEP 1: Verify CLI Command

**Command:**
\`\`\`sh
deno task test
\`\`\`

**What this proves:**
Verifies that all tests execute cleanly.

**Expected result:**
All tests pass with exit code 0.

---

## STEP 2: Verify Lint Task

**Command:**
\`\`\`sh
deno task lint
\`\`\`

**What this proves:**
Verifies that linter reports zero errors.

**Expected result:**
Linter finishes with exit code 0.
`;

  const result = lintRunbook(validMarkdown, "runbook.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintRunbook flags personal names in H1 title", () => {
  const variations = [
    "# Josh Steps: Deno Deploy Verification",
    "# Josh: Manual Verification Runbook",
    "# Verification Runbook for Maria",
    "# Tim Steps: Deployment Guide",
    "# Henrickson Verification Walkthrough",
    "# Josh's Manual Verification Runbook",
  ];

  for (const title of variations) {
    const markdown = `${title}

## STEP 1: Run Command

**Command:**
\`\`\`sh
deno task test
\`\`\`

**What this proves:**
Verifies test execution.

**Expected result:**
Tests pass.
`;

    const result = lintRunbook(markdown, "runbook.md");
    assertEquals(result.valid, false, `Expected failure for title: ${title}`);
    const violation = result.violations.find((v) => v.rule === "no-personal-name-in-title");
    assertEquals(Boolean(violation), true);
  }
});

Deno.test("lintRunbook flags missing H1 title", () => {
  const markdown = `## STEP 1: Run Command

**Command:**
\`\`\`sh
deno task test
\`\`\`

**What this proves:**
Verifies test execution.

**Expected result:**
Tests pass.
`;

  const result = lintRunbook(markdown, "runbook.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "require-h1-title");
  assertEquals(Boolean(violation), true);
});

Deno.test("lintRunbook flags missing step headings", () => {
  const markdown = `# Manual Verification Runbook: No Steps

This runbook has a title and description but no step headings.
`;

  const result = lintRunbook(markdown, "runbook.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "require-step-headings");
  assertEquals(Boolean(violation), true);
});

Deno.test("lintRunbook flags malformed step headings", () => {
  const markdown = `# Manual Verification Runbook: Malformed Headings

### STEP 1: Malformed H3 Step Heading

**Command:**
\`\`\`sh
deno task test
\`\`\`

**What this proves:**
Verifies tests.

**Expected result:**
Tests pass.
`;

  const result = lintRunbook(markdown, "runbook.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "malformed-step-heading");
  assertEquals(Boolean(violation), true);
});

Deno.test("lintRunbook flags non-sequential step numbering", () => {
  // Case A: Starts at STEP 2
  const docStartsAt2 = `# Manual Verification Runbook: Starts at 2

## STEP 2: First step labeled 2

**Command:**
\`\`\`sh
deno task test
\`\`\`

**What this proves:**
Verifies tests.

**Expected result:**
Tests pass.
`;

  const resStartsAt2 = lintRunbook(docStartsAt2, "runbook.md");
  assertEquals(resStartsAt2.valid, false);
  const v1 = resStartsAt2.violations.find((v) => v.rule === "sequential-step-numbering");
  assertEquals(Boolean(v1), true);

  // Case B: Skips step 2 (STEP 1 then STEP 3)
  const docSkips = `# Manual Verification Runbook: Skips step

## STEP 1: First

**Command:**
\`\`\`sh
deno task test
\`\`\`

**What this proves:**
Verifies tests.

**Expected result:**
Tests pass.

## STEP 3: Third

**Command:**
\`\`\`sh
deno task lint
\`\`\`

**What this proves:**
Verifies linter.

**Expected result:**
Linter passes.
`;

  const resSkips = lintRunbook(docSkips, "runbook.md");
  assertEquals(resSkips.valid, false);
  const v2 = resSkips.violations.find((v) => v.rule === "sequential-step-numbering");
  assertEquals(Boolean(v2), true);
});

Deno.test("lintRunbook flags placeholders in command blocks and commands", () => {
  const placeholders = [
    "<google-app-password>",
    "<token>",
    "<placeholder>",
    "<branch-name>",
    "<owner/repo>",
    "YOUR_API_KEY",
    "YOUR_TOKEN",
    "INSERT_API_KEY",
    "[placeholder]",
    "[YOUR_SECRET]",
    "TODO",
    "FIXME",
    "REPLACE_ME",
  ];

  for (const ph of placeholders) {
    const doc = `# Manual Verification Runbook: Placeholder Test

## STEP 1: Run with placeholder

**Command:**
\`\`\`sh
deno run script.ts --key ${ph}
\`\`\`

**What this proves:**
Verifies script.

**Expected result:**
Success.
`;

    const result = lintRunbook(doc, "runbook.md");
    assertEquals(result.valid, false, `Expected failure for placeholder: ${ph}`);
    const violation = result.violations.find((v) => v.rule === "no-command-placeholders");
    assertEquals(Boolean(violation), true);
  }
});

Deno.test("lintRunbook allows valid shell syntax and redirection", () => {
  const doc = `# Manual Verification Runbook: Valid Shell Syntax

## STEP 1: Complex Shell Command

**Command:**
\`\`\`sh
DISPLAY="\${DISPLAY:-:0}" google-chrome "file:///path/to/doc.html" >/dev/null 2>&1 &
cat < /dev/null
\`\`\`

**What this proves:**
Verifies that background redirection syntax is accepted cleanly.

**Expected result:**
Exit code 0.
`;

  const result = lintRunbook(doc, "runbook.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintRunbook flags missing proof statement in a step", () => {
  const doc = `# Manual Verification Runbook: Missing Proof

## STEP 1: Command without proof

**Command:**
\`\`\`sh
deno task test
\`\`\`

**Expected result:**
Tests pass.
`;

  const result = lintRunbook(doc, "runbook.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "require-step-proof");
  assertEquals(Boolean(violation), true);
});

Deno.test("lintRunbook flags missing expected result statement in a step", () => {
  const doc = `# Manual Verification Runbook: Missing Expected Result

## STEP 1: Command without expected result

**Command:**
\`\`\`sh
deno task test
\`\`\`

**What this proves:**
Verifies tests.
`;

  const result = lintRunbook(doc, "runbook.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "require-expected-result");
  assertEquals(Boolean(violation), true);
});

Deno.test("lintRunbook flags multiple distinct command blocks in one step", () => {
  const doc = `# Manual Verification Runbook: Multiple Command Blocks

## STEP 1: Step with two commands

\`\`\`sh
cd /home/joshua/WebJamApps/web-jam-tools
\`\`\`

Now run:

\`\`\`sh
deno task test
\`\`\`

**What this proves:**
Verifies tests.

**Expected result:**
Tests pass.
`;

  const result = lintRunbook(doc, "runbook.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "single-action-per-step");
  assertEquals(Boolean(violation), true);
});

Deno.test("lintRunbook flags multiple numbered sub-actions in one step", () => {
  const doc = `# Manual Verification Runbook: Numbered Sub Actions

## STEP 1: Multiple Sub Actions

1. Open CircleCI dashboard.
2. Verify DENO_DEPLOY_TOKEN environment variable.

**What this proves:**
Verifies token.

**Expected result:**
Token exists.
`;

  const result = lintRunbook(doc, "runbook.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "single-action-per-step");
  assertEquals(Boolean(violation), true);
});

Deno.test("lintRunbook flags multiple surfaces in one step", () => {
  const doc = `# Manual Verification Runbook: Multiple Surfaces

## STEP 1: Multi Surface Step

**Surface:** Terminal / Web Browser

**Command:**
\`\`\`sh
curl https://example.com
\`\`\`

**What this proves:**
Verifies endpoint.

**Expected result:**
HTTP 200.
`;

  const result = lintRunbook(doc, "runbook.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "single-surface-per-step");
  assertEquals(Boolean(violation), true);
});

Deno.test("lintRunbookFile throws when path is missing or empty", async () => {
  await assertRejects(
    async () => {
      await lintRunbookFile("");
    },
    Error,
    "Runbook path is required",
  );

  await assertRejects(
    async () => {
      await lintRunbookFile("   ");
    },
    Error,
    "Runbook path is required",
  );
});

Deno.test("lintRunbookFile throws when file does not exist", async () => {
  await assertRejects(
    async () => {
      await lintRunbookFile("/tmp/non-existent-runbook-12345.md");
    },
    Error,
    "Runbook not found or cannot be read",
  );
});

Deno.test("lintRunbookFile throws when file is empty", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "lint-runbook-empty-" });
  const emptyPath = path.join(tempDir, "empty.md");
  await Deno.writeTextFile(emptyPath, "   \n\n\t  ");

  try {
    await assertRejects(
      async () => {
        await lintRunbookFile(emptyPath);
      },
      Error,
      "is empty",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("lintRunbookFile passes valid fixture valid-runbook.md", async () => {
  const validFixturePath = path.join(FIXTURES_DIR, "valid-runbook.md");
  const result = await lintRunbookFile(validFixturePath);
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintRunbookFile fails invalid fixture invalid-runbook.md with all violations", async () => {
  const invalidFixturePath = path.join(FIXTURES_DIR, "invalid-runbook.md");
  const result = await lintRunbookFile(invalidFixturePath);
  assertEquals(result.valid, false);

  const rulesViolated = result.violations.map((v) => v.rule);
  assertEquals(rulesViolated.includes("no-personal-name-in-title"), true);
  assertEquals(rulesViolated.includes("no-command-placeholders"), true);
  assertEquals(rulesViolated.includes("require-expected-result"), true);
  assertEquals(rulesViolated.includes("sequential-step-numbering"), true);
  assertEquals(rulesViolated.includes("single-surface-per-step"), true);
});

Deno.test("lintRunbookFile correctly flags individual invalid fixtures", async () => {
  const fixtures: Record<string, string> = {
    "invalid-runbook-personal-name.md": "no-personal-name-in-title",
    "invalid-runbook-no-steps.md": "require-step-headings",
    "invalid-runbook-non-sequential.md": "sequential-step-numbering",
    "invalid-runbook-placeholders.md": "no-command-placeholders",
    "invalid-runbook-missing-proof.md": "require-step-proof",
    "invalid-runbook-missing-expected.md": "require-expected-result",
    "invalid-runbook-multiple-actions.md": "single-action-per-step",
    "invalid-runbook-sub-actions.md": "single-action-per-step",
    "invalid-runbook-multiple-surfaces.md": "single-surface-per-step",
  };

  for (const [filename, expectedRule] of Object.entries(fixtures)) {
    const fixturePath = path.join(FIXTURES_DIR, filename);
    const result = await lintRunbookFile(fixturePath);
    assertEquals(result.valid, false, `Expected ${filename} to be invalid`);
    const hasExpectedRule = result.violations.some((v) => v.rule === expectedRule);
    assertEquals(
      hasExpectedRule,
      true,
      `Expected ${filename} to have violation for rule ${expectedRule}`,
    );
  }
});

Deno.test("runLintRunbookCli handles --help cleanly", async () => {
  const exitCode = await runLintRunbookCli(["--help"]);
  assertEquals(exitCode, 0);
});

Deno.test("runLintRunbookCli returns exit code 1 when runbook argument is missing", async () => {
  const exitCode = await runLintRunbookCli([]);
  assertEquals(exitCode, 1);
});

Deno.test("runLintRunbookCli returns exit code 1 when file does not exist", async () => {
  const exitCode = await runLintRunbookCli(["/tmp/non-existent-runbook-999.md"]);
  assertEquals(exitCode, 1);
});

Deno.test("runLintRunbookCli exits 0 for valid fixture", async () => {
  const validFixturePath = path.join(FIXTURES_DIR, "valid-runbook.md");
  const exitCode = await runLintRunbookCli([validFixturePath]);
  assertEquals(exitCode, 0);
});

Deno.test("runLintRunbookCli exits 1 for invalid fixture", async () => {
  const invalidFixturePath = path.join(FIXTURES_DIR, "invalid-runbook.md");
  const exitCode = await runLintRunbookCli([invalidFixturePath]);
  assertEquals(exitCode, 1);
});

Deno.test("runLintRunbookCli supports --json flag", async () => {
  const validFixturePath = path.join(FIXTURES_DIR, "valid-runbook.md");
  const exitCode = await runLintRunbookCli([validFixturePath, "--json"]);
  assertEquals(exitCode, 0);
});

Deno.test("cli.ts routes lint-runbook subcommand correctly", async () => {
  const validFixturePath = path.join(FIXTURES_DIR, "valid-runbook.md");
  const exitCodeValid = await runCli(["lint-runbook", validFixturePath]);
  assertEquals(exitCodeValid, 0);

  const invalidFixturePath = path.join(FIXTURES_DIR, "invalid-runbook.md");
  const exitCodeInvalid = await runCli(["lint-runbook", invalidFixturePath]);
  assertEquals(exitCodeInvalid, 1);
});

Deno.test("deno.json defines design:lint-runbook task", async () => {
  const denoJsonContent = await Deno.readTextFile(
    new URL("../deno.json", import.meta.url).pathname,
  );
  const config = JSON.parse(denoJsonContent);

  assertEquals(typeof config.tasks["design:lint-runbook"], "string");
  assertStringIncludes(config.tasks["design:lint-runbook"], "src/design-issue/cli.ts lint-runbook");
});
