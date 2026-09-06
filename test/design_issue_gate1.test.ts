// test/design_issue_gate1.test.ts — web-jam-tools#741
//
// Unit and integration tests for Gate 1 helper: render, headless screenshot layout verification,
// and Chrome launch wiring.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  defaultOpenBrowserImpl,
  defaultScreenshotImpl,
  DesignDocResolutionRefusal,
  expandHome,
  extractDateFromFilename,
  extractTopicFromText,
  findExistingDesignDoc,
  findExistingDesignDocs,
  formatMajorRevisionPrompt,
  isDesignDocFilename,
  matchesTopic,
  normalizeTopicSlug,
  parseDecisionsRecord,
  refuseRedundantDesignDoc,
  resolveCanonicalDesignDoc,
  resolveDesignDocsRoot,
  resolveHtmlPath,
  runGate1,
} from "../src/design-issue/gate1.ts";
import { runCandidatesCli } from "../src/design-issue/candidates.ts";
import { runCli, runMatchDesignCli } from "../src/design-issue/cli.ts";

// A minimal document that still satisfies design:lint-doc's required sections (web-jam-tools#815)
// — used by tests below that are exercising gate1's render/screenshot/browser mechanics, not the
// linter itself, so the fixture just needs to pass rather than being representative content.
const MINIMAL_LINT_CLEAN_DOC = `# Test

## Section
Content

## Both surfaces
Identical on both surfaces.

## Load-bearing premises
| Premise | Proof |
|---|---|
| This is a test fixture, not a real design | Read this file |
`;

Deno.test("expandHome expands leading tilde to home directory", () => {
  const home = Deno.env.get("HOME") || "/home/joshua";
  assertEquals(expandHome("~/Dropbox/test.md"), `${home}/Dropbox/test.md`);
  assertEquals(expandHome("~"), home);
  assertEquals(expandHome("/var/log/test.md"), "/var/log/test.md");
  assertEquals(expandHome("relative/path.md"), "relative/path.md");
});

Deno.test("resolveHtmlPath replaces .md extension with .html or appends .html", () => {
  const home = Deno.env.get("HOME") || "/home/joshua";
  assertEquals(
    resolveHtmlPath("~/Dropbox/doc.md"),
    path.resolve(`${home}/Dropbox/doc.html`),
  );
  assertEquals(
    resolveHtmlPath("/tmp/sample-design.MD"),
    path.resolve("/tmp/sample-design.html"),
  );
  assertEquals(
    resolveHtmlPath("/tmp/sample-design"),
    path.resolve("/tmp/sample-design.html"),
  );
});

Deno.test("runGate1 throws when docPath is empty or missing", async () => {
  await assertRejects(
    async () => {
      await runGate1({ docPath: "" });
    },
    Error,
    "Design document path is required",
  );

  await assertRejects(
    async () => {
      await runGate1({ docPath: "   " });
    },
    Error,
    "Design document path is required",
  );
});

Deno.test("runGate1 throws when design document does not exist", async () => {
  const nonExistentPath = "/tmp/non-existent-gate1-doc-12345.md";
  await assertRejects(
    async () => {
      await runGate1({ docPath: nonExistentPath });
    },
    Error,
    "Design document not found or cannot be read",
  );
});

