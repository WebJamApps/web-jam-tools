// test/design_issue_verify_citations.test.ts — web-jam-tools#1025
//
// Citation liveness checker: reads every issue a design document cites and fails on a title that
// no longer matches, or on a closed issue the document does not acknowledge as closed. Fails
// closed (REFUSES) when a lookup cannot be completed, never treating an unresolvable citation as
// passing. Network-dependent by design (it calls `gh api graphql`), so every test here stubs the
// lookup — this suite must never hit the network.

import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import type { CommandResult, CommandRunner } from "../src/flash-issues/types.ts";
import {
  type CitationLookup,
  defaultLookupCitations,
  extractCitations,
  runVerifyCitationsCli,
  verifyCitations,
  verifyCitationsFile,
} from "../src/design-issue/verify_citations.ts";

// --- extractCitations ---

Deno.test("extractCitations: finds repo#number, owner/repo#number, and GitHub issue URL citations with line numbers", () => {
  const doc = `# Title

This line cites web-jam-tools#1018 "hooks/agy-model-guard fix" as history.
This line cites WebJamApps/web-jam-back#42 "some other issue" for context.
This line references https://github.com/WebJamApps/web-jam-tools/issues/432 without a quote.
`;

  const citations = extractCitations(doc);
  assertEquals(citations.length, 3);

  assertEquals(citations[0].repo, "WebJamApps/web-jam-tools");
  assertEquals(citations[0].number, 1018);
  assertEquals(citations[0].line, 3);
  assertEquals(citations[0].quotedTitle, "hooks/agy-model-guard fix");

  assertEquals(citations[1].repo, "WebJamApps/web-jam-back");
  assertEquals(citations[1].number, 42);
  assertEquals(citations[1].line, 4);
  assertEquals(citations[1].quotedTitle, "some other issue");

  assertEquals(citations[2].repo, "WebJamApps/web-jam-tools");
  assertEquals(citations[2].number, 432);
  assertEquals(citations[2].line, 5);
  assertEquals(citations[2].quotedTitle, undefined);
});

Deno.test("extractCitations: a bare #number with no repo prefix is not a citation", () => {
  const doc = `# Title

This closes #1025 via GitHub's own auto-close syntax, not a citation.
`;
  const citations = extractCitations(doc);
  assertEquals(citations.length, 0);
});

Deno.test("extractCitations: skips citations inside fenced code blocks", () => {
  const doc = `# Title

\`\`\`text
Example citation format: web-jam-tools#999 "example title"
\`\`\`

Real citation: web-jam-tools#1018 "real title"
`;
  const citations = extractCitations(doc);
  assertEquals(citations.length, 1);
  assertEquals(citations[0].number, 1018);
});

Deno.test("extractCitations: a document with no citations returns an empty list", () => {
  const doc = `# Title\n\nNo citations here.\n`;
  assertEquals(extractCitations(doc).length, 0);
});

// --- sentence-scoped acknowledgement (web-jam-tools#1025 follow-up) ---

Deno.test("verifyCitations: acknowledging 'closed' on a LATER wrapped line of the same sentence passes", async () => {
  // Hard-wrapped prose: one sentence spanning three physical lines, "closed" arriving on the
  // third — a plain per-physical-line check would miss it; the sentence-wide scope must not.
  const doc =
    `This is why web-jam-tools#432 "agy hooks do not enforce — all 12 are inert on Flash, and a
Stop/SessionStart entry kills the whole config; fix that, then give Antigravity Gmail MCP fenced by
a working hook" was filed and closed about.
`;

  const result = await verifyCitations(doc, "test.md", {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#432": {
        state: "CLOSED",
        title:
          "agy hooks do not enforce — all 12 are inert on Flash, and a\nStop/SessionStart entry kills the whole config; fix that, then give Antigravity Gmail MCP fenced by\na working hook",
      },
    }),
  });

  // Title comparison isn't the point of this test (the quoted title itself also wraps physical
  // lines, which would be a drift concern for a different test); only check the acknowledgement.
  const closedViolation = result.violations.find((v) =>
    v.rule === "unacknowledged-closed-citation"
  );
  assertEquals(closedViolation, undefined, JSON.stringify(result.violations));
});

