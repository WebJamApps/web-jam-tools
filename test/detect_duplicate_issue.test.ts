// detect_duplicate_issue.test.ts — web-jam-tools#901
import { assertEquals } from "@std/assert";
import {
  checkDuplicateTitle,
  classifyDuplicate,
  DUPLICATE_MIN_SHARED_TOKENS,
  DUPLICATE_SIMILARITY_THRESHOLD,
  fetchOpenIssueTitles,
  findSimilarOpenIssues,
  formatCandidates,
  titleSimilarity,
  tokenizeTitle,
} from "../hooks/lib/detect_duplicate_issue.ts";

const EXISTING_TITLE =
  "skills/design-issue: support and validate structured Revision History tables for multi-phase design document updates";

const EXISTING_OPEN_ISSUES = [{ number: 885, title: EXISTING_TITLE }];

Deno.test("tokenizeTitle: lowercases, strips punctuation, drops stopwords and single-char tokens", () => {
  assertEquals(
    tokenizeTitle("skills/design-issue: support and validate structured Revision History tables"),
    [
      "skills",
      "design",
      "issue",
      "support",
      "validate",
      "structured",
      "revision",
      "history",
      "tables",
    ],
  );
  assertEquals(tokenizeTitle("T"), []);
  assertEquals(tokenizeTitle("a an the for to of in on or is"), []);
});

Deno.test("titleSimilarity: identical titles are 1, unrelated titles are 0", () => {
  assertEquals(titleSimilarity(EXISTING_TITLE, EXISTING_TITLE), 1);
  assertEquals(
    titleSimilarity(EXISTING_TITLE, "docs: fix a broken link in the README"),
    0,
  );
});

// --- Acceptance criterion 5: these titles are each denied as candidates ---

const DENIED_TITLES = [
  "skills/design-issue: support and validate structured Revision History tables",
  "design-issue: validate Revision History tables for design documents",
  "skills/design-issue: Revision History table support and validation",
];

for (const title of DENIED_TITLES) {
  Deno.test(`findSimilarOpenIssues: flags candidate — "${title}"`, () => {
    const candidates = findSimilarOpenIssues(title, EXISTING_OPEN_ISSUES);
    assertEquals(candidates.length, 1);
    assertEquals(candidates[0].number, 885);
  });
}

// --- Acceptance criterion 6: these titles are each allowed ---

const ALLOWED_TITLES = [
  "model/venue: apply the nine approved venue pay figures in a one-time update",
  "book-gig: add the pay column to the report table",
  "docs: fix a broken link in the README",
];

for (const title of ALLOWED_TITLES) {
  Deno.test(`findSimilarOpenIssues: allows unrelated title — "${title}"`, () => {
    assertEquals(findSimilarOpenIssues(title, EXISTING_OPEN_ISSUES), []);
  });
}

Deno.test("findSimilarOpenIssues: below the shared-token floor never matches, regardless of similarity", () => {
  // "table" alone shares exactly 1 token with the existing title's "tables" — below
  // DUPLICATE_MIN_SHARED_TOKENS even though token overlap as a fraction could be high
  // for a short title, so the floor prevents short-title false positives.
  const candidates = findSimilarOpenIssues("table", EXISTING_OPEN_ISSUES);
  assertEquals(candidates, []);
});

Deno.test("constants: threshold and floor are sane (documents current tuning)", () => {
  assertEquals(DUPLICATE_MIN_SHARED_TOKENS, 3);
  assertEquals(DUPLICATE_SIMILARITY_THRESHOLD, 0.3);
});

// --- classifyDuplicate: the three outcomes, pure (no network) ---

Deno.test("classifyDuplicate: outcome 1 — no repo or empty title is skipped, not searched", () => {
  assertEquals(classifyDuplicate("Some title with enough words", null, []), { outcome: "skip" });
  assertEquals(classifyDuplicate("Some title with enough words", undefined, []), {
    outcome: "skip",
  });
  assertEquals(classifyDuplicate("", "WebJamApps/web-jam-tools", []), { outcome: "skip" });
});

Deno.test("classifyDuplicate: outcome 1 — short/generic titles are skipped (can never reach the floor)", () => {
  assertEquals(classifyDuplicate("T", "WebJamApps/web-jam-tools", EXISTING_OPEN_ISSUES), {
    outcome: "skip",
  });
  assertEquals(classifyDuplicate("Fix bug", "WebJamApps/web-jam-tools", EXISTING_OPEN_ISSUES), {
    outcome: "skip",
  });
});

Deno.test("classifyDuplicate: outcome 1 — no similar open issue found proceeds unchanged", () => {
  const res = classifyDuplicate(
    "docs: fix a broken link in the README",
    "WebJamApps/web-jam-tools",
    EXISTING_OPEN_ISSUES,
  );
  assertEquals(res, { outcome: "pass" });
});

