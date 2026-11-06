import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { run as block } from "../scripts/block-issue.ts";
import { type Deps, parseArgs, run as unblock } from "../scripts/unblock-issue.ts";
import type { CmdResult } from "../scripts/gh-write/gh_runner.ts";

const repo = "WebJamApps/web-jam-tools";
const endpoint = `repos/${repo}/issues/10/dependencies/blocked_by`;
const issue = { id: 100, number: 10, title: "Dependent issue" };
const blocker = { id: 200, number: 20, title: "Blocking issue" };
const baseArgs = ["--repo", repo, "--issue", "10", "--blocker", "20"];
const ok = (value: unknown): CmdResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const fail = (stderr: string): CmdResult => ({ code: 1, stdout: "", stderr });

type Runner = typeof block;
interface Fixture {
  linked?: boolean;
  args?: string[];
  reply?: (cmd: string[]) => CmdResult | undefined;
}

async function exercise(run: Runner, fixture: Fixture = {}) {
  const commands: string[][] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...values: unknown[]) => stdout.push(values.join(" "));
  console.error = (...values: unknown[]) => stderr.push(values.join(" "));
  const deps: Deps = {
    sleep: () => Promise.resolve(),
    runCmd: (cmd) => {
      commands.push(cmd);
      const override = fixture.reply?.(cmd);
      if (override) return Promise.resolve(override);
      if (cmd.includes("--method")) return Promise.resolve(ok({}));
      const path = cmd.at(-1)!;
      if (path === endpoint) return Promise.resolve(ok([fixture.linked ? [blocker] : []]));
      if (path === `repos/${repo}/issues/10`) return Promise.resolve(ok(issue));
      if (path === `repos/${repo}/issues/20`) return Promise.resolve(ok(blocker));
      throw new Error(`Unexpected command: ${cmd.join(" ")}`);
    },
  };
  try {
    const code = await run(fixture.args ?? baseArgs, deps);
    return {
      code,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
      commands,
      writes: commands.filter((cmd) => cmd.includes("--method")),
    };
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

Deno.test("dependency args accept separated and equals forms including cross-repository blockers", () => {
  assertEquals(parseArgs([...baseArgs, "--dry-run"]), {
    repo,
    issue: 10,
    blocker: "20",
    dryRun: true,
  });
  assertEquals(parseArgs([`--repo=${repo}`, "--issue=10", "--blocker=OtherOrg/widgets#20"]), {
    repo,
    issue: 10,
    blocker: "OtherOrg/widgets#20",
    dryRun: false,
  });
  assertThrows(() => parseArgs([...baseArgs, "--blocker", "30"]));
});

for (
  const [name, run, linked, method, undo] of [
    ["block", block, false, "POST", "unblock"],
    ["unblock", unblock, true, "DELETE", "block"],
  ] as const
) {
  Deno.test(`${name}: changes one named link, cites both titles and prints the exact undo`, async () => {
    const result = await exercise(run, { linked });
    assertEquals(result.code, 0);
    assertEquals(result.writes, [
      method === "POST"
        ? ["gh", "api", "--method", method, endpoint, "-F", "issue_id=200"]
        : ["gh", "api", "--method", method, `${endpoint}/200`],
    ]);
    assertStringIncludes(result.stdout, `${repo}#10 "Dependent issue"`);
    assertStringIncludes(result.stdout, `${repo}#20 "Blocking issue"`);
    assertStringIncludes(
      result.stdout,
      `Undo: deno task ${undo}-issue --repo ${repo} --issue 10 --blocker 20`,
    );
    assertEquals(result.commands.length, 4); // No parent/ancestor lookup.
  });

  Deno.test(`${name}: --dry-run describes the change without writing`, async () => {
    const result = await exercise(run, { linked, args: [...baseArgs, "--dry-run"] });
    assertEquals(result.code, 0);
    assertEquals(result.writes, []);
    assertStringIncludes(result.stdout, `dry run: would ${name === "block" ? "add" : "remove"}`);
    assertStringIncludes(result.stdout, `deno task ${undo}-issue`);
  });

  Deno.test(`${name}: opposite link state refuses, including in dry-run`, async () => {
    for (const args of [baseArgs, [...baseArgs, "--dry-run"]]) {
      const result = await exercise(run, { linked: !linked, args });
      assertEquals(result.code, 1);
      assertEquals(result.writes, []);
      assertStringIncludes(result.stderr, linked ? "is not blocked by" : "is already blocked by");
      assertEquals(result.stdout, "");
    }
  });

  Deno.test(`${name}: cross-repository IDs distinguish same-number issues and preserve undo scope`, async () => {
    const foreign = "OtherOrg/widgets";
    const foreignBlocker = { ...blocker, id: 900 };
    const result = await exercise(run, {
      args: [...baseArgs.slice(0, -1), `${foreign}#20`],
      reply: (cmd) => {
        if (cmd.at(-1) === `repos/${foreign}/issues/20`) return ok(foreignBlocker);
        if (cmd.at(-1) === endpoint) return ok([[blocker], linked ? [foreignBlocker] : []]);
      },
    });
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout, `${foreign}#20 "Blocking issue"`);
    assertStringIncludes(result.stdout, `--blocker ${foreign}#20`);
    assertEquals(
      result.writes[0],
      method === "POST"
        ? ["gh", "api", "--method", method, endpoint, "-F", "issue_id=900"]
        : ["gh", "api", "--method", method, `${endpoint}/900`],
    );
  });

  Deno.test(`${name}: a same-number dependency from another repository cannot establish this link`, async () => {
    const result = await exercise(run, {
      reply: (cmd) => cmd.at(-1) === endpoint ? ok([[{ ...blocker, id: 999 }]]) : undefined,
    });
    assertEquals(result.code, linked ? 1 : 0);
    assertEquals(result.writes.length, linked ? 0 : 1);
  });

  Deno.test(`${name}: reads every page before deciding whether the link exists`, async () => {
    const result = await exercise(run, {
      reply: (cmd) =>
        cmd.at(-1) === endpoint ? ok([[{ ...blocker, id: 999 }], [blocker]]) : undefined,
    });
    assertEquals(result.code, linked ? 0 : 1);
    assertEquals(result.writes.length, linked ? 1 : 0);
    assertEquals(result.commands[2], ["gh", "api", "--paginate", "--slurp", endpoint]);
  });

  Deno.test(`${name}: each failed lookup refuses without a mutation and retains GitHub errors`, async () => {
    for (const path of [`repos/${repo}/issues/10`, `repos/${repo}/issues/20`, endpoint]) {
      for (const dryRun of [false, true]) {
        const result = await exercise(run, {
          linked,
          args: dryRun ? [...baseArgs, "--dry-run"] : baseArgs,
          reply: (cmd) => cmd.at(-1) === path ? fail("gh: Not Found (HTTP 404)") : undefined,
        });
        assertEquals(result.code, 1);
        assertEquals(result.writes, []);
        assertStringIncludes(result.stderr, "gh: Not Found (HTTP 404)");
      }
    }
  });

  Deno.test(`${name}: invalid issue and dependency payloads refuse without mutations`, async () => {
    const badJson: CmdResult = { code: 0, stdout: "not JSON", stderr: "" };
    for (const path of [`repos/${repo}/issues/10`, `repos/${repo}/issues/20`, endpoint]) {
      const malformed = path === endpoint
        ? [null, {}, [], [null], [{}], [[null]], [[{ id: "200" }]], [[], {}], [[blocker], null]]
        : [
          null,
          [],
          {},
          { ...issue, id: 0 },
          { ...blocker, id: "200" },
          { ...blocker, title: null },
          { ...issue, number: 11 },
          { ...blocker, pull_request: {} },
        ];
      for (const response of [badJson, ...malformed.map(ok)]) {
        const result = await exercise(run, {
          linked,
          reply: (cmd) => cmd.at(-1) === path ? response : undefined,
        });
        assertEquals(result.code, 1);
        assertEquals(result.writes, []);
        assertStringIncludes(result.stderr.toLowerCase(), "unreadable");
      }
    }
  });

  Deno.test(`${name}: a thrown lookup error is a refusal`, async () => {
    const result = await exercise(run, {
      reply: () => {
        throw new Error("gh could not start");
      },
    });
    assertEquals(result.code, 1);
    assertEquals(result.writes, []);
    assertStringIncludes(result.stderr, "gh could not start");
  });

  Deno.test(`${name}: GitHub mutation refusal is returned with no success or undo`, async () => {
    const result = await exercise(run, {
      linked,
      reply: (cmd) =>
        cmd.includes("--method")
          ? fail("gh: dependency would create a cycle (HTTP 422)")
          : undefined,
    });
    assertEquals(result.code, 1);
    assertEquals(result.writes.length, 1);
    assertStringIncludes(result.stderr, "gh: dependency would create a cycle (HTTP 422)");
    assertEquals(result.stdout, "");
  });

  Deno.test(`${name}: invalid CLI input refuses before any GitHub call`, async () => {
    for (
      const args of [
        [],
        ["--repo", repo, "--issue", "10"],
        [...baseArgs, "--typo"],
        [...baseArgs, "--dry-run=false"],
        [...baseArgs, "--issue", "20"],
        ...["0", "-1", "1.5", "NaN", "1e2", "9007199254740993", "../20", "20?x=y"].flatMap(
          (
            bad,
          ) => [[...baseArgs.slice(0, -1), bad], [
            "--repo",
            repo,
            "--issue",
            bad,
            "--blocker",
            "20",
          ]],
        ),
        ["--repo", "../../bad", "--issue", "10", "--blocker", "20"],
        ["--repo", "OtherOrg/..", "--issue", "10", "--blocker", "20"],
        [...baseArgs.slice(0, -1), "OtherOrg/..#20"],
        [...baseArgs.slice(0, -1), "OtherOrg/widgets#0"],
        [...baseArgs.slice(0, -1), "OtherOrg/widgets#20/extra"],
        ["--repo", "--issue", "10", "--blocker", "20"],
      ]
    ) {
      const result = await exercise(run, { args });
      assertEquals(result.code, 1, JSON.stringify(args));
      assertEquals(result.commands, []);
      assertStringIncludes(result.stderr, `usage: deno task ${name}-issue`);
    }
  });

  Deno.test(`${name}: --help names the registered task and performs no lookup`, async () => {
    const result = await exercise(run, { args: ["--help"] });
    assertEquals(result.code, 0);
    assertEquals(result.commands, []);
    assertStringIncludes(result.stdout, `deno task ${name}-issue`);
  });
}

Deno.test("unblock: parent dependency uses the same removal path as an unrelated one", async () => {
  const result = await exercise(unblock, {
    linked: true,
    reply: (cmd) =>
      cmd.at(-1) === `repos/${repo}/issues/10`
        ? ok({ ...issue, parent_issue_url: `https://api.github.com/repos/${repo}/issues/20` })
        : undefined,
  });
  assertEquals(result.code, 0);
  assertEquals(result.writes[0].at(-1), `${endpoint}/200`);
});
