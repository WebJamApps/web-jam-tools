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
  await Deno.writeTextFile(docPath, "# Test\n\n## Section\nContent");

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
  await Deno.writeTextFile(docPath, "# Test\n\n## Section\nContent");

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
  await Deno.writeTextFile(docPath, "# Test\n\n## Section\nContent");

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

Deno.test("defaultOpenBrowserImpl launches background command successfully", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gate1-open-browser-" });
  const htmlPath = path.join(tempDir, "test.html");
  await Deno.writeTextFile(htmlPath, "<h1>Test</h1>");

  try {
    // Should run non-blocking shell command cleanly without throwing
    await defaultOpenBrowserImpl(htmlPath, ":99");
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
  await Deno.writeTextFile(docPath, "# CLI Test\n\n## Section\nSome content");

  try {
    // If google-chrome is installed, test with real screenshot
    const exitCode = await runCli([docPath, "--no-open"]);
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