Deno.test("runGate1 throws when design document is empty", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-empty-" });
  const emptyDocPath = path.join(tempDir, "empty.md");
  await Deno.writeTextFile(emptyDocPath, "   \n\n  \t  ");

  try {
    await assertRejects(
      async () => {
        await runGate1({ docPath: emptyDocPath });
      },
      Error,
      "is empty",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runGate1 refuses to render or open a document that fails design:lint-doc", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-lint-fail-" });
  const docPath = path.join(tempDir, "doc.md");
  // Missing '## Both surfaces' and '## Load-bearing premises' — fails design:lint-doc.
  await Deno.writeTextFile(docPath, "# Test\n\n## Section\nContent");

  let screenshotCalled = false;
  let browserCalled = false;

  try {
    await assertRejects(
      async () => {
        await runGate1({
          docPath,
          screenshotImpl: () => {
            screenshotCalled = true;
            return Promise.resolve({ sizeBytes: 100 });
          },
          openBrowserImpl: () => {
            browserCalled = true;
            return Promise.resolve();
          },
        });
      },
      Error,
      "failed design:lint-doc",
    );

    // Refusal happens before rendering — neither the screenshot nor the browser step ever runs,
    // and no HTML file is written (web-jam-tools#815 acceptance criterion 5: "cannot be bypassed
    // by invoking design:gate1 directly").
    assertEquals(screenshotCalled, false);
    assertEquals(browserCalled, false);
    const htmlPath = path.join(tempDir, "doc.html");
    const htmlExists = await Deno.stat(htmlPath).then(() => true).catch(() => false);
    assertEquals(htmlExists, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runGate1's refusal names each design:lint-doc violation", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-lint-fail-detail-" });
  const docPath = path.join(tempDir, "doc.md");
  await Deno.writeTextFile(docPath, "# Test\n\nStatus: Draft\n\n## Section\nContent");

  try {
    await assertRejects(
      async () => {
        await runGate1({ docPath });
      },
      Error,
      "no-status-line",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("cli.ts's design:gate1 subcommand also refuses a document that fails design:lint-doc", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-cli-lint-fail-" });
  const docPath = path.join(tempDir, "doc.md");
  await Deno.writeTextFile(docPath, "# Test\n\n## Section\nContent");

  try {
    const exitCode = await runCli([docPath, "--no-open"]);
    assertEquals(exitCode, 1);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runGate1 renders HTML, verifies screenshot with stub, and opens browser", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-full-" });
  const docPath = path.join(tempDir, "sample-design-2026-08-23.md");
  const expectedHtmlPath = path.join(tempDir, "sample-design-2026-08-23.html");
  const customScreenshotPath = path.join(tempDir, "custom-screenshot.png");

  const markdownContent = `# Sample Feature Design

## Overview
This is a sample design document for testing Gate 1 automation.

| Component | Status |
| --- | --- |
| Gate 1 | In Progress |

## Both surfaces
Works on Claude Code and Antigravity.

## Load-bearing premises
| Premise | Proof |
|---|---|
| Gate 1 automation renders markdown to HTML | Read render_design_doc.ts's output format |
`;

  await Deno.writeTextFile(docPath, markdownContent);

  let screenshotInvokedWithHtml = "";
  let screenshotInvokedWithDest = "";
  let browserOpenedWithHtml = "";
  let browserOpenedWithDisplay = "";

  try {
    const result = await runGate1({
      docPath,
      screenshotPath: customScreenshotPath,
      screenshotImpl: (htmlPath, screenshotPath) => {
        screenshotInvokedWithHtml = htmlPath;
        screenshotInvokedWithDest = screenshotPath;
        return Promise.resolve({ sizeBytes: 12345 });
      },
      openBrowserImpl: (htmlPath, display) => {
        browserOpenedWithHtml = htmlPath;
        browserOpenedWithDisplay = display || "";
        return Promise.resolve();
      },
      display: ":1",
    });

    assertEquals(result.docPath, path.resolve(docPath));
    assertEquals(result.htmlPath, expectedHtmlPath);
    assertEquals(result.screenshotPath, customScreenshotPath);
    assertEquals(result.screenshotSizeBytes, 12345);
    assertEquals(result.opened, true);

    // Verify HTML was written to disk
    const writtenHtml = await Deno.readTextFile(expectedHtmlPath);
    assertStringIncludes(writtenHtml, "<title>Sample Feature Design</title>");
    assertStringIncludes(writtenHtml, '<h2 id="overview">Overview</h2>');
    assertStringIncludes(writtenHtml, '<h2 id="both-surfaces">Both surfaces</h2>');

    // Verify screenshot runner inputs
    assertEquals(screenshotInvokedWithHtml, expectedHtmlPath);
    assertEquals(screenshotInvokedWithDest, customScreenshotPath);

    // Verify browser runner inputs
    assertEquals(browserOpenedWithHtml, expectedHtmlPath);
    assertEquals(browserOpenedWithDisplay, ":1");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runGate1 skips browser launch when noOpen is true", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-noopen-" });
  const docPath = path.join(tempDir, "doc.md");
  await Deno.writeTextFile(docPath, MINIMAL_LINT_CLEAN_DOC);

  let browserOpened = false;

  try {
    const result = await runGate1({
      docPath,
      noOpen: true,
      screenshotImpl: () => Promise.resolve({ sizeBytes: 100 }),
      openBrowserImpl: () => {
        browserOpened = true;
        return Promise.resolve();
      },
    });

    assertEquals(result.opened, false);
    assertEquals(browserOpened, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runGate1 fails loudly when screenshot verification fails", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-fail-shot-" });
  const docPath = path.join(tempDir, "doc.md");
  await Deno.writeTextFile(docPath, MINIMAL_LINT_CLEAN_DOC);

  try {
    await assertRejects(
      async () => {
        await runGate1({
          docPath,
          screenshotImpl: () => Promise.reject(new Error("Headless screenshot crashed")),
        });
      },
      Error,
      "Headless screenshot crashed",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runGate1 fails loudly when browser launch fails", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-fail-browser-" });
  const docPath = path.join(tempDir, "doc.md");
  await Deno.writeTextFile(docPath, MINIMAL_LINT_CLEAN_DOC);

  try {
    await assertRejects(
      async () => {
        await runGate1({
          docPath,
          screenshotImpl: () => Promise.resolve({ sizeBytes: 200 }),
          openBrowserImpl: () => Promise.reject(new Error("Chrome failed to launch")),
        });
      },
      Error,
      "Chrome failed to launch",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("defaultOpenBrowserImpl formats and executes background command with environment propagation", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-open-browser-" });
  const htmlPath = path.join(tempDir, "test.html");
  await Deno.writeTextFile(htmlPath, "<h1>Test</h1>");

  try {
    let capturedCmd = "";
    let capturedEnv: Record<string, string> = {};
    await defaultOpenBrowserImpl(htmlPath, ":99", (cmd, env) => {
      capturedCmd = cmd;
      capturedEnv = env;
      return Promise.resolve({ success: true, code: 0 });
    });
    assertStringIncludes(capturedCmd, 'DISPLAY=":99" google-chrome "file://');
    assertStringIncludes(capturedCmd, "test.html");
    assertEquals(capturedEnv["DISPLAY"], ":99");
    if (Deno.env.get("PATH")) {
      assertEquals(capturedEnv["PATH"], Deno.env.get("PATH"));
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("defaultScreenshotImpl invokes browser with isolated temporary --user-data-dir and cleans it up", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-profile-" });
  const htmlPath = path.join(tempDir, "test.html");
  const screenshotPath = path.join(tempDir, "screenshot.png");
  await Deno.writeTextFile(htmlPath, "<h1>Test</h1>");

  let capturedBin = "";
  let capturedArgs: string[] = [];
  let capturedUserDataDir = "";

  try {
    const result = await defaultScreenshotImpl(
      htmlPath,
      screenshotPath,
      async (bin, args) => {
        capturedBin = bin;
        capturedArgs = args;
        const dirArg = args.find((a) => a.startsWith("--user-data-dir="));
        if (dirArg) {
          capturedUserDataDir = dirArg.slice("--user-data-dir=".length);
        }
        // Verify the temporary directory exists while browser command executes
        const dirStat = await Deno.stat(capturedUserDataDir);
        assertEquals(dirStat.isDirectory, true);

        // Write a fake screenshot file so stat check succeeds
        await Deno.writeTextFile(screenshotPath, "fake-screenshot-data");
        return { success: true };
      },
    );

    assertEquals(capturedBin, "google-chrome");
    assertStringIncludes(capturedUserDataDir, "gate1-chrome-profile-");
    assertEquals(capturedArgs.includes("--headless=new"), true);
    assertEquals(capturedArgs.includes(`--user-data-dir=${capturedUserDataDir}`), true);
    assertEquals(capturedArgs.includes(`--screenshot=${screenshotPath}`), true);
    assertEquals(result.sizeBytes > 0, true);

    // Verify temp directory was cleaned up in finally block
    await assertRejects(
      async () => {
        await Deno.stat(capturedUserDataDir);
      },
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("defaultScreenshotImpl cleans up temporary --user-data-dir when command execution fails", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-fail-profile-" });
  const htmlPath = path.join(tempDir, "test.html");
  const screenshotPath = path.join(tempDir, "screenshot.png");
  await Deno.writeTextFile(htmlPath, "<h1>Test</h1>");

  let capturedUserDataDir = "";

  try {
    await assertRejects(
      async () => {
        await defaultScreenshotImpl(
          htmlPath,
          screenshotPath,
          (_bin, args) => {
            const dirArg = args.find((a) => a.startsWith("--user-data-dir="));
            if (dirArg) {
              capturedUserDataDir = dirArg.slice("--user-data-dir=".length);
            }
            return Promise.reject(new Error("Command failed"));
          },
        );
      },
      Error,
    );

    assertEquals(capturedUserDataDir.includes("gate1-chrome-profile-"), true);
    // Verify temp directory was cleaned up even when screenshot fails
    await assertRejects(
      async () => {
        await Deno.stat(capturedUserDataDir);
      },
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("cli.ts handles --help flag cleanly", async () => {
  const exitCode = await runCli(["--help"]);
  assertEquals(exitCode, 0);
});

Deno.test("cli.ts returns error code 1 when doc argument is missing", async () => {
  const exitCode = await runCli([]);
  assertEquals(exitCode, 1);
});

Deno.test("cli.ts returns error code 1 when doc file does not exist", async () => {
  const exitCode = await runCli(["/tmp/non-existent-gate1-doc-999.md", "--no-open"]);
  assertEquals(exitCode, 1);
});

Deno.test("cli.ts runs Gate 1 on valid file with --no-open", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-test-cli-" });
  const docPath = path.join(tempDir, "feature-design.md");
  await Deno.writeTextFile(docPath, MINIMAL_LINT_CLEAN_DOC);

  try {
    const exitCode = await runCli([docPath, "--no-open"], {
      screenshotImpl: () => Promise.resolve({ sizeBytes: 15505 }),
    });
    assertEquals(exitCode, 0);

    const htmlPath = path.join(tempDir, "feature-design.html");
    const htmlExists = await Deno.stat(htmlPath).then(() => true).catch(() => false);
    assertEquals(htmlExists, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("defaultScreenshotImpl takes a real screenshot when google-chrome is available", async () => {
  // Check if google-chrome is on PATH
  let hasChrome = false;
  try {
    const cmd = new Deno.Command("google-chrome", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    const output = await cmd.output();
    hasChrome = output.success;
  } catch {
    hasChrome = false;
  }

  if (!hasChrome) {
    console.log("Skipping live google-chrome screenshot test: google-chrome not found on PATH");
    return;
  }

  const tempDir = await Deno.makeTempDir({ prefix: "gate1-live-chrome-" });
  const htmlPath = path.join(tempDir, "test.html");
  const screenshotPath = path.join(tempDir, "screenshot.png");

  await Deno.writeTextFile(
    htmlPath,
    "<!DOCTYPE html><html><body><h1>Live Screenshot Test</h1></body></html>",
  );

  try {
    const { sizeBytes } = await defaultScreenshotImpl(htmlPath, screenshotPath);
    assertEquals(sizeBytes > 0, true, "Screenshot size must be > 0 bytes");

    const fileStat = await Deno.stat(screenshotPath);
    assertEquals(fileStat.size, sizeBytes);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("deno.json defines design:gate1, design:match-design, render_design_doc, and write_issue_approval_token tasks", async () => {
  const denoJsonContent = await Deno.readTextFile(
    new URL("../deno.json", import.meta.url).pathname,
  );
  const config = JSON.parse(denoJsonContent);

  assertEquals(typeof config.tasks["design:gate1"], "string");
  assertEquals(typeof config.tasks["design:match-design"], "string");
  assertEquals(typeof config.tasks["render_design_doc"], "string");
  assertEquals(typeof config.tasks["write_issue_approval_token"], "string");

  assertStringIncludes(config.tasks["design:gate1"], "src/design-issue/cli.ts");
  assertStringIncludes(config.tasks["design:match-design"], "src/design-issue/cli.ts match-design");
  assertStringIncludes(config.tasks["render_design_doc"], "scripts/render_design_doc.ts");
  assertStringIncludes(
    config.tasks["write_issue_approval_token"],
    "scripts/write_issue_approval_token.ts",
  );
});

// Tests for automatic feature matching and Major Revision resolution (web-jam-tools#886)

Deno.test("normalizeTopicSlug produces clean lowercase kebab-case slug", () => {
  assertEquals(normalizeTopicSlug("Design-Issue"), "design-issue");
  assertEquals(normalizeTopicSlug("book_gig"), "book-gig");
  assertEquals(normalizeTopicSlug("  skills/design-issue  "), "skills-design-issue");
  assertEquals(normalizeTopicSlug("---multiple---hyphens---"), "multiple-hyphens");
});

Deno.test("extractTopicFromText extracts canonical topic slug from diverse titles and formats", () => {
  assertEquals(
    extractTopicFromText(
      "skills/design-issue: automatically match existing feature design documents on Epics for Major Revisions",
    ),
    "design-issue",
  );
  assertEquals(
    extractTopicFromText("skills/book-gig: automated venue followups"),
    "book-gig",
  );
  assertEquals(
    extractTopicFromText("[Epic] design-issue skill enhancements and fixes"),
    "design-issue",
  );
  assertEquals(
    extractTopicFromText('web-jam-tools#737 ("design-issue skill enhancements and fixes")'),
    "design-issue",
  );
  assertEquals(
    extractTopicFromText("src/design-issue/gate1.ts: candidate resolution"),
    "design-issue",
  );
  assertEquals(
    extractTopicFromText("CollegeLutheran bulletin archive browser"),
    "collegelutheran",
  );
  assertEquals(extractTopicFromText("design-issue"), "design-issue");
  assertEquals(extractTopicFromText(""), "");
});

Deno.test("isDesignDocFilename correctly identifies design documents and filters non-design artifacts", () => {
  // Valid design documents
  assertEquals(
    isDesignDocFilename("design-issue-enhancements-design-2026-08-23.md"),
    true,
  );
  assertEquals(isDesignDocFilename("book-gig-skill-design-2026-08-16.md"), true);
  assertEquals(isDesignDocFilename("simple-feature-design.md"), true);

  // Non-design artifacts (must be filtered out)
  assertEquals(
    isDesignDocFilename("design-issue-manual-steps-2026-08-23.md"),
    false,
  );
  assertEquals(
    isDesignDocFilename("pr-review-josh-steps-2026-08-22.md"),
    false,
  );
  assertEquals(
    isDesignDocFilename("book-gig-run-2026-10-16-to-2026-10-18.md"),
    false,
  );
  assertEquals(
    isDesignDocFilename("design-issue-enhancements-design-2026-08-23.md.bak-20260827"),
    false,
  );
  assertEquals(
    isDesignDocFilename("design-issue-enhancements-design-2026-08-23.html"),
    false,
  );
  assertEquals(isDesignDocFilename("venue-zipcodes.json"), false);
});

Deno.test("extractDateFromFilename extracts ISO date from filename when present", () => {
  assertEquals(
    extractDateFromFilename("design-issue-enhancements-design-2026-08-23.md"),
    "2026-08-23",
  );
  assertEquals(
    extractDateFromFilename("book-gig-skill-design-2026-08-16.md"),
    "2026-08-16",
  );
  assertEquals(extractDateFromFilename("undated-feature-design.md"), undefined);
});

Deno.test("matchesTopic accurately matches document filenames to topic slugs", () => {
  assertEquals(
    matchesTopic("design-issue-enhancements-design-2026-08-23.md", "design-issue"),
    true,
  );
  assertEquals(
    matchesTopic("book-gig-skill-design-2026-08-16.md", "book-gig"),
    true,
  );
  assertEquals(
    matchesTopic("issue-design-skill-design-2026-08-08.md", "design-issue"),
    true,
  );
  assertEquals(
    matchesTopic("pr-review-self-posting-design-2026-08-22.md", "pr-review"),
    true,
  );

  // Non-matching topics
  assertEquals(
    matchesTopic("agents-md-duplication-design-2026-08-12.md", "design-issue"),
    false,
  );
  assertEquals(
    matchesTopic("book-gig-skill-design-2026-08-16.md", "pr-review"),
    false,
  );
  assertEquals(
    matchesTopic("design-issue-manual-steps-2026-08-23.md", "design-issue"),
    false,
  );
});

Deno.test("findExistingDesignDocs and findExistingDesignDoc discover canonical files and order newest-first", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "design-doc-disc-" });
  const themeDir1 = path.join(tempDir, "Token_Savings");
  const themeDir2 = path.join(tempDir, "gig-outreach");
  await Deno.mkdir(themeDir1, { recursive: true });
  await Deno.mkdir(themeDir2, { recursive: true });

  // Older and newer design docs for design-issue
  const docOlder = path.join(themeDir1, "issue-design-skill-design-2026-08-08.md");
  const docNewer = path.join(themeDir1, "design-issue-enhancements-design-2026-08-23.md");
  const docRunbook = path.join(themeDir1, "design-issue-manual-steps-2026-08-23.md");
  const docBak = path.join(themeDir1, "design-issue-enhancements-design-2026-08-23.md.bak-1");

  // Gig outreach doc
  const docGig = path.join(themeDir2, "book-gig-skill-design-2026-08-16.md");

  await Deno.writeTextFile(docOlder, "# Older Design");
  await Deno.writeTextFile(docNewer, "# Newer Design");
  await Deno.writeTextFile(docRunbook, "# Runbook");
  await Deno.writeTextFile(docBak, "# Backup");
  await Deno.writeTextFile(docGig, "# Book Gig");

  try {
    // Discovery across all themes
    const matches = await findExistingDesignDocs({
      topic: "design-issue",
      dropboxDir: tempDir,
    });
    assertEquals(matches.length, 2);
    // Newest first
    assertEquals(matches[0].filename, "design-issue-enhancements-design-2026-08-23.md");
    assertEquals(matches[0].date, "2026-08-23");
    assertEquals(matches[1].filename, "issue-design-skill-design-2026-08-08.md");
    assertEquals(matches[1].date, "2026-08-08");

    // findExistingDesignDoc returns newest canonical document
    const canonical = await findExistingDesignDoc({
      title: "skills/design-issue: automatically match existing feature design documents",
      dropboxDir: tempDir,
    });
    assertEquals(canonical !== null, true);
    assertEquals(canonical?.filename, "design-issue-enhancements-design-2026-08-23.md");
    assertEquals(canonical?.theme, "Token_Savings");
    assertStringIncludes(canonical?.suggestion || "", "Proposing a Major Revision");

    // Scoped theme search
    const gigDoc = await findExistingDesignDoc({
      topic: "book-gig",
      theme: "gig-outreach",
      dropboxDir: tempDir,
    });
    assertEquals(gigDoc !== null, true);
    assertEquals(gigDoc?.filename, "book-gig-skill-design-2026-08-16.md");

    // Unmatched topic returns null
    const notFound = await findExistingDesignDoc({
      topic: "unknown-feature",
      dropboxDir: tempDir,
    });
    assertEquals(notFound, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("formatMajorRevisionPrompt articulates the Major Revision protocol", () => {
  const prompt = formatMajorRevisionPrompt(
    "/home/joshua/Dropbox/web-jam-llms/Token_Savings/design-issue-enhancements-design-2026-08-23.md",
    "design-issue",
  );
  assertStringIncludes(prompt, 'Found existing canonical design document for "design-issue"');
  assertStringIncludes(prompt, "Proposing a Major Revision");
  assertStringIncludes(prompt, "Record a new entry in ## Revision History");
  assertStringIncludes(
    prompt,
    "Update architecture, ERD, decisions, and both-surfaces sections in-place",
  );
  assertStringIncludes(prompt, "Preserve the document as the single source of truth");
  assertStringIncludes(prompt, "Strictly refuse creating redundant parallel design documents");
});

Deno.test("refuseRedundantDesignDoc throws on pre-existing document and passes when none exists", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "refuse-redun-" });
  const themeDir = path.join(tempDir, "Token_Savings");
  await Deno.mkdir(themeDir, { recursive: true });
  const docPath = path.join(themeDir, "design-issue-enhancements-design-2026-08-23.md");
  await Deno.writeTextFile(docPath, "# Existing Design");

  try {
    // Should throw Error refusing parallel document creation when document exists
    await assertRejects(
      async () => {
        await refuseRedundantDesignDoc({
          topic: "design-issue",
          dropboxDir: tempDir,
        });
      },
      Error,
      'Refusing to create redundant parallel design document for "design-issue"',
    );

    // Should return null and not throw when no document exists
    const result = await refuseRedundantDesignDoc({
      topic: "non-existent-topic",
      dropboxDir: tempDir,
    });
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runMatchDesignCli CLI prints match and returns 0 or 1 appropriately", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "cli-match-" });
  const themeDir = path.join(tempDir, "Token_Savings");
  await Deno.mkdir(themeDir, { recursive: true });
  const docPath = path.join(themeDir, "design-issue-enhancements-design-2026-08-23.md");
  await Deno.writeTextFile(docPath, "# Existing Design");

  try {
    // Matching query returns 0
    const exitCode0 = await runMatchDesignCli(
      ["design-issue", "--dropbox-dir", tempDir],
    );
    assertEquals(exitCode0, 0);

    // Unmatched query returns 1
    const exitCode1 = await runMatchDesignCli(
      ["unknown-feature", "--dropbox-dir", tempDir],
    );
    assertEquals(exitCode1, 1);

    // Missing query returns 1
    const exitCodeMissing = await runMatchDesignCli([]);
    assertEquals(exitCodeMissing, 1);

    // Help returns 0
    const exitCodeHelp = await runMatchDesignCli(["--help"]);
    assertEquals(exitCodeHelp, 0);

    // Routed through runCli
    const exitCodeRouted = await runCli([
      "match-design",
      "design-issue",
      "--dropbox-dir",
      tempDir,
    ]);
    assertEquals(exitCodeRouted, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runCandidatesCli resolves Epic argument to existing canonical design doc and prompts Major Revision", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "candidates-epic-" });
  const themeDir = path.join(tempDir, "Token_Savings");
  await Deno.mkdir(themeDir, { recursive: true });
  const docPath = path.join(themeDir, "design-issue-enhancements-design-2026-08-23.md");
  await Deno.writeTextFile(docPath, "# Existing Design");

  const logs: string[] = [];

  try {
    const exitCode = await runCandidatesCli(
      [
        "--epic",
        "skills/design-issue: automatically match existing feature design documents on Epics for Major Revisions",
        "--dropbox-dir",
        tempDir,
      ],
      {
        log: (msg) => logs.push(msg),
      },
    );

    assertEquals(exitCode, 0);
    const joined = logs.join("\n");
    assertStringIncludes(joined, 'Resolved existing canonical design document for "design-issue"');
    assertStringIncludes(joined, docPath);
    assertStringIncludes(joined, "Suggested action: Major Revision to existing design document");
    assertStringIncludes(joined, "Record a new entry in ## Revision History");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runGate1 refuses to process redundant parallel design document when pre-existing canonical doc exists", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-redundant-refusal-" });
  const themeDir = path.join(tempDir, "Gig_Outreach");
  await Deno.mkdir(themeDir, { recursive: true });

  // Pre-existing canonical doc
  const canonicalDocPath = path.join(themeDir, "book-gig-skill-design-2026-08-16.md");
  await Deno.writeTextFile(canonicalDocPath, MINIMAL_LINT_CLEAN_DOC);

  // Redundant parallel doc
  const redundantDocPath = path.join(themeDir, "book-gig-skill-phase-2-design-2026-09-03.md");
  await Deno.writeTextFile(redundantDocPath, MINIMAL_LINT_CLEAN_DOC);

  try {
    await assertRejects(
      async () => {
        await runGate1({
          docPath: redundantDocPath,
          dropboxDir: tempDir,
          noOpen: true,
          screenshotImpl: () => Promise.resolve({ sizeBytes: 100 }),
        });
      },
      Error,
      'Refusing to process redundant parallel design document for "book-gig"',
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runGate1 succeeds when performing Major Revision in-place on existing canonical doc", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-inplace-revision-" });
  const themeDir = path.join(tempDir, "Gig_Outreach");
  await Deno.mkdir(themeDir, { recursive: true });

  const canonicalDocPath = path.join(themeDir, "book-gig-skill-design-2026-08-16.md");
  await Deno.writeTextFile(canonicalDocPath, MINIMAL_LINT_CLEAN_DOC);

  try {
    const result = await runGate1({
      docPath: canonicalDocPath,
      dropboxDir: tempDir,
      noOpen: true,
      screenshotImpl: () => Promise.resolve({ sizeBytes: 120 }),
    });

    assertEquals(result.docPath, path.resolve(canonicalDocPath));
    assertEquals(result.opened, false);
    assertEquals(result.screenshotSizeBytes, 120);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runCandidatesCli: explicitly parses boolean --find-existing flag without errors", async () => {
  const logs: string[] = [];
  const exitCode = await runCandidatesCli(
    ["--find-existing"],
    {
      runner: () => Promise.resolve({ code: 0, stdout: "[]", stderr: "" }),
      log: (msg) => logs.push(msg),
    },
  );

  assertEquals(exitCode, 0);
  assertStringIncludes(logs.join("\n"), "No open 'Needs Design' candidate issues found");
});

// --- web-jam-tools#942: the canonical-document precondition and its three guard outcomes ---
//
// The pre-existing refusal above guards *writing a duplicate file*, at the end of Phase 1. A design
// run that creates no document never trips it, so these cover the precondition that fires up front
// instead — including the outcome that must never silently look like "no document found".

const DOC_WITH_DECISIONS_RECORD = `# Book Gig Skill Design

## Appendix — Decisions Record

| ID | Topic | Options Considered | Decision / Outcome |
|---|---|---|---|
| D-1 | Invocation | 1. Flexible CLI (Rec)<br>2. Strict flags | **Option 1 approved by Josh on 2026-08-16**: accepts natural or ISO weekend dates. |
| D-4 | Pitch Delivery | 1. Gmail drafts (Rec)<br>2. Direct send | **Option 1 approved on 2026-08-16**: generates Gmail drafts for review; Josh sends. |
`;

Deno.test("web-jam-tools#942 outcome 1: a topic with an existing canonical document resolves it and reports its decisions record", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "precondition-outcome-1-" });
  const themeDir = path.join(tempDir, "gig-outreach");
  await Deno.mkdir(themeDir, { recursive: true });
  const docPath = path.join(themeDir, "book-gig-skill-design-2026-08-16.md");
  await Deno.writeTextFile(docPath, DOC_WITH_DECISIONS_RECORD);

  try {
    const resolution = await resolveCanonicalDesignDoc({
      topic: "book-gig",
      dropboxDir: tempDir,
    });

    assertEquals(resolution.outcome, "existing-document");
    assertEquals(resolution.match?.path, docPath);
    assertEquals(resolution.decisions.length, 2);
    assertEquals(resolution.decisions[0].id, "D-1");
    assertStringIncludes(
      resolution.decisions[0].outcome,
      "Option 1 approved by Josh on 2026-08-16",
    );
    assertEquals(resolution.decisions[1].id, "D-4");
    assertStringIncludes(resolution.decisions[1].outcome, "generates Gmail drafts for review");

    // The CLI surfaces the decisions record alongside the path, and exits 0.
    const logs: string[] = [];
    const exitCode = await runMatchDesignCli(
      ["book-gig", "--dropbox-dir", tempDir],
      { log: (msg) => logs.push(msg) },
    );
    assertEquals(exitCode, 0);
    const joined = logs.join("\n");
    assertStringIncludes(joined, 'Resolved existing canonical design document for "book-gig"');
    assertStringIncludes(joined, docPath);
    assertStringIncludes(joined, "Decisions record — 2 entries already settled");
    assertStringIncludes(joined, "D-1:");
    assertStringIncludes(joined, "D-4:");
    assertStringIncludes(joined, "Suggested action: Major Revision to existing design document");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("web-jam-tools#942 outcome 2: a topic with no existing document proceeds unchanged", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "precondition-outcome-2-" });
  const themeDir = path.join(tempDir, "gig-outreach");
  await Deno.mkdir(themeDir, { recursive: true });
  await Deno.writeTextFile(
    path.join(themeDir, "book-gig-skill-design-2026-08-16.md"),
    DOC_WITH_DECISIONS_RECORD,
  );

  try {
    const resolution = await resolveCanonicalDesignDoc({
      topic: "brand-new-feature",
      dropboxDir: tempDir,
    });

    assertEquals(resolution.outcome, "no-document");
    assertEquals(resolution.match, null);
    assertEquals(resolution.decisions.length, 0);

    const logs: string[] = [];
    const exitCode = await runMatchDesignCli(
      ["brand-new-feature", "--dropbox-dir", tempDir],
      { log: (msg) => logs.push(msg) },
    );
    assertEquals(exitCode, 1);
    assertStringIncludes(
      logs.join("\n"),
      'No existing design document found for "brand-new-feature"',
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("web-jam-tools#942 outcome 3: an unreadable or missing theme folder REFUSES, naming the path, and never reports 'no document found'", async () => {
  const missingRoot = path.join(
    await Deno.makeTempDir({ prefix: "precondition-outcome-3-" }),
    "nonexistent-theme-root",
  );

  // The resolver refuses rather than returning an empty result.
  const refusal = await assertRejects(
    () => resolveCanonicalDesignDoc({ topic: "book-gig", dropboxDir: missingRoot }),
    DesignDocResolutionRefusal,
  );
  assertStringIncludes(refusal.message, missingRoot);
  assertEquals(refusal.resolutionPath, missingRoot);

  // The CLI exits non-zero, names the path, and — the distinction this issue exists for — does
  // NOT print the "no existing design document" wording that outcome 2 prints.
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCode = await runMatchDesignCli(
    ["book-gig", "--dropbox-dir", missingRoot],
    { log: (msg) => logs.push(msg), errorLog: (msg) => errors.push(msg) },
  );
  assertEquals(exitCode, 2);
  const allOutput = [...logs, ...errors].join("\n");
  assertStringIncludes(allOutput, missingRoot);
  assertStringIncludes(allOutput, "Refusing to proceed with the design run");
  assertEquals(
    allOutput.includes("No existing design document found"),
    false,
    "an indeterminate check must never report a genuine no-document result",
  );

  // A theme folder that exists but cannot be listed refuses the same way, naming that folder.
  const unreadableRoot = await Deno.makeTempDir({ prefix: "precondition-unreadable-" });
  const unreadableTheme = path.join(unreadableRoot, "gig-outreach");
  await Deno.mkdir(unreadableTheme, { recursive: true });
  await Deno.chmod(unreadableTheme, 0o000);

  try {
    const themeRefusal = await assertRejects(
      () => resolveCanonicalDesignDoc({ topic: "book-gig", dropboxDir: unreadableRoot }),
      DesignDocResolutionRefusal,
    );
    assertStringIncludes(themeRefusal.message, unreadableTheme);

    const themeErrors: string[] = [];
    const themeExit = await runMatchDesignCli(
      ["book-gig", "--dropbox-dir", unreadableRoot],
      { log: () => {}, errorLog: (msg) => themeErrors.push(msg) },
    );
    assertEquals(themeExit, 2);
    assertStringIncludes(themeErrors.join("\n"), unreadableTheme);
  } finally {
    await Deno.chmod(unreadableTheme, 0o700);
    await Deno.remove(unreadableRoot, { recursive: true });
  }

  // A topic that cannot be resolved is equally indeterminate, and equally refuses.
  const emptyTopicRoot = await Deno.makeTempDir({ prefix: "precondition-empty-topic-" });
  try {
    await assertRejects(
      () => resolveCanonicalDesignDoc({ title: "", dropboxDir: emptyTopicRoot }),
      DesignDocResolutionRefusal,
      "no topic slug could be resolved",
    );
  } finally {
    await Deno.remove(emptyTopicRoot, { recursive: true });
  }
});

Deno.test("web-jam-tools#942: a resolved canonical document that cannot be read refuses rather than resolving", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "precondition-unreadable-doc-" });
  const themeDir = path.join(tempDir, "gig-outreach");
  await Deno.mkdir(themeDir, { recursive: true });
  const docPath = path.join(themeDir, "book-gig-skill-design-2026-08-16.md");
  await Deno.writeTextFile(docPath, DOC_WITH_DECISIONS_RECORD);

  try {
    const refusal = await assertRejects(
      () =>
        resolveCanonicalDesignDoc({
          topic: "book-gig",
          dropboxDir: tempDir,
          readTextFileImpl: () => Promise.reject(new Error("EACCES: permission denied")),
        }),
      DesignDocResolutionRefusal,
    );
    assertStringIncludes(refusal.message, docPath);
    assertStringIncludes(refusal.message, "found but could not be read");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("web-jam-tools#942: resolveDesignDocsRoot honours DESIGN_DOCS_ROOT above DROPBOX_BASE_DIR, and an explicit path above both", () => {
  const priorDesignRoot = Deno.env.get("DESIGN_DOCS_ROOT");
  const priorDropboxBase = Deno.env.get("DROPBOX_BASE_DIR");

  try {
    Deno.env.delete("DESIGN_DOCS_ROOT");
    Deno.env.delete("DROPBOX_BASE_DIR");
    assertEquals(
      resolveDesignDocsRoot(),
      path.resolve(expandHome("~/Dropbox/web-jam-llms")),
    );

    Deno.env.set("DROPBOX_BASE_DIR", "/tmp/dropbox-base");
    assertEquals(resolveDesignDocsRoot(), "/tmp/dropbox-base");

    Deno.env.set("DESIGN_DOCS_ROOT", "/nonexistent-theme-root");
    assertEquals(resolveDesignDocsRoot(), "/nonexistent-theme-root");
    assertEquals(resolveDesignDocsRoot("/tmp/explicit-root"), "/tmp/explicit-root");
  } finally {
    if (priorDesignRoot === undefined) Deno.env.delete("DESIGN_DOCS_ROOT");
    else Deno.env.set("DESIGN_DOCS_ROOT", priorDesignRoot);
    if (priorDropboxBase === undefined) Deno.env.delete("DROPBOX_BASE_DIR");
    else Deno.env.set("DROPBOX_BASE_DIR", priorDropboxBase);
  }
});

Deno.test("web-jam-tools#942: DESIGN_DOCS_ROOT pointed at a nonexistent theme root makes design:match-design refuse", async () => {
  const priorDesignRoot = Deno.env.get("DESIGN_DOCS_ROOT");
  Deno.env.set("DESIGN_DOCS_ROOT", "/nonexistent-theme-root");

  const errors: string[] = [];
  const logs: string[] = [];
  try {
    const exitCode = await runMatchDesignCli(
      ["book-gig"],
      { log: (msg) => logs.push(msg), errorLog: (msg) => errors.push(msg) },
    );
    assertEquals(exitCode, 2);
    assertStringIncludes(errors.join("\n"), "/nonexistent-theme-root");
    assertEquals(
      [...logs, ...errors].join("\n").includes("No existing design document found"),
      false,
    );
  } finally {
    if (priorDesignRoot === undefined) Deno.env.delete("DESIGN_DOCS_ROOT");
    else Deno.env.set("DESIGN_DOCS_ROOT", priorDesignRoot);
  }
});

Deno.test("web-jam-tools#942: the Gate 1 refusal on a redundant parallel document is unchanged and still fires beside the precondition", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-refusal-still-there-" });
  const themeDir = path.join(tempDir, "gig-outreach");
  await Deno.mkdir(themeDir, { recursive: true });
  await Deno.writeTextFile(
    path.join(themeDir, "book-gig-skill-design-2026-08-16.md"),
    MINIMAL_LINT_CLEAN_DOC,
  );
  const redundantDocPath = path.join(themeDir, "book-gig-skill-phase-2-design-2026-09-06.md");
  await Deno.writeTextFile(redundantDocPath, MINIMAL_LINT_CLEAN_DOC);

  try {
    // The precondition resolves the canonical document up front...
    const resolution = await resolveCanonicalDesignDoc({
      topic: "book-gig",
      dropboxDir: tempDir,
    });
    assertEquals(resolution.outcome, "existing-document");

    // ...and the late refusal still refuses the duplicate file independently.
    await assertRejects(
      () =>
        runGate1({
          docPath: redundantDocPath,
          dropboxDir: tempDir,
          noOpen: true,
          screenshotImpl: () => Promise.resolve({ sizeBytes: 100 }),
        }),
      Error,
      'Refusing to process redundant parallel design document for "book-gig"',
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("web-jam-tools#942: parseDecisionsRecord reads both decisions-record table shapes and ignores other appendices", () => {
  const fourColumn = parseDecisionsRecord(DOC_WITH_DECISIONS_RECORD);
  assertEquals(fourColumn.map((entry) => entry.id), ["D-1", "D-4"]);

  const threeColumn = parseDecisionsRecord(`# Doc

## Appendix A — ground facts

| Fact | Proof |
|---|---|
| Not a decision | Checked |

## Appendix B — decision record

| # | Decision | Outcome |
|---|---|---|
| 1 | Milestone / theme | **AI Misbehaves** — Josh picked option 1 |
| 2 | Fate of the alias | **Officially retired.** Josh picked option 2 |

## Appendix C — what Josh asked for, verbatim

| Quote | Date |
|---|---|
| "not a decision either" | 2026-09-06 |
`);
  assertEquals(threeColumn.length, 2);
  assertEquals(threeColumn[0].id, "1");
  assertStringIncludes(threeColumn[0].outcome, "AI Misbehaves");
  assertEquals(threeColumn[1].id, "2");
  assertStringIncludes(threeColumn[1].outcome, "Officially retired.");

  // A document with no decisions record yields no entries rather than throwing.
  assertEquals(parseDecisionsRecord("# Doc\n\nNo appendix here.\n"), []);
  assertEquals(parseDecisionsRecord(""), []);

  // Long outcomes are truncated for the CLI line, never dropped.
  const long = parseDecisionsRecord(
    `## Appendix — Decisions Record\n\n| ID | Outcome |\n|---|---|\n| D-9 | ${"x".repeat(400)} |\n`,
    50,
  );
  assertEquals(long.length, 1);
  assertEquals(long[0].outcome.length, 51);
  assertStringIncludes(long[0].outcome, "…");
});
