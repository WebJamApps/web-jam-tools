/**
 * scripts/set-workflow-switch.ts — CLI to activate or clear the workflow guard off-switch (web-jam-tools#1046).
 *
 * Usage:
 *   deno task workflow-switch --guard opus-delegation-gate --ttl-minutes 15
 *   deno task workflow-switch --all --ttl-minutes 30
 *   deno task workflow-switch opus-delegation-gate
 *   deno task workflow-switch --clear
 */

import { parseArgs } from "@std/cli/parse-args";
import {
  defaultWorkflowSwitchPath,
  normalizeGuardName,
} from "../hooks/lib/workflow_switch.ts";

export const DEFAULT_TTL_MINUTES = 15;

export interface SetWorkflowSwitchOptions {
  guard?: string;
  all?: boolean;
  ttlMinutes?: number;
  expiresAt?: string;
  clear?: boolean;
  path?: string;
}

export function writeWorkflowSwitchFile(options: SetWorkflowSwitchOptions): {
  action: "set" | "cleared";
  path: string;
  guard?: string;
  expiresAt?: string;
} {
  const targetPath = options.path || defaultWorkflowSwitchPath();

  if (options.clear) {
    try {
      Deno.removeSync(targetPath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }
    }
    return { action: "cleared", path: targetPath };
  }

  let guard = options.guard?.trim();
  if (options.all) {
    guard = "all workflow guards";
  }

  if (!guard) {
    throw new Error(
      "Missing guard name. Specify a guard (e.g. 'opus-delegation-gate', 'agy-model-guard'), pass positional argument, or pass --all.",
    );
  }

  let expiresAt: string;
  if (options.expiresAt) {
    const parsed = new Date(options.expiresAt).getTime();
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid --expires-at timestamp: '${options.expiresAt}'`);
    }
    expiresAt = new Date(parsed).toISOString();
  } else {
    const ttl = typeof options.ttlMinutes === "number" && options.ttlMinutes > 0
      ? options.ttlMinutes
      : DEFAULT_TTL_MINUTES;
    expiresAt = new Date(Date.now() + ttl * 60 * 1000).toISOString();
  }

  const payload = {
    guard,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  };

  const lastSlash = targetPath.lastIndexOf("/");
  if (lastSlash > 0) {
    const parentDir = targetPath.slice(0, lastSlash);
    try {
      Deno.mkdirSync(parentDir, { recursive: true });
    } catch {
      // ignore directory creation error
    }
  }

  Deno.writeTextFileSync(targetPath, JSON.stringify(payload, null, 2) + "\n");
  return {
    action: "set",
    path: targetPath,
    guard,
    expiresAt,
  };
}

export function printHelp(): void {
  console.log(`Usage: deno task workflow-switch [options] [guard-name]

Sets or clears a time-boxed workflow guard off-switch in ~/.claude/state/workflow-switch.json.

Options:
  --guard <name>        Guard to disable (e.g. 'opus-delegation-gate', 'agy-model-guard')
  --all                 Disable all workflow guards ('all workflow guards')
  --ttl-minutes <mins>  Minutes until switch expires (default: ${DEFAULT_TTL_MINUTES})
  --expires-at <iso>    Exact ISO 8601 expiry timestamp
  --clear, --off        Clear the active off-switch
  --path <path>         Override state file path (defaults to WORKFLOW_SWITCH_PATH)
  -h, --help            Show this help message
`);
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["guard", "expires-at", "path", "ttl-minutes", "minutes", "ttl"],
    boolean: ["all", "clear", "expire", "off", "help", "h"],
    alias: {
      h: "help",
    },
  });

  if (args.help) {
    printHelp();
    Deno.exit(0);
  }

  const positionalGuard = args._[0] ? String(args._[0]) : undefined;
  const guard = args.guard || positionalGuard;
  const rawTtl = args["ttl-minutes"] ?? args.minutes ?? args.ttl;
  const ttlMinutes = rawTtl ? parseFloat(String(rawTtl)) : undefined;

  try {
    const res = writeWorkflowSwitchFile({
      guard,
      all: args.all,
      ttlMinutes,
      expiresAt: args["expires-at"],
      clear: args.clear || args.expire || args.off,
      path: args.path,
    });

    if (res.action === "cleared") {
      console.log(`Workflow switch cleared (${res.path}).`);
    } else {
      console.log(
        `Workflow switch active for '${res.guard}' until ${res.expiresAt} (${res.path}).`,
      );
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}
