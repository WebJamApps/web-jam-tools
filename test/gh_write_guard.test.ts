// gh_write_guard.test.ts — web-jam-tools#685

import { assertEquals } from "@std/assert";
import {
  checkNoCredentialLiteral,
  checkNotEmpty,
  checkReviewerLine,
  checkReviewSummaryHeader,
  extractFooterAuthors,
  extractFooterEntries,
  isAlreadyReviewedAtHeadSha,
  REVIEW_SUMMARY_HEADER,
  runFormGuards,
} from "../scripts/gh-write/guard.ts";
import { variedFakeBody } from "./support/varied_fake_value.ts";

Deno.test("checkNotEmpty refuses an empty body", () => {
  const res = checkNotEmpty("");
  assertEquals(res.ok, false);
});

Deno.test("checkNotEmpty refuses a whitespace-only body", () => {
  const res = checkNotEmpty("   \n\t  ");
  assertEquals(res.ok, false);
});

Deno.test("checkNotEmpty allows a non-empty body", () => {
  const res = checkNotEmpty("## PR Review Summary\n**Approved**");
  assertEquals(res.ok, true);
});

Deno.test("checkNoCredentialLiteral refuses a synthetic AIza-prefixed literal", () => {
  const fake = "AIza" + variedFakeBody(35, 30);
  const res = checkNoCredentialLiteral(`config: ${fake}`);
  assertEquals(res.ok, false);
});

Deno.test("checkNoCredentialLiteral allows ordinary text", () => {
  const res = checkNoCredentialLiteral("## PR Review Summary\n**Approved**\nNo issues found.");
  assertEquals(res.ok, true);
});

Deno.test("checkReviewSummaryHeader refuses a body with no header", () => {
  const res = checkReviewSummaryHeader("**Approved** — looks fine.");
  assertEquals(res.ok, false);
});

Deno.test("checkReviewSummaryHeader allows a body carrying the header", () => {
  const res = checkReviewSummaryHeader(`${REVIEW_SUMMARY_HEADER}\n**Approved**`);
  assertEquals(res.ok, true);
});

Deno.test("runFormGuards without requireReviewHeader allows a headerless body", () => {
  const res = runFormGuards("looks fine, no findings.");
  assertEquals(res.ok, true);
});

Deno.test("runFormGuards with requireReviewHeader refuses a headerless body", () => {
  const res = runFormGuards("looks fine, no findings.", { requireReviewHeader: true });
  assertEquals(res.ok, false);
});

Deno.test("runFormGuards refuses empty before checking the header (empty-body check wins)", () => {
  const res = runFormGuards("   ", { requireReviewHeader: true });
  assertEquals(res.ok, false);
  assertEquals(res.error?.includes("empty"), true);
});

Deno.test("checkReviewerLine allows a well-formed reviewer line", () => {
  const body =
    `${REVIEW_SUMMARY_HEADER}\n**Approved**\n\n🤖 Reviewed by Claude Code — Claude Opus 5.5\n`;
  assertEquals(checkReviewerLine(body).ok, true);
  assertEquals(
    checkReviewerLine("🤖 Reviewed by Antigravity — Gemini Flash (High)").ok,
    true,
  );
});

Deno.test("checkReviewerLine refuses an absent line, with the exact refusal text", () => {
  const res = checkReviewerLine(`${REVIEW_SUMMARY_HEADER}\n**Approved**\n`);
  assertEquals(res.ok, false);
  assertEquals(
    res.error?.startsWith(
      'refusing to post: review body is missing the "🤖 Reviewed by <tool> — <model>" line',
    ),
    true,
  );
});

Deno.test("checkReviewerLine refuses each malformed shape", () => {
  const bad = [
    "🤖 Reviewed by",
    "🤖 Reviewed by ",
    "🤖 Reviewed by Claude Code",
    "🤖 Reviewed by Claude Code - Claude Opus",
    "🤖 Reviewed by Claude Code — ",
    "🤖 Reviewed by — Claude Opus",
    "🤖 Reviewed by Claude Code —Claude Opus",
    "some text 🤖 Reviewed by Claude Code — Claude Opus",
    "🤖 Reviewed by <tool> — <model>",
    "🤖 Reviewed by — — x",
  ];
  for (const line of bad) {
    assertEquals(checkReviewerLine(`${REVIEW_SUMMARY_HEADER}\n${line}\n`).ok, false, line);
  }
});