Deno.test("verifyCitations: 'closed' in a DIFFERENT sentence of the same paragraph still fails — widening is to the sentence, not the paragraph", () => {
  const doc = `See web-jam-tools#1018 "hooks fix" for the original report. That issue is now closed.
`;

  // This is a same-paragraph, two-sentence case: assert directly on extractCitations's computed
  // scope, which is what verifyCitations checks "closed" against.
  const citations = extractCitations(doc);
  assertEquals(citations.length, 1);
  assertEquals(citations[0].acknowledgementScope.includes("closed"), false);
  assertStringIncludes(citations[0].acknowledgementScope, "hooks fix");
});

Deno.test("verifyCitations integration: 'closed' in a different sentence of the same paragraph fails", async () => {
  const doc = `See web-jam-tools#1018 "hooks fix" for the original report. That issue is now closed.
`;

  const result = await verifyCitations(doc, "test.md", {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#1018": { state: "CLOSED", title: "hooks fix" },
    }),
  });

  const violation = result.violations.find((v) => v.rule === "unacknowledged-closed-citation");
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
});

Deno.test("extractCitations: a table-cell citation is scoped to its own cell — an adjacent cell saying 'closed' does not acknowledge it", () => {
  const doc = `| web-jam-tools#1018 | hooks/agy-model-guard fix | closed |
`;
  const citations = extractCitations(doc);
  assertEquals(citations.length, 1);
  assertEquals(citations[0].acknowledgementScope.includes("closed"), false);
  assertStringIncludes(citations[0].acknowledgementScope, "web-jam-tools#1018");
});

Deno.test("extractCitations: a table-cell citation whose OWN cell says closed is acknowledged", () => {
  const doc = `| web-jam-tools#1018 "hooks/agy-model-guard fix", closed | In progress |
`;
  const citations = extractCitations(doc);
  assertEquals(citations.length, 1);
  assertEquals(citations[0].acknowledgementScope.includes("closed"), true);
});

Deno.test("extractCitations: a period inside a backtick code span does not split the sentence", () => {
  const doc =
    `The fix lives in \`hooks/lib/opus_gate.ts\` and resolves web-jam-tools#1018 "hooks fix", and was closed.
`;
  const citations = extractCitations(doc);
  assertEquals(citations.length, 1);
  // If the code span's internal structure were mistaken for sentence punctuation, the scope
  // would be truncated before reaching "closed" at the end of the real sentence.
  assertEquals(citations[0].acknowledgementScope.includes("closed"), true);
  assertStringIncludes(citations[0].acknowledgementScope, "opus_gate.ts");
});

Deno.test("extractCitations: a period inside a version number such as 1.38.15 does not split the sentence", () => {
  const doc =
    `The fix shipped in 1.38.15 and resolves web-jam-tools#1018 "hooks fix", and was closed.
`;
  const citations = extractCitations(doc);
  assertEquals(citations.length, 1);
  assertEquals(citations[0].acknowledgementScope.includes("closed"), true);
  assertStringIncludes(citations[0].acknowledgementScope, "1.38.15");
});

// --- verifyCitations ---

function stubLookup(map: Record<string, CitationLookup>) {
  return (targets: Array<{ repo: string; number: number }>) => {
    const results = new Map<string, CitationLookup>();
    for (const t of targets) {
      const key = `${t.repo}#${t.number}`;
      results.set(key, map[key] ?? { error: `no stub entry for ${key}` });
    }
    return Promise.resolve(results);
  };
}

Deno.test("verifyCitations: a document with no citations passes without ever calling lookupImpl", async () => {
  let called = false;
  const result = await verifyCitations(`# Title\n\nNo citations.\n`, "test.md", {
    lookupImpl: () => {
      called = true;
      return Promise.resolve(new Map());
    },
  });
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
  assertEquals(called, false);
});

