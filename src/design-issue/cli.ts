// src/design-issue/cli.ts
// CLI script for deno task design:gate1 <doc.md> (web-jam-tools#741)

import { parseArgs } from "@std/cli/parse-args";
import { runGate1 } from "./gate1.ts";

export async function runCli(args: string[]): Promise<number> {
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

  const docPath = flags.doc || (flags._.length > 0 ? String(flags._[0]) : "");
  if (!docPath) {
    console.error("Error: Missing required design document path.");
    console.error("Usage: deno task design:gate1 <doc.md>");
    return 1;
  }

  try {
    const result = await runGate1({
      docPath,
      screenshotPath: flags["screenshot-path"],
      noOpen: flags["no-open"],
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

if (import.meta.main) {
  const exitCode = await runCli(Deno.args);
  if (exitCode !== 0) {
    Deno.exit(exitCode);
  }
}
