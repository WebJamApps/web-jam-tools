// src/design-issue/gate1.ts
// Gate 1 helper: renders markdown to HTML, takes a headless screenshot to confirm layout,
// and opens the HTML in Chrome on the active display (web-jam-tools#741).

import * as path from "@std/path";
import { renderDesignDoc } from "../../scripts/render_design_doc.ts";
import { lintDesignDoc } from "./lint_doc.ts";

export interface Gate1Options {
  docPath: string;
  screenshotPath?: string;
  noOpen?: boolean;
  screenshotImpl?: (htmlPath: string, screenshotPath: string) => Promise<{ sizeBytes: number }>;
  openBrowserImpl?: (htmlPath: string, display?: string) => Promise<void>;
  display?: string;
}

export interface Gate1Result {
  docPath: string;
  htmlPath: string;
  screenshotPath: string;
  screenshotSizeBytes: number;
  opened: boolean;
}

/**
 * Expands leading `~` to $HOME or /home/joshua.
 */
export function expandHome(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    const home = Deno.env.get("HOME") || "/home/joshua";
    if (filePath === "~") return home;
    return `${home}/${filePath.slice(2)}`;
  }
  return filePath;
}

/**
 * Resolves the destination HTML path for a given markdown path.
 * Replaces .md extension with .html, or appends .html.
 */
export function resolveHtmlPath(markdownPath: string): string {
  const expanded = expandHome(markdownPath);
  const resolved = path.resolve(expanded);
  if (resolved.toLowerCase().endsWith(".md")) {
    return resolved.slice(0, -3) + ".html";
  }
  return resolved + ".html";
}

/**
 * Takes a headless screenshot of the rendered HTML using google-chrome / chromium or playwright.
 * Fails loudly if screenshot generation fails or produces an empty file.
 */
