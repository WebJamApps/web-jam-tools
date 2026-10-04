import { installCodex } from "./install.ts";

export function main(args: string[]): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: deno task install-codex [--check] [--home <dir>]");
    console.log("Install Codex hooks, copied rules, shared skill links and sandbox_mode.");
    console.log(
      "--check reports drift without writing; --home uses an alternate home for testing.",
    );
    return 0;
  }
  let home: string | undefined;
  let check = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--check") check = true;
    else if (args[index] === "--home" && args[index + 1] && !args[index + 1].startsWith("--")) {
      home = args[++index];
    } else {
      console.error(`Unknown or incomplete argument: ${args[index]}; use --help`);
      return 1;
    }
  }
  home ??= Deno.env.get("HOME");
  if (!home) {
    console.error("HOME is unset; provide --home <dir>");
    return 1;
  }
  return installCodex({ home, check });
}
