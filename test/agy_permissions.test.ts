import { assertEquals, assertThrows } from "@std/assert";
import { parsePermissionOutput, run, validateSettings } from "../scripts/agy-permissions.ts";

Deno.test("permission output accepts only exact global allow grants", () => {
  assertEquals(
    parsePermissionOutput(
      "global\tdeny\tcommand(/script)\nworkspace allow command(/script)\nglobal allow command(/script-extra)",
    ),
    ["command(/script-extra)"],
  );
  assertEquals(parsePermissionOutput("\x1b[32mglobal\tallow\tcommand(/script)\x1b[0m\r\n"), [
    "command(/script)",
  ]);
  for (
    const output of [
      "",
      "unrelated",
      "global allow",
      "unknown allow command(/script)",
      "global allow command(/script)\nunreadable",
    ]
  ) {
    assertThrows(() => parsePermissionOutput(output));
  }
});

Deno.test("permission settings reject malformed lists and retain unrelated fields", () => {
  const settings = {
    custom: "keep",
    permissions: { allow: [], deny: ["command(/script)"], ask: [] },
  };
  assertEquals(validateSettings(settings), settings);
  assertEquals(validateSettings({}), {});
  for (
    const invalid of [null, [], "text", { permissions: null }, { permissions: [] }, {
      permissions: { allow: [1] },
    }, { permissions: { deny: {} } }]
  ) {
    assertThrows(() => validateSettings(invalid));
  }
});

Deno.test("adding an allow grant is idempotent and refuses malformed files unchanged", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/settings.json`;
  try {
    await run(["add-allow", path, "command(/script)"]);
    const initial = await Deno.readTextFile(path);
    await run(["add-allow", path, "command(/script)"]);
    assertEquals(await Deno.readTextFile(path), initial);
    await Deno.writeTextFile(path, '{"permissions":{"allow":null}}');
    let refused = false;
    try {
      await run(["add-allow", path, "command(/script)"]);
    } catch {
      refused = true;
    }
    assertEquals(refused, true);
    assertEquals(await Deno.readTextFile(path), '{"permissions":{"allow":null}}');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
