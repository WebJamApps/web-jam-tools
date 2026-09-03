// src/design-issue/cli.ts
// Multi-command CLI for design-issue tooling:
// - deno task design:gate1 <doc.md> (web-jam-tools#741)
// - deno task design:lint-doc <doc.md> (web-jam-tools#742)
// - deno task design:lint-runbook <runbook.md> (web-jam-tools#743)
// - deno task design:candidates (web-jam-tools#745)
// - deno task design:stale-bodies <doc.md> --issues <list> (web-jam-tools#746)
// - deno task design:lint-plan <plan.md> (web-jam-tools#796)
// - deno task design:file-plan <plan.json> (web-jam-tools#748)

import { parseArgs } from "@std/cli/parse-args";
import { runCandidatesCli } from "./candidates.ts";
import { runFilePlanCli } from "./file_plan.ts";
import {
  type FindDesignDocOptions,
  findExistingDesignDoc,
  type Gate1Options,
  runGate1,
} from "./gate1.ts";
import { runLintDocCli } from "./lint_doc.ts";
import { runLintPlanCli } from "./lint_plan.ts";
import { runLintRunbookCli } from "./lint_runbook.ts";
import { runStaleBodiesCli } from "./stale_bodies.ts";

export {
  runCandidatesCli,
  runFilePlanCli,
  runLintDocCli,
  runLintPlanCli,
  runLintRunbookCli,
  runStaleBodiesCli,
};

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

export async function runMatchDesignCli(
  args: string[],
  options?: FindDesignDocOptions,
): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["help"],
    string: ["topic", "theme", "dropbox-dir"],
    alias: {
      h: "help",
    },
    default: {
      help: false,
    },
  });

  if (flags.help) {
    console.log(`Usage: deno task design:match-design <topic|epic|title> [options]

Matches pre-existing canonical design document for a feature or Epic
and prompts for a Major Revision.

Options:
  --topic <topic>       Match existing design document by topic slug
  --theme <theme>       Scope search to specific theme directory
  --dropbox-dir <path>  Override base Dropbox directory
  -h, --help            Show this help message`);
    return 0;
  }

  const query = flags.topic || (flags._.length > 0 ? String(flags._[0]) : "");
  if (!query) {
    console.error("Error: Missing required topic, epic, or title argument.");
    console.error("Usage: deno task design:match-design <topic|epic|title>");
    return 1;
  }

  const match = await findExistingDesignDoc({
    topic: flags.topic,
    title: query,
    theme: flags.theme || options?.theme,
    dropboxDir: flags["dropbox-dir"] || options?.dropboxDir,
  });

  if (match) {
    console.log(
      `[design:match-design] Resolved existing canonical design document for "${match.topic}":`,
    );
    console.log(`  ${match.path}`);
    console.log(
      `[design:match-design] Suggested action: Major Revision to existing design document.`,
    );
    console.log(match.suggestion);
    return 0;
  } else {
    console.log(`[design:match-design] No existing design document found for "${query}".`);
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

  if (firstArg === "lint-runbook" || firstArg === "lint_runbook") {
    return await runLintRunbookCli(args.slice(1));
  }

  if (firstArg === "candidates") {
    return await runCandidatesCli(args.slice(1));
  }

  if (
    firstArg === "match-design" || firstArg === "match_design" ||
    firstArg === "find-design" || firstArg === "find_design"
  ) {
    return await runMatchDesignCli(args.slice(1));
  }

  if (firstArg === "stale-bodies" || firstArg === "stale_bodies") {
    return await runStaleBodiesCli(args.slice(1));
  }

  if (firstArg === "lint-plan" || firstArg === "lint_plan") {
    return await runLintPlanCli(args.slice(1));
  }

  if (firstArg === "file-plan" || firstArg === "file_plan") {
    return await runFilePlanCli(args.slice(1));
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
