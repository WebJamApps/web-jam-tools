// test/design_issue_candidates.test.ts — web-jam-tools#745
//
// Unit tests for Needs Design candidates scanner (scanNeedsDesignCandidates, formatCandidateCitation, runCandidatesCli).

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatCandidateCitation,
  type NeedsDesignIssue,
  runCandidatesCli,
  scanNeedsDesignCandidates,
} from "../src/design-issue/candidates.ts";
import { runCli } from "../src/design-issue/cli.ts";
import type { CommandResult, CommandRunner } from "../src/shared/repos.ts";

function createMockRunner(
  handlers: Record<string, { code?: number; stdout?: string; stderr?: string; error?: Error }>,
): CommandRunner {
  return (args: string[]): Promise<CommandResult> => {
    // args: ["issue", "list", "--repo", "WebJamApps/<repo>", "--state", "open", "--label", "Needs Design", "--json", "number,title,labels,url"]
    const repoArgIndex = args.indexOf("--repo");
    const repoTarget = repoArgIndex !== -1 ? args[repoArgIndex + 1] : "";
    const repoName = repoTarget.replace("WebJamApps/", "");

    const config = handlers[repoName];
    if (config?.error) {
      return Promise.reject(config.error);
    }

    if (config) {
      return Promise.resolve({
        code: config.code ?? 0,
        stdout: config.stdout ?? "[]",
        stderr: config.stderr ?? "",
      });
    }

    return Promise.resolve({
      code: 0,
      stdout: "[]",
      stderr: "",
    });
  };
}

Deno.test("formatCandidateCitation formats issue citation with repo, number, and title", () => {
  const issue: NeedsDesignIssue = {
    repo: "web-jam-tools",
    number: 745,
    title:
      "Add a deno task design:candidates to scan the active repos for open Needs Design issues",
  };
  const citation = formatCandidateCitation(issue);
  assertEquals(
    citation,
    'web-jam-tools#745 "Add a deno task design:candidates to scan the active repos for open Needs Design issues"',
  );
});

Deno.test("scanNeedsDesignCandidates returns issues for matching repos and handles empty repos", async () => {
  const runner = createMockRunner({
    "web-jam-tools": {
      stdout: JSON.stringify([
        {
          number: 724,
          title: "design-issue skill never reconciles a pre-existing issue's stale body",
          labels: [{ name: "Needs Design" }, { name: "Sonnet" }],
          url: "https://github.com/WebJamApps/web-jam-tools/issues/724",
        },
      ]),
    },
    "JaMmusic": {
      stdout: "[]",
    },
    "CollegeLutheran": {
      stdout: JSON.stringify([
        {
          number: 105,
          title: "Redesign bulletin archive browser",
          labels: [{ name: "Needs Design" }],
          url: "https://github.com/WebJamApps/CollegeLutheran/issues/105",
        },
      ]),
    },
  });

  const warnings: string[] = [];
  const result = await scanNeedsDesignCandidates({
    runner,
    repos: ["web-jam-tools", "JaMmusic", "CollegeLutheran"],
    errorLog: (msg) => warnings.push(msg),
  });

  assertEquals(result.errors.length, 0);
  assertEquals(result.issues.length, 2);
  assertEquals(result.issues[0].repo, "web-jam-tools");
  assertEquals(result.issues[0].number, 724);
  assertEquals(
    result.issues[0].title,
    "design-issue skill never reconciles a pre-existing issue's stale body",
  );
  assertEquals(result.issues[1].repo, "CollegeLutheran");
  assertEquals(result.issues[1].number, 105);
  assertEquals(result.issues[1].title, "Redesign bulletin archive browser");
});

