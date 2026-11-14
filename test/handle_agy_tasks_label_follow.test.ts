import { assertEquals, assertStringIncludes } from "@std/assert";
import { withSigningFixture } from "./support/codex_signing_fixture.ts";
import { AGY_IDENTITIES, withAgySigningFixture } from "./support/agy_signing_fixture.ts";

const script = new URL("../scripts/handle-agy-tasks.sh", import.meta.url).pathname;
let sequence = 0;
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "issue view" ]; then
  if [ -f "$TEST_EDITED" ] && [ "\${TEST_FAILURE:-}" = "unreadable" ]; then echo null; else cat "$TEST_ISSUE"; fi
elif [ "$1 $2" = "issue edit" ]; then
  if [ "\${TEST_FAILURE:-}" = "edit" ]; then echo "fixture edit failed" >&2; exit 1; fi
  touch "$TEST_EDITED"
  shift 3
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --add-label)
        jq --arg v "$2" '.labels = ((.labels + [{name:$v}]) | unique_by(.name))' "$TEST_ISSUE" > "$TEST_ISSUE.tmp"
        mv "$TEST_ISSUE.tmp" "$TEST_ISSUE"; shift 2 ;;
      --remove-label)
        if [ "\${TEST_FAILURE:-}" != "mismatch" ]; then
          jq --arg v "$2" '.labels |= map(select(.name != $v))' "$TEST_ISSUE" > "$TEST_ISSUE.tmp"
          mv "$TEST_ISSUE.tmp" "$TEST_ISSUE"
        fi
        shift 2 ;;
      *) shift ;;
    esac
  done
elif [ "$1" = "api" ]; then echo '[]'
elif [ "$1 $2" = "pr list" ]; then :
else echo "unexpected fixture gh call" >&2; exit 1
fi
`;

async function command(args: string[], cwd: string) {
  const result = await new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}

async function setupFixture(
  labels: string[],
  identity: Record<string, string>,
  author?: string,
  failure?: string,
) {
  const home = await Deno.makeTempDir({ prefix: "wjt-1468-" });
  const repo = `Fixture1468-${Deno.pid}-${sequence++}`;
  const cwd = `${home}/${repo}`;
  await Deno.mkdir(cwd);
  const issuePath = `${home}/issue.json`;
  await Deno.writeTextFile(
    issuePath,
    JSON.stringify({
      title: "Record working model",
      body: "Feature spec",
      comments: [],
      labels: labels.map((name) => ({ name })),
    }),
  );
  await Deno.writeTextFile(`${home}/gh`, fakeGh);
  await Deno.chmod(`${home}/gh`, 0o755);
  await command(["git", "init", "-b", "dev"], cwd);
  await command(["git", "config", "user.name", "Fixture"], cwd);
  await command(["git", "config", "user.email", "fixture@example.com"], cwd);
  await Deno.writeTextFile(`${cwd}/README.md`, "fixture\n");
  await command(["git", "add", "README.md"], cwd);
  await command(["git", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"], cwd);
  await command(["git", "remote", "add", "origin", cwd], cwd);
  const args = [script, "--setup-only"];
  if (author) args.push("--author", author);
  args.push(`${repo}#1468`);
  try {
    const result = await new Deno.Command("bash", {
      args,
      cwd,
      clearEnv: true,
      env: {
        HOME: home,
        PATH: `${home}:${Deno.env.get("PATH") ?? ""}`,
        DENO_DIR: Deno.env.get("DENO_DIR") ?? `${Deno.env.get("HOME")}/.cache/deno`,
        AGY_WEBJAM_ROOT: home,
        TEST_ISSUE: issuePath,
        TEST_EDITED: `${home}/edited`,
        TEST_FAILURE: failure ?? "",
        ...identity,
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      labels: JSON.parse(await Deno.readTextFile(issuePath)).labels.map((l: { name: string }) =>
        l.name
      ),
      branches: await command([
        "git",
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/agy/",
      ], cwd),
    };
  } finally {
    const worktrees = await command(["git", "worktree", "list", "--porcelain"], cwd);
    for (const match of worktrees.matchAll(/^worktree (.+)$/gm)) {
      if (match[1] !== cwd) await command(["git", "worktree", "remove", match[1]], cwd);
    }
    await Deno.remove(home, { recursive: true });
  }
}

async function withModel(
  model: string,
  test: (env: Record<string, string>, author?: string) => Promise<void>,
) {
  if (model === "Sol" || model === "Terra") {
    await withSigningFixture(async (_options, env, path) => {
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          type: "turn_context",
          payload: { model: `gpt-6.1-${model.toLowerCase()}` },
        }) + "\n",
      );
      // A contradictory typed author must never replace the recorded Codex model.
      await test(env, "Claude Code — Claude Haiku 5.5");
    });
  } else if (model === "Sonnet") {
    await test({ CLAUDE_CODE_SESSION_ID: "fixture" }, "Claude Code — Claude Sonnet 5.5");
  } else {
    const identity = AGY_IDENTITIES.find((value) => value.author.endsWith(model));
    if (!identity) throw new Error(`missing fixture ${model}`);
    await withAgySigningFixture(async (_options, env) => {
      await test(env, "agy — Gemini Hydrogen");
    }, identity);
  }
}

