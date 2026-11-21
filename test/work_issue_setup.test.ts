import { assertEquals, assertRejects } from "@std/assert";
import { recordWorkingModel, type SetupDeps } from "../scripts/work-issue-setup.ts";

const author = "Claude Code — Opus";
const repo = "web-jam-tools";
const issue = "123";

function setupFixture(initialLabels: string[], labelsAfterEdit: string[]) {
  const edits: string[][] = [];
  let views = 0;
  const deps: SetupDeps = {
    signing: { env: () => undefined },
    run: (args) => {
      let stdout = "";
      switch (args[0]) {
        case "bash":
          assertEquals(args.slice(-2), ["--author-label", author]);
          stdout = "Opus\n";
          break;
        case "gh": {
          const labels = views++ === 0 ? initialLabels : labelsAfterEdit;
          stdout = JSON.stringify({ labels: labels.map((name) => ({ name })) });
          break;
        }
        case "deno":
          edits.push(args.slice(args.indexOf("edit-issue")));
          break;
        default:
          throw new Error(`Unexpected command: ${args[0]}`);
      }
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    },
  };
  return { deps, edits };
}

Deno.test("work-issue setup records Opus on Sol work and preserves non-model labels", async () => {
  const { deps, edits } = setupFixture(["Sol", "Needs Design"], ["Needs Design", "Opus"]);
  assertEquals(await recordWorkingModel(repo, issue, author, deps), author);
  assertEquals(edits, [[
    "edit-issue",
    "--repo",
    "WebJamApps/web-jam-tools",
    "--issue",
    issue,
    "--add-label",
    "Opus",
    "--remove-label",
    "Sol",
  ]]);
});

Deno.test("work-issue setup refuses an out-of-lane model and invalid mixed lanes before editing", async () => {
  for (
    const [labels, error] of [
      [["Hydrogen"], "ask Josh before overriding the lane"],
      [["Sol", "Hydrogen"], "forbidden model-label combination"],
      [["Fable"], "ask Josh before overriding the lane"],
    ] as const
  ) {
    const { deps, edits } = setupFixture([...labels], []);
    await assertRejects(() => recordWorkingModel(repo, issue, author, deps), Error, error);
    assertEquals(edits, []);
  }
});

Deno.test("work-issue setup refuses an unverified working-model relabel", async () => {
  const { deps, edits } = setupFixture(["Sol", "Needs Design"], ["Opus"]);
  await assertRejects(
    () => recordWorkingModel(repo, issue, author, deps),
    Error,
    "working-model label update could not be verified",
  );
  assertEquals(edits.length, 1);
});
