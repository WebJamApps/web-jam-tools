import { assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("registered dependency tasks run with scoped permissions and a stubbed gh", async () => {
  const temp = await Deno.makeTempDir({ prefix: "wjt-dependencies-" });
  const log = `${temp}/calls`;
  const target = { id: 100, number: 10, title: "Dependent" };
  const blocker = { id: 200, number: 20, title: "Blocker" };
  const stub = [
    "#!/bin/sh",
    'printf \'%s\\n\' "$*" >> "$WJT_TEST_LOG"',
    'case "$*" in',
    "  *--method*) printf '{}';;",
    "  *dependencies/blocked_by*) printf '%s\\n' \"$WJT_TEST_DEPENDENCIES\";;",
    `  *issues/10*) printf '%s\\n' '${JSON.stringify(target)}';;`,
    `  *issues/20*) printf '%s\\n' '${JSON.stringify(blocker)}';;`,
    "  *) exit 9;;",
    "esac",
  ].join("\n");
  try {
    await Deno.writeTextFile(`${temp}/gh`, stub);
    await Deno.chmod(`${temp}/gh`, 0o700);
    for (const action of ["block", "unblock"]) {
      for (const dryRun of [false, true]) {
        await Deno.writeTextFile(log, "");
        const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
          args: [
            "task",
            "--quiet",
            `${action}-issue`,
            "--repo",
            "OtherOrg/widgets",
            "--issue",
            "10",
            "--blocker",
            "20",
            ...(dryRun ? ["--dry-run"] : []),
          ],
          cwd: new URL("..", import.meta.url),
          env: {
            PATH: `${temp}:${Deno.env.get("PATH")}`,
            WJT_TEST_LOG: log,
            WJT_TEST_DEPENDENCIES: JSON.stringify([action === "unblock" ? [blocker] : []]),
          },
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output();
        const output = new TextDecoder().decode(stdout);
        assertEquals(code, 0, new TextDecoder().decode(stderr));
        assertStringIncludes(output, 'OtherOrg/widgets#10 "Dependent"');
        assertStringIncludes(output, `deno task ${action === "block" ? "unblock" : "block"}-issue`);
        const calls = (await Deno.readTextFile(log)).trim().split("\n");
        assertEquals(calls.length, dryRun ? 3 : 4);
        const writes = calls.filter((line) => line.includes("--method"));
        assertEquals(writes.length, dryRun ? 0 : 1);
        if (!dryRun) {
          assertStringIncludes(writes[0], action === "block" ? "POST" : "DELETE");
        }
      }
    }
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
