#!/usr/bin/env -S deno run --allow-run=gh
/** Remove the blocked-by link Josh or an approved plan names, and print its undo. */
import { realRunCmd, runDependencyCommand } from "./gh-write/issue_dependencies.ts";

export { type Deps, parseArgs } from "./gh-write/issue_dependencies.ts";
import type { Deps } from "./gh-write/issue_dependencies.ts";

export function run(args: string[], deps: Deps): Promise<number> {
  return runDependencyCommand("unblock", args, deps);
}

if (import.meta.main) Deno.exit(await run(Deno.args, { runCmd: realRunCmd }));