Deno.test("scanNeedsDesignCandidates handles command errors and runner rejections gracefully", async () => {
  const runner = createMockRunner({
    "web-jam-tools": {
      code: 1,
      stderr: "GraphQL error: rate limit exceeded",
    },
    "JaMmusic": {
      error: new Error("Network timeout connecting to api.github.com"),
    },
    "AppersonAuto": {
      stdout: JSON.stringify([
        {
          number: 42,
          title: "Appointment booking flow design",
          labels: [{ name: "Needs Design" }],
          url: "https://github.com/WebJamApps/AppersonAuto/issues/42",
        },
      ]),
    },
  });

  const warnings: string[] = [];
  const result = await scanNeedsDesignCandidates({
    runner,
    repos: ["web-jam-tools", "JaMmusic", "AppersonAuto"],
    errorLog: (msg) => warnings.push(msg),
  });

  assertEquals(result.errors.length, 2);
  assertEquals(result.errors[0].repo, "web-jam-tools");
  assertStringIncludes(result.errors[0].error, "rate limit exceeded");
  assertEquals(result.errors[1].repo, "JaMmusic");
  assertStringIncludes(result.errors[1].error, "Network timeout");

  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings[0], "Failed to query web-jam-tools");
  assertStringIncludes(warnings[1], "Error querying JaMmusic");

  assertEquals(result.issues.length, 1);
  assertEquals(result.issues[0].repo, "AppersonAuto");
  assertEquals(result.issues[0].number, 42);
});

Deno.test("runCandidatesCli prints formatted candidate list when matches exist", async () => {
  const runner = createMockRunner({
    "web-jam-tools": {
      stdout: JSON.stringify([
        {
          number: 724,
          title: "design-issue skill never reconciles a pre-existing issue's stale body",
          labels: [{ name: "Needs Design" }],
          url: "https://github.com/WebJamApps/web-jam-tools/issues/724",
        },
      ]),
    },
  });

  const logs: string[] = [];
  const exitCode = await runCandidatesCli([], {
    runner,
    repos: ["web-jam-tools", "JaMmusic"],
    log: (msg) => logs.push(msg),
  });

  assertEquals(exitCode, 0);
  assertEquals(logs.length, 2);
  assertStringIncludes(logs[0], "Found 1 open 'Needs Design' candidate issue");
  assertEquals(
    logs[1],
    'web-jam-tools#724 "design-issue skill never reconciles a pre-existing issue\'s stale body"',
  );
});

Deno.test("runCandidatesCli prints clear 0 candidates message when no issues found", async () => {
  const runner = createMockRunner({
    "web-jam-tools": { stdout: "[]" },
    "JaMmusic": { stdout: "[]" },
  });

  const logs: string[] = [];
  const exitCode = await runCandidatesCli([], {
    runner,
    repos: ["web-jam-tools", "JaMmusic"],
    log: (msg) => logs.push(msg),
  });

  assertEquals(exitCode, 0);
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0], "0 candidates found");
});

Deno.test("runCandidatesCli handles --help flag", async () => {
  const logs: string[] = [];
  const exitCode = await runCandidatesCli(["--help"], {
    log: (msg) => logs.push(msg),
  });

  assertEquals(exitCode, 0);
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0], "Usage: deno task design:candidates");
});

Deno.test("cli.ts routes 'candidates' subcommand to runCandidatesCli", async () => {
  const exitCode = await runCli(["candidates", "--help"]);
  assertEquals(exitCode, 0);
});

Deno.test("deno.json defines design:candidates task", async () => {
  const denoJsonContent = await Deno.readTextFile(
    new URL("../deno.json", import.meta.url).pathname,
  );
  const config = JSON.parse(denoJsonContent);

  assertEquals(typeof config.tasks["design:candidates"], "string");
  assertStringIncludes(config.tasks["design:candidates"], "src/design-issue/cli.ts candidates");
});

// --- web-jam-tools#942: the canonical-document precondition, as reached through design:candidates ---

