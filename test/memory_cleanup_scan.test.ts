// test/memory_cleanup_scan.test.ts — web-jam-tools#1166
//
// Unit tests for src/memory-cleanup/scan.ts and cli.ts. No network, no real
// `gh` binary — every `gh` shell-out goes through an injected CommandRunner
// with a fake implementation. Covers the mechanical Phase 1 checks for
// surfaces 1, 6, and 10: a dangling [[link]], an unparseable memory file, a
// project memory citing a closed issue, a surface-6 line citing a merged PR,
// and a gh lookup failure surfacing as an explicit `error` finding rather
// than being dropped or counted as clean.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type CommandResult,
  type CommandRunner,
  containsWholeSlug,
  DEFAULT_QUEUE_FILENAMES,
  extractGhRefs,
  extractLinkedSlugs,
  type Finding,
  runMemoryCleanupScan,
  scanMemoryIndexSurface,
  scanQueueSurface,
  type SurfaceCheckedResult,
} from "../src/memory-cleanup/scan.ts";
import { runCli } from "../src/memory-cleanup/cli.ts";

// --- test helpers ---

interface GhRule {
  type: "issue" | "pr";
  repo: string;
  number: number;
  result: CommandResult;
}

/** A fake CommandRunner driven by explicit (type, repo, number) -> result rules. */
function makeFakeRunner(rules: GhRule[]): CommandRunner {
  return (args: string[]): Promise<CommandResult> => {
    const type = args[0];
    const number = Number(args[2]);
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] : "";
    const rule = rules.find(
      (r) => r.type === type && r.number === number && repo === `WebJamApps/${r.repo}`,
    );
    if (rule) return Promise.resolve(rule.result);
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: `no mock for ${type} view ${number} repo ${repo}`,
    });
  };
}

const NO_CALLS_RUNNER: CommandRunner = () => {
  throw new Error("gh should not have been called in this test");
};

function jsonResult(obj: unknown): CommandResult {
  return { code: 0, stdout: JSON.stringify(obj), stderr: "" };
}

function failResult(stderr: string): CommandResult {
  return { code: 1, stdout: "", stderr };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function assertChecked(result: { status: string }): asserts result is SurfaceCheckedResult {
  assertEquals(result.status, "checked");
}

function findByKind(findings: Finding[], kind: Finding["kind"]): Finding[] {
  return findings.filter((f) => f.kind === kind);
}

// --- extractGhRefs ---

Deno.test("extractGhRefs: extracts repo#number citations gated to the known repo roster", () => {
  const text =
    "Merged as web-jam-tools#1121, see also JaMmusic#1250 and CollegeLutheran#42. Not a citation: issue #43, PR #44, fooBar#99.";
  const refs = extractGhRefs(text);
  assertEquals(refs.length, 3);
  assert(refs.some((r) => r.repo === "web-jam-tools" && r.number === 1121));
  assert(refs.some((r) => r.repo === "JaMmusic" && r.number === 1250));
  assert(refs.some((r) => r.repo === "CollegeLutheran" && r.number === 42));
});

Deno.test("extractGhRefs: dedupes repeated citations", () => {
  const text = "web-jam-tools#100 mentioned twice: web-jam-tools#100 again.";
  const refs = extractGhRefs(text);
  assertEquals(refs.length, 1);
});

// --- extractLinkedSlugs / containsWholeSlug ---

Deno.test("extractLinkedSlugs: pulls every [[slug]] token, deduped", () => {
  const text = "See [[foo-bar]] and [[baz-qux]], and [[foo-bar]] again.";
  assertEquals(extractLinkedSlugs(text), ["foo-bar", "baz-qux"]);
});

Deno.test("containsWholeSlug: matches whole tokens only, not substrings of longer slugs", () => {
  assert(containsWholeSlug("see verify-dont-assume in the index", "verify-dont-assume"));
  assert(
    !containsWholeSlug("see never-verify-dont-assume-anything in the index", "verify-dont-assume"),
  );
  assert(containsWholeSlug("[Title](my-slug.md)", "my-slug"));
  assert(containsWholeSlug("my-slug is at start", "my-slug"));
  assert(containsWholeSlug("is at end my-slug", "my-slug"));
  assert(containsWholeSlug("my-slug", "my-slug"));
  assert(containsWholeSlug("prefix-my-slug but then my-slug", "my-slug"));
  assert(!containsWholeSlug("just prefix-my-slug", "my-slug"));
  assert(!containsWholeSlug("just my-slug-suffix", "my-slug"));
  assert(!containsWholeSlug("empty slug search", ""));
});

// --- scanMemoryIndexSurface ---

Deno.test("scanMemoryIndexSurface: reports an unparseable memory file", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "no-frontmatter.md"), "Just plain text, no frontmatter.\n");
    await Deno.writeTextFile(join(dir, "MEMORY.md"), "# Memory Index\n\nno-frontmatter\n");
    const result = await scanMemoryIndexSurface(1, dir, NO_CALLS_RUNNER);
    assertChecked(result);
    const unparseable = findByKind(result.findings, "unparseable-file");
    assertEquals(unparseable.length, 1);
    assertStringIncludes(unparseable[0].detail, "no-frontmatter.md");
    assertEquals(result.metrics.skippedCount, 1);
  });
});

