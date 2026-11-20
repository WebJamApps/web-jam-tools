import { assertEquals } from "@std/assert";

const files = [
  "test/backend_mutation_guard.test.ts",
  "test/block_private_folder_read_hook.test.ts",
  "test/block_production_media_change_hook.test.ts",
  "test/block_secret_dumps_hook.test.ts",
  "test/block_agy_gmail_send_delete_hook.test.ts",
];

Deno.test("direct hook tests leave an inherited recording sentinel unchanged", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const record = `${dir}/record.jsonl`;
    const sentinel = new TextEncoder().encode("sentinel\n");
    await Deno.writeFile(record, sentinel);
    for (const args of [files, ["--filter", "Gmail fence: shim preserves", files[4]]]) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["test", "-A", ...args],
        env: { AGY_HOOK_RECORD_PATH: record },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      assertEquals(await Deno.readFile(record), sentinel);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
