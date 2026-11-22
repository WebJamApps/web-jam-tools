/**
 * test/fix_run.test.ts
 *
 * Tests for agy conversation binding in `readTypedSkillCall()` and `resolveAntigravityWriteContext(true)`
 * across all 12 cases of web-jam-tools#1845 ("How the command reads what Josh typed").
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { readTypedSkillCall } from "../hooks/lib/fix_run.ts";
import { runPush } from "../scripts/push.ts";
import { resolveAntigravityWriteContext } from "../scripts/write_issue_approval_token.ts";

const DENO_CONFIG_PATH = new URL("../deno.json", import.meta.url).pathname;

function agyTranscriptLine(text: string, stepIndex = 0): string {
  return JSON.stringify({
    type: "USER_INPUT",
    timestamp: "2026-11-18T01:10:57.943Z",
    source: "USER_EXPLICIT",
    step_index: stepIndex,
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
  });
}

interface AgyHarness {
  root: string;
  brainRoot: string;
  convATranscript: string;
  convBTranscript: string;
  recordPath: string;
  subagentMarker: string;
  cleanup: () => Promise<void>;
}

async function setupAgyHarness(): Promise<AgyHarness> {
  const root = await Deno.makeTempDir({ prefix: "fix-run-1845-" });
  const brainRoot = join(root, ".gemini", "antigravity-cli", "brain");
  const convATranscript = join(
    brainRoot,
    "conv-a",
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
  const convBTranscript = join(
    brainRoot,
    "conv-b",
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
  const subagentsDir = join(brainRoot, "conv-p", ".system_generated", "subagents");
  const subagentMarker = join(subagentsDir, "conv-a.json");
  const recordPath = join(root, "agy-hook-invocations.jsonl");

  await Deno.mkdir(join(brainRoot, "conv-a", ".system_generated", "logs"), { recursive: true });
  await Deno.mkdir(join(brainRoot, "conv-b", ".system_generated", "logs"), { recursive: true });
  await Deno.mkdir(subagentsDir, { recursive: true });

  await Deno.writeTextFile(
    convATranscript,
    `${agyTranscriptLine("/fix-pr web-jam-tools#1318")}\n`,
  );
  await Deno.writeTextFile(
    convBTranscript,
    `${agyTranscriptLine("/fix-pr web-jam-tools#9999")}\n`,
  );

  return {
    root,
    brainRoot,
    convATranscript,
    convBTranscript,
    recordPath,
    subagentMarker,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

function makeEnvReader(
  values: Record<string, string | undefined>,
): (name: string) => string | undefined {
  return (name: string) => values[name];
}

async function runPushSubprocess(
  repoDir: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["task", "--config", DENO_CONFIG_PATH, "push", "--repo-dir", repoDir, ...args],
    cwd: repoDir,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function setupPushRepo(root: string): Promise<{
  repoDir: string;
  bareDir: string;
  shellEnvBase: Record<string, string>;
  git: (args: string[], cwd?: string) => Promise<string>;
}> {
  const bareDir = join(root, "origin.git");
  const repoDir = join(root, "repo");
  const binDir = join(root, "bin");
  await Deno.mkdir(bareDir, { recursive: true });
  await Deno.mkdir(repoDir, { recursive: true });
  await Deno.mkdir(binDir, { recursive: true });

  const git = async (args: string[], cwd = repoDir): Promise<string> => {
    const out = await new Deno.Command("git", {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`);
    }
    return new TextDecoder().decode(out.stdout).trim();
  };

  await git(["init", "--bare", "--initial-branch=dev", bareDir], root);
  await git(["clone", bareDir, repoDir], root);
  await git(["config", "user.email", "probe@example.com"]);
  await git(["config", "user.name", "Probe"]);
  await Deno.writeTextFile(join(repoDir, "README.md"), "init\n");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "init"]);
  await git(["push", "-u", "origin", "dev"]);
  await git(["checkout", "-b", "probe-branch"]);
  await Deno.writeTextFile(join(repoDir, "file.txt"), "first\n");
  await git(["add", "file.txt"]);
  await git(["commit", "-m", "first"]);
  await git(["push", "-u", "origin", "probe-branch"]);
  await Deno.writeTextFile(join(repoDir, "file.txt"), "rewritten\n");
  await git(["commit", "--amend", "-am", "rewritten"]);

  const realGit = (Deno.env.get("PATH") ?? "")
    .split(":")
    .map((dir) => `${dir}/git`)
    .find((candidate) => {
      try {
        return Deno.statSync(candidate).isFile;
      } catch {
        return false;
      }
    });
  if (!realGit) throw new Error("git binary not found");
  const quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`;
  await Deno.writeTextFile(
    join(binDir, "git"),
    '#!/bin/sh\nif [ "$1" = remote ] && [ "$2" = get-url ]; then\n' +
      '  printf "%s\\n" "https://github.com/WebJamApps/web-jam-tools.git"\n  exit 0\nfi\n' +
      `exec ${quotedGit} "$@"\n`,
  );
  await Deno.writeTextFile(
    join(binDir, "gh"),
    '#!/bin/sh\nif [ "$1" = pr ] && [ "$2" = comment ]; then exit 0; fi\n' +
      'printf "%s\\n" \'{"number":1318,"state":"OPEN","headRefName":"probe-branch","headRepository":{"nameWithOwner":"WebJamApps/web-jam-tools"},"isCrossRepository":false}\'\n',
  );
  await Deno.chmod(join(binDir, "git"), 0o755);
  await Deno.chmod(join(binDir, "gh"), 0o755);
  await Deno.writeTextFile(join(repoDir, "c.md"), "Fixed.\n\n🤖 Fixed by agy — Gemini Hydrogen\n");

  return {
    repoDir,
    bareDir,
    git,
    shellEnvBase: {
      PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
      HOME: root,
      WJT_SURFACE: "agy",
      AGY_MODEL_NAME: "gemini-4-hydrogen-high",
      CODEX_THREAD_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      WJT_UNATTENDED: "",
    },
  };
}

Deno.test("web-jam-tools#1845: all 12 agy strict conversation-binding cases in readTypedSkillCall and deno task push", async () => {
  const harness = await setupAgyHarness();
  try {
    const repo = await setupPushRepo(harness.root);
    const convARow = JSON.stringify({
      conversationId: "conv-a",
      transcriptPath: harness.convATranscript,
      modelName: "gemini-4-hydrogen-high",
    });
    const convBRow = JSON.stringify({
      conversationId: "conv-b",
      transcriptPath: harness.convBTranscript,
      modelName: "gemini-4-hydrogen-high",
    });
    const gmailProbeRow = JSON.stringify({
      timestamp: "2026-11-18T01:10:57.943Z",
      event: "PreToolUse",
      matcher: ".*",
      targetHookPath: "/home/joshua/.claude/hooks/block-agy-gmail-send-delete.sh",
      toolCall: { name: "run_command" },
    });
    const testRow = JSON.stringify({
      conversationId: null,
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: "bash /tmp/private-folder-guard-x/shell-syntax-2.sh",
          Cwd: "/tmp",
        },
      },
    });

    interface CaseSpec {
      id: number;
      name: string;
      recordLines: string[] | null;
      conversationId?: string;
      transcriptPath?: string;
      subagent?: boolean;
      expectAllowed: boolean;
    }

    const cases: CaseSpec[] = [
      {
        id: 1,
        name: "conv-a row then Gmail probe row last",
        recordLines: [convARow, gmailProbeRow],
        conversationId: "conv-a",
        transcriptPath: harness.convATranscript,
        expectAllowed: true,
      },
      {
        id: 2,
        name: "conv-a row then conv-b row last",
        recordLines: [convARow, convBRow],
        conversationId: "conv-a",
        transcriptPath: harness.convATranscript,
        expectAllowed: true,
      },
      {
        id: 3,
        name: "conv-a row then null-conversationId test row last",
        recordLines: [convARow, testRow],
        conversationId: "conv-a",
        transcriptPath: harness.convATranscript,
        expectAllowed: true,
      },
      {
        id: 4,
        name: "AGY_CONVERSATION_ID unset",
        recordLines: [convARow],
        conversationId: undefined,
        transcriptPath: harness.convATranscript,
        expectAllowed: false,
      },
      {
        id: 5,
        name: "AGY_CONVERSATION_ID empty",
        recordLines: [convARow],
        conversationId: "",
        transcriptPath: harness.convATranscript,
        expectAllowed: false,
      },
      {
        id: 6,
        name: "AGY_TRANSCRIPT_PATH unset",
        recordLines: [convARow],
        conversationId: "conv-a",
        transcriptPath: undefined,
        expectAllowed: false,
      },
      {
        id: 7,
        name: "only conv-b rows in record",
        recordLines: [convBRow],
        conversationId: "conv-a",
        transcriptPath: harness.convATranscript,
        expectAllowed: false,
      },
      {
        id: 8,
        name: "conv-a row pointing to conv-b transcript",
        recordLines: [
          JSON.stringify({
            conversationId: "conv-a",
            transcriptPath: harness.convBTranscript,
            modelName: "gemini-4-hydrogen-high",
          }),
        ],
        conversationId: "conv-a",
        transcriptPath: harness.convATranscript,
        expectAllowed: false,
      },
      {
        id: 9,
        name: "conv-a row and {broken line",
        recordLines: [convARow, "{broken"],
        conversationId: "conv-a",
        transcriptPath: harness.convATranscript,
        expectAllowed: false,
      },
      {
        id: 10,
        name: "conv-a row and [] line",
        recordLines: [convARow, "[]"],
        conversationId: "conv-a",
        transcriptPath: harness.convATranscript,
        expectAllowed: false,
      },
      {
        id: 11,
        name: "no record file at AGY_HOOK_RECORD_PATH",
        recordLines: null,
        conversationId: "conv-a",
        transcriptPath: harness.convATranscript,
        expectAllowed: false,
      },
      {
        id: 12,
        name: "conv-a row where conv-a is a helper under brain/conv-p/.system_generated/subagents",
        recordLines: [convARow],
        conversationId: "conv-a",
        transcriptPath: harness.convATranscript,
        subagent: true,
        expectAllowed: false,
      },
    ];

    for (const c of cases) {
      if (c.recordLines === null) {
        try {
          await Deno.remove(harness.recordPath);
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        }
      } else {
        await Deno.writeTextFile(harness.recordPath, c.recordLines.join("\n") + "\n");
      }

      if (c.subagent) {
        await Deno.writeTextFile(harness.subagentMarker, "{}");
      } else {
        try {
          await Deno.remove(harness.subagentMarker);
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        }
      }

      const envReader = makeEnvReader({
        AGY_HOOK_RECORD_PATH: harness.recordPath,
        AGY_CONVERSATION_ID: c.conversationId,
        AGY_TRANSCRIPT_PATH: c.transcriptPath,
      });

      const call = await readTypedSkillCall(envReader);
      if (c.expectAllowed) {
        assertEquals(call?.name, "fix-pr", `case ${c.id} (${c.name})`);
        assertEquals(call?.arguments, "web-jam-tools#1318", `case ${c.id} (${c.name})`);
      } else {
        assertEquals(call, null, `case ${c.id} (${c.name}) must find no typed call`);
      }

      const childEnv: Record<string, string> = {
        ...repo.shellEnvBase,
        AGY_HOOK_RECORD_PATH: harness.recordPath,
      };
      if (c.conversationId !== undefined) childEnv.AGY_CONVERSATION_ID = c.conversationId;
      if (c.transcriptPath !== undefined) childEnv.AGY_TRANSCRIPT_PATH = c.transcriptPath;

      if (c.expectAllowed) {
        if (c.id === 3) {
          // Signing (scripts/running-model.ts) is out of scope here and rejects null-conversationId
          // rows until its own issue lands, so exercise runPush's fix-run path directly.
          let pushed = false;
          const code = await runPush(
            ["--force-with-lease", "--fix-comment", "c.md"],
            repo.repoDir,
            {
              branch: "probe-branch",
              readSkillCall: () => readTypedSkillCall(envReader),
              runGit: () =>
                Promise.resolve({
                  code: 0,
                  stdout: "https://github.com/WebJamApps/web-jam-tools.git",
                }),
              lookupPullRequest: () =>
                Promise.resolve({
                  number: 1318,
                  state: "OPEN",
                  headRefName: "probe-branch",
                  headRepository: { nameWithOwner: "WebJamApps/web-jam-tools" },
                  isCrossRepository: false,
                }),
              signing: { env: () => undefined },
              prepareComment: () => Promise.resolve(),
              postComment: () => Promise.resolve(0),
              confirmForce: () => {
                throw new Error("active fix must never ask");
              },
              spawnPush: () => {
                pushed = true;
                return Promise.resolve(0);
              },
            },
          );
          assertEquals(code, 0, `case 3 (${c.name})`);
          assertEquals(pushed, true, `case 3 (${c.name})`);
        } else {
          await Deno.writeTextFile(join(repo.repoDir, "file.txt"), `case ${c.id}\n`);
          await repo.git(["commit", "--amend", "-am", `case ${c.id}`]);
          const res = await runPushSubprocess(
            repo.repoDir,
            ["--force-with-lease", "--fix-comment", "c.md"],
            childEnv,
          );
          assertEquals(res.code, 0, `case ${c.id} (${c.name}) stderr: ${res.stderr}`);
        }
      } else {
        const before = await repo.git(["ls-remote", "origin"]);
        let localPushed = false;
        const localCode = await runPush(["--force-with-lease"], repo.repoDir, {
          branch: "probe-branch",
          readSkillCall: () => readTypedSkillCall(envReader),
          runGit: () =>
            Promise.resolve({ code: 0, stdout: "https://github.com/WebJamApps/web-jam-tools.git" }),
          lookupPullRequest: () =>
            Promise.resolve({
              number: 1318,
              state: "OPEN",
              headRefName: "probe-branch",
              headRepository: { nameWithOwner: "WebJamApps/web-jam-tools" },
              isCrossRepository: false,
            }),
          signing: { env: () => undefined },
          confirmForce: () => false,
          spawnPush: () => {
            localPushed = true;
            return Promise.resolve(0);
          },
        });
        assertEquals(localCode, 1, `case ${c.id} (${c.name}) must stay outside fix run`);
        assertEquals(localPushed, false, `case ${c.id} (${c.name}) must not push`);

        const res = await runPushSubprocess(
          repo.repoDir,
          ["--force-with-lease"],
          childEnv,
        );
        assertEquals(res.code, 1, `case ${c.id} (${c.name}) must stay outside fix run`);
        assertStringIncludes(res.stderr, "Refused (");
        assertEquals(await repo.git(["ls-remote", "origin"]), before);
      }
    }
  } finally {
    await harness.cleanup();
  }
});

Deno.test("resolveAntigravityWriteContext(true): fails closed when damaged lines appear before conv-a or conv-a row lacks transcriptPath", async () => {
  const harness = await setupAgyHarness();
  try {
    const convARow = JSON.stringify({
      conversationId: "conv-a",
      transcriptPath: harness.convATranscript,
    });
    for (
      const lines of [
        ["{broken", convARow],
        ["[]", convARow],
        [JSON.stringify({ conversationId: "conv-a" }), convARow],
        [convARow, JSON.stringify({ conversationId: "conv-a", transcriptPath: "" })],
      ]
    ) {
      await Deno.writeTextFile(harness.recordPath, lines.join("\n") + "\n");
      const ctx = await resolveAntigravityWriteContext(true, {
        conversationId: "conv-a",
        transcriptPath: harness.convATranscript,
        recordPath: harness.recordPath,
      });
      assertEquals(ctx, null);
    }

    // Empty AGY_TRANSCRIPT_PATH also fails closed in readTypedSkillCall.
    await Deno.writeTextFile(harness.recordPath, `${convARow}\n`);
    const call = await readTypedSkillCall(
      makeEnvReader({
        AGY_HOOK_RECORD_PATH: harness.recordPath,
        AGY_CONVERSATION_ID: "conv-a",
        AGY_TRANSCRIPT_PATH: "",
      }),
    );
    assertEquals(call, null);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("web-jam-tools#1916: agy strict binding supports throwaway fix-pr/<number> worktree and leaves sibling worktree untouched", async () => {
  const harness = await setupAgyHarness();
  try {
    const repo = await setupPushRepo(harness.root);
    const convARow = JSON.stringify({
      conversationId: "conv-a",
      transcriptPath: harness.convATranscript,
      modelName: "gemini-4-hydrogen-high",
    });
    await Deno.writeTextFile(harness.recordPath, `${convARow}\n`);

    const siblingHead = await repo.git(["rev-parse", "HEAD"]);
    const wtDir = join(harness.root, "fix-pr-1318");
    await repo.git(["worktree", "add", "-B", "fix-pr/1318", wtDir, "origin/probe-branch"]);
    await Deno.writeTextFile(join(wtDir, "file.txt"), "agy throwaway fix\n");
    await repo.git(["commit", "--amend", "-am", "agy throwaway fix"], wtDir);
    const throwawayHead = await repo.git(["rev-parse", "HEAD"], wtDir);
    await Deno.writeTextFile(join(wtDir, "c.md"), "Fixed.\n\n🤖 Fixed by agy — Gemini Hydrogen\n");

    const env = {
      ...repo.shellEnvBase,
      AGY_HOOK_RECORD_PATH: harness.recordPath,
      AGY_CONVERSATION_ID: "conv-a",
      AGY_TRANSCRIPT_PATH: harness.convATranscript,
    };
    const res = await runPushSubprocess(
      wtDir,
      ["--force-with-lease", "--fix-comment", "c.md"],
      env,
    );
    assertEquals(res.code, 0, res.stderr);
    assertEquals(
      (await repo.git(["ls-remote", "origin", "refs/heads/probe-branch"])).split(/\s+/)[0],
      throwawayHead,
    );
    assertEquals(await repo.git(["ls-remote", "origin", "refs/heads/fix-pr/1318"]), "");
    assertEquals(await repo.git(["rev-parse", "HEAD"]), siblingHead);

    // Without matching record row, fix-pr/1318 is refused with fix-pr-branch-outside-run.
    const refused = await runPushSubprocess(wtDir, [], {
      ...env,
      AGY_CONVERSATION_ID: "",
    });
    assertEquals(refused.code, 1);
    assertStringIncludes(refused.stderr, "Refused (fix-pr-branch-outside-run)");
  } finally {
    await harness.cleanup();
  }
});
