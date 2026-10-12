// test/consume_memory_rules_script.test.ts — web-jam-tools#499
// Tests for scripts/consume_memory_rules.ts and scripts/consume-memory-rules.sh

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  captureAndVerifyRulesInDesignDoc,
  capturedRulesPathForDesignDoc,
  findDanglingLinks,
  isValidSlug,
  parsePlanInput,
  runConsumeMemoryRules,
  stripSlugsFromMemoryMd,
} from "../scripts/consume_memory_rules.ts";

const REPO_ROOT = new URL("../", import.meta.url).pathname;
const SCRIPT_SH_PATH = join(REPO_ROOT, "scripts", "consume-memory-rules.sh");

// Force trash commands to fall back to a HOME inside the fixture, never the user's trash.
async function executeFixturePlan(planPath: string, tempDir: string, denyWrite?: string) {
  return await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      ...(denyWrite ? [`--deny-write=${denyWrite}`] : []),
      join(REPO_ROOT, "scripts", "consume_memory_rules.ts"),
      planPath,
      "--delete",
    ],
    env: { HOME: tempDir, PATH: tempDir },
    stdout: "piped",
    stderr: "piped",
  }).output();
}

Deno.test("captured-rules path uses the topic beside current and legacy design filenames", () => {
  assertEquals(
    capturedRulesPathForDesignDoc("Theme/my-topic-design.md"),
    "Theme/my-topic-captured-rules.md",
  );
  assertEquals(
    capturedRulesPathForDesignDoc("Theme/design-issue-file-issue-design-2026-08-23.md"),
    "Theme/design-issue-file-issue-captured-rules.md",
  );
  assertEquals(capturedRulesPathForDesignDoc("Theme/topic.md"), "Theme/topic-captured-rules.md");
});

Deno.test("parsePlanInput handles JSON and YAML objects and arrays", () => {
  const jsonArray = JSON.stringify([
    { slug: "rule-1", disposition: "consume", target_skill: "skills/design-issue/SKILL.md" },
    { slug: "rule-2", disposition: "delete" },
  ]);
  const parsed1 = parsePlanInput(jsonArray);
  assertEquals(parsed1.rules.length, 2);
  assertEquals(parsed1.rules[0].slug, "rule-1");

  const jsonObject = JSON.stringify({
    design_doc: "doc.md",
    memory_dir: "memory/",
    rules: [{ slug: "rule-3", disposition: "stay" }],
  });
  const parsed2 = parsePlanInput(jsonObject);
  assertEquals(parsed2.design_doc, "doc.md");
  assertEquals(parsed2.rules.length, 1);

  const yamlInput = `
design_doc: doc.md
rules:
  - slug: rule-yaml
    disposition: delete
`;
  const parsed3 = parsePlanInput(yamlInput);
  assertEquals(parsed3.rules[0].slug, "rule-yaml");
});

Deno.test("findDanglingLinks correctly detects inbound [[slug]] wikilinks", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "file1.md"),
      `# Header\nLine 2 mentions [[target-slug]].\nLine 3 is clean.`,
    );
    await Deno.writeTextFile(
      join(tempDir, "file2.md"),
      `Line 1 has [[target-slug|alias]] and [[other-slug]].`,
    );

    const removedSlugs = new Set(["target-slug"]);
    const matches = await findDanglingLinks(tempDir, removedSlugs);

    assertEquals(matches.length, 2);
    const file1Match = matches.find((m) => m.file === "file1.md");
    assert(file1Match);
    assertEquals(file1Match.line, 2);
    assertEquals(file1Match.slug, "target-slug");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("stripSlugsFromMemoryMd removes only approved slugs and preserves structure", () => {
  const memoryMdContent = `# Memory Index

## Project

alpha-rule · beta-rule · gamma-rule
delta-rule

- [session-checkpoint-1](session-checkpoint-1.md) — active session
`;

  const removed = new Set(["beta-rule"]);
  const updated = stripSlugsFromMemoryMd(memoryMdContent, removed);

  assert(!updated.includes("beta-rule"));
  assertStringIncludes(updated, "alpha-rule · gamma-rule");
  assertStringIncludes(updated, "delta-rule");
  assertStringIncludes(updated, "## Project");
  assertStringIncludes(updated, "session-checkpoint-1");
});

