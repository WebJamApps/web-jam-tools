import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from "@std/assert";

const RETIRED_NAME = ["Haiku", "4.5"].join(" ");
const RETIRED_SLUG = ["haiku", "4", "5"].join("-");
const OLD_FOOTER_RULE =
  `- **Older Haiku footers:** A pull request already signed \`Claude ${RETIRED_NAME}\` keeps its footer and is read as a Haiku author; the current roster is used only when signing new work.`;

function assertCurrentNames(file: string, text: string) {
  for (const [index, line] of text.split("\n").entries()) {
    if (file === "skills/pr-review/SKILL.md" && line.trim() === OLD_FOOTER_RULE) continue;
    const lower = line.toLowerCase();
    assertFalse(
      lower.includes(RETIRED_NAME.toLowerCase()) || lower.includes(RETIRED_SLUG),
      `${file}:${index + 1} names the retired Haiku model`,
    );
  }
}

Deno.test("Haiku model names: all tracked files use the current version except the old-footer rule", async () => {
  const listing = await new Deno.Command("git", {
    args: ["ls-files", "-z"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(listing.code, 0);
  const files = new TextDecoder().decode(listing.stdout).split("\0").filter(Boolean);
  assert(files.length > 0);
  for (const file of files) assertCurrentNames(file, await Deno.readTextFile(file));
});

Deno.test("Haiku model names: scratch content reintroducing either old spelling fails", () => {
  assertThrows(() => assertCurrentNames("skills/delegate/SKILL.md", `Sign ${RETIRED_NAME}`));
  assertThrows(() => assertCurrentNames("fixture.ts", `model: claude-${RETIRED_SLUG}`));
  assertThrows(() => assertCurrentNames("fixture.md", OLD_FOOTER_RULE));
  assertCurrentNames("skills/pr-review/SKILL.md", OLD_FOOTER_RULE);
  assertThrows(() =>
    assertCurrentNames("skills/pr-review/SKILL.md", `${OLD_FOOTER_RULE}\nUse ${RETIRED_NAME}`)
  );
});

Deno.test("Haiku model names: new authors use the current roster and old PR footers retain their rule", async () => {
  const script = new URL("../scripts/create-draft-pr.sh", import.meta.url).pathname;
  for (
    const [author, expected] of [
      ["Claude Code — Claude Haiku 5.5", 0],
      ["Claude Code — Haiku 5.5", 0],
      [`Claude Code — Claude ${RETIRED_NAME}`, 1],
      [`Claude Code — ${RETIRED_NAME}`, 1],
    ] as const
  ) {
    const result = await new Deno.Command("bash", {
      args: [script, "--check-author", author],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, expected);
  }
  const skill = await Deno.readTextFile("skills/pr-review/SKILL.md");
  assertStringIncludes(skill, OLD_FOOTER_RULE);
  assertStringIncludes(skill, "`Claude Haiku 5.5`");
});

Deno.test("Haiku model names: the shared launcher settings request high effort", async () => {
  const data = JSON.parse(await Deno.readTextFile("scripts/claude-settings.json"));
  assertEquals(data.modelSettings, { "claude-haiku-5-5": { effortLevel: "high" } });
});
