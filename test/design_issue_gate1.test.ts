// test/design_issue_gate1.test.ts — web-jam-tools#741
//
// Unit and integration tests for Gate 1 helper: render, headless screenshot layout verification,
// and Chrome launch wiring.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  defaultOpenBrowserImpl,
  defaultScreenshotImpl,
  expandHome,
  resolveHtmlPath,
  runGate1,
} from "../src/design-issue/gate1.ts";
import { runCli } from "../src/design-issue/cli.ts";

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

Deno.test("deno.json defines design:gate1, render_design_doc, and write_issue_approval_token tasks", async () => {
  const denoJsonContent = await Deno.readTextFile(
    new URL("../deno.json", import.meta.url).pathname,
  );
  const config = JSON.parse(denoJsonContent);

  assertEquals(typeof config.tasks["design:gate1"], "string");
  assertEquals(typeof config.tasks["render_design_doc"], "string");
  assertEquals(typeof config.tasks["write_issue_approval_token"], "string");

  assertStringIncludes(config.tasks["design:gate1"], "src/design-issue/cli.ts");
  assertStringIncludes(config.tasks["render_design_doc"], "scripts/render_design_doc.ts");
  assertStringIncludes(
    config.tasks["write_issue_approval_token"],
    "scripts/write_issue_approval_token.ts",
  );
});
