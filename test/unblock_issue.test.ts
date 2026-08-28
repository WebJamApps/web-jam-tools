// unblock_issue.test.ts — web-jam-tools#839

import { assertEquals } from "@std/assert";
import { type Deps, parseArgs, run } from "../scripts/unblock-issue.ts";

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    runCmd: () => Promise.resolve({ code: 0, stdout: "[]", stderr: "" }),
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("unblock-issue: parseArgs parses options correctly", () => {
  const opts = parseArgs([
    "--repo",
    "WebJamApps/web-jam-tools",
    "--issue",
    "753",
    "--blocker",
    "737",
    "--dry-run",
  ]);
  assertEquals(opts.repo, "WebJamApps/web-jam-tools");
  assertEquals(opts.issue, 753);
  assertEquals(opts.blocker, 737);
  assertEquals(opts.dryRun, true);
});

Deno.test("unblock-issue: missing required args prints usage and exits 1", async () => {
  const code = await run(["--repo", "WebJamApps/web-jam-tools", "--issue", "753"], fakeDeps());
  assertEquals(code, 1);
});

Deno.test("unblock-issue: non-blocked target issue exits 1", async () => {
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "753", "--blocker", "737"],
    fakeDeps({
      runCmd: (cmd) => {
        if (cmd.join(" ").includes("dependencies/blocked_by")) {
          // No dependencies returned
          return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      },
    }),
  );
  assertEquals(code, 1);
});

Deno.test("unblock-issue: non-ancestor / sibling blocker is REFUSED with non-zero exit", async () => {
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "753", "--blocker", "748", "--dry-run"],
    fakeDeps({
      runCmd: (cmd) => {
        const cmdStr = cmd.join(" ");
        // 753 is blocked by sibling 748
        if (
          cmdStr.includes(
            "GET repos/WebJamApps/web-jam-tools/issues/753/dependencies/blocked_by",
          ) ||
          cmdStr.includes(
            "gh api repos/WebJamApps/web-jam-tools/issues/753/dependencies/blocked_by",
          )
        ) {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify([
              {
                id: 998877,
                number: 748,
                repository: { name: "web-jam-tools", owner: { login: "WebJamApps" } },
              },
            ]),
            stderr: "",
          });
        }
        // Ancestor traversal: 753's parent is 737
        if (cmdStr.includes("issue(number: 753)")) {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({
              data: {
                repository: {
                  issue: {
                    parent: {
                      number: 737,
                      repository: { name: "web-jam-tools", owner: { login: "WebJamApps" } },
                    },
                  },
                },
              },
            }),
            stderr: "",
          });
        }
        // 737 has no parent
        if (cmdStr.includes("issue(number: 737)")) {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({
              data: { repository: { issue: { parent: null } } },
            }),
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      },
    }),
  );
  assertEquals(code, 1);
});

Deno.test("unblock-issue: ancestor blocker with --dry-run is ACCEPTED without DELETE", async () => {
  let deleteCalled = false;
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "753", "--blocker", "737", "--dry-run"],
    fakeDeps({
      runCmd: (cmd) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("DELETE")) {
          deleteCalled = true;
        }
        // 753 is blocked by parent 737
        if (cmdStr.includes("dependencies/blocked_by")) {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify([
              {
                id: 11223344,
                number: 737,
                repository: { name: "web-jam-tools", owner: { login: "WebJamApps" } },
              },
            ]),
            stderr: "",
          });
        }
        // Ancestor traversal: 753's parent is 737
        if (cmdStr.includes("issue(number: 753)")) {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({
              data: {
                repository: {
                  issue: {
                    parent: {
                      number: 737,
                      repository: { name: "web-jam-tools", owner: { login: "WebJamApps" } },
                    },
                  },
                },
              },
            }),
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(deleteCalled, false);
});

Deno.test("unblock-issue: ancestor blocker executes DELETE and succeeds", async () => {
  let seenDeleteCmd: string[] = [];
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "753", "--blocker", "737"],
    fakeDeps({
      runCmd: (cmd) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("DELETE")) {
          seenDeleteCmd = cmd;
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }
        // 753 is blocked by parent 737
        if (cmdStr.includes("dependencies/blocked_by")) {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify([
              {
                id: 11223344,
                number: 737,
                repository: { name: "web-jam-tools", owner: { login: "WebJamApps" } },
              },
            ]),
            stderr: "",
          });
        }
        // Ancestor traversal: 753's parent is 737
        if (cmdStr.includes("issue(number: 753)")) {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({
              data: {
                repository: {
                  issue: {
                    parent: {
                      number: 737,
                      repository: { name: "web-jam-tools", owner: { login: "WebJamApps" } },
                    },
                  },
                },
              },
            }),
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(seenDeleteCmd, [
    "gh",
    "api",
    "--method",
    "DELETE",
    "repos/WebJamApps/web-jam-tools/issues/753/dependencies/blocked_by/11223344",
  ]);
});
