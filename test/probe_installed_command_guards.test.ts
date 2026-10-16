import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { readHookRegistrations } from "../src/install-codex/hooks.ts";
import { updateConfig } from "../src/install-codex/config.ts";
import {
  probeInstalledGuard,
  type ProbeOptions,
} from "../scripts/probe-installed-command-guards.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(ROOT, "scripts/probe-installed-command-guards.ts");

async function fixture(run: (options: ProbeOptions) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "apostrophe-installed-" });
  const home = join(dir, "home");
  const repoDir = join(dir, "canonical-clone");
  try {
    for (const path of [".claude/hooks", ".gemini/config", ".codex"]) {
      await Deno.mkdir(join(home, path), { recursive: true });
    }
    await Deno.mkdir(join(repoDir, "hooks/lib"), { recursive: true });
    for (const name of ["block-irreversible-operations.sh", "agy-hook-shim.sh"]) {
      await Deno.copyFile(join(ROOT, "hooks", name), join(repoDir, "hooks", name));
      await Deno.symlink(join(repoDir, "hooks", name), join(home, ".claude/hooks", name));
    }
    for (
      const name of [
        "normalize_command.ts",
        "check_irreversible_operations.ts",
        "agy_hook_shim.ts",
        "detect_credential_literal.ts",
      ]
    ) await Deno.copyFile(join(ROOT, "hooks/lib", name), join(repoDir, "hooks/lib", name));

    const wanted = readHookRegistrations(
      await Deno.readTextFile(join(ROOT, "scripts/install-hooks.sh")),
      home,
    );
    const registration = wanted.PreToolUse.find((entry) =>
      entry.hooks[0].command.includes("block-irreversible-operations.sh")
    )!;
    const matcher = registration.matcher!;
    const target = join(home, ".claude/hooks/block-irreversible-operations.sh");
    const config = (command: string, match = matcher) =>
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: match, hooks: [{ type: "command", command }] }] },
      });
    await Deno.writeTextFile(join(home, ".claude/settings.json"), config(`"${target}"`));
    await Deno.writeTextFile(
      join(home, ".gemini/config/hooks.json"),
      config(
        `$HOME/.claude/hooks/agy-hook-shim.sh PreToolUse ${
          btoa(matcher)
        } $HOME/.claude/hooks/block-irreversible-operations.sh`,
        ".*",
      ),
    );
    await Deno.writeTextFile(join(home, ".codex/config.toml"), updateConfig("", wanted, home).text);
    await run({ surface: "claude", home, repoDir });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

for (const surface of ["claude", "agy", "codex"] as const) {
  Deno.test(`apostrophe installed ${surface}: CLI verifies existing registration and all 36 cases without changing config`, async () => {
    await fixture(async (options) => {
      const configs = [".claude/settings.json", ".gemini/config/hooks.json", ".codex/config.toml"];
      const before = await Promise.all(
        configs.map((path) => Deno.readTextFile(join(options.home, path))),
      );
      const result = await new Deno.Command("deno", {
        args: [
          "run",
          "--config",
          join(ROOT, "deno.json"),
          "--allow-read",
          "--allow-write=/tmp",
          "--allow-env=HOME",
          "--allow-run=bash",
          SCRIPT,
          "--guard",
          "irreversible",
          "--surface",
          surface,
          "--home",
          options.home,
          "--repo-dir",
          options.repoDir,
        ],
        env: { HOME: options.home },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      assertStringIncludes(
        new TextDecoder().decode(result.stdout),
        `${surface} irreversible: 36/36 literal cases passed`,
      );
      assertEquals(
        await Promise.all(configs.map((path) => Deno.readTextFile(join(options.home, path)))),
        before,
      );
    });
  });
}

Deno.test("apostrophe probe sends a filesystem write only as data, without creating the file", async () => {
  await fixture(async (options) => {
    const destination = join(options.home, "must-not-exist");
    assertEquals(
      await probeInstalledGuard(options, [{
        id: 1,
        command: `touch '${destination}'`,
        irreversible: "allow",
      }]),
      { passed: 1, total: 1 },
    );
    await assertRejects(() => Deno.stat(destination), Deno.errors.NotFound);
  });
});

Deno.test("apostrophe probe refuses an arbitrary registration command rather than executing it", async () => {
  await fixture(async (options) => {
    const destination = join(options.home, "must-not-exist");
    const hook = join(options.home, ".claude/hooks/block-irreversible-operations.sh");
    await Deno.writeTextFile(
      join(options.home, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [{ type: "command", command: `touch '${destination}' ${hook}` }],
          }],
        },
      }),
    );
    await assertRejects(() => probeInstalledGuard(options), Error, "expected surface");
    await assertRejects(() => Deno.stat(destination), Deno.errors.NotFound);
  });
});

Deno.test("apostrophe probe refuses a broken symlink, missing registration and wrong Codex surface", async () => {
  await fixture(async (options) => {
    await assertRejects(
      () => probeInstalledGuard({ ...options, repoDir: join(options.home, "missing") }),
      Deno.errors.NotFound,
    );
    await Deno.writeTextFile(join(options.home, ".claude/settings.json"), "{}");
    await assertRejects(() => probeInstalledGuard(options), Error, "no PreToolUse");
    const path = join(options.home, ".codex/config.toml");
    await Deno.writeTextFile(
      path,
      (await Deno.readTextFile(path)).replaceAll("WJT_SURFACE=codex ", ""),
    );
    await assertRejects(
      () => probeInstalledGuard({ ...options, surface: "codex" }),
      Error,
      "expected surface",
    );
  });
});
