import { assert, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/file-issue/SKILL.md", import.meta.url).pathname;

Deno.test("skills/file-issue/SKILL.md keeps the delegated filing prompt rule inside rule 2", async () => {
  let content: string;
  try {
    content = await Deno.readTextFile(SKILL_MD_PATH);
  } catch (err) {
    throw new Error(`skills/file-issue/SKILL.md is missing or unreadable: ${err}`);
  }

  assert(content.length > 0, "skills/file-issue/SKILL.md is empty");

  const rule2Start = content.indexOf(
    "2. **Choose the model label deliberately, not as an afterthought.**",
  );
  assert(rule2Start >= 0, "rule 2 must choose the model label deliberately");

  const rule3Start = content.indexOf("\n3. ", rule2Start);
  assert(rule3Start > rule2Start, "rule 2 must end before rule 3");

  const rule2 = content.slice(rule2Start, rule3Start);
  const delegatedPromptRule =
    "**A prompt that hands filing to another agent never names the label.**";
  assertStringIncludes(rule2, delegatedPromptRule);

  const delegatedPromptPosition = rule2.indexOf(delegatedPromptRule);
  const tierSizeRulePosition = rule2.indexOf("**Tier is not a function of diff size.**");
  assert(
    tierSizeRulePosition > delegatedPromptPosition,
    "delegated filing prompt rule must precede the tier-size rule",
  );
});