Deno.test("scanMemoryIndexSurface: reports a dangling [[link]]", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "some-memory.md"),
      `---\nname: some-memory\ndescription: "d"\nmetadata:\n  type: feedback\n---\nSee [[nonexistent-target]] for details.\n`,
    );
    await Deno.writeTextFile(join(dir, "MEMORY.md"), "# Memory Index\n\nsome-memory\n");
    const result = await scanMemoryIndexSurface(1, dir, NO_CALLS_RUNNER);
    assertChecked(result);
    const dangling = findByKind(result.findings, "dangling-link");
    assertEquals(dangling.length, 1);
    assertStringIncludes(dangling[0].detail, "nonexistent-target");
    assertStringIncludes(dangling[0].detail, "some-memory.md");
  });
});

Deno.test("scanMemoryIndexSurface: a real inbound [[link]] is counted, not flagged dangling", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "a.md"),
      `---\nname: a\ndescription: "d"\nmetadata:\n  type: feedback\n---\nSee [[b]].\n`,
    );
    await Deno.writeTextFile(
      join(dir, "b.md"),
      `---\nname: b\ndescription: "d"\nmetadata:\n  type: feedback\n---\nBody.\n`,
    );
    await Deno.writeTextFile(join(dir, "MEMORY.md"), "# Memory Index\n\na · b\n");
    const result = await scanMemoryIndexSurface(1, dir, NO_CALLS_RUNNER);
    assertChecked(result);
    assertEquals(findByKind(result.findings, "dangling-link").length, 0);
    assertEquals(result.metrics.inboundLinkCounts["b"], 1);
    assertEquals(result.metrics.inboundLinkCounts["a"], 0);
  });
});

Deno.test("scanMemoryIndexSurface: flags a file present on disk but missing from MEMORY.md", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "orphaned.md"),
      `---\nname: orphaned\ndescription: "d"\nmetadata:\n  type: feedback\n---\nBody.\n`,
    );
    await Deno.writeTextFile(join(dir, "MEMORY.md"), "# Memory Index\n\n(nothing relevant here)\n");
    const result = await scanMemoryIndexSurface(1, dir, NO_CALLS_RUNNER);
    assertChecked(result);
    const missing = findByKind(result.findings, "missing-from-index");
    assertEquals(missing.length, 1);
    assertStringIncludes(missing[0].detail, "orphaned.md");
  });
});

Deno.test("scanMemoryIndexSurface: index↔file sync finds no missing entries when every slug is present", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "design-work-runs-through-design-issue.md"),
      `---\nname: design-work-runs-through-design-issue\ndescription: "d"\nmetadata:\n  type: feedback\n---\nBody.\n`,
    );
    await Deno.writeTextFile(
      join(dir, "session-checkpoint-pr-1121-chunked-dispatch.md"),
      `---\nname: session-checkpoint-pr-1121-chunked-dispatch\ndescription: "d"\nmetadata:\n  type: project\n---\nBody.\n`,
    );
    await Deno.writeTextFile(
      join(dir, "MEMORY.md"),
      "## Feedback\n\ndesign-work-runs-through-design-issue\n\n## Project\n\n- [session-checkpoint-pr-1121-chunked-dispatch](session-checkpoint-pr-1121-chunked-dispatch.md) — LIVE\n",
    );
    const result = await scanMemoryIndexSurface(1, dir, NO_CALLS_RUNNER);
    assertChecked(result);
    assertEquals(findByKind(result.findings, "missing-from-index").length, 0);
  });
});

