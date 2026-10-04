import { main } from "../src/install-codex/cli.ts";

if (import.meta.main) Deno.exit(main(Deno.args));