Deno.test("checkReviewerLine refuses an angle-bracket placeholder in tool or model", () => {
  assertEquals(
    checkReviewerLine(`${REVIEW_SUMMARY_HEADER}\n**Approved**\n\n🤖 Reviewed by <tool> — <model>\n`)
      .ok,
    false,
  );
  assertEquals(
    checkReviewerLine(
      `${REVIEW_SUMMARY_HEADER}\n**Approved**\n\n🤖 Reviewed by Claude Code — <model>\n`,
    ).ok,
    false,
  );
  assertEquals(
    checkReviewerLine(
      `${REVIEW_SUMMARY_HEADER}\n**Approved**\n\n🤖 Reviewed by <tool> — Claude Opus 5.5\n`,
    ).ok,
    false,
  );
});

Deno.test("checkReviewerLine refuses a tool or model consisting only of dashes", () => {
  assertEquals(
    checkReviewerLine(`${REVIEW_SUMMARY_HEADER}\n**Approved**\n\n🤖 Reviewed by — — x\n`).ok,
    false,
  );
  assertEquals(
    checkReviewerLine(`${REVIEW_SUMMARY_HEADER}\n**Approved**\n\n🤖 Reviewed by Claude Code — —\n`)
      .ok,
    false,
  );
  assertEquals(
    checkReviewerLine(
      `${REVIEW_SUMMARY_HEADER}\n**Approved**\n\n🤖 Reviewed by - — Claude Opus 5.5\n`,
    ).ok,
    false,
  );
});

Deno.test("checkReviewerLine refuses a reviewer line that is not on the last non-empty line", () => {
  const buriedInCode =
    `${REVIEW_SUMMARY_HEADER}\n**Approved**\n\n\`\`\`\n🤖 Reviewed by Claude Code — Claude Opus 5.5\n\`\`\`\n`;
  assertEquals(checkReviewerLine(buriedInCode).ok, false);

  const followedByText =
    `${REVIEW_SUMMARY_HEADER}\n**Approved**\n\n🤖 Reviewed by Claude Code — Claude Opus 5.5\n\nSome trailing note\n`;
  assertEquals(checkReviewerLine(followedByText).ok, false);
});

Deno.test("runFormGuards without requireReviewerLine allows a body with no reviewer line", () => {
  assertEquals(
    runFormGuards(`${REVIEW_SUMMARY_HEADER}\nfine`, { requireReviewHeader: true }).ok,
    true,
  );
});

Deno.test("runFormGuards with requireReviewerLine refuses a body with no reviewer line and allows one with it", () => {
  const without = runFormGuards(`${REVIEW_SUMMARY_HEADER}\nfine`, { requireReviewerLine: true });
  assertEquals(without.ok, false);
  const withLine = runFormGuards(
    `${REVIEW_SUMMARY_HEADER}\nfine\n\n🤖 Reviewed by Claude Code — Claude Opus 5.5`,
    { requireReviewHeader: true, requireReviewerLine: true },
  );
  assertEquals(withLine.ok, true);
});

Deno.test("runFormGuards runs the reviewer-line check after the header check", () => {
  const res = runFormGuards("no header, no line", {
    requireReviewHeader: true,
    requireReviewerLine: true,
  });
  assertEquals(res.error?.includes(REVIEW_SUMMARY_HEADER), true);
});

Deno.test("isAlreadyReviewedAtHeadSha skips when last review SHA equals head SHA", async () => {
  const result = await isAlreadyReviewedAtHeadSha(
    "WebJamApps/JaMmusic",
    1324,
    () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ last_review_sha: "abc123", head_sha: "abc123" }),
        stderr: "",
      }),
  );
  assertEquals(result.skip, true);
});

Deno.test("isAlreadyReviewedAtHeadSha does not skip when SHAs differ (new commits since last review)", async () => {
  const result = await isAlreadyReviewedAtHeadSha(
    "WebJamApps/JaMmusic",
    1324,
    () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ last_review_sha: "abc123", head_sha: "def456" }),
        stderr: "",
      }),
  );
  assertEquals(result.skip, false);
});

