// gen-npm-manifest.ts — web-jam-tools#84
//
// Trivy/OSV/etc. can't read `deno.lock` directly, but they scan npm
// `package-lock.json` well. This script reads the **exact** npm dependency
// versions Deno resolved (from `deno.lock`'s `specifiers`) and writes a
// `package.json` pinned to those versions. The audit step then runs
// `npm install --package-lock-only` on it and scans the resulting lockfile —
// so we scan the npm deps Deno actually uses (cheerio, playwright, xlsx, …).
//
// JSR deps (`jsr:@std/*`) are intentionally excluded — no scanner covers JSR
// today, and they're Deno's first-party stdlib.
//
// Usage: deno run --allow-read --allow-write gen-npm-manifest.ts <deno.lock> <out-dir>

const lockPath = Deno.args[0] ?? "deno.lock";
const outDir = Deno.args[1] ?? ".";

const lock = JSON.parse(await Deno.readTextFile(lockPath)) as {
  specifiers?: Record<string, string>;
};

const deps: Record<string, string> = {};
for (const [spec, version] of Object.entries(lock.specifiers ?? {})) {
  if (!spec.startsWith("npm:")) continue;
  // spec looks like "npm:cheerio@^1.2.0" or "npm:@scope/pkg@1.0.0"
  const rest = spec.slice("npm:".length);
  const at = rest.lastIndexOf("@");
  const name = at > 0 ? rest.slice(0, at) : rest; // at===0 ⇒ scope-only (shouldn't happen)
  deps[name] = version; // exact resolved version from the lock
}

const pkg = {
  name: "web-jam-tools-audit",
  version: "0.0.0",
  private: true,
  dependencies: Object.fromEntries(Object.entries(deps).sort()),
};

await Deno.writeTextFile(`${outDir}/package.json`, JSON.stringify(pkg, null, 2) + "\n");
const names = Object.keys(pkg.dependencies);
console.error(
  `[audit] wrote ${outDir}/package.json — ${names.length} npm dep(s): ${names.join(", ")}`,
);