Deno.test("verifyCitations: a closed issue acknowledged as closed on its line passes", async () => {
  const doc =
    `web-jam-tools#526 "block-irreversible-operations.sh matches text inside heredocs and strings, so writing a test about the guard is blocked as if it were a deletion" records the same shape in a different guard, and was closed by tokenising rather than raw text matching.\n`;

  const result = await verifyCitations(doc, "test.md", {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#526": {
        state: "CLOSED",
        title:
          "block-irreversible-operations.sh matches text inside heredocs and strings, so writing a test about the guard is blocked as if it were a deletion",
      },
    }),
  });

  assertEquals(result.valid, true, JSON.stringify(result.violations));
});

Deno.test("verifyCitations: a merged pull request acknowledged as merged in its sentence passes", async () => {
  const doc = `web-jam-tools#526 "some PR title" was merged in an earlier release.\n`;

  const result = await verifyCitations(doc, "test.md", {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#526": {
        state: "CLOSED",
        title: "some PR title",
      },
    }),
  });

  assertEquals(result.valid, true, JSON.stringify(result.violations));
});

Deno.test("verifyCitations: a closed issue NOT acknowledged on its line fails", async () => {
  const doc = `| web-jam-tools#1018 | hooks/agy-model-guard fix | In progress |\n`;

  const result = await verifyCitations(doc, "test.md", {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#1018": {
        state: "CLOSED",
        title: "hooks/agy-model-guard fix",
      },
    }),
  });

  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "unacknowledged-closed-citation");
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
  assertEquals(violation?.line, 1);
});

Deno.test("verifyCitations: a drifted title fails, naming the quoted and live titles", async () => {
  const doc = `See web-jam-tools#1018 "old title that no longer matches" for background.\n`;

  const result = await verifyCitations(doc, "test.md", {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#1018": {
        state: "OPEN",
        title: "new live title",
      },
    }),
  });

  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "drifted-citation-title");
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
  assertStringIncludes(violation!.message, "old title that no longer matches");
  assertStringIncludes(violation!.message, "new live title");
});

Deno.test("verifyCitations: an unresolvable lookup REFUSES rather than passing, naming the citation", async () => {
  const doc = `See web-jam-tools#999999 "a made-up issue" for background.\n`;

  const result = await verifyCitations(doc, "test.md", {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#999999": { error: "Could not resolve to an issue" },
    }),
  });

  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "unresolved-citation");
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
  assertStringIncludes(violation!.message, "web-jam-tools#999999");
  assertStringIncludes(violation!.message, "Could not resolve to an issue");
});

Deno.test("verifyCitations: an OPEN issue with a matching title and no closed-acknowledgement issue passes cleanly", async () => {
  const doc = `web-jam-tools#742 "design document linter and body checks" is still open work.\n`;

  const result = await verifyCitations(doc, "test.md", {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#742": {
        state: "OPEN",
        title: "design document linter and body checks",
      },
    }),
  });

  assertEquals(result.valid, true, JSON.stringify(result.violations));
});

Deno.test("verifyCitations: the same issue cited on two lines is looked up once (deduped) but checked on each line", async () => {
  const doc =
    `web-jam-tools#1018 "hooks fix" line one.\nweb-jam-tools#1018 "hooks fix" line two, also closed.\n`;

  let callCount = 0;
  const result = await verifyCitations(doc, "test.md", {
    lookupImpl: (targets) => {
      callCount++;
      assertEquals(targets.length, 1);
      return stubLookup({
        "WebJamApps/web-jam-tools#1018": { state: "CLOSED", title: "hooks fix" },
      })(targets);
    },
  });

  assertEquals(callCount, 1);
  assertEquals(result.valid, false);
  const closedViolations = result.violations.filter((v) =>
    v.rule === "unacknowledged-closed-citation"
  );
  // Line one doesn't say "closed"; line two does, so only line one violates.
  assertEquals(closedViolations.length, 1);
  assertEquals(closedViolations[0].line, 1);
});

