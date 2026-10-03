// edit_issue.test.ts — web-jam-tools#685

import { assertEquals } from "@std/assert";
import { type Deps, findBodyFlags, run } from "../scripts/edit-issue.ts";
import { variedFakeBody } from "./support/varied_fake_value.ts";

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    readFileText: () => Promise.resolve("some body text"),
    runCmd: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("edit-issue: missing required args prints usage and exits 1", async () => {
  const code = await run(["--repo", "WebJamApps/web-jam-tools", "--issue", "685"], fakeDeps());
  assertEquals(code, 1);
});

Deno.test("edit-issue: a label edit with no body passes through untouched", async () => {
  let seenArgs: string[] = [];
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "685", "--remove-label", "Blocked"],
    fakeDeps({
      runCmd: (cmd) => {
        seenArgs = cmd;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(seenArgs, [
    "gh",
    "issue",
    "edit",
    "685",
    "--repo",
    "WebJamApps/web-jam-tools",
    "--remove-label",
    "Blocked",
  ]);
});

Deno.test("edit-issue: an inline --body value is REFUSED when empty", async () => {
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "685", "--body", ""],
    fakeDeps(),
  );
  assertEquals(code, 1);
});

Deno.test("edit-issue: a --body-file pointing at an empty file is REFUSED", async () => {
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "685", "--body-file", "/tmp/empty.md"],
    fakeDeps({ readFileText: () => Promise.resolve("") }),
  );
  assertEquals(code, 1);
});

Deno.test("edit-issue: a credential-shaped literal in any argument value is REFUSED", async () => {
  const fake = "AIza" + variedFakeBody(35, 70);
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "685", "--title", `leak ${fake}`],
    fakeDeps(),
  );
  assertEquals(code, 1);
});