Deno.test("classifyDuplicate: outcome 2 — a similar open issue found is denied, naming the candidate", () => {
  const res = classifyDuplicate(
    "skills/design-issue: support and validate structured Revision History tables",
    "WebJamApps/web-jam-tools",
    EXISTING_OPEN_ISSUES,
  );
  if (res.outcome !== "deny_duplicate") {
    throw new Error(`expected deny_duplicate, got ${res.outcome}`);
  }
  assertEquals(res.candidates[0].number, 885);
  assertEquals(
    formatCandidates(res.repoFull, res.candidates),
    'web-jam-tools#885 "skills/design-issue: support and validate structured Revision History tables for multi-phase design document updates"',
  );
});

Deno.test("classifyDuplicate: outcome 3 — the search cannot run (null) is refused, not treated as no match", () => {
  const res = classifyDuplicate(
    "skills/design-issue: support and validate structured Revision History tables",
    "WebJamApps/web-jam-tools",
    null,
  );
  assertEquals(res, { outcome: "deny_search_failed", repoFull: "WebJamApps/web-jam-tools" });
});

Deno.test("classifyDuplicate: an override reason clears outcome 2 (duplicate found)", () => {
  const res = classifyDuplicate(
    "skills/design-issue: support and validate structured Revision History tables",
    "WebJamApps/web-jam-tools",
    EXISTING_OPEN_ISSUES,
    { candidate: "web-jam-tools#885", reason: "different scope: this is documentation only" },
  );
  assertEquals(res, { outcome: "pass" });
});

Deno.test("classifyDuplicate: an override reason clears outcome 3 (search failed) without needing a candidate", () => {
  const res = classifyDuplicate(
    "skills/design-issue: support and validate structured Revision History tables",
    "WebJamApps/web-jam-tools",
    null,
    { reason: "gh API was down, Josh approved filing anyway" },
  );
  assertEquals(res, { outcome: "pass" });
});

Deno.test("classifyDuplicate: an empty/whitespace-only override reason does NOT clear a deny", () => {
  const res = classifyDuplicate(
    "skills/design-issue: support and validate structured Revision History tables",
    "WebJamApps/web-jam-tools",
    EXISTING_OPEN_ISSUES,
    { candidate: "web-jam-tools#885", reason: "   " },
  );
  assertEquals(res.outcome, "deny_duplicate");
});

// --- fetchOpenIssueTitles / checkDuplicateTitle: async orchestration with an injected runner ---

Deno.test("fetchOpenIssueTitles: parses a successful gh issue list response", async () => {
  const issues = await fetchOpenIssueTitles("WebJamApps/web-jam-tools", (args) => {
    assertEquals(args[0], "issue");
    assertEquals(args[1], "list");
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify([{ number: 1, title: "One" }, { number: 2, title: "Two" }]),
      stderr: "",
    });
  });
  assertEquals(issues, [{ number: 1, title: "One" }, { number: 2, title: "Two" }]);
});

Deno.test("fetchOpenIssueTitles: non-zero exit code returns null (search failed)", async () => {
  const issues = await fetchOpenIssueTitles(
    "WebJamApps/web-jam-tools",
    () => Promise.resolve({ code: 1, stdout: "", stderr: "auth error" }),
  );
  assertEquals(issues, null);
});

Deno.test("fetchOpenIssueTitles: unparseable stdout returns null (search failed)", async () => {
  const issues = await fetchOpenIssueTitles(
    "WebJamApps/web-jam-tools",
    () => Promise.resolve({ code: 0, stdout: "not json", stderr: "" }),
  );
  assertEquals(issues, null);
});

Deno.test("fetchOpenIssueTitles: non-array JSON returns null (search failed)", async () => {
  const issues = await fetchOpenIssueTitles(
    "WebJamApps/web-jam-tools",
    () => Promise.resolve({ code: 0, stdout: "{}", stderr: "" }),
  );
  assertEquals(issues, null);
});

Deno.test("checkDuplicateTitle: end-to-end deny_duplicate via an injected runner", async () => {
  const res = await checkDuplicateTitle(
    "skills/design-issue: support and validate structured Revision History tables",
    "WebJamApps/web-jam-tools",
    null,
    () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify(EXISTING_OPEN_ISSUES),
        stderr: "",
      }),
  );
  assertEquals(res.outcome, "deny_duplicate");
});

Deno.test("checkDuplicateTitle: an override skips the network call entirely", async () => {
  let called = false;
  const res = await checkDuplicateTitle(
    "skills/design-issue: support and validate structured Revision History tables",
    "WebJamApps/web-jam-tools",
    { reason: "already reviewed, not a duplicate" },
    () => {
      called = true;
      return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
    },
  );
  assertEquals(res, { outcome: "pass" });
  assertEquals(called, false);
});