Deno.test("isAlreadyReviewedAtHeadSha does not skip when there is no prior review", async () => {
  const result = await isAlreadyReviewedAtHeadSha(
    "WebJamApps/JaMmusic",
    1324,
    () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ last_review_sha: null, head_sha: "def456" }),
        stderr: "",
      }),
  );
  assertEquals(result.skip, false);
});

Deno.test("isAlreadyReviewedAtHeadSha fails open (does not skip) when the gh query fails", async () => {
  const result = await isAlreadyReviewedAtHeadSha(
    "WebJamApps/JaMmusic",
    1324,
    () =>
      Promise.resolve({
        code: 1,
        stdout: "",
        stderr: "gh: not found",
      }),
  );
  assertEquals(result.skip, false);
});

Deno.test("isAlreadyReviewedAtHeadSha fails open (does not skip) on unparseable output", () => {
  return isAlreadyReviewedAtHeadSha("WebJamApps/JaMmusic", 1324, () =>
    Promise.resolve({
      code: 0,
      stdout: "not json",
      stderr: "",
    })).then((result) => assertEquals(result.skip, false));
});

Deno.test("isAlreadyReviewedAtHeadSha refuses (stale) when caller-supplied SHA differs from the live head", async () => {
  const result = await isAlreadyReviewedAtHeadSha(
    "WebJamApps/web-jam-tools",
    825,
    () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ last_review_sha: null, head_sha: "b2ff3ef" }),
        stderr: "",
      }),
    "487d3a2",
  );
  assertEquals(result.skip, false);
  assertEquals(result.stale, true);
  assertEquals(result.reason?.includes("487d3a2"), true);
  assertEquals(result.reason?.includes("b2ff3ef"), true);
});

Deno.test("isAlreadyReviewedAtHeadSha proceeds (no skip, no stale) when caller-supplied SHA matches the live head and no prior review exists", async () => {
  const result = await isAlreadyReviewedAtHeadSha(
    "WebJamApps/web-jam-tools",
    825,
    () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ last_review_sha: null, head_sha: "b2ff3ef" }),
        stderr: "",
      }),
    "b2ff3ef",
  );
  assertEquals(result.skip, false);
  assertEquals(result.stale, undefined);
});

Deno.test("isAlreadyReviewedAtHeadSha still skips (already-reviewed) when caller-supplied SHA matches the live head and a review already exists there", async () => {
  const result = await isAlreadyReviewedAtHeadSha(
    "WebJamApps/web-jam-tools",
    825,
    () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ last_review_sha: "b2ff3ef", head_sha: "b2ff3ef" }),
        stderr: "",
      }),
    "b2ff3ef",
  );
  assertEquals(result.skip, true);
  assertEquals(result.stale, undefined);
});

Deno.test("isAlreadyReviewedAtHeadSha with a caller-supplied SHA still fails open (no skip, no stale) on an inconclusive gh call", async () => {
  const result = await isAlreadyReviewedAtHeadSha(
    "WebJamApps/web-jam-tools",
    825,
    () =>
      Promise.resolve({
        code: 1,
        stdout: "",
        stderr: "gh: not found",
      }),
    "487d3a2",
  );
  assertEquals(result.skip, false);
  assertEquals(result.stale, undefined);
});

Deno.test("isAlreadyReviewedAtHeadSha omitting the caller-supplied SHA behaves unchanged (byte-identical to before web-jam-tools#825)", async () => {
  const result = await isAlreadyReviewedAtHeadSha(
    "WebJamApps/web-jam-tools",
    825,
    () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ last_review_sha: "abc123", head_sha: "def456" }),
        stderr: "",
      }),
  );
  assertEquals(result.skip, false);
  assertEquals(result.stale, undefined);
});

Deno.test("isAlreadyReviewedAtHeadSha refuses (stale) even when a review already exists at the live head — the staleness check runs first (regression: swapping the two arms back to the old order would silently reintroduce web-jam-tools#825)", async () => {
  const result = await isAlreadyReviewedAtHeadSha(
    "WebJamApps/web-jam-tools",
    825,
    () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ last_review_sha: "b2ff3ef", head_sha: "b2ff3ef" }),
        stderr: "",
      }),
    "487d3a2",
  );
  assertEquals(result.stale, true);
  assertEquals(result.skip, false);
});

