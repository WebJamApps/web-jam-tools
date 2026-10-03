// test/codex_rules.test.ts — web-jam-tools#1142
//
// Tests for the versioned Codex execpolicy rules file in codex/rules/web-jam-tools.rules.
// Verifies:
// 1. File existence as a plain-text regular file (not a symlink).
// 2. Structural parsing and validation of all 7 prefix rules.
// 3. Evaluation semantics across all literal cases (the 12 from the issue plus review and extra cases).
// 4. If `codex` is available on PATH, invokes `codex execpolicy check` directly
//    against each literal case and verifies the returned decision.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, resolve } from "@std/path";

const REPO_ROOT = resolve(fromFileUrl(import.meta.url), "../..");
const RULES_PATH = resolve(REPO_ROOT, "codex/rules/web-jam-tools.rules");

interface PrefixRule {
  pattern: Array<string | string[]>;
  decision: "forbidden" | "prompt" | "allowed";
}

const EXPECTED_RULES: PrefixRule[] = [
  { pattern: ["git", "push"], decision: "forbidden" },
  { pattern: ["git", "branch", "-D"], decision: "forbidden" },
  { pattern: ["git", "branch", "--delete"], decision: "forbidden" },
  { pattern: ["gh", "repo", "sync"], decision: "forbidden" },
  { pattern: ["claude"], decision: "forbidden" },
  { pattern: [["env", "command", "sudo"], "git", "push"], decision: "forbidden" },
  { pattern: ["/usr/bin/git", "push"], decision: "forbidden" },
  { pattern: [["npx", "env", "command"], "claude"], decision: "forbidden" },
  { pattern: ["gh", "api"], decision: "prompt" },
  { pattern: ["deno", "task", "push", "--force-with-lease"], decision: "prompt" },
  { pattern: [["env", "command"], "gh", "api"], decision: "prompt" },
  { pattern: ["/usr/bin/gh", "api"], decision: "prompt" },
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

// Review findings and extra cases for web-jam-tools#1142 (PR 1222), plus the regression list.
const EXTRA_CASES: Array<{ cmd: string[]; expected: "forbidden" | "prompt" | "allowed" }> = [
  { cmd: ["git", "-C", "/tmp/x", "push"], expected: "allowed" },
  { cmd: ["git", "-c", "x=y", "push"], expected: "allowed" },
  { cmd: ["git", "--git-dir", "/tmp/x/.git", "push"], expected: "allowed" },
  { cmd: ["git", "--work-tree", "/tmp/x", "push"], expected: "allowed" },
  { cmd: ["env", "git", "push"], expected: "forbidden" },
  { cmd: ["command", "git", "push"], expected: "forbidden" },
  { cmd: ["/usr/bin/git", "push"], expected: "forbidden" },
  { cmd: ["sudo", "git", "push"], expected: "forbidden" },
  { cmd: ["npx", "claude", "-p", "hi"], expected: "forbidden" },
  { cmd: ["env", "claude", "-p", "hi"], expected: "forbidden" },
  { cmd: ["command", "claude", "-p", "hi"], expected: "forbidden" },
  { cmd: ["env", "gh", "api", "user"], expected: "prompt" },
  { cmd: ["command", "gh", "api", "user"], expected: "prompt" },
  { cmd: ["/usr/bin/gh", "api", "user"], expected: "prompt" },
  // Pinned: global-option forms are deliberately unmatched here (Josh, 2026-10-03); the push-guard hooks decide them.
  { cmd: ["git", "-C", "/tmp/x", "status"], expected: "allowed" },
  // Regression list.
  { cmd: ["git", "push", "-u", "origin", "some-branch"], expected: "forbidden" },
  { cmd: ["git", "push", "--force-with-lease"], expected: "forbidden" },
  { cmd: ["git", "push", "origin", ":some-branch"], expected: "forbidden" },
  { cmd: ["git", "log", "--oneline"], expected: "allowed" },
  { cmd: ["gh", "pr", "view", "1"], expected: "allowed" },
  { cmd: ["git", "branch", "-d", "foo"], expected: "allowed" },
];
const ALL_CASES = [...LITERAL_CASES, ...EXTRA_CASES];

type Decision = "forbidden" | "prompt" | "allowed";
const SEVERITY: Record<Decision, number> = { allowed: 0, prompt: 1, forbidden: 2 };

function parsePattern(raw: string): Array<string | string[]> {
  const out: Array<string | string[]> = [];
  const re = /\[([^\]]*)\]|"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) {
      out.push([...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]));
    } else {
      out.push(m[2]);
    }
  }
  return out;
}

function parseRules(content: string): PrefixRule[] {
  const rules: PrefixRule[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^prefix_rule\(pattern=\[(.*)\],\s*decision="([^"]+)"\)$/);
    if (match) {
      rules.push({ pattern: parsePattern(match[1]), decision: match[2] as Decision });
    }
  }
  return rules;
}

// Returns the MOST RESTRICTIVE matching decision, as Codex does.
function evaluatePrefixRules(cmd: string[], rules: PrefixRule[]): Decision {
  let result: Decision = "allowed";
  for (const rule of rules) {
    if (rule.pattern.length > cmd.length) continue;
    const matches = rule.pattern.every((tok, idx) =>
      Array.isArray(tok) ? tok.includes(cmd[idx]) : tok === cmd[idx]
    );
    if (matches && SEVERITY[rule.decision] > SEVERITY[result]) result = rule.decision;
  }
  return result;
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

Deno.test("pure prefix matching logic matches all literal cases", () => {
  const content = Deno.readTextFileSync(RULES_PATH);
  const rules = parseRules(content);

  for (const { cmd, expected } of ALL_CASES) {
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

Deno.test("most restrictive decision wins over first match", () => {
  const rules: PrefixRule[] = [
    { pattern: ["gh", "api"], decision: "prompt" },
    { pattern: ["gh"], decision: "forbidden" },
  ];
  assertEquals(evaluatePrefixRules(["gh", "api", "user"], rules), "forbidden");
});

Deno.test("codex execpolicy check matches all literal cases when codex is installed", async () => {
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

  for (const { cmd, expected } of ALL_CASES) {
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