Deno.test("captureAndVerifyRulesInDesignDoc refuses on capture mismatch", () => {
  const sourceContent = "Rule 1: Always enforce engineering rigor.";

  // Fixture design doc with mismatched/corrupted captured content
  const startTag = "<!-- START_CAPTURED_RULE:rule-1 -->";
  const endTag = "<!-- END_CAPTURED_RULE:rule-1 -->";
  const corruptedDesignDoc = `## Appendix
### Captured Rule: \`rule-1\`
${startTag}
Corrupted content!
${endTag}
`;

  try {
    captureAndVerifyRulesInDesignDoc(corruptedDesignDoc, [
      { slug: "rule-1", target_skill: "skills/design-issue/SKILL.md", sourceContent },
    ]);
    assert(
      false,
      "Expected captureAndVerifyRulesInDesignDoc to throw error on byte/content mismatch",
    );
  } catch (err) {
    assertStringIncludes(
      (err as Error).message,
      "Capture byte verification failed for slug 'rule-1'",
    );
  }
});

Deno.test("runConsumeMemoryRules --dry-run (default) verifies without modifying files", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const memoryDir = join(tempDir, "memory");
    await Deno.mkdir(memoryDir);

    const designDocPath = join(tempDir, "design_doc.md");
    await Deno.writeTextFile(designDocPath, "# Design Document\n\nInitial content.\n");

    const memoryFile1 = join(memoryDir, "rule-consume.md");
    await Deno.writeTextFile(memoryFile1, "Rule consume content.");

    const memoryFile2 = join(memoryDir, "rule-delete.md");
    await Deno.writeTextFile(memoryFile2, "Rule delete content.");

    const memoryMdPath = join(memoryDir, "MEMORY.md");
    await Deno.writeTextFile(
      memoryMdPath,
      "# Memory Index\n\nrule-consume · rule-delete · rule-stay\n",
    );

    const planPath = join(tempDir, "plan.json");
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        design_doc: designDocPath,
        memory_dir: memoryDir,
        rules: [
          {
            slug: "rule-consume",
            disposition: "consume",
            target_skill: "skills/design-issue/SKILL.md",
          },
          { slug: "rule-delete", disposition: "delete" },
        ],
      }),
    );

    // Run with dryRun default (delete: false)
    const result = await runConsumeMemoryRules({ planPath });
    assertEquals(result.dryRun, true);
    assertStringIncludes(result.summary, "Mode: DRY RUN");
    assertStringIncludes(result.summary, "rule-consume");
    assertStringIncludes(result.summary, "rule-delete");

    // Verify no files were moved or changed
    const stat1 = await Deno.stat(memoryFile1);
    assert(stat1.isFile);
    const stat2 = await Deno.stat(memoryFile2);
    assert(stat2.isFile);

    assertEquals(await Deno.readTextFile(designDocPath), "# Design Document\n\nInitial content.\n");
    await assertRejects(
      () => Deno.stat(join(tempDir, "design_doc-captured-rules.md")),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runConsumeMemoryRules --delete executes capture, MEMORY.md strip, and moves files to trash", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const memoryDir = join(tempDir, "memory");
    await Deno.mkdir(memoryDir);

    const designDocPath = join(tempDir, "my-topic-design.md");
    const designBytes = new TextEncoder().encode(
      "# Design Document\r\n\r\nApproved café design.\r\n\r\n<!-- START_CAPTURED_RULE:legacy-rule -->\r\nLegacy capture stays here.\r\n<!-- END_CAPTURED_RULE:legacy-rule -->\r\n",
    );
    await Deno.writeFile(designDocPath, designBytes);
    const capturedRulesPath = join(tempDir, "my-topic-captured-rules.md");

    const memoryFile1 = join(memoryDir, "rule-consume.md");
    const source1Text = "\uFEFFRule consume content: café, byte verified.\r\n";
    await Deno.writeTextFile(memoryFile1, source1Text);

    const memoryFile2 = join(memoryDir, "rule-delete.md");
    await Deno.writeTextFile(memoryFile2, "Rule delete content.");

    const memoryMdPath = join(memoryDir, "MEMORY.md");
    await Deno.writeTextFile(
      memoryMdPath,
      "# Memory Index\n\nrule-consume · rule-delete · rule-stay\n",
    );

    const planPath = join(tempDir, "plan.json");
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        design_doc: designDocPath,
        memory_dir: memoryDir,
        rules: [
          {
            slug: "rule-consume",
            disposition: "consume",
            target_skill: "skills/design-issue/SKILL.md",
          },
          { slug: "rule-delete", disposition: "delete" },
        ],
      }),
    );

    // Execute with delete: true
    const result = await executeFixturePlan(planPath, tempDir);
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    const summary = new TextDecoder().decode(result.stdout);
    assertStringIncludes(summary, "Mode: EXECUTE");
    assertStringIncludes(summary, `Captured-rules file: ${capturedRulesPath}`);

    // 1. Verify memory files are no longer in memoryDir
    let exists1 = true;
    try {
      await Deno.stat(memoryFile1);
    } catch {
      exists1 = false;
    }
    assert(!exists1, "rule-consume.md should be moved out of memoryDir to trash");

    let exists2 = true;
    try {
      await Deno.stat(memoryFile2);
    } catch {
      exists2 = false;
    }
    assert(!exists2, "rule-delete.md should be moved out of memoryDir to trash");

    // 2. Verify MEMORY.md lost exactly the approved slugs
    const updatedMemoryMd = await Deno.readTextFile(memoryMdPath);
    assert(!updatedMemoryMd.includes("rule-consume"));
    assert(!updatedMemoryMd.includes("rule-delete"));
    assertStringIncludes(updatedMemoryMd, "rule-stay");

    // 3. Verify the sibling record gained the capture and the design bytes stayed unchanged.
    assertEquals(await Deno.readFile(designDocPath), designBytes);
    const capturedText = await Deno.readTextFile(capturedRulesPath);
    assertStringIncludes(capturedText, "### Captured Rule: `rule-consume`");
    assertStringIncludes(capturedText, source1Text);
    assert(!capturedText.includes("legacy-rule"));
    assertEquals(
      await Deno.readFile(join(tempDir, ".local/share/Trash/files/rule-consume.md")),
      new TextEncoder().encode(source1Text),
    );

    // Re-run captureAndVerifyRulesInDesignDoc to assert byte verification passes
    const reVerify = captureAndVerifyRulesInDesignDoc(capturedText, [
      {
        slug: "rule-consume",
        target_skill: "skills/design-issue/SKILL.md",
        sourceContent: source1Text,
      },
    ]);
    assertEquals(reVerify.verifiedCount, 1);

    // A later run adds another capture to the same record and preserves the first capture.
    const source2Text = "Second rule, with no trailing newline.";
    await Deno.writeTextFile(join(memoryDir, "second-rule.md"), source2Text);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        design_doc: designDocPath,
        memory_dir: memoryDir,
        rules: [{ slug: "second-rule", disposition: "consume" }],
      }),
    );
    const secondResult = await executeFixturePlan(planPath, tempDir);
    assertEquals(secondResult.code, 0, new TextDecoder().decode(secondResult.stderr));
    const appendedText = await Deno.readTextFile(capturedRulesPath);
    assertStringIncludes(appendedText, capturedText.trimEnd());
    assertEquals(
      captureAndVerifyRulesInDesignDoc(appendedText, [
        { slug: "rule-consume", sourceContent: source1Text },
        { slug: "second-rule", sourceContent: source2Text },
      ]).verifiedCount,
      2,
    );
    assertEquals(await Deno.readFile(designDocPath), designBytes);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runConsumeMemoryRules stops when a slug is absent from memory directory", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const memoryDir = join(tempDir, "memory");
    await Deno.mkdir(memoryDir);

    const planPath = join(tempDir, "plan.json");
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        memory_dir: memoryDir,
        rules: [{ slug: "absent-slug", disposition: "delete" }],
      }),
    );

    await assertRejects(
      async () => {
        await runConsumeMemoryRules({ planPath });
      },
      Error,
      "absent from memory directory",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

for (
  const failure of [
    "write-denied",
    "readback-mismatch",
    "directory",
    "symlink",
    "hardlink",
    "corrupt-capture",
  ] as const
) {
  Deno.test(`capture ${failure} refuses before any memory or index changes`, async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      const memoryDir = join(tempDir, "memory");
      await Deno.mkdir(memoryDir);
      const designDocPath = join(tempDir, "topic-design.md");
      const designBytes = new TextEncoder().encode("# Approved design\r\n\r\nUnchanged.\r\n");
      await Deno.writeFile(designDocPath, designBytes);
      const capturePath = join(tempDir, "topic-captured-rules.md");
      const sourceText = "Original consumed rule.\n";
      await Deno.writeTextFile(join(memoryDir, "consume-rule.md"), sourceText);
      await Deno.writeTextFile(join(memoryDir, "delete-rule.md"), "Original deleted rule.\n");
      const indexText = "# Memory Index\n\nconsume-rule · delete-rule\n";
      await Deno.writeTextFile(join(memoryDir, "MEMORY.md"), indexText);
      const planPath = join(tempDir, "plan.json");
      await Deno.writeTextFile(
        planPath,
        JSON.stringify({
          design_doc: designDocPath,
          memory_dir: memoryDir,
          rules: [
            { slug: "consume-rule", disposition: "consume" },
            { slug: "delete-rule", disposition: "delete" },
          ],
        }),
      );

      if (failure === "directory") await Deno.mkdir(capturePath);
      if (failure === "symlink") await Deno.symlink(designDocPath, capturePath);
      if (failure === "hardlink") await Deno.link(designDocPath, capturePath);
      if (failure === "corrupt-capture") {
        await Deno.writeTextFile(
          capturePath,
          "<!-- START_CAPTURED_RULE:consume-rule -->\nWrong copy.\n<!-- END_CAPTURED_RULE:consume-rule -->\n",
        );
      }
      if (failure === "readback-mismatch") {
        const originalReadFile = Deno.readFile;
        Deno.readFile = (path, options) =>
          path === capturePath
            ? Promise.resolve(new Uint8Array())
            : originalReadFile(path, options);
        try {
          await assertRejects(
            () => runConsumeMemoryRules({ planPath, delete: true }),
            Error,
            "Capture byte verification failed after writing",
          );
        } finally {
          Deno.readFile = originalReadFile;
        }
      } else {
        const result = await executeFixturePlan(
          planPath,
          tempDir,
          failure === "write-denied" ? capturePath : undefined,
        );
        assertEquals(result.code, 1);
        const errorText = new TextDecoder().decode(result.stderr);
        assertStringIncludes(
          errorText,
          failure === "write-denied"
            ? "Cannot persist captured-rules file"
            : failure === "corrupt-capture"
            ? "Capture byte verification failed"
            : "Captured-rules file",
        );
      }
      assertEquals(await Deno.readFile(designDocPath), designBytes);
      assertEquals(await Deno.readTextFile(join(memoryDir, "consume-rule.md")), sourceText);
      assertEquals(
        await Deno.readTextFile(join(memoryDir, "delete-rule.md")),
        "Original deleted rule.\n",
      );
      assertEquals(await Deno.readTextFile(join(memoryDir, "MEMORY.md")), indexText);
      await assertRejects(
        () => Deno.stat(join(tempDir, ".local/share/Trash")),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });
}

Deno.test("runConsumeMemoryRules stops when design document is unreadable or missing for consume rules", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const memoryDir = join(tempDir, "memory");
    await Deno.mkdir(memoryDir);
    await Deno.writeTextFile(join(memoryDir, "rule-1.md"), "content");

    const planPath = join(tempDir, "plan.json");
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        design_doc: join(tempDir, "non_existent_doc.md"),
        memory_dir: memoryDir,
        rules: [{ slug: "rule-1", disposition: "consume" }],
      }),
    );

    await assertRejects(
      async () => {
        await runConsumeMemoryRules({ planPath });
      },
      Error,
      "unreadable or missing",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("shell wrapper scripts/consume-memory-rules.sh runs dry-run by default and --delete on flag", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const memoryDir = join(tempDir, "memory");
    await Deno.mkdir(memoryDir);

    const designDocPath = join(tempDir, "design_doc.md");
    await Deno.writeTextFile(designDocPath, "# Design Doc\n");

    const memoryFile = join(memoryDir, "sh-test-rule.md");
    await Deno.writeTextFile(memoryFile, "Shell wrapper test rule content.");

    const memoryMdPath = join(memoryDir, "MEMORY.md");
    await Deno.writeTextFile(memoryMdPath, "# Memory Index\n\nsh-test-rule\n");

    const planPath = join(tempDir, "plan.json");
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        design_doc: designDocPath,
        memory_dir: memoryDir,
        rules: [{
          slug: "sh-test-rule",
          disposition: "consume",
          target_skill: "skills/design-issue/SKILL.md",
        }],
      }),
    );

    // 1. Dry run via shell wrapper
    const dryRunCmd = new Deno.Command("/bin/bash", {
      args: [SCRIPT_SH_PATH, planPath],
      env: {
        HOME: tempDir,
        XDG_DATA_HOME: join(tempDir, ".local/share"),
        DENO_BIN: Deno.execPath(),
      },
      stdout: "piped",
      stderr: "piped",
    });
    const dryRunOut = await dryRunCmd.output();
    assertEquals(dryRunOut.code, 0);
    const dryRunOutputStr = new TextDecoder().decode(dryRunOut.stdout);
    assertStringIncludes(dryRunOutputStr, "Mode: DRY RUN");

    // File should still exist
    const statBefore = await Deno.stat(memoryFile);
    assert(statBefore.isFile);

    // 2. Delete run via shell wrapper
    const deleteCmd = new Deno.Command("/bin/bash", {
      args: [SCRIPT_SH_PATH, planPath, "--delete"],
      env: {
        HOME: tempDir,
        XDG_DATA_HOME: join(tempDir, ".local/share"),
        DENO_BIN: Deno.execPath(),
      },
      stdout: "piped",
      stderr: "piped",
    });
    const deleteOut = await deleteCmd.output();
    assertEquals(deleteOut.code, 0);
    const deleteOutputStr = new TextDecoder().decode(deleteOut.stdout);
    assertStringIncludes(deleteOutputStr, "Mode: EXECUTE");

    // File should be moved out to trash
    let fileExistsAfter = true;
    try {
      await Deno.stat(memoryFile);
    } catch {
      fileExistsAfter = false;
    }
    assert(!fileExistsAfter);
    assertEquals(await Deno.readTextFile(designDocPath), "# Design Doc\n");
    assertStringIncludes(
      await Deno.readTextFile(join(tempDir, "design_doc-captured-rules.md")),
      "Shell wrapper test rule content.",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("isValidSlug validates safe slugs and rejects invalid/path-traversal identifiers", () => {
  // Valid slugs
  assert(isValidSlug("rule-1"));
  assert(isValidSlug("alpha_beta"));
  assert(isValidSlug("gamma-123"));
  assert(isValidSlug("Rule123_test"));

  // Malicious / invalid slugs
  assert(!isValidSlug("../../../etc/passwd"));
  assert(!isValidSlug("foo/bar"));
  assert(!isValidSlug(".."));
  assert(!isValidSlug(""));
  assert(!isValidSlug(".hidden"));
  assert(!isValidSlug("rule with spaces"));
  assert(!isValidSlug("-leading-dash"));
  assert(!isValidSlug("_leading_underscore"));
});

Deno.test("captureAndVerifyRulesInDesignDoc rejects invalid slug identifier", () => {
  try {
    captureAndVerifyRulesInDesignDoc("# Design Doc\n", [
      { slug: "../../../etc/passwd", sourceContent: "malicious" },
    ]);
    assert(false, "Expected captureAndVerifyRulesInDesignDoc to throw on invalid slug");
  } catch (err) {
    assertStringIncludes((err as Error).message, "Invalid slug '../../../etc/passwd'");
  }
});

Deno.test("runConsumeMemoryRules rejects plans with malicious path-traversal slugs", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const memoryDir = join(tempDir, "memory");
    await Deno.mkdir(memoryDir);

    const traversalPlan = join(tempDir, "traversal-plan.json");
    await Deno.writeTextFile(
      traversalPlan,
      JSON.stringify({
        memory_dir: memoryDir,
        rules: [{ slug: "../../../etc/passwd", disposition: "delete" }],
      }),
    );

    await assertRejects(
      async () => {
        await runConsumeMemoryRules({ planPath: traversalPlan });
      },
      Error,
      "Invalid slug '../../../etc/passwd' in plan. Slugs must match /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/ and cannot contain path separators or parent directory segments.",
    );

    const subpathPlan = join(tempDir, "subpath-plan.json");
    await Deno.writeTextFile(
      subpathPlan,
      JSON.stringify({
        memory_dir: memoryDir,
        rules: [{ slug: "foo/bar", disposition: "delete" }],
      }),
    );

    await assertRejects(
      async () => {
        await runConsumeMemoryRules({ planPath: subpathPlan });
      },
      Error,
      "Invalid slug 'foo/bar' in plan. Slugs must match /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/ and cannot contain path separators or parent directory segments.",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