Deno.test("edit-issue: --dry-run resolves without editing", async () => {
  let called = false;
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "685", "--add-label", "Sonnet", "--dry-run"],
    fakeDeps({
      runCmd: () => {
        called = true;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(called, false);
});

Deno.test("edit-issue: builds gh argv with bare issue id and --repo flag (regression web-jam-tools#781)", async () => {
  let seenEditArgs: string[] = [];
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "685", "--add-label", "Sonnet"],
    fakeDeps({
      runCmd: (cmd) => {
        seenEditArgs = cmd;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(seenEditArgs, [
    "gh",
    "issue",
    "edit",
    "685",
    "--repo",
    "WebJamApps/web-jam-tools",
    "--add-label",
    "Sonnet",
  ]);
});

// --- Authored-by footer (web-jam-tools#1205) ---

const BASE = ["--repo", "WebJamApps/web-jam-tools", "--issue", "685"];
const PROBE = "/fake/create-draft-pr.sh";

/** Deps whose roster probe returns `probe`; every other command is recorded in `calls`. */
function footerDeps(
  fileBody: string,
  probe: { code: number; stderr: string } | "throw" = { code: 0, stderr: "" },
): { deps: Deps; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    deps: fakeDeps({
      probeScriptPath: PROBE,
      readFileText: () => Promise.resolve(fileBody),
      runCmd: (cmd) => {
        if (cmd[0] === PROBE) {
          calls.push(cmd);
          if (probe === "throw") return Promise.reject(new Error("spawn ENOENT"));
          return Promise.resolve({ code: probe.code, stdout: "", stderr: probe.stderr });
        }
        calls.push(cmd);
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  };
}

Deno.test("edit-issue --body-file: replaces an earlier footer with exactly one naming --author, and does not pass --author to gh", async () => {
  const { deps, calls } = footerDeps("## Body\n\n🤖 Authored by agy — Gemini Flash\n");
  const code = await run(
    [...BASE, "--author", "Claude Code — Opus", "--body-file", "/tmp/b.md"],
    deps,
  );
  assertEquals(code, 0);
  const gh = calls.find((c) => c[0] === "gh")!;
  assertEquals(gh.includes("--author"), false);
  assertEquals(gh.includes("Claude Code — Opus"), false);
  const body = gh[gh.indexOf("--body") + 1];
  assertEquals(body.split("🤖 Authored by").length - 1, 1);
  assertEquals(body.trimEnd().endsWith("🤖 Authored by Claude Code — Opus"), true);
  assertEquals(gh.includes("--body-file"), false);
});

Deno.test("edit-issue --body: writes the footer onto an inline body", async () => {
  const { deps, calls } = footerDeps("");
  const code = await run(
    [...BASE, "--body", "Inline text", "--author", "Claude Code — Opus"],
    deps,
  );
  assertEquals(code, 0);
  const gh = calls.find((c) => c[0] === "gh")!;
  assertEquals(gh[gh.indexOf("--body") + 1], "Inline text\n\n🤖 Authored by Claude Code — Opus\n");
});

Deno.test("edit-issue: a body replacement with no --author is refused and edits nothing", async () => {
  const { deps, calls } = footerDeps("Body", {
    code: 1,
    stderr: "ERROR: --author '' does not name a model on the roster",
  });
  const code = await run([...BASE, "--body-file", "/tmp/b.md"], deps);
  assertEquals(code, 1);
  assertEquals(calls.filter((c) => c[0] === "gh").length, 0);
});

Deno.test("edit-issue: a body replacement with an author not on the roster is refused and edits nothing", async () => {
  const { deps, calls } = footerDeps("Body", {
    code: 1,
    stderr: "ERROR: --author 'Codex — GPT-6' does not name a model on the roster",
  });
  const code = await run([...BASE, "--author", "Codex — GPT-6", "--body", "x"], deps);
  assertEquals(code, 1);
  assertEquals(calls.filter((c) => c[0] === "gh").length, 0);
});

Deno.test("edit-issue: when the probe cannot run, the body edit is refused with the could-not-run message", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    for (const probe of ["throw", { code: 127, stderr: "not found" }] as const) {
      const { deps, calls } = footerDeps("Body", probe);
      const code = await run([...BASE, "--author", "Claude Code — Opus", "--body", "x"], deps);
      assertEquals(code, 1);
      assertEquals(calls.filter((c) => c[0] === "gh").length, 0);
    }
  } finally {
    console.error = orig;
  }
  assertEquals(errors.length, 2);
  for (const e of errors) assertEquals(e.includes("roster check could not run"), true);
});

Deno.test("edit-issue --add-label with no body flag and no --author succeeds and runs no roster probe", async () => {
  const { deps, calls } = footerDeps("Body");
  const code = await run([...BASE, "--add-label", "Haiku"], deps);
  assertEquals(code, 0);
  assertEquals(calls.filter((c) => c[0] === PROBE).length, 0);
});

// Every form the underlying gh command accepts for a body flag (web-jam-tools#1205).
const TEXT_FORMS: string[][] = [
  ["--body", "Inline text"],
  ["--body=Inline text"],
  ["-b", "Inline text"],
  ["-b=Inline text"],
  ["-bInline text"],
];
const FILE_FORMS: string[][] = [
  ["--body-file", "/tmp/b.md"],
  ["--body-file=/tmp/b.md"],
  ["-F", "/tmp/b.md"],
  ["-F=/tmp/b.md"],
  ["-F/tmp/b.md"],
];

for (const form of TEXT_FORMS) {
  Deno.test(`edit-issue ${form.join(" ")}: the body is roster-checked, gains the footer and reaches gh as --body`, async () => {
    const { deps, calls } = footerDeps("");
    const code = await run([...BASE, ...form, "--author", "Claude Code — Opus"], deps);
    assertEquals(code, 0);
    assertEquals(calls.filter((c) => c[0] === PROBE).length, 1);
    const gh = calls.find((c) => c[0] === "gh")!;
    assertEquals(gh.slice(-2), ["--body", "Inline text\n\n🤖 Authored by Claude Code — Opus\n"]);
    assertEquals(gh.filter((a) => a.startsWith("-b") || a.startsWith("--body=")), []);
  });
}

for (const form of FILE_FORMS) {
  Deno.test(`edit-issue ${form.join(" ")}: the file body is roster-checked, gains the footer and reaches gh as --body`, async () => {
    const { deps, calls } = footerDeps("## Body\n\n🤖 Authored by agy — Gemini Flash\n");
    const code = await run([...BASE, "--author", "Claude Code — Opus", ...form], deps);
    assertEquals(code, 0);
    assertEquals(calls.filter((c) => c[0] === PROBE).length, 1);
    const gh = calls.find((c) => c[0] === "gh")!;
    assertEquals(gh.slice(-2), ["--body", "## Body\n\n🤖 Authored by Claude Code — Opus\n"]);
    assertEquals(gh.filter((a) => a.startsWith("-F") || a.startsWith("--body-file")), []);
  });
}

for (const form of [...TEXT_FORMS, ...FILE_FORMS]) {
  Deno.test(`edit-issue ${form.join(" ")} with no --author is refused and edits nothing`, async () => {
    const { deps, calls } = footerDeps("Body", {
      code: 1,
      stderr: "ERROR: --author '' does not name a model on the roster",
    });
    const code = await run([...BASE, ...form], deps);
    assertEquals(code, 1);
    assertEquals(calls.filter((c) => c[0] === "gh").length, 0);
  });
}

Deno.test("edit-issue: a body given twice is refused before any probe or edit", async () => {
  for (
    const twice of [
      ["--body", "one", "-b", "two"],
      ["--body=one", "--body-file", "/tmp/b.md"],
      ["-F", "/tmp/b.md", "-F/tmp/c.md"],
    ]
  ) {
    const { deps, calls } = footerDeps("Body");
    const code = await run([...BASE, "--author", "Claude Code — Opus", ...twice], deps);
    assertEquals(code, 1);
    assertEquals(calls.length, 0);
  }
});

Deno.test("edit-issue: a body flag given last with no value is refused and edits nothing", async () => {
  for (const flag of ["--body", "-b", "--body-file", "-F"]) {
    const { deps, calls } = footerDeps("Body");
    const code = await run([...BASE, "--author", "Claude Code — Opus", flag], deps);
    assertEquals(code, 1);
    assertEquals(calls.length, 0);
  }
});

Deno.test("findBodyFlags: the value after a spaced flag is never read as a second flag", () => {
  assertEquals(findBodyFlags(["--body", "-b"]), [{ kind: "text", index: 0, span: 2, value: "-b" }]);
  assertEquals(findBodyFlags(["--add-label", "Haiku", "-F", "--body=x"]), [
    { kind: "file", index: 2, span: 2, value: "--body=x" },
  ]);
  assertEquals(findBodyFlags(["--add-label", "Haiku", "--title", "T"]), []);
});