Deno.test("runCandidatesCli resolving a topic prints the matched document's decisions record alongside its path", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "candidates-decisions-" });
  const themeDir = `${tempDir}/gig-outreach`;
  await Deno.mkdir(themeDir, { recursive: true });
  await Deno.writeTextFile(
    `${themeDir}/book-gig-skill-design-2026-08-16.md`,
    `# Book Gig Skill Design

## Appendix — Decisions Record

| ID | Topic | Options Considered | Decision / Outcome |
|---|---|---|---|
| D-4 | Pitch Delivery | 1. Gmail drafts (Rec)<br>2. Direct send | **Option 1 approved on 2026-08-16**: Josh reviews and sends from Gmail. |
`,
  );

  const logs: string[] = [];
  try {
    const exitCode = await runCandidatesCli(
      ["--topic", "book-gig", "--dropbox-dir", tempDir],
      { log: (msg) => logs.push(msg) },
    );

    assertEquals(exitCode, 0);
    const joined = logs.join("\n");
    assertStringIncludes(joined, 'Resolved existing canonical design document for "book-gig"');
    assertStringIncludes(joined, "Decisions record — 1 entry already settled");
    assertStringIncludes(joined, "D-4: Option 1 approved on 2026-08-16: Josh reviews and sends");
    assertStringIncludes(joined, "Suggested action: Major Revision to existing design document");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runCandidatesCli resolving a topic under an unreadable design-documents root REFUSES rather than reporting no document", async () => {
  const missingRoot = `${await Deno.makeTempDir({
    prefix: "candidates-refusal-",
  })}/nonexistent-theme-root`;

  const logs: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCandidatesCli(
    ["--topic", "book-gig", "--dropbox-dir", missingRoot],
    { log: (msg) => logs.push(msg), errorLog: (msg) => errors.push(msg) },
  );

  assertEquals(exitCode, 2);
  const allOutput = [...logs, ...errors].join("\n");
  assertStringIncludes(allOutput, missingRoot);
  assertStringIncludes(allOutput, "Refusing to proceed with the design run");
  assertEquals(
    allOutput.includes("No existing design document found"),
    false,
    "an indeterminate check must never report a genuine no-document result",
  );
});