Deno.test("scanMemoryIndexSurface: a project memory citing a CLOSED issue is flagged (mocked gh)", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "old-fix.md"),
      `---\nname: old-fix\ndescription: "d"\nmetadata:\n  type: project\n---\nTracked in web-jam-tools#1234, done now.\n`,
    );
    await Deno.writeTextFile(join(dir, "MEMORY.md"), "## Project\n\nold-fix\n");
    const runner = makeFakeRunner([
      {
        type: "issue",
        repo: "web-jam-tools",
        number: 1234,
        result: jsonResult({ state: "CLOSED" }),
      },
    ]);
    const result = await scanMemoryIndexSurface(1, dir, runner);
    assertChecked(result);
    const closed = findByKind(result.findings, "closed-issue");
    assertEquals(closed.length, 1);
    assertEquals(closed[0].repo, "web-jam-tools");
    assertEquals(closed[0].number, 1234);
    assertEquals(closed[0].status, "flag");
  });
});

Deno.test("scanMemoryIndexSurface: an OPEN issue citation on a project memory is not flagged", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "active.md"),
      `---\nname: active\ndescription: "d"\nmetadata:\n  type: project\n---\nStill open: web-jam-tools#5000.\n`,
    );
    await Deno.writeTextFile(join(dir, "MEMORY.md"), "## Project\n\nactive\n");
    const runner = makeFakeRunner([
      { type: "issue", repo: "web-jam-tools", number: 5000, result: jsonResult({ state: "OPEN" }) },
    ]);
    const result = await scanMemoryIndexSurface(1, dir, runner);
    assertChecked(result);
    assertEquals(findByKind(result.findings, "closed-issue").length, 0);
    assertEquals(findByKind(result.findings, "gh-lookup-error").length, 0);
  });
});

Deno.test("scanMemoryIndexSurface: a MERGED and a CLOSED (unmerged) PR citation are both flagged", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "prs.md"),
      `---\nname: prs\ndescription: "d"\nmetadata:\n  type: project\n---\nSee web-jam-tools#111 (merged) and JaMmusic#222 (closed unmerged).\n`,
    );
    await Deno.writeTextFile(join(dir, "MEMORY.md"), "## Project\n\nprs\n");
    const runner = makeFakeRunner([
      {
        type: "issue",
        repo: "web-jam-tools",
        number: 111,
        result: failResult("no issue found"),
      },
      { type: "pr", repo: "web-jam-tools", number: 111, result: jsonResult({ state: "MERGED" }) },
      { type: "issue", repo: "JaMmusic", number: 222, result: failResult("no issue found") },
      { type: "pr", repo: "JaMmusic", number: 222, result: jsonResult({ state: "CLOSED" }) },
    ]);
    const result = await scanMemoryIndexSurface(1, dir, runner);
    assertChecked(result);
    assertEquals(findByKind(result.findings, "merged-pr").length, 1);
    assertEquals(findByKind(result.findings, "closed-pr").length, 1);
  });
});

Deno.test("lookupGhRef: an unparseable JSON response from gh is an explicit error, not a thrown exception", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "broken.md"),
      `---\nname: broken\ndescription: "d"\nmetadata:\n  type: project\n---\nSee web-jam-tools#777.\n`,
    );
    await Deno.writeTextFile(join(dir, "MEMORY.md"), "## Project\n\nbroken\n");
    const runner: CommandRunner = () =>
      Promise.resolve({ code: 0, stdout: "not json", stderr: "" });
    const result = await scanMemoryIndexSurface(1, dir, runner);
    assertChecked(result);
    const errors = findByKind(result.findings, "gh-lookup-error");
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].detail, "unparseable JSON");
  });
});

Deno.test("lookupGhRef: an unparseable JSON response from `gh pr view` (issue view fails first) is an explicit error", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "broken2.md"),
      `---\nname: broken2\ndescription: "d"\nmetadata:\n  type: project\n---\nSee web-jam-tools#778.\n`,
    );
    await Deno.writeTextFile(join(dir, "MEMORY.md"), "## Project\n\nbroken2\n");
    const runner: CommandRunner = (args: string[]) => {
      if (args[0] === "issue") return Promise.resolve(failResult("no issue found"));
      return Promise.resolve({ code: 0, stdout: "also not json", stderr: "" });
    };
    const result = await scanMemoryIndexSurface(1, dir, runner);
    assertChecked(result);
    const errors = findByKind(result.findings, "gh-lookup-error");
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].detail, "unparseable JSON");
  });
});

