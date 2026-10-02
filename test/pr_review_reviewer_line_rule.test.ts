import { assert, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/pr-review/SKILL.md", import.meta.url).pathname;

async function readSkill(): Promise<string> {
  let content: string;
  try {
    content = await Deno.readTextFile(SKILL_MD_PATH);
  } catch (err) {
    throw new Error(`skills/pr-review/SKILL.md is missing or unreadable: ${err}`);
  }
  assert(content.length > 0, "skills/pr-review/SKILL.md is empty");
  return content;
}

/** Slice of the skill between two headings, so a rule is pinned to the step it belongs to. */
function between(content: string, from: string, to: string): string {
  const start = content.indexOf(from);
  const end = content.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, `could not locate "${from}" .. "${to}" in the skill`);
  return content.slice(start, end);
}

Deno.test("skills/pr-review/SKILL.md Step 3 requires the reviewer line as the final element of every review post", async () => {
  const step3 = between(await readSkill(), "### Step 3:", "### Step 4:");

  assertStringIncludes(step3, "**Reviewer line**");
  assertStringIncludes(step3, "`🤖 Reviewed by <tool> — <model>`");
  assertStringIncludes(step3, "**final element of every review post**");
  // Names the model actually running, never the PR author's footer.
  assertStringIncludes(step3, "**actually running this review**");
  assertStringIncludes(step3, "never copied from the PR's own `🤖 Work by …` author footer");
  // The guard paragraph lists the missing reviewer line among the refusals.
  assertStringIncludes(step3, "no well-formed\n   `🤖 Reviewed by <tool> — <model>` line");
});

Deno.test("skills/pr-review/SKILL.md Step 3 example blocks each end with a reviewer line", async () => {
  const step3 = between(await readSkill(), "### Step 3:", "### Step 4:");
  const blocks = step3.split("````md").slice(1).map((b) => b.split("````")[0]);
  assert(blocks.length >= 2, "expected the initial-post and follow-up example blocks");
  for (const block of blocks) {
    const lines = block.trimEnd().split("\n").map((l) => l.trim());
    assert(
      /^🤖 Reviewed by .+ — .+$/u.test(lines[lines.length - 1]),
      `example block does not end with a reviewer line: ${lines[lines.length - 1]}`,
    );
  }
});

Deno.test("skills/pr-review/SKILL.md Step 4 requires the same reviewer line on the CircleCI follow-up", async () => {
  const step4 = between(await readSkill(), "### Step 4:", "### A found defect");

  assertStringIncludes(step4, "the reviewer line `🤖 Reviewed by <tool> — <model>`");
  assertStringIncludes(
    step4,
    "refuses a\n   body that carries the review header but no reviewer line",
  );
  assertStringIncludes(
    step4,
    "**Apart from the reviewer line named above, it carries nothing else.**",
  );
  // The old absolute statements are gone.
  assert(
    !step4.includes("Carry only the"),
    "Step 4 still says the follow-up carries only the header/verdict/sections",
  );
  assert(
    !step4.includes("**It carries nothing else.**"),
    "Step 4 still says the follow-up carries nothing else",
  );
});
