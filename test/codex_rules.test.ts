// test/codex_rules.test.ts — web-jam-tools#1142
//
// Tests for the versioned Codex execpolicy rules file in codex/rules/web-jam-tools.rules.
// Verifies:
// 1. File existence as a plain-text regular file (not a symlink).
// 2. Structural parsing and validation of all 7 prefix rules.
// 3. Evaluation semantics across all 12 literal cases.
// 4. If `codex` is available on PATH, invokes `codex execpolicy check` directly
//    against each literal case and verifies the returned decision.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, resolve } from "@std/path";

const REPO_ROOT = resolve(fromFileUrl(import.meta.url), "../..");
const RULES_PATH = resolve(REPO_ROOT, "codex/rules/web-jam-tools.rules");

interface PrefixRule {
  pattern: string[];
  decision: "forbidden" | "prompt" | "allowed";
}

const EXPECTED_RULES: PrefixRule[] = [
  { pattern: ["git", "push"], decision: "forbidden" },
  { pattern: ["git", "branch", "-D"], decision: "forbidden" },
  { pattern: ["git", "branch", "--delete"], decision: "forbidden" },
  { pattern: ["gh", "repo", "sync"], decision: "forbidden" },
  { pattern: ["claude"], decision: "forbidden" },
  { pattern: ["gh", "api"], decision: "prompt" },
  { pattern: ["deno", "task", "push", "--force-with-lease"], decision: "prompt" },
];

const LITERAL_CASES: Array<{ cmd: string[]; expected: "forbidden" | "prompt" | "allowed" }> = [
  { cmd: ["git", "push"], expected: "forbidden" },
  { cmd: ["git", "push", "origin", "dev"], expected: "forbidden" },
  { cmd: ["git", "push", "--delete", "origin", "x"], expected: "forbidden" },
  { cmd: ["git", "branch", "-D", "x"], expected: "forbidden" },
  { cmd: ["git", "branch", "--delete", "x"], expected: "forbidden" },
  { cmd: ["gh", "repo", "sync"], expected: "forbidden" },
  { cmd: ["claude", "-p", "hi"], expected: "forbidden" },
  { cmd: ["gh", "api", "user"], expected: "prompt" },
  { cmd: ["gh", "api", "-X", "POST", "repos/x/y/issues"], expected: "prompt" },
  { cmd: ["deno", "task", "push", "--force-with-lease"], expected: "prompt" },
  { cmd: ["deno", "task", "push"], expected: "allowed" },
  { cmd: ["git", "status"], expected: "allowed" },
];

function parseRules(content: string): PrefixRule[] {
  const rules: PrefixRule[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^prefix_rule\(pattern=\[(.*?)\],\s*decision="([^"]+)"\)$/);
    if (match) {
      const patternRaw = match[1];
      const decision = match[2] as "forbidden" | "prompt" | "allowed";
      const tokens = patternRaw
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      rules.push({ pattern: tokens, decision });
    }
  }
  return rules;
}

function evaluatePrefixRules(
  cmd: string[],
  rules: PrefixRule[],
): "forbidden" | "prompt" | "allowed" {
  for (const rule of rules) {
    if (rule.pattern.length <= cmd.length) {
      const matches = rule.pattern.every((patToken, idx) => patToken === cmd[idx]);
      if (matches) {
        return rule.decision;
      }
    }
  }
  return "allowed";
}

Deno.test("codex rules file is a regular file and not a symlink", () => {
  const stat = Deno.lstatSync(RULES_PATH);
  assert(stat.isFile, "Rules path must be a regular file");
  assert(!stat.isSymlink, "Rules path must not be a symlink");
});

Deno.test("codex rules file structurally matches expected prefix rules", () => {
  const content = Deno.readTextFileSync(RULES_PATH);
  const rules = parseRules(content);
  assertEquals(rules, EXPECTED_RULES);
});

Deno.test("pure prefix matching logic matches all 12 literal cases", () => {
  const content = Deno.readTextFileSync(RULES_PATH);
  const rules = parseRules(content);

  for (const { cmd, expected } of LITERAL_CASES) {
    const decision = evaluatePrefixRules(cmd, rules);
    assertEquals(
      decision,
      expected,
      `Simulated prefix rule mismatch for '${
        cmd.join(" ")
      }': expected '${expected}', got '${decision}'`,
    );
  }
});

Deno.test("codex execpolicy check matches all 12 literal cases when codex is installed", async () => {
  let hasCodex = false;
  try {
    const check = await new Deno.Command("codex", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    hasCodex = check.success;
  } catch {
    hasCodex = false;
  }

  if (!hasCodex) {
    console.log("codex binary not found on PATH; skipping live CLI check");
    return;
  }

  for (const { cmd, expected } of LITERAL_CASES) {
    const proc = await new Deno.Command("codex", {
      args: ["execpolicy", "check", "--rules", RULES_PATH, ...cmd],
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(proc.success, true, `codex execpolicy check failed for ${cmd.join(" ")}`);
    const stdout = new TextDecoder().decode(proc.stdout);
    const parsed = JSON.parse(stdout);
    const decision = parsed.decision ?? (parsed.matchedRules?.length === 0 ? "allowed" : "unknown");
    assertEquals(
      decision,
      expected,
      `Expected decision for '${cmd.join(" ")}' to be '${expected}', but got '${decision}'`,
    );
  }
});
