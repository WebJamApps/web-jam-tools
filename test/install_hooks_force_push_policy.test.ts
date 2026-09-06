// install_hooks_force_push_policy.test.ts
//
// Pins WHICH permission array each force-push pattern lives in inside
// scripts/install-hooks.sh, because that placement is the policy.
//
// `--force-with-lease` is ASK, not DENY (Josh, 2026-08-13: "force with lease
// should be allowed if I give permission"). A deny entry cannot enforce the
// remote-branch hard rule — static string matching has no view of whether Josh
// authorized anything, so it refused the authorized case and the unauthorized
// one identically, and a rebase behind an open PR became unlandable. An ask
// prompt shows the literal command including the branch and takes his answer
// per invocation, which is the only layer that can evaluate that condition.
//
// Plain `--force` and every remote-deleting shape stay denied outright.
//
// install_hooks_merge.test.ts exercises the merge helper against its own
// literal lists and says nothing about which array a pattern ships in, so
// these assertions are not covered there.

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const INSTALL_SCRIPT = `${REPO_ROOT}scripts/install-hooks.sh`;

async function ruleBlocks(): Promise<{ deny: string; ask: string }> {
  const src = await Deno.readTextFile(INSTALL_SCRIPT);
  const grab = (name: string) => {
    const start = src.indexOf(`${name}=(`);
    assert(start !== -1, `${name}=( not found in install-hooks.sh`);
    const end = src.indexOf("\n)", start);
    assert(end !== -1, `end of ${name} array not found`);
    return src.slice(start, end);
  };
  return { deny: grab("DENY_RULES"), ask: grab("ASK_RULES") };
}

Deno.test("--force-with-lease is an ASK rule, never a DENY rule", async () => {
  const { deny, ask } = await ruleBlocks();
  assert(
    ask.includes("git push --force-with-lease*"),
    "--force-with-lease must be an ASK rule so Josh is prompted per invocation",
  );
  assert(
    ask.includes("git push * --force-with-lease*"),
    "the <remote> <branch> form must also be an ASK rule",
  );
  // Match quoted RULE ENTRIES, not any occurrence of the string: DENY_RULES
  // carries a comment pointing at where --force-with-lease went, and a bare
  // substring check trips on that comment.
  const denyEntries = [...deny.matchAll(/'Bash\(([^)]*)\)'/g)].map((m) => m[1]);
  assertEquals(
    denyEntries.filter((e) => e.includes("--force-with-lease")),
    [],
    "--force-with-lease must not be a DENY entry — a deny rule cannot represent Josh's authorization",
  );
});

Deno.test("plain --force and every remote-deleting shape stay DENIED", async () => {
  const { deny, ask } = await ruleBlocks();
  const mustDeny = [
    "git push --force *",
    "git push --force)",
    "git push -f *",
    "git push * :*",
    "git push --mirror*",
    "git push --prune*",
    "git push -d *",
    "git branch -D remotes/*",
  ];
  for (const pattern of mustDeny) {
    assert(deny.includes(pattern), `DENY_RULES must still contain: ${pattern}`);
  }
  assertEquals(
    ask.includes("git push --force *"),
    false,
    "plain --force must never be downgraded to a prompt",
  );
  assertEquals(
    ask.includes("remotes/*"),
    false,
    "remote-ref deletion must never be downgraded to a prompt",
  );
});
