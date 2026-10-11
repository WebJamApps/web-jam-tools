// edit_issue.test.ts — web-jam-tools#685

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  PRIORITY_FIELD_ID,
  PRIORITY_FIELD_NODE_ID,
  PRIORITY_MAP,
} from "../src/create-issue/lib.ts";
import { LUNA_SIGNATURE, withSigningFixture } from "./support/codex_signing_fixture.ts";
import { type Deps, findBodyFlags, run } from "../scripts/edit-issue.ts";
import { variedFakeBody } from "./support/varied_fake_value.ts";

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    signing: { env: () => undefined },
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

Deno.test("signing edit l: dry run prints the looked-up Luna footer", () =>
  withSigningFixture(async (signing) => {
    const { deps, calls } = footerDeps("## Body\nContent");
    deps.signing = signing;
    const output: string[] = [];
    const log = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    try {
      assertEquals(
        await run([
          ...BASE,
          "--author",
          "Codex — GPT-6.1 Sol",
          "--body-file",
          "/tmp/b.md",
          "--dry-run",
        ], deps),
        0,
      );
    } finally {
      console.log = log;
    }
    assertEquals(output.join("\n").includes(`🤖 Authored by ${LUNA_SIGNATURE}`), true);
    assertEquals(output.join("\n").includes("🤖 Authored by Codex — GPT-6.1 Sol"), false);
    assertEquals(calls.some((cmd) => cmd[0] === "gh"), false);
  }));
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

/** Fake gh endpoints; unexpected calls fail instead of silently succeeding. */
function priorityDeps(level: string, override: Partial<Deps> = {}) {
  const calls: string[][] = [];
  const deps = fakeDeps({
    runCmd: (cmd) => {
      calls.push(cmd);
      let stdout: string;
      if (cmd[1] === "issue" && cmd[2] === "edit") stdout = "edited";
      else if (cmd.at(-1) === ".node_id") stdout = "I_test12\n";
      else if (cmd[2] === "graphql") {
        stdout = JSON.stringify({ data: { updateIssueFieldValue: { clientMutationId: null } } });
      } else if (cmd.at(-1) === ".issue_field_values") {
        stdout = JSON.stringify([
          { issue_field_name: "Other field", single_select_option: { name: "Urgent" } },
          { issue_field_id: PRIORITY_FIELD_ID, single_select_option: { name: level } },
        ]);
      } else throw new Error(`Unexpected command: ${cmd.join(" ")}`);
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    },
    ...override,
  });
  return { calls, deps };
}

