/**
 * test/fix_run.test.ts
 *
 * Tests for agy conversation binding in `readTypedSkillCall()` and `resolveAntigravityWriteContext(true)`
 * across all 12 cases of web-jam-tools#1845 ("How the command reads what Josh typed").
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  checkFixRun,
  fixPrInstructions,
  NAMES_MORE_THAN_ONE,
  NAMES_NO_PULL_REQUEST,
  parseFixPrTarget,
  readTypedSkillCall,
  resolveFixPrTarget,
  type TargetResolution,
} from "../hooks/lib/fix_run.ts";
import { runPush } from "../scripts/push.ts";
import { resolveTargetCli } from "../scripts/resolve-fix-pr-target.ts";
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
      'printf \'{"number":1318,"state":"%s","headRefName":"probe-branch","headRepository":{"nameWithOwner":"WebJamApps/web-jam-tools"},"isCrossRepository":false}\\n\' "${PUSH_TEST_PR_STATE:-OPEN}"\n',
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

    // A terminal PR leaves the throwaway branch under ordinary push rules.
    for (const state of ["MERGED", "CLOSED"]) {
      const ended = await runPushSubprocess(wtDir, ["--fix-comment", "c.md"], {
        ...env,
        PUSH_TEST_PR_STATE: state,
      });
      assertEquals(ended.code, 1);
      assertStringIncludes(ended.stderr, "Refused (fix-pr-branch-outside-run)");
      assertEquals(await repo.git(["ls-remote", "origin", "refs/heads/fix-pr/1318"]), "");
    }

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

Deno.test("checkFixRun ends a terminal PR only when its number matches the typed target", () => {
  const call = {
    name: "fix-pr",
    arguments: "web-jam-tools#1318",
    text: "/fix-pr web-jam-tools#1318",
  };
  const pr = {
    number: 1318,
    headRefName: "main",
    headRepository: null,
    isCrossRepository: true,
  };
  for (const checkoutRepo of ["WebJamApps/web-jam-tools", "WebJamApps/JaMmusic"]) {
    for (const state of ["MERGED", "CLOSED"]) {
      assertEquals(checkFixRun(call, checkoutRepo, "feat/other", { ...pr, state }), {
        kind: "none",
      });
      assertEquals(
        checkFixRun(call, checkoutRepo, "feat/other", { ...pr, state, number: 9999 }).kind,
        "refused",
      );
    }
    assertEquals(checkFixRun(call, checkoutRepo, "feat/other", null), { kind: "none" });
  }
});

// --- Shared /fix-pr target parser and CircleCI resolution (web-jam-tools#1920) ---
// Design: fix-pr-design-2026-10-10.md rev 1.10.0, "Parsing the pull request target anywhere in the
// call" and "Accepting CircleCI build and job links".

const CHECKOUT = "WebJamApps/web-jam-tools";
const WF = "b42fe7f4-6da1-4ef9-9375-ec142b60a3af";
const JOB = "110ce2eb-8f67-4d16-98d7-cbde1e29a323";
const BRANCH_1907 = "agy/1894-fix";
const PR_URL_1907 = "https://github.com/WebJamApps/web-jam-tools/pull/1907";

type Outcome = { pr: number; repo?: string } | { build: number } | { refused: string };

function outcomeOf(args: string): Outcome {
  const parsed = parseFixPrTarget(args);
  if (!parsed.ok) return { refused: parsed.reason };
  const target = parsed.target;
  if (target.kind === "pull-request") {
    return { pr: target.number, repo: target.repo ?? CHECKOUT };
  }
  if (target.kind === "circleci-build") return { build: target.buildNumber };
  throw new Error(`unexpected job target for ${args}`);
}

const PR = (pr: number): Outcome => ({ pr, repo: CHECKOUT });
const MORE = { refused: NAMES_MORE_THAN_ONE };
const NONE = { refused: NAMES_NO_PULL_REQUEST };

Deno.test("target parser: all 22 literal cases of 'Parsing the pull request target anywhere in the call'", () => {
  const cases: [string, Outcome][] = [
    ['for web-jam-tools#1932 "accounting skill: keep the books in rustledger"', PR(1932)],
    ['web-jam-tools#1937, with "add the jq fail-closed fix" after it.', PR(1937)],
    ["please rebase (WebJamApps/web-jam-tools#1937): and wait for CI.", PR(1937)],
    ['check "https://github.com/WebJamApps/web-jam-tools/pull/1937", then push!', PR(1937)],
    ["for https://circleci.com/gh/WebJamApps/web-jam-tools/2856, wait for CI", { build: 2856 }],
    ["web-jam-tools#1937 fix step 2 and wait 5 minutes", PR(1937)],
    ["web-jam-tools#1937 https://github.com/WebJamApps/web-jam-tools/pull/1937", PR(1937)],
    [
      "web-jam-tools#1937 (see https://github.com/WebJamApps/web-jam-tools/issues/1422)",
      PR(1937),
    ],
    ["1937, fix step 2", PR(1937)],
    ["#1937: bump version", PR(1937)],
    ["for 1937, bump version", PR(1937)],
    ["for pull request #1937", PR(1937)],
    ["web-jam-tools#1937 and web-jam-tools#1938", MORE],
    ["for web-jam-tools#1422, fix web-jam-tools#1937", MORE],
    [
      "https://github.com/WebJamApps/web-jam-tools/pull/1937 https://github.com/WebJamApps/web-jam-tools/pull/1938",
      MORE,
    ],
    ["web-jam-tools#1937 https://circleci.com/gh/WebJamApps/web-jam-tools/2856", MORE],
    ["1937 and 1938", MORE],
    ["1937, 1938", MORE],
    ["fix step 2", NONE],
    ["https://github.com/WebJamApps/web-jam-tools/issues/1422", NONE],
    ["use a Fable helper", NONE],
    ["", NONE],
  ];
  assertEquals(cases.length, 22);
  for (const [args, expected] of cases) assertEquals(outcomeOf(args), expected, args);
});

Deno.test("target parser: pairwise and self-collision rules across the five key sources", () => {
  const ghUrl = (n: number) => `https://github.com/WebJamApps/web-jam-tools/pull/${n}`;
  const v1 = (n: number) => `https://circleci.com/gh/WebJamApps/web-jam-tools/${n}`;
  const checks = (job: string) => `https://app.circleci.com/workflow/${WF}/job/${job}`;
  const OTHER_JOB = "220ce2eb-8f67-4d16-98d7-cbde1e29a323";
  const cases: [string, Outcome | "job"][] = [
    // 1 & 1, 2 & 2, 1 & 2: the same { repo, number } collapses, case-insensitively.
    [`${ghUrl(1937)} ${ghUrl(1937)}`, PR(1937)],
    ["web-jam-tools#1937 WebJamApps/web-jam-tools#1937", PR(1937)],
    [`webjamapps/WEB-JAM-TOOLS#1937 ${ghUrl(1937)}`, {
      pr: 1937,
      repo: "webjamapps/WEB-JAM-TOOLS",
    }],
    // Different targets in any GitHub pairing refuse.
    [`${ghUrl(1937)} ${ghUrl(1938)}`, MORE],
    ["web-jam-tools#1937 JaMmusic#1937", MORE],
    [`web-jam-tools#1937 ${ghUrl(1938)}`, MORE],
    // 3 & 3 list forms refuse; a lone repeat after a non-list word is prose.
    ["for 1937 & 1938", MORE],
    ["#1937 and #1938", MORE],
    ["1937, #1938", MORE],
    ["1937, and 1938", MORE],
    ["for 1937, & #1938", MORE],
    ["1937, and wait for CI", PR(1937)],
    ["1937 then 1938", PR(1937)],
    // An explicit source skips source 3, so prose digits never collide.
    ["1938 web-jam-tools#1937", PR(1937)],
    [`fix 1938 ${v1(2856)}`, { build: 2856 }],
    // 4 & 4, 5 & 5: identical targets collapse, distinct ones refuse.
    [`${v1(2856)} ${v1(2856)}`, { build: 2856 }],
    [`${v1(2856)} ${v1(2857)}`, MORE],
    [`${checks(JOB)} ${checks(JOB)}`, "job"],
    [`${checks(JOB)} ${checks(OTHER_JOB)}`, MORE],
    // 4 & 5, and any GitHub target alongside any CircleCI link, refuse synchronously.
    [`${v1(2856)} ${checks(JOB)}`, MORE],
    [`${ghUrl(1907)} ${checks(JOB)}`, MORE],
    [`web-jam-tools#1907 ${v1(2856)}`, MORE],
    // Bare numbers only first or after the closed lead-in words, and only safe positive integers.
    ["please fix 1937", NONE],
    ["wait 5 minutes", NONE],
    ["FOR PR 1937", PR(1937)],
    ["0", { refused: "'0' is not a valid pull request number" }],
    ["9007199254740993", { refused: "'9007199254740993' is not a valid pull request number" }],
    ["web-jam-tools#0", { refused: "'web-jam-tools#0' does not name a valid pull request" }],
    ["1937suffix", NONE],
    ["-1937", NONE],
    // Every closed punctuation character trims from its own side, repeatedly.
    ["“‘(<[web-jam-tools#1937]>)’”!?.,;:", PR(1937)],
    ["web-jam-tools#1937)", PR(1937)],
  ];
  for (const [args, expected] of cases) {
    if (expected === "job") {
      const parsed = parseFixPrTarget(args);
      assertEquals(parsed.ok && parsed.target.kind, "circleci-job", args);
    } else {
      assertEquals(outcomeOf(args), expected, args);
    }
  }
});

Deno.test("target parser: CircleCI URL shapes, hosts and malformed links", () => {
  const details = `https://app.circleci.com/pipelines/gh/WebJamApps/web-jam-tools/2779/details`;
  const builds: [string, Record<string, unknown>][] = [
    [`https://circleci.com/github/WebJamApps/web-jam-tools/2856/`, {}],
    [`${details}?jobType=build&buildNumber=2856#step-119-`, {}],
    [`${details}?workflowId=${WF}&job=${JOB}&buildNumber=2856`, { workflowId: WF, jobId: JOB }],
    [
      `https://app.circleci.com/pipelines/github/WebJamApps/web-jam-tools/2779/workflows/${WF}/jobs/2856`,
      { workflowId: WF },
    ],
  ];
  for (const [url, extra] of builds) {
    assertEquals(parseFixPrTarget(url), {
      ok: true,
      target: { kind: "circleci-build", repo: CHECKOUT, buildNumber: 2856, ...extra },
    }, url);
  }
  assertEquals(
    parseFixPrTarget(`https://app.circleci.com/workflows/${WF.toUpperCase()}/jobs/${JOB}`),
    {
      ok: true,
      target: { kind: "circleci-job", repo: null, workflowId: WF, jobId: JOB },
    },
  );
  assertEquals(parseFixPrTarget(`${details}?workflowId=${WF}&job=${JOB}`), {
    ok: true,
    target: { kind: "circleci-job", repo: CHECKOUT, workflowId: WF, jobId: JOB },
  });
  const refusals: [string, string][] = [
    [`${details}?buildNumber=2856&buildNumber=2857`, "repeats the 'buildNumber'"],
    [`${details}?workflowId=${WF}&workflowId=${WF}&job=${JOB}`, "repeats the 'workflowId'"],
    [`${details}?workflowId=${WF}`, "names no build or job"],
    [`${details}?workflowId=nope&job=${JOB}`, "malformed 'workflowId'"],
    [`${details}?buildNumber=0`, "malformed 'buildNumber'"],
    [`https://app.circleci.com/workflow/${WF}/job/not-a-uuid`, "malformed workflow or job id"],
    [
      "https://circleci.com/api/private/output/raw/github/WebJamApps/web-jam-tools/2856/output/101/0?token=abc",
      "signed CircleCI log URL",
    ],
    ["https://circleci.com/api/v1.1/project/github/WebJamApps/web-jam-tools/2856", "CircleCI API"],
    ["https://app.circleci.com/pipelines/gh/WebJamApps/web-jam-tools", "names no build or job"],
    ["https://circleci.com/gh/WebJamApps/web-jam-tools", "names no build or job"],
    ["https://circleci.com/gh/../../2856", "names no build or job"],
    ["https://circleci.com/gh/WebJamApps/web-jam-tools/0", "malformed repository or build"],
    [
      "https://evil.example.com/pipelines/gh/WebJamApps/web-jam-tools/1/details?buildNumber=2856",
      "not a CircleCI host",
    ],
    ["http://circleci.com/gh/WebJamApps/web-jam-tools/2856", "must use https"],
    [
      "https://user:pass@circleci.com/gh/WebJamApps/web-jam-tools/2856",
      "must not carry credentials",
    ],
    ["https://circleci.com:8443/gh/WebJamApps/web-jam-tools/2856", "must not name a port"],
    ["http://github.com/WebJamApps/web-jam-tools/pull/1937", "plain https link"],
  ];
  for (const [url, reason] of refusals) {
    const parsed = parseFixPrTarget(`please ${url} now`);
    assertEquals(parsed.ok, false, url);
    if (!parsed.ok) assertStringIncludes(parsed.reason, reason, url);
  }
  // Ordinary links in the prose of a call are not targets.
  assertEquals(outcomeOf("web-jam-tools#1937 see https://example.com/docs/5"), PR(1937));
});

interface FakeWorld {
  builds?: Record<number, unknown>;
  workflowJobs?: unknown;
  prs?: Record<number, Record<string, unknown>>;
  openOnBranch?: number[];
  fail?: "500" | "redirect" | "timeout" | "json";
  ghFails?: boolean;
}

interface FakeRequest {
  url: string;
  token: string | null;
  redirect: RequestRedirect | undefined;
}

function openPr(number: number, changes: Record<string, unknown> = {}) {
  return {
    number,
    state: "OPEN",
    headRefName: BRANCH_1907,
    headRepository: { nameWithOwner: CHECKOUT },
    isCrossRepository: false,
    ...changes,
  };
}

function build2856(changes: Record<string, unknown> = {}) {
  return {
    username: "WebJamApps",
    reponame: "web-jam-tools",
    branch: BRANCH_1907,
    pull_requests: [{ head_sha: "abc", url: PR_URL_1907 }],
    workflows: { workflow_id: WF, job_id: JOB },
    ...changes,
  };
}

function fakeDeps(world: FakeWorld, requests: FakeRequest[] = [], ghCalls: string[][] = []) {
  const prs: Record<number, Record<string, unknown>> = world.prs ?? { 1907: openPr(1907) };
  return {
    circleToken: "secret-token",
    checkoutRepo: () => Promise.resolve(CHECKOUT),
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, token: headers.get("Circle-Token"), redirect: init?.redirect });
      if (world.fail === "timeout") {
        return Promise.reject(new DOMException("timed out", "TimeoutError"));
      }
      if (world.fail === "redirect") return Promise.reject(new TypeError("redirect not allowed"));
      if (world.fail === "500") return Promise.resolve(new Response("oops", { status: 500 }));
      if (world.fail === "json") return Promise.resolve(new Response("{not json", { status: 200 }));
      const v2 = url.match(/\/api\/v2\/workflow\/([^/]+)\/job$/);
      if (v2) return Promise.resolve(Response.json(world.workflowJobs));
      const v1 = url.match(/\/api\/v1\.1\/project\/github\/[^/]+\/[^/]+\/(\d+)$/);
      const body = v1 ? world.builds?.[Number(v1[1])] : undefined;
      return Promise.resolve(
        body ? Response.json(body) : new Response("not found", { status: 404 }),
      );
    }) as typeof fetch,
    runGh: (args: string[]) => {
      ghCalls.push(args);
      if (world.ghFails) return Promise.resolve({ code: 1, stdout: "" });
      if (args[1] === "view") {
        const pr = prs[Number(args[2])];
        return Promise.resolve(
          pr ? { code: 0, stdout: JSON.stringify(pr) } : { code: 1, stdout: "" },
        );
      }
      const list = (world.openOnBranch ?? []).map((n) => prs[n] ?? openPr(n));
      return Promise.resolve({ code: 0, stdout: JSON.stringify(list) });
    },
  };
}

const V2_2856 = {
  items: [{ id: JOB, job_number: 2856, project_slug: "gh/WebJamApps/web-jam-tools" }],
};
const RESOLVED_1907 = { repo: CHECKOUT, number: 1907, branch: BRANCH_1907, build: 2856 };

Deno.test("CircleCI resolution: all 17 cases of 'Accepting CircleCI build and job links'", async () => {
  const details = "https://app.circleci.com/pipelines/gh/WebJamApps/web-jam-tools/2779/details";
  const v1 = "https://circleci.com/gh/WebJamApps/web-jam-tools/2856";
  const cases: [string, FakeWorld, typeof RESOLVED_1907 | string][] = [
    [
      `${details}?workflowId=${WF}&job=${JOB}&buildNumber=2856&jobType=build#step-119-`,
      { builds: { 2856: build2856() } },
      RESOLVED_1907,
    ],
    [
      `https://app.circleci.com/pipelines/github/WebJamApps/web-jam-tools/2779/workflows/${WF}/jobs/2856`,
      { builds: { 2856: build2856() } },
      RESOLVED_1907,
    ],
    [
      v1,
      { builds: { 2856: build2856({ pull_requests: [] }) }, openOnBranch: [1907] },
      RESOLVED_1907,
    ],
    [
      `https://app.circleci.com/workflow/${WF}/job/${JOB}`,
      { workflowJobs: V2_2856, builds: { 2856: build2856() } },
      RESOLVED_1907,
    ],
    [
      `${details}?workflowId=${WF}&job=${JOB}`,
      { workflowJobs: V2_2856, builds: { 2856: build2856() } },
      RESOLVED_1907,
    ],
    [
      `${details}?workflowId=${WF}&job=00000000-0000-0000-0000-000000000000&buildNumber=2856`,
      { builds: { 2856: build2856() } },
      "does not match its build",
    ],
    [`${details}?buildNumber=2856&buildNumber=2857`, {}, "repeats the 'buildNumber'"],
    [
      "https://circleci.com/gh/WebJamApps/web-jam-tools/2853",
      { builds: { 2853: build2856({ branch: "dev", pull_requests: [] }) } },
      "protected branch 'dev'",
    ],
    [
      v1,
      { builds: { 2856: build2856({ pull_requests: [] }) }, openOnBranch: [] },
      "no open pull request",
    ],
    [
      v1,
      { builds: { 2856: build2856({ pull_requests: [] }) }, openOnBranch: [1907, 1908] },
      "more than one open pull request",
    ],
    [
      v1,
      { builds: { 2856: build2856() }, prs: { 1907: openPr(1907, { state: "CLOSED" }) } },
      "no open pull request",
    ],
    [
      v1,
      { builds: { 2856: build2856() }, prs: { 1907: openPr(1907, { state: "MERGED" }) } },
      "no open pull request",
    ],
    [
      v1,
      { builds: { 2856: build2856() }, prs: { 1907: openPr(1907, { isCrossRepository: true }) } },
      "another repository (a fork)",
    ],
    ["https://circleci.com/gh/WebJamApps/JaMmusic/412", {}, "not this checkout's"],
    [
      "https://circleci.com/api/private/output/raw/github/WebJamApps/web-jam-tools/2856/output/101/0?token=abc",
      {},
      "signed CircleCI log URL",
    ],
    ["https://app.circleci.com/pipelines/gh/WebJamApps/web-jam-tools", {}, "names no build or job"],
    [
      "https://evil.example.com/pipelines/gh/WebJamApps/web-jam-tools/1/details?buildNumber=2856",
      {},
      "not a CircleCI host",
    ],
    ["http://circleci.com/gh/WebJamApps/web-jam-tools/2856", {}, "must use https"],
    [
      "https://user:pass@circleci.com/gh/WebJamApps/web-jam-tools/2856",
      {},
      "must not carry credentials",
    ],
    [v1, { fail: "500" }, "HTTP 500"],
    [v1, { fail: "redirect" }, "could not be reached"],
    [v1, { fail: "timeout" }, "could not be reached"],
  ];
  for (const [arg, world, expected] of cases) {
    const requests: FakeRequest[] = [];
    const result = await resolveTargetCli([arg], fakeDeps(world, requests));
    if (typeof expected === "string") {
      assertEquals(result.ok, false, arg);
      if (!result.ok) assertStringIncludes(result.reason, expected, arg);
    } else {
      assertEquals(result, { ok: true, target: expected }, arg);
    }
    for (const request of requests) {
      // The token reaches CircleCI's API only, redirects are errors, and no step log is fetched.
      assertEquals(request.url.startsWith("https://circleci.com/api/"), true, request.url);
      assertEquals(request.token, "secret-token");
      assertEquals(request.redirect, "error");
      assertEquals(/output/.test(request.url), false, request.url);
    }
  }
});

Deno.test("CircleCI resolution fails closed on malformed metadata, gh failures and conflicts", async () => {
  const v1 = "https://circleci.com/gh/WebJamApps/web-jam-tools/2856";
  const checks = `https://app.circleci.com/workflow/${WF}/job/${JOB}`;
  const cases: [string, FakeWorld, TargetResolution["kind"], string][] = [
    [v1, { fail: "json" }, "unknown", "malformed JSON"],
    [v1, { builds: { 2856: [] } }, "unknown", "malformed build metadata"],
    [v1, { builds: { 2856: build2856({ username: "Someone" }) } }, "refused", "another repository"],
    [v1, { builds: { 2856: build2856({ branch: "" }) } }, "refused", "names no branch"],
    [v1, { builds: { 2856: build2856({ branch: "main" }) } }, "refused", "protected branch 'main'"],
    [
      v1,
      { builds: { 2856: build2856({ pull_requests: "x" }) } },
      "unknown",
      "malformed pull request",
    ],
    [v1, { builds: { 2856: build2856() }, ghFails: true }, "unknown", "GitHub could not be read"],
    [
      v1,
      { builds: { 2856: build2856({ pull_requests: [] }) }, openOnBranch: [1907], ghFails: true },
      "unknown",
      "GitHub could not be read",
    ],
    [
      v1,
      { builds: { 2856: build2856() }, prs: { 1907: openPr(1907, { headRefName: "other" }) } },
      "unknown",
      "no open pull request",
    ],
    [checks, { workflowJobs: { items: [] } }, "refused", "no single job"],
    [checks, { workflowJobs: {} }, "unknown", "malformed workflow job"],
    [
      checks,
      {
        workflowJobs: {
          items: [{ id: JOB, job_number: null, project_slug: "gh/WebJamApps/web-jam-tools" }],
        },
      },
      "unknown",
      "no GitHub project or build number",
    ],
    [
      `https://app.circleci.com/pipelines/gh/WebJamApps/JaMmusic/2779/details?workflowId=${WF}&job=${JOB}`,
      { workflowJobs: V2_2856 },
      "refused",
      "does not match its workflow's project",
    ],
  ];
  for (const [arg, world, kind, reason] of cases) {
    const result = await resolveFixPrTarget(arg, CHECKOUT, fakeDeps(world));
    assertEquals(result.kind, kind, `${arg} ${JSON.stringify(world)}`);
    if (result.kind !== "resolved") assertStringIncludes(result.reason, reason, arg);
  }
  // A GitHub target needs no lookup; a bare number needs a readable checkout.
  assertEquals(await resolveFixPrTarget("1907", CHECKOUT, fakeDeps({})), {
    kind: "resolved",
    ref: { repo: CHECKOUT, number: 1907 },
  });
  assertEquals((await resolveFixPrTarget("1907", null, fakeDeps({}))).kind, "refused");
  // Without a token, no Circle-Token header is sent.
  const requests: FakeRequest[] = [];
  await resolveFixPrTarget(v1, CHECKOUT, {
    ...fakeDeps({ builds: { 2856: build2856() } }, requests),
    circleToken: null,
  });
  assertEquals(requests.map((r) => r.token), [null]);
});

Deno.test("fix-pr:resolve-target verifies the GitHub pull request it resolves", async () => {
  const run = (arg: string, world: FakeWorld, checkout: string | null = CHECKOUT) =>
    resolveTargetCli([arg], { ...fakeDeps(world), checkoutRepo: () => Promise.resolve(checkout) });
  assertEquals(await run("web-jam-tools#1907", {}), {
    ok: true,
    target: { repo: CHECKOUT, number: 1907, branch: BRANCH_1907, build: null },
  });
  const refusals: [string, FakeWorld, string, string | null][] = [
    [
      "web-jam-tools#1907",
      { prs: { 1907: openPr(1907, { state: "MERGED" }) } },
      "is MERGED",
      CHECKOUT,
    ],
    [
      "web-jam-tools#1907",
      { prs: { 1907: openPr(1907, { isCrossRepository: true }) } },
      "fork",
      CHECKOUT,
    ],
    [
      "web-jam-tools#1907",
      { prs: { 1907: openPr(1907, { headRefName: "dev" }) } },
      "protected",
      CHECKOUT,
    ],
    ["web-jam-tools#1907", { prs: { 1907: { number: 1908 } } }, "malformed", CHECKOUT],
    ["web-jam-tools#1907", { ghFails: true }, "could not be read", CHECKOUT],
    ["JaMmusic#5", {}, "not this checkout's", CHECKOUT],
    ["1907", {}, "needs a checkout", null],
    ["--repo-dir", {}, "not supported", CHECKOUT],
    ["", {}, "names no pull request", CHECKOUT],
  ];
  for (const [arg, world, reason, checkout] of refusals) {
    const result = await run(arg, world, checkout);
    assertEquals(result.ok, false, arg);
    if (!result.ok) assertStringIncludes(result.reason, reason, arg);
  }
  // Explicit-argument mode with no readable checkout still resolves a named target.
  assertEquals((await run("web-jam-tools#1907", {}, null)).ok, true);
});

Deno.test("fix-pr:resolve-target --from-session: the three guard outcomes", async () => {
  const typed = (name: string, args: string) => ({
    name,
    arguments: args,
    text: `/${name} ${args}`,
  });
  const sessionEnv = (values: Record<string, string>) => (name: string) => values[name];
  const claudeEnv = sessionEnv({ CLAUDE_CODE_SESSION_ID: "s-1" });
  const repoDirs: (string | undefined)[] = [];
  const run = (
    args: string[],
    call: ReturnType<typeof typed> | null,
    world: FakeWorld = {},
    options: { checkout?: string | null; env?: (name: string) => string | undefined } = {},
  ) =>
    resolveTargetCli(args, {
      ...fakeDeps(world),
      checkoutRepo: (repoDir?: string) => {
        repoDirs.push(repoDir);
        return Promise.resolve(options.checkout === undefined ? CHECKOUT : options.checkout);
      },
      readSkillCall: () => Promise.resolve(call),
      env: options.env ?? claudeEnv,
    });
  const fromSession = ["--from-session"];
  const withRepoDir = ["--from-session", "--repo-dir", "/tmp/fix-pr-1907"];

  // (a) The condition holds: the newest typed call is fix-pr and names one open same-repo PR.
  const resolved = { repo: CHECKOUT, number: 1907, branch: BRANCH_1907, build: null };
  assertEquals(await run(fromSession, typed("fix-pr", "web-jam-tools#1907 bump version")), {
    ok: true,
    target: resolved,
  });
  assertEquals(await run(withRepoDir, typed("webjam-tasks:fix-pr", "1907")), {
    ok: true,
    target: resolved,
  });
  assertEquals(repoDirs.at(-1), "/tmp/fix-pr-1907");
  assertEquals(
    await run(
      ["--from-session", "--repo-dir=/tmp/fix-pr-1907"],
      typed("fix-pr", "https://circleci.com/gh/WebJamApps/web-jam-tools/2856, wait for CI"),
      { builds: { 2856: build2856() } },
    ),
    { ok: true, target: RESOLVED_1907 },
  );
  assertEquals(repoDirs.at(-1), "/tmp/fix-pr-1907");

  // Without --repo-dir no checkout is read, so a named target in another repository resolves
  // there rather than being bound to the working directory's web-jam-tools checkout.
  const readsBefore = repoDirs.length;
  const jamPr = openPr(1479, {
    headRefName: "agy/1478-legal-pages",
    headRepository: { nameWithOwner: "WebJamApps/JaMmusic" },
  });
  assertEquals(
    await run(fromSession, typed("fix-pr", "JaMmusic#1479"), { prs: { 1479: jamPr } }),
    {
      ok: true,
      target: {
        repo: "WebJamApps/JaMmusic",
        number: 1479,
        branch: "agy/1478-legal-pages",
        build: null,
      },
    },
  );
  assertEquals(repoDirs.length, readsBefore, "--from-session without --repo-dir reads no checkout");

  // (b) The condition does not hold, and (c) it cannot be determined: both refuse.
  const refusals: [string[], ReturnType<typeof typed> | null, FakeWorld, string, {
    checkout?: string | null;
    env?: (name: string) => string | undefined;
  }][] = [
    [fromSession, typed("work-issue", "web-jam-tools#1945"), {}, "'work-issue', not fix-pr", {}],
    [
      fromSession,
      typed("fix-pr", "web-jam-tools#1907 and web-jam-tools#1908"),
      {},
      "more than one",
      {},
    ],
    [fromSession, typed("fix-pr", "use a Fable helper"), {}, "names no pull request", {}],
    [
      fromSession,
      typed("fix-pr", "web-jam-tools#1907"),
      { prs: { 1907: openPr(1907, { state: "MERGED" }) } },
      "is MERGED",
      {},
    ],
    [
      fromSession,
      typed("fix-pr", "web-jam-tools#1907"),
      { prs: { 1907: openPr(1907, { state: "CLOSED" }) } },
      "is CLOSED",
      {},
    ],
    [
      fromSession,
      typed("fix-pr", "web-jam-tools#1907"),
      { prs: { 1907: openPr(1907, { isCrossRepository: true }) } },
      "fork",
      {},
    ],
    [
      fromSession,
      typed("fix-pr", "web-jam-tools#1907"),
      { prs: { 1907: openPr(1907, { headRefName: "main" }) } },
      "protected",
      {},
    ],
    [
      fromSession,
      typed("fix-pr", "https://circleci.com/gh/WebJamApps/web-jam-tools/2853"),
      { builds: { 2853: build2856({ branch: "dev", pull_requests: [] }) } },
      "protected branch 'dev'",
      {},
    ],
    [
      fromSession,
      typed(
        "fix-pr",
        "https://circleci.com/api/private/output/raw/github/WebJamApps/web-jam-tools/2856/output/101/0",
      ),
      {},
      "signed CircleCI log URL",
      {},
    ],
    [withRepoDir, typed("fix-pr", "JaMmusic#5"), {}, "not this checkout's", {}],
    // A bare number with no --repo-dir has no checkout to resolve against, even though the
    // fake checkout reader would answer web-jam-tools if it were asked.
    [fromSession, typed("fix-pr", "1907"), {}, "needs a checkout", {}],
    [withRepoDir, typed("fix-pr", "1907"), {}, "could not be read", { checkout: null }],
    [
      fromSession,
      typed("fix-pr", "web-jam-tools#1907"),
      { ghFails: true },
      "could not be read",
      {},
    ],
    [
      fromSession,
      typed("fix-pr", "https://circleci.com/gh/WebJamApps/web-jam-tools/2856"),
      { fail: "500" },
      "HTTP 500",
      {},
    ],
    [
      fromSession,
      typed("fix-pr", "https://circleci.com/gh/WebJamApps/web-jam-tools/2856"),
      { builds: { 2856: build2856({ pull_requests: [] }) }, openOnBranch: [1907, 1908] },
      "more than one open pull request",
      {},
    ],
    [fromSession, null, {}, "no session is named", { env: sessionEnv({}) }],
    [fromSession, null, {}, "helper's turn", {}],
    [fromSession, null, {}, "unattended", { env: sessionEnv({ WJT_UNATTENDED: "1" }) }],
    [
      fromSession,
      null,
      {},
      "cannot be told",
      { env: sessionEnv({ CODEX_THREAD_ID: "t", CLAUDE_CODE_SESSION_ID: "s" }) },
    ],
    [["--from-session", "web-jam-tools#1907"], typed("fix-pr", "1907"), {}, "is not accepted", {}],
    [["--from-session", "--from-session"], typed("fix-pr", "1907"), {}, "more than once", {}],
    [["--from-session", "--repo-dir"], typed("fix-pr", "1907"), {}, "requires a repository", {}],
    [
      ["--from-session", "--repo-dir", "/a", "--repo-dir", "/b"],
      typed("fix-pr", "1907"),
      {},
      "more than once",
      {},
    ],
  ];
  for (const [args, call, world, reason, options] of refusals) {
    const result = await run(args, call, world, options);
    const label = `${args.join(" ")} ${call?.text ?? "(no call)"}`;
    assertEquals(result.ok, false, label);
    if (!result.ok) assertStringIncludes(result.reason, reason, label);
  }
});

Deno.test("readTypedSkillCall refuses a Claude Code helper's turn, so --from-session refuses", async () => {
  const home = await Deno.makeTempDir();
  const id = "12345678-1234-5678-abcd-123456789abc";
  try {
    await Deno.mkdir(`${home}/.claude/projects/probe`, { recursive: true });
    const write = (sidechain: boolean) =>
      Deno.writeTextFile(
        `${home}/.claude/projects/probe/${id}.jsonl`,
        JSON.stringify({
          type: "user",
          timestamp: "2026-11-26T01:00:00Z",
          origin: { kind: "human" },
          isSidechain: sidechain,
          message: { role: "user", content: "/fix-pr web-jam-tools#1907" },
        }) + "\n",
      );
    const env = (name: string) =>
      ({ HOME: home, CLAUDE_CODE_SESSION_ID: id } as Record<string, string>)[name];
    const realHome = Deno.env.get("HOME");
    Deno.env.set("HOME", home);
    try {
      await write(false);
      const call = await readTypedSkillCall(env);
      assertEquals(call?.name, "fix-pr");
      assertEquals(
        (await resolveTargetCli(["--from-session"], { ...fakeDeps({}), env })).ok,
        true,
      );
      await write(true);
      assertEquals(await readTypedSkillCall(env), null);
      const refused = await resolveTargetCli(["--from-session"], { ...fakeDeps({}), env });
      assertEquals(refused.ok, false);
      if (!refused.ok) assertStringIncludes(refused.reason, "helper's turn");
    } finally {
      if (realHome === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", realHome);
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("checkFixRun takes a resolved CircleCI target and reads one without as no fix run", () => {
  const call = {
    name: "fix-pr",
    arguments: "https://circleci.com/gh/WebJamApps/web-jam-tools/2856",
    text: "",
  };
  const pr = openPr(1907);
  assertEquals(checkFixRun(call, CHECKOUT, BRANCH_1907, pr), { kind: "none" });
  assertEquals(
    checkFixRun(call, CHECKOUT, "fix-pr/1907", pr, {
      kind: "resolved",
      ref: { repo: CHECKOUT, number: 1907 },
      branch: BRANCH_1907,
      build: 2856,
    }),
    { kind: "active", pullRequest: { repo: CHECKOUT, number: 1907 }, headRefName: BRANCH_1907 },
  );
  assertEquals(
    checkFixRun(call, CHECKOUT, BRANCH_1907, null, { kind: "refused", reason: "dev build" }),
    { kind: "refused", reason: "dev build" },
  );
  assertEquals(
    checkFixRun(call, CHECKOUT, BRANCH_1907, null, { kind: "unknown", reason: "HTTP 500" }),
    { kind: "none" },
  );
  assertEquals(
    checkFixRun({ ...call, arguments: "1937 and 1938" }, CHECKOUT, BRANCH_1907, pr).kind,
    "refused",
  );
});

Deno.test("fixPrInstructions leaves what Josh asked once the target's mentions are removed", () => {
  const cases: [string, string][] = [
    ["web-jam-tools#1318 use a Fable helper", "use a Fable helper"],
    [
      "use a Fable helper on https://circleci.com/gh/WebJamApps/web-jam-tools/2856.",
      "use a Fable helper on",
    ],
    [
      "web-jam-tools#1318 https://github.com/WebJamApps/web-jam-tools/pull/1318 wait for CI",
      "wait for CI",
    ],
    ["for 1318, bump version", "for bump version"],
    ["fix step 2", "fix step 2"],
    ["1318 and 1319", "1318 and 1319"],
  ];
  for (const [args, expected] of cases) assertEquals(fixPrInstructions(args), expected, args);
});