Deno.test("isAlreadyReviewedAtHeadSha refuses (stale) with full-length 40-char SHAs — the real production shape (Step 1's --jq returns .oid, not a short SHA)", async () => {
  const fullHead = "b2ff3efabcdef0123456789abcdef0123456789a";
  const fullCaller = "487d3a2abcdef0123456789abcdef0123456789a";
  const result = await isAlreadyReviewedAtHeadSha(
    "WebJamApps/web-jam-tools",
    825,
    () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ last_review_sha: null, head_sha: fullHead }),
        stderr: "",
      }),
    fullCaller,
  );
  assertEquals(result.skip, false);
  assertEquals(result.stale, true);
});

Deno.test("isAlreadyReviewedAtHeadSha invokes gh with bare pr id and --repo flag", async () => {
  let seenArgs: string[] = [];
  await isAlreadyReviewedAtHeadSha("WebJamApps/JaMmusic", 1324, (cmd) => {
    seenArgs = cmd;
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ last_review_sha: null, head_sha: "def456" }),
      stderr: "",
    });
  });
  assertEquals(seenArgs.slice(0, 6), [
    "gh",
    "pr",
    "view",
    "1324",
    "--repo",
    "WebJamApps/JaMmusic",
  ]);
});

// --- extractFooterAuthors and extractFooterEntries (web-jam-tools#1200) ---

Deno.test("extractFooterAuthors extracts footer author from line starting with 🤖 Work by", () => {
  const authors = extractFooterAuthors("Fixed in dev.\n\n🤖 Work by Codex — GPT-6\n");
  assertEquals(authors, ["Codex — GPT-6"]);
});

Deno.test("extractFooterAuthors returns empty string for bare 🤖 Work by line", () => {
  const authors = extractFooterAuthors("Fixed in dev.\n\n🤖 Work by\n");
  assertEquals(authors, [""]);

  const authorsWhitespace = extractFooterAuthors("Fixed in dev.\n\n🤖 Work by   \n");
  assertEquals(authorsWhitespace, [""]);
});

Deno.test("extractFooterAuthors ignores footers in blockquotes or inline backticks", () => {
  const body = [
    "Quoting a footer in blockquote:",
    "> 🤖 Work by Codex — GPT-6",
    "And inline backticks:",
    "`🤖 Work by Codex — GPT-6`",
    "Mentioning `🤖 Work by other` in sentence.",
  ].join("\n");
  const authors = extractFooterAuthors(body);
  assertEquals(authors, []);
});

Deno.test("extractFooterAuthors extracts footer inside a fenced code block", () => {
  const body = [
    "Example snippet:",
    "```sh",
    "🤖 Work by Codex — GPT-6",
    "```",
  ].join("\n");
  const authors = extractFooterAuthors(body);
  assertEquals(authors, ["Codex — GPT-6"]);
});

Deno.test("extractFooterEntries matches a footer with leading whitespace and keeps the original line", () => {
  const body = "- item\n  \u{1F916} Work by Codex \u2014 GPT-6\n> \u{1F916} Work by quoted";
  assertEquals(extractFooterEntries(body), [
    { line: "  \u{1F916} Work by Codex \u2014 GPT-6", author: "Codex \u2014 GPT-6" },
  ]);
});

Deno.test("extractFooterAuthors does not require an em dash", () => {
  const body = "🤖 Work by SingleAuthorModel";
  const authors = extractFooterAuthors(body);
  assertEquals(authors, ["SingleAuthorModel"]);
});

Deno.test("extractFooterAuthors extracts multiple footers in body order", () => {
  const body = [
    "Initial attempt:",
    "🤖 Work by Claude Code — Sonnet 5.5",
    "Follow-up:",
    "🤖 Work by Codex — GPT-6",
  ].join("\n");
  const authors = extractFooterAuthors(body);
  assertEquals(authors, ["Claude Code — Sonnet 5.5", "Codex — GPT-6"]);
});

Deno.test("extractFooterEntries preserves exact original line", () => {
  const body = "🤖 Work by   Custom Model (high)  ";
  const entries = extractFooterEntries(body);
  assertEquals(entries, [
    { line: "🤖 Work by   Custom Model (high)  ", author: "Custom Model (high)" },
  ]);
});