async function capturedRun(args: string[], deps: Deps) {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  console.error = (...values: unknown[]) => errors.push(values.join(" "));
  try {
    return { code: await run(args, deps), logs, errors };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const PRIORITY_BASE = ["--repo", "WebJamApps/web-jam-tools", "--issue", "12"];
const PRIORITY_ENDPOINT = "repos/WebJamApps/web-jam-tools/issues/12";

Deno.test("edit-issue: the registered task sets, verifies and refuses a mismatch with a stub gh", async () => {
  const dir = await Deno.makeTempDir({ prefix: "edit-issue-priority-" });
  try {
    await Deno.writeTextFile(
      `${dir}/gh`,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$1 $2" >> "$EDIT_ISSUE_CALLS"',
        'case "$*" in',
        '  *".node_id") printf "%s\\n" "I_test12" ;;',
        '  *".issue_field_values") printf \'[{"issue_field_name":"Priority","single_select_option":{"name":"%s"}}]\\n\' "$EDIT_ISSUE_LEVEL" ;;',
        '  "api graphql "*) printf \'%s\\n\' \'{"data":{"updateIssueFieldValue":{"clientMutationId":null}}}\' ;;',
        "  *) exit 2 ;;",
        "esac",
      ].join("\n") + "\n",
    );
    await Deno.chmod(`${dir}/gh`, 0o755);
    for (const actual of ["High", "Medium"]) {
      const callsPath = `${dir}/calls-${actual}`;
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["task", "edit-issue", ...PRIORITY_BASE, "--priority", "High"],
        env: {
          PATH: `${dir}:${Deno.env.get("PATH") ?? ""}`,
          EDIT_ISSUE_CALLS: callsPath,
          EDIT_ISSUE_LEVEL: actual,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);
      assertEquals(result.code, actual === "High" ? 0 : 1, stderr);
      assertEquals((await Deno.readTextFile(callsPath)).trim().split("\n"), [
        `api ${PRIORITY_ENDPOINT}`,
        "api graphql",
        `api ${PRIORITY_ENDPOINT}`,
      ]);
      if (actual === "High") assertStringIncludes(stdout, "read-back verified");
      else {
        assertStringIncludes(stderr, 'expected "High", got "Medium"');
        assertEquals(stdout.includes("read-back verified"), false);
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("edit-issue: refuses duplicate Priority flags before any call", async () => {
  const { calls, deps } = priorityDeps("High");
  for (const values of [["Critical", "High"], ["High", "Low"]]) {
    assertEquals(
      (await capturedRun([
        ...PRIORITY_BASE,
        "--priority",
        values[0],
        `--priority=${values[1]}`,
      ], deps)).code,
      1,
    );
  }
  assertEquals(calls, []);
});

Deno.test("edit-issue: a literal --priority body value still passes through with its footer", async () => {
  for (const body of ["--priority", "--priority=High"]) {
    const { calls, deps } = footerDeps("");
    const result = await capturedRun(
      [...BASE, "--author", "Claude Code — Opus", "--body", body],
      deps,
    );
    assertEquals(result.code, 0);
    const gh = calls.find((cmd) => cmd[0] === "gh")!;
    assertEquals(gh[gh.indexOf("--body") + 1], `${body}\n\n🤖 Authored by Claude Code — Opus\n`);
    assertEquals(calls.filter((cmd) => cmd[1] === "api"), []);
  }
});

Deno.test("edit-issue: combining a body replacement and Priority retains the editing author footer", async () => {
  const { calls, deps } = priorityDeps("High");
  const runner = deps.runCmd;
  deps.probeScriptPath = PROBE;
  deps.runCmd = (cmd) =>
    cmd[0] === PROBE ? Promise.resolve({ code: 0, stdout: "", stderr: "" }) : runner(cmd);
  const result = await capturedRun([
    ...PRIORITY_BASE,
    "--body",
    "Replacement",
    "--author",
    "Claude Code — Opus",
    "--priority",
    "High",
  ], deps);
  assertEquals(result.code, 0);
  assertEquals(
    calls[0][calls[0].indexOf("--body") + 1],
    "Replacement\n\n🤖 Authored by Claude Code — Opus\n",
  );
  assertEquals(calls.length, 4);
});

Deno.test("edit-issue: a missing or unreadable node ID stops before the Priority mutation", async () => {
  for (const node of ["", "null", 'unsafe"node', "failure", "throw"]) {
    const calls: string[][] = [];
    const deps = fakeDeps({
      runCmd: (cmd) => {
        calls.push(cmd);
        if (node === "throw") return Promise.reject(new Error("gh unavailable"));
        return Promise.resolve({
          code: node === "failure" ? 1 : 0,
          stdout: node,
          stderr: "denied",
        });
      },
    });
    const result = await capturedRun([...PRIORITY_BASE, "--priority", "High"], deps);
    assertEquals(result.code, 1);
    assertEquals(calls.length, 1);
    assertStringIncludes(result.errors.join("\n"), "Priority High for WebJamApps/web-jam-tools#12");
  }
});

Deno.test("edit-issue: invalid or absent mutation responses and thrown field calls fail closed", async () => {
  for (
    const response of [
      "invalid JSON",
      "null",
      "{}",
      '{"data":{"updateIssueFieldValue":null}}',
      "throw",
    ]
  ) {
    const { deps } = priorityDeps("High");
    const runner = deps.runCmd;
    deps.runCmd = (cmd) => {
      if (cmd[2] !== "graphql") return runner(cmd);
      if (response === "throw") return Promise.reject(new Error("gh unavailable"));
      return Promise.resolve({ code: 0, stdout: response, stderr: "" });
    };
    const result = await capturedRun([...PRIORITY_BASE, "--priority", "High"], deps);
    assertEquals(result.code, 1);
    assertEquals(result.logs, []);
  }
});

Deno.test("edit-issue: transient Priority failures retry and verify the native field by name", async () => {
  const { calls, deps } = priorityDeps("High");
  const runner = deps.runCmd;
  let attempts = 0;
  deps.runCmd = (cmd) => {
    if (cmd[2] === "graphql" && ++attempts === 1) {
      return Promise.resolve({ code: 1, stdout: "", stderr: "i/o timeout" });
    }
    if (cmd.at(-1) === ".issue_field_values") {
      return Promise.resolve({
        code: 0,
        stdout: '[{"issue_field_name":"Priority","single_select_option":{"name":"High"}}]',
        stderr: "",
      });
    }
    return runner(cmd);
  };
  assertEquals((await capturedRun([...PRIORITY_BASE, "--priority", "High"], deps)).code, 0);
  assertEquals(attempts, 2);
  assertEquals(calls.length, 2);
});

for (const level of ["Urgent", "High", "Medium", "Low"]) {
  Deno.test(`edit-issue: sets and verifies native Priority ${level}`, async () => {
    const { calls, deps } = priorityDeps(level);
    const result = await capturedRun([...PRIORITY_BASE, "--priority", level], deps);
    assertEquals(result.code, 0);
    assertEquals(calls.length, 3);
    assertEquals(calls[0], ["gh", "api", PRIORITY_ENDPOINT, "--jq", ".node_id"]);
    assertEquals(calls[1].slice(0, 4), ["gh", "api", "graphql", "-f"]);
    assertStringIncludes(calls[1][4], "updateIssueFieldValue");
    assertStringIncludes(calls[1][4], 'issueId: "I_test12"');
    assertStringIncludes(calls[1][4], `fieldId: "${PRIORITY_FIELD_NODE_ID}"`);
    assertStringIncludes(
      calls[1][4],
      `singleSelectOptionId: "${PRIORITY_MAP[level.toLowerCase()].node_id}"`,
    );
    assertEquals(calls[2], ["gh", "api", PRIORITY_ENDPOINT, "--jq", ".issue_field_values"]);
    assertStringIncludes(result.logs.join("\n"), `Priority to ${level}; read-back verified`);
    assertEquals(result.errors, []);
  });
}

for (const value of ["urgent", "Critical", "", "--dry-run"]) {
  Deno.test(`edit-issue: refuses invalid Priority ${JSON.stringify(value)} before any call`, async () => {
    const { calls, deps } = priorityDeps("High");
    const result = await capturedRun([
      ...PRIORITY_BASE,
      "--add-label",
      "Sol",
      "--body",
      "body",
      "--priority",
      value,
    ], deps);
    assertEquals(result.code, 1);
    assertEquals(calls, []);
    assertStringIncludes(result.errors.join("\n"), "Urgent, High, Medium or Low");
  });
}

Deno.test("edit-issue: refuses --priority without a value before any call", async () => {
  const { calls, deps } = priorityDeps("High");
  const result = await capturedRun([...PRIORITY_BASE, "--priority"], deps);
  assertEquals(result.code, 1);
  assertEquals(calls, []);
});

Deno.test("edit-issue: --priority=High is consumed rather than passed to gh", async () => {
  const { calls, deps } = priorityDeps("High");
  assertEquals((await capturedRun([...PRIORITY_BASE, "--priority=High"], deps)).code, 0);
  assertEquals(calls.length, 3);
});

Deno.test("edit-issue: a combined Priority and label edit reports both", async () => {
  const { calls, deps } = priorityDeps("High");
  const result = await capturedRun([
    ...PRIORITY_BASE,
    "--priority",
    "High",
    "--add-label",
    "Sol",
  ], deps);
  assertEquals(result.code, 0);
  assertEquals(calls[0], [
    "gh",
    "issue",
    "edit",
    "12",
    "--repo",
    "WebJamApps/web-jam-tools",
    "--add-label",
    "Sol",
  ]);
  assertEquals(calls.length, 4);
  assertStringIncludes(result.logs.join("\n"), "via gh issue edit");
  assertStringIncludes(result.logs.join("\n"), "Priority to High; read-back verified");
});

Deno.test("edit-issue: Priority dry runs preview both edits without any call", async () => {
  for (const extra of [[], ["--add-label", "Sol"]]) {
    const { calls, deps } = priorityDeps("High");
    const result = await capturedRun([
      ...PRIORITY_BASE,
      "--priority",
      "High",
      ...extra,
      "--dry-run",
    ], deps);
    assertEquals(result.code, 0);
    assertEquals(calls, []);
    assertStringIncludes(result.logs.join("\n"), "Priority to High and read it back");
    assertEquals(result.logs.length, extra.length ? 2 : 1);
  }
});

Deno.test("edit-issue: field failure names the target and requested Priority", async () => {
  const { deps } = priorityDeps("High");
  const runner = deps.runCmd;
  const calls: string[][] = [];
  deps.runCmd = (cmd) => {
    calls.push(cmd);
    return cmd[2] === "graphql"
      ? Promise.resolve({ code: 1, stdout: "", stderr: "field denied" })
      : runner(cmd);
  };
  const result = await capturedRun([...PRIORITY_BASE, "--priority", "High"], deps);
  assertEquals(result.code, 1);
  assertEquals(calls.length, 2);
  assertStringIncludes(result.errors.join("\n"), "Priority High for WebJamApps/web-jam-tools#12");
  assertStringIncludes(result.errors.join("\n"), "field call failed");
  assertEquals(result.logs, []);
});

Deno.test("edit-issue: a mismatched Priority read-back refuses verified success", async () => {
  const { deps } = priorityDeps("Medium");
  const result = await capturedRun([...PRIORITY_BASE, "--priority", "High"], deps);
  assertEquals(result.code, 1);
  assertStringIncludes(result.errors.join("\n"), 'expected "High", got "Medium"');
  assertEquals(result.logs, []);
});

for (const failure of ["command", "throw", "invalid JSON", "null", "{}", "[]"]) {
  Deno.test(`edit-issue: refuses Priority verification when read-back is ${failure}`, async () => {
    const { deps } = priorityDeps("High");
    const runner = deps.runCmd;
    deps.runCmd = (cmd) => {
      if (cmd.at(-1) !== ".issue_field_values") return runner(cmd);
      if (failure === "throw") return Promise.reject(new Error("gh unavailable"));
      return Promise.resolve({
        code: failure === "command" ? 1 : 0,
        stdout: failure,
        stderr: "denied",
      });
    };
    const result = await capturedRun([...PRIORITY_BASE, "--priority", "High"], deps);
    assertEquals(result.code, 1);
    assertStringIncludes(result.errors.join("\n"), failure === "[]" ? 'got "none"' : "unverified");
    assertEquals(result.logs, []);
  });
}

Deno.test("edit-issue: GraphQL errors with exit zero still fail the Priority edit", async () => {
  const { deps } = priorityDeps("High");
  const runner = deps.runCmd;
  deps.runCmd = (cmd) =>
    cmd[2] === "graphql"
      ? Promise.resolve({ code: 0, stdout: '{"errors":[{"message":"denied"}]}', stderr: "" })
      : runner(cmd);
  assertEquals((await capturedRun([...PRIORITY_BASE, "--priority", "High"], deps)).code, 1);
});

Deno.test("edit-issue: combined edit failures stop or report partial success", async () => {
  for (const failEdit of [true, false]) {
    const { deps } = priorityDeps("High");
    const runner = deps.runCmd;
    const calls: string[][] = [];
    deps.runCmd = (cmd) => {
      calls.push(cmd);
      if ((failEdit && cmd[1] === "issue") || (!failEdit && cmd[2] === "graphql")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "denied" });
      }
      return runner(cmd);
    };
    const result = await capturedRun([
      ...PRIORITY_BASE,
      "--priority",
      "High",
      "--add-label",
      "Sol",
    ], deps);
    assertEquals(result.code, 1);
    assertEquals(calls.length, failEdit ? 1 : 3);
    assertEquals(result.logs.length, failEdit ? 0 : 1);
    assertEquals(result.logs.some((line) => line.includes("read-back verified")), false);
  }
});

Deno.test("edit-issue: Priority leaves empty-body, author and credential guards in place", async () => {
  for (
    const extra of [
      ["--body", ""],
      ["--body", "replacement without author"],
      ["--title", "AIza" + variedFakeBody(35, 71)],
    ]
  ) {
    const { calls, deps } = priorityDeps("High");
    assertEquals(
      (await capturedRun([...PRIORITY_BASE, "--priority", "High", ...extra], deps)).code,
      1,
    );
    assertEquals(calls.filter((cmd) => cmd[0] === "gh"), []);
  }
});

Deno.test("edit-issue: refuses unsafe Priority targets before any call", async () => {
  for (
    const [repo, issue] of [
      ["WebJamApps/web-jam-tools/extra", "12"],
      ["WebJamApps/web-jam-tools", "-12"],
      ["WebJamApps/web-jam-tools", "1.5"],
      ["WebJamApps/web-jam-tools", "NaN"],
    ]
  ) {
    const { calls, deps } = priorityDeps("High");
    const result = await capturedRun(
      ["--repo", repo, "--issue", issue, "--priority", "High"],
      deps,
    );
    assertEquals(result.code, 1);
    assertEquals(calls, []);
  }
});