Deno.test("verifyCitationsFile throws when path is missing or file does not exist", async () => {
  let threw = false;
  try {
    await verifyCitationsFile("");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);

  threw = false;
  try {
    await verifyCitationsFile("/tmp/non-existent-verify-citations-doc-12345.md");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("verifyCitationsFile reads and checks a real file on disk", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "verify-citations-file-" });
  const docPath = path.join(tempDir, "doc.md");
  await Deno.writeTextFile(docPath, `web-jam-tools#742 "design document linter and body checks"\n`);

  try {
    const result = await verifyCitationsFile(docPath, {
      lookupImpl: stubLookup({
        "WebJamApps/web-jam-tools#742": {
          state: "OPEN",
          title: "design document linter and body checks",
        },
      }),
    });
    assertEquals(result.valid, true, JSON.stringify(result.violations));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// --- defaultLookupCitations (the real gh api graphql batching) ---

Deno.test("defaultLookupCitations: batches every number for a repo into one gh api graphql call", async () => {
  let callCount = 0;
  const mockRunner: CommandRunner = (args: string[]): Promise<CommandResult> => {
    callCount++;
    assertEquals(args[0], "api");
    assertEquals(args[1], "graphql");
    const queryArg = args.find((a) => a.startsWith("query="))!;
    assertStringIncludes(queryArg, "issue(number: 1018)");
    assertStringIncludes(queryArg, "issue(number: 432)");

    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            i1018: { number: 1018, title: "Title A", state: "CLOSED" },
            i432: { number: 432, title: "Title B", state: "OPEN" },
          },
        },
      }),
      stderr: "",
    });
  };

  const results = await defaultLookupCitations(
    [
      { repo: "WebJamApps/web-jam-tools", number: 1018 },
      { repo: "WebJamApps/web-jam-tools", number: 432 },
    ],
    mockRunner,
  );

  assertEquals(callCount, 1);
  assertEquals(results.get("WebJamApps/web-jam-tools#1018")?.title, "Title A");
  assertEquals(results.get("WebJamApps/web-jam-tools#1018")?.state, "CLOSED");
  assertEquals(results.get("WebJamApps/web-jam-tools#432")?.title, "Title B");
  assertEquals(results.get("WebJamApps/web-jam-tools#432")?.state, "OPEN");
});

Deno.test("defaultLookupCitations: two distinct repos produce two separate calls", async () => {
  let callCount = 0;
  const mockRunner: CommandRunner = (): Promise<CommandResult> => {
    callCount++;
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        data: { repository: { i1: { number: 1, title: "T", state: "OPEN" } } },
      }),
      stderr: "",
    });
  };

  await defaultLookupCitations(
    [
      { repo: "WebJamApps/web-jam-tools", number: 1 },
      { repo: "WebJamApps/web-jam-back", number: 1 },
    ],
    mockRunner,
  );

  assertEquals(callCount, 2);
});

Deno.test("defaultLookupCitations: a non-zero exit code refuses every citation in that repo, naming stderr", async () => {
  const mockRunner: CommandRunner = (): Promise<CommandResult> => {
    return Promise.resolve({ code: 1, stdout: "", stderr: "rate limited" });
  };

  const results = await defaultLookupCitations(
    [{ repo: "WebJamApps/web-jam-tools", number: 1018 }],
    mockRunner,
  );

  const entry = results.get("WebJamApps/web-jam-tools#1018");
  assertEquals(Boolean(entry?.error), true);
  assertStringIncludes(entry!.error!, "rate limited");
});

Deno.test("defaultLookupCitations: unparseable stdout refuses every citation in that repo", async () => {
  const mockRunner: CommandRunner = (): Promise<CommandResult> => {
    return Promise.resolve({ code: 0, stdout: "not json", stderr: "" });
  };

  const results = await defaultLookupCitations(
    [{ repo: "WebJamApps/web-jam-tools", number: 1018 }],
    mockRunner,
  );

  assertEquals(Boolean(results.get("WebJamApps/web-jam-tools#1018")?.error), true);
});

Deno.test("defaultLookupCitations: a repo GraphQL cannot resolve refuses every citation for it", async () => {
  const mockRunner: CommandRunner = (): Promise<CommandResult> => {
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        data: { repository: null },
        errors: [{ message: 'Could not resolve to a Repository with the name "nope".' }],
      }),
      stderr: "",
    });
  };

  const results = await defaultLookupCitations(
    [{ repo: "WebJamApps/nope", number: 1 }],
    mockRunner,
  );

  const entry = results.get("WebJamApps/nope#1");
  assertEquals(Boolean(entry?.error), true);
  assertStringIncludes(entry!.error!, "nope");
});

