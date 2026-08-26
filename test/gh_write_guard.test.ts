// gh_write_guard.test.ts — web-jam-tools#685

import { assertEquals } from "@std/assert";
import {
  checkNoCredentialLiteral,
  checkNotEmpty,
  checkReviewSummaryHeader,
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
