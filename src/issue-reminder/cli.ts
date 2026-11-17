#!/usr/bin/env -S deno run --allow-env=HOME --allow-read=$HOME/.claude.json --allow-run=gh,node
/**
 * Manage weekly Google Calendar reminders for Blocked issues waiting on someone outside GitHub.
 */
import { createRealDeps, runIssueReminder } from "./lib.ts";

if (import.meta.main) {
  Deno.exit(await runIssueReminder(Deno.args, createRealDeps()));
}