Deno.test("defaultLookupCitations: an issue number GraphQL could not resolve refuses just that citation", async () => {
  const mockRunner: CommandRunner = (): Promise<CommandResult> => {
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            i1018: { number: 1018, title: "Title A", state: "OPEN" },
            i999999: null,
          },
        },
        errors: [
          {
            type: "NOT_FOUND",
            path: ["repository", "i999999"],
            message: "Could not resolve to an issue with the number of 999999.",
          },
        ],
      }),
      stderr: "",
    });
  };

  const results = await defaultLookupCitations(
    [
      { repo: "WebJamApps/web-jam-tools", number: 1018 },
      { repo: "WebJamApps/web-jam-tools", number: 999999 },
    ],
    mockRunner,
  );

  assertEquals(results.get("WebJamApps/web-jam-tools#1018")?.title, "Title A");
  const bad = results.get("WebJamApps/web-jam-tools#999999");
  assertEquals(Boolean(bad?.error), true);
  assertStringIncludes(bad!.error!, "999999");
});

Deno.test("defaultLookupCitations: a number that resolves as a pull request (not an issue) is used, batched in the same query", async () => {
  let queryArg = "";
  const mockRunner: CommandRunner = (args: string[]): Promise<CommandResult> => {
    queryArg = args.find((a) => a.startsWith("query="))!;
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            i526: null,
            p526: {
              number: 526,
              title:
                "block-irreversible-operations.sh matches text inside heredocs and strings, so writing a test about the guard is blocked as if it were a deletion",
              state: "MERGED",
            },
          },
        },
        errors: [
          {
            type: "NOT_FOUND",
            path: ["repository", "i526"],
            message: "Could not resolve to an Issue with the number of 526.",
          },
        ],
      }),
      stderr: "",
    });
  };

  const results = await defaultLookupCitations(
    [{ repo: "WebJamApps/web-jam-tools", number: 526 }],
    mockRunner,
  );

  assertStringIncludes(queryArg, "issue(number: 526)");
  assertStringIncludes(queryArg, "pullRequest(number: 526)");

  const entry = results.get("WebJamApps/web-jam-tools#526");
  assertEquals(
    entry?.title,
    "block-irreversible-operations.sh matches text inside heredocs and strings, so writing a test about the guard is blocked as if it were a deletion",
  );
  assertEquals(entry?.state, "CLOSED");
  assertEquals(entry?.error, undefined);
});

Deno.test("defaultLookupCitations: a MERGED pull request maps to CLOSED, a CLOSED pull request maps to CLOSED, an OPEN one maps to OPEN", async () => {
  const stateFor = async (rawState: string) => {
    const mockRunner: CommandRunner = (): Promise<CommandResult> => {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          data: { repository: { i1: null, p1: { number: 1, title: "T", state: rawState } } },
        }),
        stderr: "",
      });
    };
    const results = await defaultLookupCitations(
      [{ repo: "WebJamApps/web-jam-tools", number: 1 }],
      mockRunner,
    );
    return results.get("WebJamApps/web-jam-tools#1")?.state;
  };

  assertEquals(await stateFor("MERGED"), "CLOSED");
  assertEquals(await stateFor("CLOSED"), "CLOSED");
  assertEquals(await stateFor("OPEN"), "OPEN");
});

Deno.test("defaultLookupCitations: a number that is neither an issue nor a pull request REFUSES with unresolved-citation", async () => {
  const mockRunner: CommandRunner = (): Promise<CommandResult> => {
    return Promise.resolve({
      code: 1,
      stdout: JSON.stringify({
        data: { repository: { i999999: null, p999999: null } },
        errors: [
          {
            type: "NOT_FOUND",
            path: ["repository", "i999999"],
            message: "Could not resolve to an Issue with the number of 999999.",
          },
          {
            type: "NOT_FOUND",
            path: ["repository", "p999999"],
            message: "Could not resolve to a PullRequest with the number of 999999.",
          },
        ],
      }),
      stderr: "gh: Could not resolve to an Issue with the number of 999999.",
    });
  };

  const results = await defaultLookupCitations(
    [{ repo: "WebJamApps/web-jam-tools", number: 999999 }],
    mockRunner,
  );

  const entry = results.get("WebJamApps/web-jam-tools#999999");
  assertEquals(Boolean(entry?.error), true);
});