Deno.test("scanMemoryIndexSurface: a non-project memory's citation is never looked up", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "rule.md"),
      `---\nname: rule\ndescription: "d"\nmetadata:\n  type: feedback\n---\nSee web-jam-tools#1 for origin.\n`,
    );
    await Deno.writeTextFile(join(dir, "MEMORY.md"), "## Feedback\n\nrule\n");
    const result = await scanMemoryIndexSurface(1, dir, NO_CALLS_RUNNER);
    assertChecked(result);
    // NO_CALLS_RUNNER would have thrown if gh were invoked; reaching here proves it wasn't.
  });
});

Deno.test("scanMemoryIndexSurface: a gh lookup failure is an explicit error finding, never dropped or clean", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "flaky.md"),
      `---\nname: flaky\ndescription: "d"\nmetadata:\n  type: project\n---\nSee web-jam-tools#9999.\n`,
    );
    await Deno.writeTextFile(join(dir, "MEMORY.md"), "## Project\n\nflaky\n");
    // No rule registered -> both `issue view` and `pr view` fail (rate limit / auth / network).
    const runner: CommandRunner = () =>
      Promise.resolve(failResult("HTTP 403: API rate limit exceeded"));
    const result = await scanMemoryIndexSurface(1, dir, runner);
    assertChecked(result);
    const errors = findByKind(result.findings, "gh-lookup-error");
    assertEquals(errors.length, 1);
    assertEquals(errors[0].status, "error");
    assertStringIncludes(errors[0].detail, "web-jam-tools#9999");
    // Never silently claim the surface is clean, or drop the finding: it must
    // be present, and it must not be miscategorized as closed-issue/merged-pr.
    assertEquals(findByKind(result.findings, "closed-issue").length, 0);
    assertEquals(findByKind(result.findings, "merged-pr").length, 0);
  });
});

Deno.test("scanMemoryIndexSurface: surface-level error when the directory does not exist", async () => {
  const result = await scanMemoryIndexSurface(1, "/nonexistent/path/for/real", NO_CALLS_RUNNER);
  assertEquals(result.status, "error");
  if (result.status === "error") {
    assertStringIncludes(result.reason, "/nonexistent/path/for/real");
  }
});

Deno.test("scanMemoryIndexSurface: missing MEMORY.md is reported as its own finding", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "lonely.md"),
      `---\nname: lonely\ndescription: "d"\nmetadata:\n  type: feedback\n---\nBody.\n`,
    );
    const result = await scanMemoryIndexSurface(1, dir, NO_CALLS_RUNNER);
    assertChecked(result);
    const indexMissing = findByKind(result.findings, "index-file-missing");
    assertEquals(indexMissing.length, 1);
    assertEquals(indexMissing[0].status, "error");
    // Should not also spam a missing-from-index finding per file once the index itself is gone.
    assertEquals(findByKind(result.findings, "missing-from-index").length, 0);
  });
});

// --- scanQueueSurface (surface 6) ---

Deno.test("scanQueueSurface: a line citing a MERGED PR is flagged", async () => {
  await withTempDir(async (dir) => {
    const queuePath = join(dir, "claude-opus-tasks.txt");
    await Deno.writeTextFile(
      queuePath,
      "Task 12 — done, see web-jam-back#998 for the fix.\n",
    );
    const runner = makeFakeRunner([
      {
        type: "issue",
        repo: "web-jam-back",
        number: 998,
        result: failResult("no issue found"),
      },
      {
        type: "pr",
        repo: "web-jam-back",
        number: 998,
        result: jsonResult({ state: "MERGED" }),
      },
    ]);
    const result = await scanQueueSurface([queuePath], runner);
    assertChecked(result);
    const merged = findByKind(result.findings, "merged-pr");
    assertEquals(merged.length, 1);
    assertEquals(merged[0].repo, "web-jam-back");
    assertEquals(merged[0].number, 998);
  });
});

