// src/book-gig/browser.ts — Chrome auto-opener for /book-gig HTML artifacts

import * as path from "@std/path";

export interface OpenBrowserOptions {
  display?: string;
  execCommand?: (
    cmd: string,
    env: Record<string, string>,
  ) => Promise<{ success: boolean; code: number }>;
}

/**
 * Opens the rendered HTML review artifact in Google Chrome on the active display in the background.
 */
export async function openHtmlInBrowser(
  htmlPath: string,
  options: OpenBrowserOptions = {},
): Promise<boolean> {
  const absHtmlPath = path.resolve(htmlPath);
  const activeDisplay = options.display || Deno.env.get("DISPLAY") || ":0";
  const shellCmd =
    `DISPLAY="${activeDisplay}" google-chrome "file://${absHtmlPath}" >/dev/null 2>&1 &`;
  const env = { ...Deno.env.toObject(), DISPLAY: activeDisplay };

  if (options.execCommand) {
    try {
      const output = await options.execCommand(shellCmd, env);
      return output.success;
    } catch {
      return false;
    }
  }

  try {
    const cmd = new Deno.Command("bash", {
      args: ["-c", shellCmd],
      env,
      stdout: "null",
      stderr: "null",
    });

    const output = await cmd.output();
    return output.success;
  } catch (err) {
    console.warn(`[book-gig] Note: Could not auto-open browser: ${(err as Error).message}`);
    return false;
  }
}
