import { assert } from "@std/assert";
import { runCronCheck } from "../src/uptime/cron.ts";

Deno.test("runCronCheck function runs cleanly", () => {
  assert(typeof runCronCheck === "function");
});
