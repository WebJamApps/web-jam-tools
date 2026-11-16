// test/design_issue_check_copies.test.ts — web-jam-tools#1813
// One test per row of the push table in "Copied text between design documents"
// ("Appendix D — Case Lists", design-issue-file-issue-design-2026-08-23.md).

import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { checkCopies, runCheckCopiesCli } from "../src/design-issue/check_copies.ts";
import { runCli } from "../src/design-issue/cli.ts";

const ROOT_DIR = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const COPIED_LINE =
  "The lookup debounces typing and asks the backend with a key only the server holds and returns the exact position";

function git(repoDir: string, args: string[]): string {
  const out = new Deno.Command("git", {
    args: ["-C", repoDir, ...args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  if (out.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${out.code}): ${stderr || stdout}`);
  }
  return stdout.trim();
}

async function writeAndCommit(
  repoDir: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(repoDir, relPath);
    await Deno.mkdir(path.dirname(abs), { recursive: true });
    await Deno.writeTextFile(abs, content);
  }
  git(repoDir, ["add", ...Object.keys(files)]);
  git(repoDir, ["commit", "-m", message]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

async function withPushFixture(
  fn: (ctx: {
    designRoot: string;
    designDocPath: string;
    repoDir: string;
    baseSha: string;
  }) => Promise<void> | void,
  baseFiles: Record<string, string> = {
    "skills/design-issue/SKILL.md": "# Design Issue\n\nFollow these steps.\n",
  },
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "check-copies-" });
  const designRoot = path.join(tempDir, "design-docs");
  const repoDir = path.join(tempDir, "repo");
  try {
    const themeDir = path.join(designRoot, "Token_Savings");
    await Deno.mkdir(themeDir, { recursive: true });
    const designDocPath = path.join(themeDir, "sample-design-2026-08-23.md");
    await Deno.writeTextFile(
      designDocPath,
      `# Sample Design\n\n## What it is\n\n${COPIED_LINE}\n\n## Both surfaces\n\nClaude Code, agy, Codex.\n`,
    );

    await Deno.mkdir(repoDir, { recursive: true });
    git(repoDir, ["init", "-q", "-b", "dev"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test User"]);
    const baseSha = await writeAndCommit(repoDir, baseFiles, "base commit on dev");
    git(repoDir, ["checkout", "-q", "-b", "feat/copy-test"]);

    await fn({ designRoot, designDocPath, repoDir, baseSha });
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
}

Deno.test("deno.json defines design:check-copies task", async () => {
  const raw = await Deno.readTextFile(path.join(ROOT_DIR, "deno.json"));
  const config = JSON.parse(raw) as { tasks?: Record<string, string> };
  assertEquals(typeof config.tasks?.["design:check-copies"], "string");
  assertStringIncludes(
    config.tasks!["design:check-copies"],
    "src/design-issue/cli.ts check-copies",
  );
});

Deno.test(
  "Push table: the line, added to skills/design-issue/SKILL.md -> refuse, naming the file, the design document and the words",
  async () => {
    await withPushFixture(async ({ designRoot, designDocPath, repoDir, baseSha }) => {
      const headSha = await writeAndCommit(
        repoDir,
        {
          "skills/design-issue/SKILL.md": `# Design Issue\n\n${COPIED_LINE}\n`,
        },
        "add copied line to skill",
      );

      const res = checkCopies({
        repoDir,
        range: `${baseSha}..${headSha}`,
        dropboxDir: designRoot,
      });
      assertEquals(res.ok, false);
      assertEquals(res.violations.length, 1);
      assertStringIncludes(res.violations[0].message, "skills/design-issue/SKILL.md");
      assertStringIncludes(res.violations[0].message, designDocPath);
      assertStringIncludes(res.violations[0].message, COPIED_LINE);

      const errors: string[] = [];
      const exitCode = await runCheckCopiesCli(
        ["--repo", repoDir, "--range", `${baseSha}..${headSha}`, "--dropbox-dir", designRoot],
        { errorLog: (m) => errors.push(m) },
      );
      assertEquals(exitCode, 1);
      const errText = errors.join("\n");
      assertStringIncludes(errText, "skills/design-issue/SKILL.md");
      assertStringIncludes(errText, designDocPath);
      assertStringIncludes(errText, COPIED_LINE);
    });
  },
);

Deno.test(
  "Push table: the line, added to docs/scripts.md -> refuse",
  async () => {
    await withPushFixture(async ({ designRoot, designDocPath, repoDir, baseSha }) => {
      const headSha = await writeAndCommit(
        repoDir,
        { "docs/scripts.md": `# Scripts\n\n${COPIED_LINE}\n` },
        "add copied line to docs",
      );

      const res = checkCopies({
        repoDir,
        range: `${baseSha}..${headSha}`,
        dropboxDir: designRoot,
      });
      assertEquals(res.ok, false);
      assertStringIncludes(res.violations[0].message, "docs/scripts.md");
      assertStringIncludes(res.violations[0].message, designDocPath);
      assertStringIncludes(res.violations[0].message, COPIED_LINE);
    });
  },
);

Deno.test(
  "Push table: the line, added to AGENTS.md -> refuse",
  async () => {
    await withPushFixture(async ({ designRoot, designDocPath, repoDir, baseSha }) => {
      const headSha = await writeAndCommit(
        repoDir,
        { "AGENTS.md": `# Agents\n\n${COPIED_LINE}\n` },
        "add copied line to AGENTS.md",
      );

      const res = checkCopies({
        repoDir,
        range: `${baseSha}..${headSha}`,
        dropboxDir: designRoot,
      });
      assertEquals(res.ok, false);
      assertStringIncludes(res.violations[0].message, "AGENTS.md");
      assertStringIncludes(res.violations[0].message, designDocPath);
    });
  },
);

Deno.test(
  "Push table: the line, added to CLAUDE.md -> refuse",
  async () => {
    await withPushFixture(async ({ designRoot, designDocPath, repoDir, baseSha }) => {
      const headSha = await writeAndCommit(
        repoDir,
        { "CLAUDE.md": `# Claude\n\n${COPIED_LINE}\n` },
        "add copied line to CLAUDE.md",
      );

      const res = checkCopies({
        repoDir,
        range: `${baseSha}..${headSha}`,
        dropboxDir: designRoot,
      });
      assertEquals(res.ok, false);
      assertStringIncludes(res.violations[0].message, "CLAUDE.md");
      assertStringIncludes(res.violations[0].message, designDocPath);
    });
  },
);

Deno.test(
  "Push table: the line, added to src/design-issue/lint_doc.ts -> pass — not an instruction file",
  async () => {
    await withPushFixture(async ({ designRoot, repoDir, baseSha }) => {
      const headSha = await writeAndCommit(
        repoDir,
        { "src/design-issue/lint_doc.ts": `// ${COPIED_LINE}\nexport const x = 1;\n` },
        "add line to source file",
      );

      const res = checkCopies({
        repoDir,
        range: `${baseSha}..${headSha}`,
        dropboxDir: designRoot,
      });
      assertEquals(res.ok, true);
      assertEquals(res.violations, []);
    });
  },
);

Deno.test(
  "Push table: the first 11 words of the line, added to skills/design-issue/SKILL.md -> pass",
  async () => {
    await withPushFixture(async ({ designRoot, repoDir, baseSha }) => {
      const first11 = COPIED_LINE.split(" ").slice(0, 11).join(" ");
      const headSha = await writeAndCommit(
        repoDir,
        { "skills/design-issue/SKILL.md": `# Design Issue\n\n${first11}\n` },
        "add 11 words",
      );

      const res = checkCopies({
        repoDir,
        range: `${baseSha}..${headSha}`,
        dropboxDir: designRoot,
      });
      assertEquals(res.ok, true);
    });
  },
);

Deno.test(
  "Push table: the line with the case changed and a comma added, added to skills/design-issue/SKILL.md -> refuse",
  async () => {
    await withPushFixture(async ({ designRoot, designDocPath, repoDir, baseSha }) => {
      const altered =
        "THE LOOKUP DEBOUNCES TYPING, and asks the backend with a key, only the server holds and returns the exact position.";
      const headSha = await writeAndCommit(
        repoDir,
        { "skills/design-issue/SKILL.md": `# Design Issue\n\n${altered}\n` },
        "add case/punctuation-altered line",
      );

      const res = checkCopies({
        repoDir,
        range: `${baseSha}..${headSha}`,
        dropboxDir: designRoot,
      });
      assertEquals(res.ok, false);
      assertStringIncludes(res.violations[0].message, "skills/design-issue/SKILL.md");
      assertStringIncludes(res.violations[0].message, designDocPath);
      assertStringIncludes(
        res.violations[0].sharedWords.toLowerCase(),
        "the lookup debounces typing",
      );
    });
  },
);

Deno.test(
  "Push table: the line in backticks, added to skills/design-issue/SKILL.md -> pass",
  async () => {
    await withPushFixture(async ({ designRoot, repoDir, baseSha }) => {
      const headSha = await writeAndCommit(
        repoDir,
        { "skills/design-issue/SKILL.md": `# Design Issue\n\n\`${COPIED_LINE}\`\n` },
        "add line in backticks",
      );

      const res = checkCopies({
        repoDir,
        range: `${baseSha}..${headSha}`,
        dropboxDir: designRoot,
      });
      assertEquals(res.ok, true);
    });
  },
);

Deno.test(
  "Push table: a pointer naming the design document's path in backticks and its section in double quotes, added to skills/design-issue/SKILL.md -> pass",
  async () => {
    await withPushFixture(async ({ designRoot, designDocPath, repoDir, baseSha }) => {
      const pointer = `Follow \`${designDocPath}\` ("${COPIED_LINE}") when checking.`;
      const headSha = await writeAndCommit(
        repoDir,
        { "skills/design-issue/SKILL.md": `# Design Issue\n\n${pointer}\n` },
        "add pointer",
      );

      const res = checkCopies({
        repoDir,
        range: `${baseSha}..${headSha}`,
        dropboxDir: designRoot,
      });
      assertEquals(res.ok, true);
    });
  },
);

Deno.test(
  "Push table: the line, already in skills/design-issue/SKILL.md at the base commit, and a different line added -> pass — only added lines are read",
  async () => {
    await withPushFixture(
      async ({ designRoot, repoDir, baseSha }) => {
        const headSha = await writeAndCommit(
          repoDir,
          {
            "skills/design-issue/SKILL.md":
              `# Design Issue\n\n${COPIED_LINE}\n\nFollow these new steps.\n`,
          },
          "add different line leaving base copy untouched",
        );

        const res = checkCopies({
          repoDir,
          range: `${baseSha}..${headSha}`,
          dropboxDir: designRoot,
        });
        assertEquals(res.ok, true);
        assertEquals(res.violations, []);
      },
      { "skills/design-issue/SKILL.md": `# Design Issue\n\n${COPIED_LINE}\n` },
    );
  },
);

Deno.test(
  "Push table: the line, removed from skills/design-issue/SKILL.md -> pass",
  async () => {
    await withPushFixture(
      async ({ designRoot, repoDir, baseSha }) => {
        const headSha = await writeAndCommit(
          repoDir,
          { "skills/design-issue/SKILL.md": "# Design Issue\n" },
          "remove copied line",
        );

        const res = checkCopies({
          repoDir,
          range: `${baseSha}..${headSha}`,
          dropboxDir: designRoot,
        });
        assertEquals(res.ok, true);
      },
      { "skills/design-issue/SKILL.md": `# Design Issue\n\n${COPIED_LINE}\n` },
    );
  },
);

Deno.test(
  "Push table: a design document cannot be read -> refuse, naming it",
  async () => {
    await withPushFixture(async ({ designRoot, designDocPath, repoDir, baseSha }) => {
      const headSha = await writeAndCommit(
        repoDir,
        { "skills/design-issue/SKILL.md": "# Design Issue\n\nNew step.\n" },
        "edit skill",
      );

      await Deno.chmod(designDocPath, 0o000);
      try {
        const errors: string[] = [];
        const exitCode = await runCheckCopiesCli(
          ["--repo", repoDir, "--range", `${baseSha}..${headSha}`, "--dropbox-dir", designRoot],
          { errorLog: (m) => errors.push(m) },
        );
        assertEquals(exitCode, 1);
        assertStringIncludes(errors.join("\n"), designDocPath);
      } finally {
        await Deno.chmod(designDocPath, 0o644);
      }
    });
  },
);

Deno.test(
  "Push table: --whole-file skills/design-issue/SKILL.md, the line already in that file at the base commit -> refuse, naming the file, the design document and the words",
  async () => {
    await withPushFixture(
      ({ designRoot, designDocPath, repoDir }) => {
        const errors: string[] = [];
        const exitCode = runCheckCopiesCli(
          [
            "--repo",
            repoDir,
            "--whole-file",
            "skills/design-issue/SKILL.md",
            "--dropbox-dir",
            designRoot,
          ],
          { errorLog: (m) => errors.push(m) },
        );
        assertEquals(exitCode, 1);
        const errText = errors.join("\n");
        assertStringIncludes(errText, "skills/design-issue/SKILL.md");
        assertStringIncludes(errText, designDocPath);
        assertStringIncludes(errText, COPIED_LINE);
      },
      { "skills/design-issue/SKILL.md": `# Design Issue\n\n${COPIED_LINE}\n` },
    );
  },
);

Deno.test(
  "Push table: --whole-file skills/design-issue/SKILL.md, the file holding only a pointer to the design section -> pass",
  async () => {
    await withPushFixture(
      ({ designRoot, designDocPath, repoDir }) => {
        Deno.writeTextFileSync(
          path.join(repoDir, "skills/design-issue/SKILL.md"),
          `# Design Issue\n\nFollow \`${designDocPath}\` ("What it is") for the rule.\n`,
        );
        const res = checkCopies({
          repoDir,
          wholeFiles: ["skills/design-issue/SKILL.md"],
          dropboxDir: designRoot,
        });
        assertEquals(res.ok, true);
        assertEquals(res.violations, []);
      },
    );
  },
);

Deno.test(
  "Push table: --whole-file skills/design-issue/SKILL.md --whole-file AGENTS.md, the line only in AGENTS.md -> refuse, naming AGENTS.md",
  async () => {
    await withPushFixture(
      ({ designRoot, designDocPath, repoDir }) => {
        const errors: string[] = [];
        const exitCode = runCheckCopiesCli(
          [
            "--repo",
            repoDir,
            "--whole-file",
            "skills/design-issue/SKILL.md",
            "--whole-file",
            "AGENTS.md",
            "--dropbox-dir",
            designRoot,
          ],
          { errorLog: (m) => errors.push(m) },
        );
        assertEquals(exitCode, 1);
        const errText = errors.join("\n");
        assertStringIncludes(errText, "AGENTS.md");
        assertStringIncludes(errText, designDocPath);
        assertStringIncludes(errText, COPIED_LINE);
        assertEquals(errText.includes("skills/design-issue/SKILL.md"), false);
      },
      {
        "skills/design-issue/SKILL.md": "# Design Issue\n\nClean pointer only.\n",
        "AGENTS.md": `# Agents\n\n${COPIED_LINE}\n`,
      },
    );
  },
);

Deno.test(
  "Push table: --whole-file skills/no-such/SKILL.md -> refuse, naming the file it could not read",
  async () => {
    await withPushFixture(({ designRoot, repoDir }) => {
      const errors: string[] = [];
      const exitCode = runCheckCopiesCli(
        [
          "--repo",
          repoDir,
          "--whole-file",
          "skills/no-such/SKILL.md",
          "--dropbox-dir",
          designRoot,
        ],
        { errorLog: (m) => errors.push(m) },
      );
      assertEquals(exitCode, 1);
      assertStringIncludes(errors.join("\n"), "skills/no-such/SKILL.md");
    });
  },
);

Deno.test(
  "cli check-copies default branch mode detects added copy in throwaway repo and passes after deletion",
  async () => {
    await withPushFixture(async ({ designRoot, designDocPath, repoDir }) => {
      const skillPath = path.join(repoDir, "skills/design-issue/SKILL.md");
      await Deno.writeTextFile(skillPath, `# Design Issue\n\n${COPIED_LINE}\n`);

      const prevRoot = Deno.env.get("DESIGN_DOCS_ROOT");
      const prevCwd = Deno.cwd();
      Deno.env.set("DESIGN_DOCS_ROOT", designRoot);
      Deno.chdir(repoDir);
      try {
        const failOut = new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            path.join(ROOT_DIR, "src/design-issue/cli.ts"),
            "check-copies",
          ],
          cwd: repoDir,
          env: { ...Deno.env.toObject(), DESIGN_DOCS_ROOT: designRoot },
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).outputSync();
        assertEquals(failOut.code, 1);
        const stderr = new TextDecoder().decode(failOut.stderr);
        assertStringIncludes(stderr, "skills/design-issue/SKILL.md");
        assertStringIncludes(stderr, designDocPath);
        assertStringIncludes(stderr, COPIED_LINE);

        await Deno.writeTextFile(skillPath, "# Design Issue\n\nFollow these steps.\n");
        const passCode = await runCli(["check-copies"]);
        assertEquals(passCode, 0);
      } finally {
        Deno.chdir(prevCwd);
        if (prevRoot === undefined) Deno.env.delete("DESIGN_DOCS_ROOT");
        else Deno.env.set("DESIGN_DOCS_ROOT", prevRoot);
      }
    });
  },
);

Deno.test("check-copies CLI supports --help and rejects combining --whole-file and --range", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  assertEquals(runCheckCopiesCli(["--help"], { log: (m) => logs.push(m) }), 0);
  assertStringIncludes(logs.join("\n"), "--whole-file");

  await withPushFixture(({ designRoot, repoDir, baseSha }) => {
    const code = runCheckCopiesCli(
      [
        "--repo",
        repoDir,
        "--range",
        `${baseSha}..HEAD`,
        "--whole-file",
        "skills/design-issue/SKILL.md",
        "--dropbox-dir",
        designRoot,
      ],
      { errorLog: (m) => errors.push(m) },
    );
    assertEquals(code, 1);
    assertStringIncludes(errors.join("\n"), "--whole-file and --range cannot be combined");
  });
});

Deno.test("merge commit introducing copied wording is refused for both old..merge-tip and merge-tip --not --remotes", async () => {
  await withPushFixture(async ({ designRoot, designDocPath, repoDir, baseSha }) => {
    const branchA = await writeAndCommit(
      repoDir,
      { "docs/branch-a.md": "# Branch A\n\nClean text A.\n" },
      "clean branch A",
    );
    git(repoDir, ["checkout", "-q", "-b", "feat/branch-b", baseSha]);
    await writeAndCommit(
      repoDir,
      { "docs/branch-b.md": "# Branch B\n\nClean text B.\n" },
      "clean branch B",
    );
    git(repoDir, ["checkout", "-q", "feat/copy-test"]);
    git(repoDir, ["merge", "--no-commit", "--no-ff", "feat/branch-b"]);
    const mergeGuide = path.join(repoDir, "docs/merge-guide.md");
    await Deno.writeTextFile(mergeGuide, `# Merge Guide\n\n${COPIED_LINE}\n`);
    git(repoDir, ["add", "docs/merge-guide.md"]);
    git(repoDir, ["commit", "-m", "merge branch B with copied wording"]);
    const mergeTip = git(repoDir, ["rev-parse", "HEAD"]);

    for (const range of [`${branchA}..${mergeTip}`, `${mergeTip} --not --remotes`]) {
      const res = checkCopies({ repoDir, range, dropboxDir: designRoot });
      assertEquals(res.ok, false, `Expected refusal for range: ${range}`);
      assertStringIncludes(res.violations[0].message, "docs/merge-guide.md");
      assertStringIncludes(res.violations[0].message, designDocPath);
      assertStringIncludes(res.violations[0].message, COPIED_LINE);
    }
  });
});

Deno.test("unrelated feature merging existing copy from dev is allowed on old..merge-tip and merge-tip --not --remotes", async () => {
  await withPushFixture(async ({ designRoot, repoDir }) => {
    // Feature branches off baseSha and pushes its own clean commit
    const oldFeat = await writeAndCommit(
      repoDir,
      { "src/feature.ts": "export const f = 1;\n" },
      "clean feature commit",
    );

    // Meanwhile dev lands an existing copy in docs/existing.md
    git(repoDir, ["checkout", "-q", "dev"]);
    await writeAndCommit(
      repoDir,
      { "docs/existing.md": `# Existing\n\n${COPIED_LINE}\n` },
      "pre-existing copy on dev",
    );

    // Feature merges dev and pushes oldFeat..mergeTip
    git(repoDir, ["checkout", "-q", "feat/copy-test"]);
    git(repoDir, ["merge", "--no-edit", "dev"]);
    const mergeTip = git(repoDir, ["rev-parse", "HEAD"]);

    for (const range of [`${oldFeat}..${mergeTip}`, `${mergeTip} --not --remotes`]) {
      const res = checkCopies({ repoDir, range, dropboxDir: designRoot });
      assertEquals(res.ok, true, `Unexpected violation for ${range}: ${JSON.stringify(res)}`);
    }

    // Same check with a bare remote where origin/dev and origin/feat exist
    const bareDir = path.join(path.dirname(repoDir), "bare.git");
    git(repoDir, ["init", "--bare", "-q", bareDir]);
    git(repoDir, ["remote", "add", "origin", bareDir]);
    git(repoDir, ["push", "-q", "origin", "dev"]);
    git(repoDir, ["push", "-q", "origin", `${oldFeat}:refs/heads/feat/copy-test`]);

    const resRemote = checkCopies({
      repoDir,
      range: `${oldFeat}..${mergeTip}`,
      dropboxDir: designRoot,
    });
    assertEquals(resRemote.ok, true);
    const resNew = checkCopies({
      repoDir,
      range: `${mergeTip} --not --remotes`,
      dropboxDir: designRoot,
    });
    assertEquals(resNew.ok, true);
  });
});

Deno.test("feature that adds then removes a copy before merging dev is allowed", async () => {
  await withPushFixture(async ({ designRoot, repoDir, baseSha }) => {
    await writeAndCommit(
      repoDir,
      { "docs/draft.md": `# Draft\n\n${COPIED_LINE}\n` },
      "temporarily add copy",
    );
    await writeAndCommit(
      repoDir,
      { "docs/draft.md": "# Draft\n\nClean replacement.\n" },
      "remove copy before merge",
    );

    git(repoDir, ["checkout", "-q", "dev"]);
    await writeAndCommit(
      repoDir,
      { "docs/unrelated.md": "# Unrelated\n\nClean dev line.\n" },
      "advance dev",
    );

    git(repoDir, ["checkout", "-q", "feat/copy-test"]);
    git(repoDir, ["merge", "--no-edit", "dev"]);
    const mergeTip = git(repoDir, ["rev-parse", "HEAD"]);

    const res = checkCopies({
      repoDir,
      range: `${baseSha}..${mergeTip}`,
      dropboxDir: designRoot,
    });
    assertEquals(res.ok, true, JSON.stringify(res));
  });
});

Deno.test("unavailable design-documents root is refused while existing empty root passes", async () => {
  await withPushFixture(async ({ designRoot, repoDir, baseSha }) => {
    const headSha = await writeAndCommit(
      repoDir,
      { "docs/guide.md": `# Guide\n\n${COPIED_LINE}\n` },
      "add copied line to docs/guide.md",
    );
    const missingRoot = path.join(path.dirname(designRoot), "missing-design-docs");
    const errors: string[] = [];
    const exitCode = runCheckCopiesCli(
      ["--repo", repoDir, "--range", `${baseSha}..${headSha}`, "--dropbox-dir", missingRoot],
      { errorLog: (m) => errors.push(m) },
    );
    assertEquals(exitCode, 1);
    assertStringIncludes(errors.join("\n"), missingRoot);

    const emptyRoot = path.join(path.dirname(designRoot), "empty-design-docs");
    await Deno.mkdir(emptyRoot, { recursive: true });
    const emptyRes = checkCopies({
      repoDir,
      range: `${baseSha}..${headSha}`,
      dropboxDir: emptyRoot,
    });
    assertEquals(emptyRes.ok, true);
  });
});
