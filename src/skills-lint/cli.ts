// src/skills-lint/cli.ts
// CLI entrypoint for deno task lint:skills (web-jam-tools#744).

import { runLintSkillsCli } from "./lint_skills.ts";

if (import.meta.main) {
  const exitCode = await runLintSkillsCli(Deno.args);
  if (exitCode !== 0) {
    Deno.exit(exitCode);
  }
}
