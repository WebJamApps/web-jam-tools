#!/usr/bin/env -S deno run --allow-net --allow-env
// scripts/circleci-settings.ts — CircleCI project settings standard & drift checker (web-jam-tools#697)
import { main } from "../src/circleci-settings/cli.ts";

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
