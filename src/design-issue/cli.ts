// src/design-issue/cli.ts
// Multi-command CLI for design-issue tooling:
// - deno task design:gate1 <doc.md> (web-jam-tools#741)
// - deno task design:lint-doc <doc.md> (web-jam-tools#742)

import { parseArgs } from "@std/cli/parse-args";
import { type Gate1Options, runGate1 } from "./gate1.ts";
import { runLintDocCli } from "./lint_doc.ts";

export async function runGate1Cli(
  args: string[],
  options?: Partial<Gate1Options>,
): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["no-open", "help"],
    string: ["doc", "screenshot-path"],
    alias: {
      h: "help",
    },
    default: {
      "no-open": false,
      help: false,
    },
  });

  if (flags.help) {
    console.log(`Usage: deno task design:gate1 <doc.md> [options]

Renders a markdown design document to HTML, verifies layout via headless screenshot,
and opens the rendered HTML in Google Chrome on the active display.

Arguments:
  <doc.md>                  Path to design document markdown file

Options:
  --doc <path>              Explicit design document path
  --screenshot-path <path>  Override output screenshot file path
  --no-open                 Skip launching Google Chrome
  -h, --help                Show this help message
`);
    return 0;
  }

  const docPath = flags.doc || (flags._.length > 0 ? String(flags._[0]) : "") ||
    options?.docPath || "";
  if (!docPath) {
    console.error("Error: Missing required design document path.");
    console.error("Usage: deno task design:gate1 <doc.md>");
    return 1;
  }

  try {
    const result = await runGate1({
      docPath,
      screenshotPath: flags["screenshot-path"] || options?.screenshotPath,
      noOpen: flags["no-open"] || options?.noOpen,
      screenshotImpl: options?.screenshotImpl,
      openBrowserImpl: options?.openBrowserImpl,
      display: options?.display,
    });

    console.log(`[design:gate1] Rendered HTML: ${result.htmlPath}`);
    console.log(
      `[design:gate1] Headless screenshot verified: ${result.screenshotPath} (${result.screenshotSizeBytes} bytes)`,
    );
    if (result.opened) {
      console.log(`[design:gate1] Opened ${result.htmlPath} in Google Chrome`);
    }
    return 0;
  } catch (err) {
    console.error(`[design:gate1] Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function runCli(
  args: string[],
  options?: Partial<Gate1Options>,
): Promise<number> {
  const firstArg = args.length > 0 ? String(args[0]) : "";

  if (firstArg === "lint-doc" || firstArg === "lint_doc") {
    return await runLintDocCli(args.slice(1));
  }

  if (firstArg === "gate1") {
    return await runGate1Cli(args.slice(1), options);
  }

  // If no subcommand was matched, default to Gate 1 (preserving backwards compatibility)
  return await runGate1Cli(args, options);
}

if (import.meta.main) {
  const exitCode = await runCli(Deno.args);
  if (exitCode !== 0) {
    Deno.exit(exitCode);
  }
}