Deno.test("verifyCitations: a cited merged pull request that is acknowledged passes; an unacknowledged one fails", async () => {
  const acknowledgedDoc =
    `web-jam-tools#526 "block-irreversible-operations.sh matches text inside heredocs and strings, so writing a test about the guard is blocked as if it were a deletion" records the same shape in a different guard, and was closed by tokenising rather than raw text matching.\n`;

  const acknowledgedResult = await verifyCitations(acknowledgedDoc, "test.md", {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#526": {
        state: "CLOSED",
        title:
          "block-irreversible-operations.sh matches text inside heredocs and strings, so writing a test about the guard is blocked as if it were a deletion",
      },
    }),
  });
  assertEquals(acknowledgedResult.valid, true, JSON.stringify(acknowledgedResult.violations));

  const unacknowledgedDoc = `| web-jam-tools#526 | some PR title | merged recently |\n`;
  const unacknowledgedResult = await verifyCitations(unacknowledgedDoc, "test.md", {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#526": { state: "CLOSED", title: "some PR title" },
    }),
  });
  const violation = unacknowledgedResult.violations.find((v) =>
    v.rule === "unacknowledged-closed-citation"
  );
  assertEquals(Boolean(violation), true, JSON.stringify(unacknowledgedResult.violations));
});

Deno.test("verifyCitations: a cited OPEN pull request passes without needing acknowledgement", async () => {
  const doc = `web-jam-tools#600 "some open PR" is still in review.\n`;

  const result = await verifyCitations(doc, "test.md", {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#600": { state: "OPEN", title: "some open PR" },
    }),
  });

  assertEquals(result.valid, true, JSON.stringify(result.violations));
});

Deno.test("verifyCitations: a drifted pull-request title fails the same way a drifted issue title does", async () => {
  const doc = `See web-jam-tools#600 "old PR title" for background.\n`;

  const result = await verifyCitations(doc, "test.md", {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#600": { state: "OPEN", title: "new live PR title" },
    }),
  });

  const violation = result.violations.find((v) => v.rule === "drifted-citation-title");
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
  assertStringIncludes(violation!.message, "old PR title");
  assertStringIncludes(violation!.message, "new live PR title");
});

Deno.test("defaultLookupCitations: gh's non-zero exit on a field-level error doesn't poison the other citations in the same batch", async () => {
  // Observed real behavior: `gh api graphql` exits 1 whenever the response carries ANY GraphQL
  // error, even a single field-level one (e.g. a citation naming a PR number, which the
  // `issue()` field can't resolve) — while stdout still carries the full partial `data` for
  // every other field in the same batched query. Treating that non-zero exit as a whole-repo
  // failure would wrongly mark every other, perfectly resolvable citation in the repo as
  // unresolved too.
  const mockRunner: CommandRunner = (): Promise<CommandResult> => {
    return Promise.resolve({
      code: 1,
      stdout: JSON.stringify({
        data: {
          repository: {
            i1018: { number: 1018, title: "Real issue title", state: "CLOSED" },
            i526: null,
          },
        },
        errors: [
          {
            type: "NOT_FOUND",
            path: ["repository", "i526"],
            message: "Could not resolve to an Issue with the number of 526.",
          },
        ],
      }),
      stderr: "gh: Could not resolve to an Issue with the number of 526.",
    });
  };

  const results = await defaultLookupCitations(
    [
      { repo: "WebJamApps/web-jam-tools", number: 1018 },
      { repo: "WebJamApps/web-jam-tools", number: 526 },
    ],
    mockRunner,
  );

  const good = results.get("WebJamApps/web-jam-tools#1018");
  assertEquals(good?.title, "Real issue title");
  assertEquals(good?.state, "CLOSED");
  assertEquals(good?.error, undefined);

  const bad = results.get("WebJamApps/web-jam-tools#526");
  assertEquals(Boolean(bad?.error), true);
  assertStringIncludes(bad!.error!, "526");
});