export async function defaultScreenshotImpl(
  htmlPath: string,
  screenshotPath: string,
  execCommand?: (
    bin: string,
    args: string[],
  ) => Promise<{ success: boolean; code?: number }>,
): Promise<{ sizeBytes: number }> {
  const fileUrl = `file://${path.resolve(htmlPath)}`;
  const tempUserDataDir = await Deno.makeTempDir({ prefix: "gate1-chrome-profile-" });

  try {
    // Try CLI browser binaries first
    for (const bin of ["google-chrome", "chromium", "chromium-browser"]) {
      let outputSuccess = false;
      const args = [
        "--headless=new",
        `--user-data-dir=${tempUserDataDir}`,
        `--screenshot=${screenshotPath}`,
        "--window-size=1400,900",
        fileUrl,
      ];

      if (execCommand) {
        try {
          const res = await execCommand(bin, args);
          outputSuccess = res.success;
        } catch {
          continue;
        }
      } else {
        try {
          const cmd = new Deno.Command(bin, {
            args,
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          outputSuccess = output.success;
        } catch {
          continue;
        }
      }

      if (outputSuccess) {
        try {
          const fileInfo = await Deno.stat(screenshotPath);
          if (fileInfo.size > 0) {
            return { sizeBytes: fileInfo.size };
          }
        } catch {
          // continue
        }
      }
    }

    // Fallback to Playwright
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        await page.goto(fileUrl, { waitUntil: "load" });
        await page.screenshot({ path: screenshotPath, fullPage: true });
        const fileInfo = await Deno.stat(screenshotPath);
        if (fileInfo.size > 0) {
          return { sizeBytes: fileInfo.size };
        }
      } finally {
        await browser.close();
      }
    } catch (err) {
      throw new Error(
        `Headless screenshot failed: no working browser executable found (checked google-chrome, chromium, chromium-browser, and playwright): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    throw new Error(`Screenshot output file at ${screenshotPath} is empty (0 bytes)`);
  } finally {
    try {
      await Deno.remove(tempUserDataDir, { recursive: true });
    } catch {
      // ignore if already removed
    }
  }
}

/**
 * Opens the rendered HTML in Google Chrome on the active display in the background.
 */
export async function defaultOpenBrowserImpl(
  htmlPath: string,
  display?: string,
  execCommand?: (
    cmd: string,
    env: Record<string, string>,
  ) => Promise<{ success: boolean; code: number }>,
): Promise<void> {
  const absHtmlPath = path.resolve(htmlPath);
  const activeDisplay = display || Deno.env.get("DISPLAY") || ":0";
  const shellCmd =
    `DISPLAY="${activeDisplay}" google-chrome "file://${absHtmlPath}" >/dev/null 2>&1 &`;
  const env = { ...Deno.env.toObject(), DISPLAY: activeDisplay };

  if (execCommand) {
    const output = await execCommand(shellCmd, env);
    if (!output.success) {
      throw new Error(`Failed to launch Google Chrome (exit code ${output.code})`);
    }
    return;
  }

  const cmd = new Deno.Command("bash", {
    args: ["-c", shellCmd],
    env,
    stdout: "null",
    stderr: "null",
  });

  const output = await cmd.output();
  if (!output.success) {
    throw new Error(`Failed to launch Google Chrome (exit code ${output.code})`);
  }
}

/**
 * Runs Gate 1 end-to-end:
 * 1. Validates and reads the markdown design doc.
 * 2. Renders it to HTML with design rules.
 * 3. Takes a headless screenshot to verify layout.
 * 4. Opens the HTML in Chrome on the active display.
 */
export async function runGate1(options: Gate1Options): Promise<Gate1Result> {
  if (!options.docPath || options.docPath.trim() === "") {
    throw new Error("Design document path is required");
  }

  const absDocPath = path.resolve(expandHome(options.docPath.trim()));

  let markdownContent: string;
  try {
    markdownContent = await Deno.readTextFile(absDocPath);
  } catch (err) {
    throw new Error(
      `Design document not found or cannot be read at ${absDocPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (markdownContent.trim() === "") {
    throw new Error(`Design document at ${absDocPath} is empty`);
  }

  // Refuse to render or open a document whose design:lint-doc run does not pass, so the checker
  // cannot be bypassed by invoking Gate 1 directly instead of running the linter first
  // (web-jam-tools#815). There is no flag to skip this — the whole point is that it can't be
  // walked around.
  const lintResult = lintDesignDoc(markdownContent, absDocPath);
  if (!lintResult.valid) {
    const violationLines = lintResult.violations
      .map((v) => `  - [${v.rule}]${v.line ? ` (line ${v.line})` : ""} ${v.message}`)
      .join("\n");
    throw new Error(
      `Design document at ${absDocPath} failed design:lint-doc with ${lintResult.violations.length} violation(s) — refusing to render or open Gate 1:\n${violationLines}`,
    );
  }

  const htmlPath = resolveHtmlPath(absDocPath);
  const fallbackTitle = path.basename(absDocPath, path.extname(absDocPath));
  const renderedHtml = renderDesignDoc(markdownContent, fallbackTitle);

  if (!renderedHtml || renderedHtml.trim() === "") {
    throw new Error(`Rendered HTML for ${absDocPath} is empty`);
  }

  await Deno.writeTextFile(htmlPath, renderedHtml);

  // Determine screenshot path
  const screenshotPath = options.screenshotPath
    ? path.resolve(expandHome(options.screenshotPath))
    : path.join(
      await Deno.makeTempDir({ prefix: "gate1-screenshot-" }),
      "rendered-design-doc.png",
    );

  const screenshotRunner = options.screenshotImpl || defaultScreenshotImpl;
  const { sizeBytes: screenshotSizeBytes } = await screenshotRunner(htmlPath, screenshotPath);

  let opened = false;
  if (!options.noOpen) {
    const openRunner = options.openBrowserImpl || defaultOpenBrowserImpl;
    await openRunner(htmlPath, options.display);
    opened = true;
  }

  return {
    docPath: absDocPath,
    htmlPath,
    screenshotPath,
    screenshotSizeBytes,
    opened,
  };
}