Deno.test("web-jam-tools#1394: runCandidatesCli with --epic matches theme folder whose name is spelled differently from milestone", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "candidates-milestone-diff-" });
  const themeDir = `${tempDir}/AI_Misbehaves`;
  await Deno.mkdir(themeDir, { recursive: true });

  const runner = createMockRunner({
    "JaMmusic": {
      stdout: JSON.stringify({
        title: "secret-guard: push guard protection",
        body: "",
        milestone: { title: "AI Misbehaves" },
      }),
    },
  });

  const logs: string[] = [];
  const errors: string[] = [];
  try {
    // An issue without a body path asks Josh; its milestone does not limit the search.
    const exitCode1 = await runCandidatesCli(
      [
        "--epic",
        'JaMmusic#1315 "Secret Guard"',
        "--dropbox-dir",
        tempDir,
      ],
      {
        runner,
        log: (msg) => logs.push(msg),
        errorLog: (msg) => errors.push(msg),
      },
    );

    assertEquals(exitCode1, 2);
    assertEquals(errors.length, 0);
    assertStringIncludes(logs.join("\n"), "could not tell");

    // A document sharing a title word is listed without being resolved.
    await Deno.writeTextFile(
      `${themeDir}/secret-guard-design-2026-10-14.md`,
      `# Secret Guard Design\n\n## Section\nContent\n`,
    );
    const logs2: string[] = [];
    const errors2: string[] = [];
    const exitCode2 = await runCandidatesCli(
      [
        "--epic",
        'JaMmusic#1315 "Secret Guard"',
        "--dropbox-dir",
        tempDir,
      ],
      {
        runner,
        log: (msg) => logs2.push(msg),
        errorLog: (msg) => errors2.push(msg),
      },
    );

    assertEquals(exitCode2, 2);
    assertEquals(errors2.length, 0);
    assertStringIncludes(
      logs2.join("\n"),
      "could not tell",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// Approved step-zero case list: each row runs both public CLI entry functions.
import { runMatchDesignCli } from "../src/design-issue/cli.ts";
import * as path from "@std/path";

const LOOKUP_DOCS = [
  "Token_Savings/hooks-design.md",
  "Token_Savings/model-tier-order-design-2026-10-02.md",
  "Token_Savings/design-issue-file-issue-design.md",
  "promote-gigs/promote-gigs-design-2026-10-11.md",
  "promote-gigs/promote-gigs-copy-design.md",
  "Token_Savings/standing-preamble-design-2026-08-08.md",
  "Token_Savings/design-issue-1450-issue-plan-2026-10-26.md",
  "resume-records/session-checkpoint-2026-10-28-design-issue-1602.md",
  "resume-records/old-approval-design.md",
  "claude-backup/hooks-design.md",
  "backups/hooks-design.md",
];
const HOOKS = LOOKUP_DOCS[0];
const MODEL = LOOKUP_DOCS[1];
const DESIGN = LOOKUP_DOCS[2];
const GIGS = LOOKUP_DOCS[3];
const COPY = LOOKUP_DOCS[4];
const PREAMBLE = LOOKUP_DOCS[5];
interface LookupCase {
  name: string;
  input?: string;
  body?: string;
  title?: string;
  milestone?: string;
  failure?: boolean;
  code: number;
  docs?: string[];
  reason?: string;
  theme?: string;
  missingRoot?: boolean;
  add?: string[];
}
const LOOKUP_CASES: LookupCase[] = [
  {
    name: "an unreadable body path retains every named candidate",
    input: "web-jam-tools#9001",
    body: "<R>/Token_Savings/hooks-design.md\n<R>/Token_Savings/gone-design.md",
    code: 2,
    docs: [HOOKS, "Token_Savings/gone-design.md"],
    reason: "gone-design.md",
  },
  {
    name: "backup suffix does not count as a document path",
    input: "web-jam-tools#9001",
    body: "<R>/Token_Savings/hooks-design.md.bak",
    title: "Model: a change",
    code: 2,
    docs: [MODEL],
  },
  {
    name: "quoted body path supports folder spaces",
    input: "web-jam-tools#9001",
    body: '"<R>/Theme Folder/space-design.md"',
    add: ["Theme Folder/space-design.md"],
    code: 0,
    docs: ["Theme Folder/space-design.md"],
  },
  { name: "01 direct path", input: "<R>/" + HOOKS, code: 0, docs: [HOOKS] },
  {
    name: "02 issue plan is not a design",
    input: "<R>/" + LOOKUP_DOCS[6],
    code: 2,
    reason: "not a design document",
  },
  {
    name: "03 resume record is not a design",
    input: "<R>/" + LOOKUP_DOCS[8],
    code: 2,
    reason: "not a design document",
  },
  {
    name: "04 missing path",
    input: "<R>/Token_Savings/gone-design.md",
    code: 2,
    reason: "<R>/Token_Savings/gone-design.md",
  },
  {
    name: "05 body tilde path",
    input: "web-jam-tools#9001",
    body: "~/Dropbox/web-jam-llms/" + PREAMBLE,
    code: 0,
    docs: [PREAMBLE],
  },
  {
    name: "06 body absolute path beats title",
    input: 'web-jam-tools#9001 "Hooks: some title"',
    title: "Hooks: some title",
    body: "<R>/" + PREAMBLE,
    code: 0,
    docs: [PREAMBLE],
  },
  {
    name: "07 two body paths",
    input: "web-jam-tools#9001",
    body: "<R>/" + HOOKS + "\n<R>/" + GIGS,
    code: 2,
    docs: [HOOKS, GIGS],
  },
  {
    name: "08 duplicate body paths",
    input: "web-jam-tools#9001",
    body: "<R>/" + HOOKS + "\n~/Dropbox/web-jam-llms/" + HOOKS,
    code: 0,
    docs: [HOOKS],
  },
  {
    name: "09 missing body path",
    input: "web-jam-tools#9001",
    body: "<R>/Token_Savings/gone-design.md",
    code: 2,
    reason: "<R>/Token_Savings/gone-design.md",
  },
  {
    name: "10 bare filename is ignored",
    input: "web-jam-tools#9001",
    body: "hooks-design.md",
    title: "Model: a change",
    code: 2,
    docs: [MODEL],
  },
  {
    name: "11 milestone adds candidate",
    input: "web-jam-tools#9001",
    title: "Zebra stripes",
    milestone: "promote-gigs",
    code: 2,
    docs: [GIGS],
  },
  {
    name: "12 no candidates",
    input: "web-jam-tools#9001",
    title: "Zebra stripes",
    code: 2,
    docs: [],
  },
  {
    name: "13 unreadable body",
    input: "web-jam-tools#9001",
    failure: true,
    code: 2,
    reason: "web-jam-tools#9001",
  },
  { name: "14 single exact word", input: "hooks", code: 0, docs: [HOOKS] },
  { name: "15 exact beats contiguous", input: "promote gigs", code: 0, docs: [GIGS] },
  { name: "16 contiguous prefix", input: "model tier", code: 0, docs: [MODEL] },
  { name: "17 contiguous infix", input: "file issue", code: 0, docs: [DESIGN] },
  { name: "18 hyphenated topic", input: "design-issue", code: 0, docs: [DESIGN] },
  { name: "19 single partial word", input: "promote", code: 2, docs: [GIGS, COPY] },
  { name: "20 single partial model", input: "model", code: 2, docs: [MODEL] },
  { name: "21 session load excludes records", input: "session load", code: 2, docs: [] },
  { name: "22 session excludes records", input: "session", code: 2, docs: [] },
  { name: "23 unknown topic", input: "zebra migration", code: 2, docs: [] },
  {
    name: "24 explicit theme limits topics",
    input: "hooks",
    theme: "promote-gigs",
    code: 2,
    docs: [],
  },
  { name: "25 missing theme", input: "hooks", theme: "Nowhere", code: 2, reason: "<R>/Nowhere" },
  { name: "26 missing root", input: "hooks", missingRoot: true, code: 2, reason: "<R>" },
  { name: "27 missing argument", code: 1, reason: "Usage:" },
  {
    name: "two exact names refuse regardless of date",
    input: "hooks",
    add: ["Token_Savings/hooks-design-2026-10-30.md"],
    code: 2,
    docs: [HOOKS, "Token_Savings/hooks-design-2026-10-30.md"],
  },
  {
    name: "two contiguous matches refuse",
    input: "gigs copy",
    add: ["Token_Savings/gigs-copy-other-design.md"],
    code: 2,
    docs: [COPY, "Token_Savings/gigs-copy-other-design.md"],
  },
  { name: "every topic word is retained", input: "hooks need revision", code: 2, docs: [HOOKS] },
  { name: "topic words must be adjacent and ordered", input: "tier model", code: 2, docs: [MODEL] },
  {
    name: "title exact match alone still asks Josh",
    input: "web-jam-tools#9001",
    title: "hooks",
    code: 2,
    docs: [HOOKS],
  },
  {
    name: "explicit path ignores theme",
    input: "<R>/" + HOOKS,
    theme: "Nowhere",
    code: 0,
    docs: [HOOKS],
  },
  {
    name: "body path ignores theme",
    input: "web-jam-tools#9001",
    body: "<R>/" + HOOKS,
    theme: "Nowhere",
    code: 0,
    docs: [HOOKS],
  },
  {
    name: "milestone does not hide title candidates",
    input: "web-jam-tools#9001",
    title: "hooks",
    milestone: "promote-gigs",
    code: 2,
    docs: [HOOKS, GIGS],
  },
];
for (const row of LOOKUP_CASES) {
  Deno.test(`step-zero lookup: ${row.name}`, async () => {
    const home = await Deno.makeTempDir({ prefix: "step-zero-" });
    const root = path.join(home, "Dropbox/web-jam-llms");
    const prior = Deno.env.get("HOME");
    Deno.env.set("HOME", home);
    try {
      if (!row.missingRoot) {
        for (const name of [...LOOKUP_DOCS, ...(row.add ?? [])]) {
          const file = path.join(root, name);
          await Deno.mkdir(path.dirname(file), { recursive: true });
          await Deno.writeTextFile(
            file,
            "# Fixture\n\n## Appendix — Decisions Record\n\n| ID | Decision | Outcome |\n|---|---|---|\n| D-1 | Scope | Fixture approved |\n",
          );
        }
      }
      const expand = (text: string) => text.replaceAll("<R>", root);
      for (const command of ["match-design", "candidates"] as const) {
        const output: string[] = [];
        const calls: string[][] = [];
        const runner: CommandRunner = (args) => {
          calls.push(args);
          assertEquals(args, [
            "issue",
            "view",
            "9001",
            "--repo",
            "WebJamApps/web-jam-tools",
            "--json",
            "title,body,milestone",
          ]);
          return Promise.resolve({
            code: row.failure ? 1 : 0,
            stderr: "",
            stdout: JSON.stringify({
              title: row.title ?? "Unrelated title",
              body: expand(row.body ?? ""),
              milestone: row.milestone ? { title: row.milestone } : null,
            }),
          });
        };
        const options = {
          runner,
          log: (line: string) => output.push(line),
          errorLog: (line: string) => output.push(line),
        };
        const args = row.input === undefined ? [] : [expand(row.input)];
        if (row.theme) args.push("--theme", row.theme);
        args.push("--dropbox-dir", root);
        const code = command === "match-design"
          ? await runMatchDesignCli(args, options)
          : await runCandidatesCli(["--epic", ...args], options);
        assertEquals(code, row.code, command);
        const joined = output.join("\n");
        if (row.reason) assertStringIncludes(joined, expand(row.reason));
        if (row.code === 2) assertStringIncludes(joined, "could not tell");
        if (row.code === 0) assertStringIncludes(joined, "D-1: Fixture approved");
        if (row.docs) {
          const printed = output.filter((line) => line.startsWith("  " + root + "/")).map((line) =>
            line.trim()
          ).sort();
          assertEquals(printed, row.docs.map((name) => path.join(root, name)).sort(), command);
        }
        assertEquals(joined.includes("No existing design document found"), false);
        assertEquals(joined.includes("YYYY-MM-DD"), false);
        if (!row.input?.startsWith("web-jam-tools#")) assertEquals(calls.length, 0);
        else assertEquals(calls.length, 1);
      }
    } finally {
      if (prior === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", prior);
      await Deno.remove(home, { recursive: true });
    }
  });
}

Deno.test("step-zero real CLI reads an issue body through a read-only gh invocation", async () => {
  const fixture = await Deno.makeTempDir({ prefix: "step-zero-cli-" });
  try {
    const root = path.join(fixture, "Dropbox/web-jam-llms");
    const doc = path.join(root, HOOKS);
    const bin = path.join(fixture, "bin");
    const response = path.join(fixture, "issue.json");
    const calls = path.join(fixture, "calls.txt");
    await Deno.mkdir(path.dirname(doc), { recursive: true });
    await Deno.mkdir(bin);
    await Deno.writeTextFile(doc, "# Hooks\n");
    await Deno.writeTextFile(
      response,
      JSON.stringify({
        title: "Other topic",
        body: "~/Dropbox/web-jam-llms/" + HOOKS,
        milestone: null,
      }),
    );
    await Deno.writeTextFile(
      path.join(bin, "gh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${calls}'\ncat '${response}'\n`,
    );
    await Deno.chmod(path.join(bin, "gh"), 0o755);
    for (
      const command of [["match-design", "web-jam-tools#9001"], [
        "candidates",
        "--epic",
        "web-jam-tools#9001",
      ]]
    ) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--cached-only",
          "-A",
          "src/design-issue/cli.ts",
          ...command,
          "--dropbox-dir",
          root,
        ],
        cwd: path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), ".."),
        env: {
          HOME: fixture,
          PATH: bin + ":" + Deno.env.get("PATH"),
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            path.join(Deno.env.get("HOME") ?? fixture, ".cache/deno"),
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      assertStringIncludes(new TextDecoder().decode(result.stdout), doc);
      assertEquals(
        await Deno.readTextFile(calls),
        "issue\nview\n9001\n--repo\nWebJamApps/web-jam-tools\n--json\ntitle,body,milestone\n",
      );
    }
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});
