import { main } from "../src/install-codex/cli.ts";
export { main } from "../src/install-codex/cli.ts";
export { readHookRegistrations } from "../src/install-codex/hooks.ts";
export { installCodex } from "../src/install-codex/install.ts";

if (import.meta.main) Deno.exit(main(Deno.args));