Deno.test("scanQueueSurface: a line citing a CLOSED issue and a CLOSED (unmerged) PR are both flagged", async () => {
  await withTempDir(async (dir) => {
    const queuePath = join(dir, "claude-opus-tasks.txt");
    await Deno.writeTextFile(
      queuePath,
      "Task 1 — web-jam-tools#301 closed. Task 2 — JaMmusic#302 closed unmerged.\n",
    );
    const runner = makeFakeRunner([
      {
        type: "issue",
        repo: "web-jam-tools",
        number: 301,
        result: jsonResult({ state: "CLOSED" }),
      },
      { type: "issue", repo: "JaMmusic", number: 302, result: failResult("no issue found") },
      { type: "pr", repo: "JaMmusic", number: 302, result: jsonResult({ state: "CLOSED" }) },
    ]);
    const result = await scanQueueSurface([queuePath], runner);
    assertChecked(result);
    assertEquals(findByKind(result.findings, "closed-issue").length, 1);
    assertEquals(findByKind(result.findings, "closed-pr").length, 1);
  });
});

Deno.test("scanQueueSurface: a read failure that is not 'file not found' is a surface-level error", async () => {
  await withTempDir(async (dir) => {
    // A directory, not a file, at the queue path: readTextFile throws
    // Deno.errors.IsADirectory, not Deno.errors.NotFound.
    const queuePath = join(dir, "claude-fable-tasks.txt");
    await Deno.mkdir(queuePath);
    const result = await scanQueueSurface([queuePath], NO_CALLS_RUNNER);
    assertEquals(result.status, "error");
    if (result.status === "error") {
      assertStringIncludes(result.reason, queuePath);
    }
  });
});

Deno.test("scanQueueSurface: a missing queue file is an info finding, not an error", async () => {
  const result = await scanQueueSurface(
    ["/tmp/definitely-not-a-real-queue-file.txt"],
    NO_CALLS_RUNNER,
  );
  assertChecked(result);
  const absent = findByKind(result.findings, "queue-file-absent");
  assertEquals(absent.length, 1);
  assertEquals(absent[0].status, "info");
});

Deno.test("scanQueueSurface: a gh lookup failure on a queue line is an explicit error, not dropped", async () => {
  await withTempDir(async (dir) => {
    const queuePath = join(dir, "claude-fable-tasks.txt");
    await Deno.writeTextFile(queuePath, "Task 3 — JaMmusic#4321 pending review.\n");
    const runner: CommandRunner = () => Promise.resolve(failResult("connection reset"));
    const result = await scanQueueSurface([queuePath], runner);
    assertChecked(result);
    const errors = findByKind(result.findings, "gh-lookup-error");
    assertEquals(errors.length, 1);
    assertEquals(errors[0].status, "error");
  });
});

Deno.test("scanQueueSurface: an OPEN issue citation is not flagged", async () => {
  await withTempDir(async (dir) => {
    const queuePath = join(dir, "agy-tasks.txt");
    await Deno.writeTextFile(queuePath, "Task 1 — JaMmusic#1 still open.\n");
    const runner = makeFakeRunner([
      { type: "issue", repo: "JaMmusic", number: 1, result: jsonResult({ state: "OPEN" }) },
    ]);
    const result = await scanQueueSurface([queuePath], runner);
    assertChecked(result);
    assertEquals(result.findings.length, 0);
  });
});

// --- runMemoryCleanupScan (top-level combined scan) ---

Deno.test("runMemoryCleanupScan: emits one result per surface (1, 6, 10), each with an explicit status", async () => {
  await withTempDir(async (base) => {
    const surface1Dir = join(base, "surface1");
    const surface10Dir = join(base, "surface10");
    await Deno.mkdir(surface1Dir);
    await Deno.mkdir(surface10Dir);
    await Deno.writeTextFile(join(surface1Dir, "MEMORY.md"), "# Memory Index\n");
    await Deno.writeTextFile(join(surface10Dir, "MEMORY.md"), "# Memory Index\n");
    const missingQueuePath = join(base, "no-such-queue.txt");

    const result = await runMemoryCleanupScan({
      surface1Dir,
      surface10Dir,
      surface6Paths: [missingQueuePath],
      runner: NO_CALLS_RUNNER,
    });

    assertEquals(result.surfaces.length, 3);
    assertEquals(result.surfaces.map((s) => s.surface).sort((a, b) => a - b), [1, 6, 10]);
    for (const s of result.surfaces) {
      assert(
        s.status === "checked" || s.status === "error",
        "every surface has an explicit status",
      );
    }
    assert(typeof result.generatedAt === "string" && result.generatedAt.length > 0);
  });
});