Deno.test("defaultLookupCitations: a repo string without a slash refuses without calling the runner", async () => {
  let called = false;
  const mockRunner: CommandRunner = (): Promise<CommandResult> => {
    called = true;
    return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
  };

  const results = await defaultLookupCitations(
    [{ repo: "not-a-valid-repo-format", number: 1 }],
    mockRunner,
  );

  assertEquals(called, false);
  assertEquals(Boolean(results.get("not-a-valid-repo-format#1")?.error), true);
});

// --- runVerifyCitationsCli ---

Deno.test("runVerifyCitationsCli handles --help cleanly", async () => {
  const exitCode = await runVerifyCitationsCli(["--help"]);
  assertEquals(exitCode, 0);
});

Deno.test("runVerifyCitationsCli returns exit code 1 when doc argument is missing", async () => {
  const exitCode = await runVerifyCitationsCli([]);
  assertEquals(exitCode, 1);
});

Deno.test("runVerifyCitationsCli returns exit code 1 when file does not exist", async () => {
  const exitCode = await runVerifyCitationsCli(["/tmp/non-existent-citations-doc-999.md"]);
  assertEquals(exitCode, 1);
});

Deno.test("runVerifyCitationsCli exits 0 for a document with no citations", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "verify-citations-cli-pass-" });
  const docPath = path.join(tempDir, "doc.md");
  await Deno.writeTextFile(docPath, "# Title\n\nNo citations.\n");

  try {
    const exitCode = await runVerifyCitationsCli([docPath]);
    assertEquals(exitCode, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runVerifyCitationsCli exits 1 for a determinate violation and 2 for an unresolved citation", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "verify-citations-cli-fail-" });

  const driftDocPath = path.join(tempDir, "drift.md");
  await Deno.writeTextFile(driftDocPath, `web-jam-tools#1018 "quoted old title"\n`);
  const driftExit = await runVerifyCitationsCli([driftDocPath], {
    lookupImpl: stubLookup({
      "WebJamApps/web-jam-tools#1018": { state: "OPEN", title: "live different title" },
    }),
  });
  assertEquals(driftExit, 1);

  const unresolvedDocPath = path.join(tempDir, "unresolved.md");
  await Deno.writeTextFile(unresolvedDocPath, `web-jam-tools#1018 "quoted title"\n`);
  const unresolvedExit = await runVerifyCitationsCli([unresolvedDocPath], {
    lookupImpl: stubLookup({}),
  });
  assertEquals(unresolvedExit, 2);

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("runVerifyCitationsCli supports --json flag", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "verify-citations-cli-json-" });
  const docPath = path.join(tempDir, "doc.md");
  await Deno.writeTextFile(docPath, "# Title\n\nNo citations.\n");

  try {
    const exitCode = await runVerifyCitationsCli([docPath, "--json"]);
    assertEquals(exitCode, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("cli.ts routes verify-citations subcommand correctly", async () => {
  const { runCli } = await import("../src/design-issue/cli.ts");
  const tempDir = await Deno.makeTempDir({ prefix: "verify-citations-cli-route-" });
  const docPath = path.join(tempDir, "doc.md");
  await Deno.writeTextFile(docPath, "# Title\n\nNo citations.\n");

  try {
    const exitCode = await runCli(["verify-citations", docPath]);
    assertEquals(exitCode, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("deno.json defines design:verify-citations task", async () => {
  const denoJsonContent = await Deno.readTextFile(
    new URL("../deno.json", import.meta.url).pathname,
  );
  const config = JSON.parse(denoJsonContent);

  assertEquals(typeof config.tasks["design:verify-citations"], "string");
  assertStringIncludes(
    config.tasks["design:verify-citations"],
    "src/design-issue/cli.ts verify-citations",
  );
});