for (const lane of [["Sol", "Argon", "Hydrogen"], ["Terra", "Sonnet"]]) {
  for (const model of lane) {
    for (const label of lane) {
      Deno.test(`setup records ${model} working ${label} without a model override`, async () => {
        await withModel(model, async (env, author) => {
          const result = await setupFixture([label, "Josh", "bug"], env, author);
          assertEquals(result.code, 0, result.stderr);
          assertEquals(result.labels.sort(), [model, "Josh", "bug"].sort());
          assertStringIncludes(result.stdout, "=== GEMINI-TASK READY ===");
          assertStringIncludes(result.stdout, "Setup verified the author as");
          assertEquals(result.stdout.includes("This agy launch exports FORCED_PR_AUTHOR"), false);
          assertStringIncludes(result.branches, "agy/1468-");
        });
      });
    }
  }
}

for (const labels of [["Argon", "Hydrogen"], ["Sol", "Argon", "Hydrogen"], ["Terra", "Sonnet"]]) {
  Deno.test(`setup collapses optional lane labels ${labels.join("/")}`, async () => {
    const model = labels.includes("Terra") ? "Terra" : "Sol";
    await withModel(model, async (env, author) => {
      const result = await setupFixture([...labels, "Josh"], env, author);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(result.labels.sort(), [model, "Josh"].sort());
    });
  });
}

Deno.test("agy Sonnet uses its recorded identity for everyday-lane setup", async () => {
  await withAgySigningFixture(async (_options, env) => {
    const result = await setupFixture(["Terra", "Josh"], env, "agy — Gemini Argon");
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.labels.sort(), ["Sonnet", "Josh"].sort());
  }, AGY_IDENTITIES[1]);
});

for (const failure of ["edit", "unreadable", "mismatch"]) {
  Deno.test(`setup ${failure} label update refuses before any branch exists`, async () => {
    await withModel("Sol", async (env, author) => {
      const result = await setupFixture(["Argon", "Josh"], env, author, failure);
      assertEquals(result.code, 1);
      assertStringIncludes(result.stderr, "Refused setup for Fixture1468-");
      assertEquals(result.branches, "");
    });
  });
}

for (const labels of [["Terra"], ["Mystery", "Josh"], ["Sol", "Terra"]]) {
  Deno.test(`setup refuses labels ${labels.join("/")} before branching`, async () => {
    await withModel("Sol", async (env, author) => {
      const result = await setupFixture(labels, env, author);
      assertEquals(result.code, 1);
      assertEquals(result.branches, "");
      assertEquals(result.labels, labels);
      if (labels[0] === "Terra") assertStringIncludes(result.stderr, "ask Josh");
    });
  });
}

Deno.test("setup refuses absent or contradictory recorded identity before branching", async () => {
  const contexts: Record<string, string>[] = [
    {},
    { WJT_SURFACE: "agy" },
    { CODEX_THREAD_ID: "invalid" },
    { CODEX_THREAD_ID: "invalid", CLAUDE_CODE_SESSION_ID: "fixture" },
  ];
  for (const env of contexts) {
    const result = await setupFixture(["Sol"], env, "Codex — GPT-6.1 Sol");
    assertEquals(result.code, 1);
    assertEquals(result.branches, "");
  }
});