// --- CLI ---

async function withConsole(fn: () => Promise<void>): Promise<{ logs: string[] }> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return { logs };
}

Deno.test("cli runCli: --help prints usage and exits 0 without touching any directory", async () => {
  const { logs } = await withConsole(async () => {
    const code = await runCli(["--help"]);
    assertEquals(code, 0);
  });
  assert(logs.some((l) => l.includes("memory-cleanup:scan")));
});

Deno.test("cli runCli: a real run against temp dirs prints valid JSON covering all 3 surfaces", async () => {
  await withTempDir(async (base) => {
    const surface1Dir = join(base, "surface1");
    const surface10Dir = join(base, "surface10");
    const dropboxDir = join(base, "dropbox");
    await Deno.mkdir(surface1Dir);
    await Deno.mkdir(surface10Dir);
    await Deno.mkdir(dropboxDir);
    await Deno.writeTextFile(join(surface1Dir, "MEMORY.md"), "# Memory Index\n");
    await Deno.writeTextFile(join(surface10Dir, "MEMORY.md"), "# Memory Index\n");
    // None of DEFAULT_QUEUE_FILENAMES exist in dropboxDir -> all queue-file-absent, no gh calls.

    const { logs } = await withConsole(async () => {
      const code = await runCli([
        "--dir",
        surface1Dir,
        "--shared-dir",
        surface10Dir,
        "--dropbox-dir",
        dropboxDir,
      ]);
      assertEquals(code, 0);
    });

    interface ParsedSurface {
      surface: number;
      status: string;
      findings: Finding[];
    }
    interface ParsedOutput {
      surfaces: ParsedSurface[];
    }
    const output = logs.join("\n");
    const parsed = JSON.parse(output) as ParsedOutput;
    assertEquals(parsed.surfaces.length, 3);
    const bySurface = new Map<number, ParsedSurface>(parsed.surfaces.map((s) => [s.surface, s]));
    assertEquals(bySurface.get(1)?.status, "checked");
    assertEquals(bySurface.get(10)?.status, "checked");
    assertEquals(bySurface.get(6)?.status, "checked");
    assertEquals(
      bySurface.get(6)?.findings.filter((f) => f.kind === "queue-file-absent").length,
      DEFAULT_QUEUE_FILENAMES.length,
    );
  });
});

Deno.test("cli runCli: expands a '~/'-prefixed --dir against HOME", async () => {
  await withTempDir(async (fakeHome) => {
    const surface1Dir = join(fakeHome, "surface1");
    const surface10Dir = join(fakeHome, "surface10");
    const dropboxDir = join(fakeHome, "dropbox");
    await Deno.mkdir(surface1Dir);
    await Deno.mkdir(surface10Dir);
    await Deno.mkdir(dropboxDir);
    await Deno.writeTextFile(join(surface1Dir, "MEMORY.md"), "# Memory Index\n");
    await Deno.writeTextFile(join(surface10Dir, "MEMORY.md"), "# Memory Index\n");

    const origHome = Deno.env.get("HOME");
    Deno.env.set("HOME", fakeHome);
    try {
      const { logs } = await withConsole(async () => {
        const code = await runCli([
          "--dir",
          "~/surface1",
          "--shared-dir",
          "~/surface10",
          "--dropbox-dir",
          "~/dropbox",
        ]);
        assertEquals(code, 0);
      });
      const parsed = JSON.parse(logs.join("\n"));
      assertEquals(parsed.surfaces.length, 3);
    } finally {
      if (origHome !== undefined) Deno.env.set("HOME", origHome);
    }
  });
});

Deno.test("DEFAULT_QUEUE_FILENAMES matches the SKILL.md surface-6 roster", () => {
  assertEquals(
    [...DEFAULT_QUEUE_FILENAMES].sort(),
    ["agy-tasks.txt", "claude-fable-tasks.txt", "claude-opus-tasks.txt"].sort(),
  );
});
