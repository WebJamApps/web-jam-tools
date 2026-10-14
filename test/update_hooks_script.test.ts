// update_hooks_script.test.ts
//
// Exercises scripts/update-hooks.sh against a sandbox: a bare "origin" whose
// dev branch carries a stub scripts/install-hooks.sh, plus a clone of it. The
// real update-hooks.sh is run from an unrelated cwd to prove it works from any
// directory. The real ~/.claude and the real clone are never touched.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const UPDATE_SCRIPT = `${REPO_ROOT}scripts/update-hooks.sh`;

async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
) {
  const out = await new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), ...opts.env },
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await run("git", args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

interface Sandbox {
  root: string;
  origin: string;
  seed: string;
  clone: string;
  elsewhere: string;
  marker: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await Deno.makeTempDir({ prefix: "update-hooks-" });
  const origin = `${root}/origin.git`;
  const seed = `${root}/seed`;
  const clone = `${root}/clone`;
  const elsewhere = `${root}/elsewhere`;
  await Deno.mkdir(elsewhere);
  await git(root, "init", "--bare", "-b", "dev", origin);
  await git(root, "init", "-b", "dev", seed);
  await git(seed, "config", "user.name", "Test");
  await git(seed, "config", "user.email", "test@example.com");
  await Deno.mkdir(`${seed}/scripts`);
  await Deno.writeTextFile(
    `${seed}/scripts/install-hooks.sh`,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$UPDATE_HOOKS_MARKER"\n',
  );
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "initial");
  await git(seed, "remote", "add", "origin", origin);
  await git(seed, "push", "origin", "dev");
  await git(root, "clone", "-b", "dev", origin, clone);
  await git(clone, "config", "user.name", "Test");
  await git(clone, "config", "user.email", "test@example.com");
  return { root, origin, seed, clone, elsewhere, marker: `${root}/marker.txt` };
}

function runUpdate(sb: Sandbox, args: string[] = []) {
  return run("bash", [UPDATE_SCRIPT, ...args], {
    cwd: sb.elsewhere,
    env: { WJT_REPO_DIR: sb.clone, UPDATE_HOOKS_MARKER: sb.marker },
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("update-hooks.sh refuses when the clone is not on dev", async () => {
  const sb = await makeSandbox();
  try {
    await git(sb.clone, "checkout", "-b", "feature/x");
    const before = await git(sb.clone, "rev-parse", "HEAD");

    const r = await runUpdate(sb, ["--check"]);

    assertEquals(r.code, 1, r.stderr);
    assertStringIncludes(r.stderr, "feature/x");
    assert(!(await exists(sb.marker)), "install-hooks.sh must not run");
    assertEquals(await git(sb.clone, "rev-parse", "HEAD"), before);
    assertEquals(await git(sb.clone, "symbolic-ref", "--short", "HEAD"), "feature/x");
  } finally {
    await Deno.remove(sb.root, { recursive: true });
  }
});

Deno.test("update-hooks.sh pulls dev and passes args to install-hooks.sh from any cwd", async () => {
  const sb = await makeSandbox();
  try {
    await Deno.writeTextFile(`${sb.seed}/newer.txt`, "newer\n");
    await git(sb.seed, "add", ".");
    await git(sb.seed, "commit", "-m", "newer");
    await git(sb.seed, "push", "origin", "dev");
    const originHead = await git(sb.seed, "rev-parse", "HEAD");
    assert((await git(sb.clone, "rev-parse", "HEAD")) !== originHead);

    const r = await runUpdate(sb, ["--check"]);

    assertEquals(r.code, 0, r.stderr);
    assertEquals(await git(sb.clone, "rev-parse", "HEAD"), originHead);
    assertEquals((await Deno.readTextFile(sb.marker)).trim(), "--check");
  } finally {
    await Deno.remove(sb.root, { recursive: true });
  }
});
