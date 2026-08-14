#!/usr/bin/env deno run
// scripts/consume_memory_rules.ts — web-jam-tools#499
// Performs the memory consume/delete file surgery approved by /design-issue.

import { parseArgs } from "@std/cli/parse-args";
import { parse as parseYaml } from "@std/yaml";
import { basename, dirname, join, resolve } from "@std/path";

export interface PlanRule {
  slug: string;
  disposition: "consume" | "delete" | "split-or-stay" | "stay";
  target_skill?: string;
}

export interface ApprovedPlan {
  design_doc?: string;
  memory_dir?: string;
  rules: PlanRule[];
}

export interface DanglingLinkMatch {
  file: string;
  line: number;
  slug: string;
  lineContent: string;
}

/**
 * Move a file to system trash (or fallback trash directory).
 * NEVER permanently deletes with rm / Deno.remove.
 */
export async function moveToTrash(filePath: string): Promise<void> {
  // 1. Try `gio trash` (standard on GNOME / Linux desktops)
  try {
    const cmd = new Deno.Command("gio", {
      args: ["trash", filePath],
      stdout: "piped",
      stderr: "piped",
    });
    const { success } = await cmd.output();
    if (success) return;
  } catch {
    // Ignore and try next option
  }

  // 2. Try `trash` CLI if installed
  try {
    const cmd = new Deno.Command("trash", {
      args: [filePath],
      stdout: "piped",
      stderr: "piped",
    });
    const { success } = await cmd.output();
    if (success) return;
  } catch {
    // Ignore and try next option
  }

  // 3. Fallback: move to user trash directory ~/.local/share/Trash/files/
  const home = Deno.env.get("HOME") || "/home/joshua";
  const systemTrashDir = join(home, ".local", "share", "Trash", "files");
  try {
    await Deno.mkdir(systemTrashDir, { recursive: true });
    const fileName = basename(filePath);
    const destPath = join(systemTrashDir, fileName);
    await Deno.rename(filePath, destPath);
    return;
  } catch {
    // 4. Ultimate fallback: local .trash dir in file's parent directory
    const parentDir = dirname(filePath);
    const localTrashDir = join(parentDir, ".trash");
    await Deno.mkdir(localTrashDir, { recursive: true });
    const fileName = basename(filePath);
    await Deno.rename(filePath, join(localTrashDir, fileName));
  }
}

/**
 * Parses raw plan input (JSON or YAML) into an ApprovedPlan object.
 */
export function parsePlanInput(content: string): ApprovedPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    try {
      parsed = parseYaml(content);
    } catch (e) {
      throw new Error(`Failed to parse plan file as JSON or YAML: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (Array.isArray(parsed)) {
    return { rules: parsed as PlanRule[] };
  }

  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    const rules = Array.isArray(obj.rules) ? (obj.rules as PlanRule[]) : Array.isArray(obj.plan) ? (obj.plan as PlanRule[]) : [];
    return {
      design_doc: typeof obj.design_doc === "string" ? obj.design_doc : undefined,
      memory_dir: typeof obj.memory_dir === "string" ? obj.memory_dir : undefined,
      rules,
    };
  }

  throw new Error("Plan file must be a JSON/YAML object with a 'rules' array or an array of rules.");
}

/**
 * Searches markdown files in memoryDir for inbound [[slug]] wikilinks targeting removed slugs.
 */
export async function findDanglingLinks(
  memoryDir: string,
  removedSlugs: Set<string>,
): Promise<DanglingLinkMatch[]> {
  const matches: DanglingLinkMatch[] = [];
  if (removedSlugs.size === 0) return matches;

  for await (const entry of Deno.readDir(memoryDir)) {
    if (!entry.isFile || !entry.name.endsWith(".md")) continue;
    const filePath = join(memoryDir, entry.name);
    try {
      const text = await Deno.readTextFile(filePath);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match [[slug]], [[slug|alias]], [[slug#section]]
        const regex = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
        let match;
        while ((match = regex.exec(line)) !== null) {
          const targetSlug = match[1].trim();
          if (removedSlugs.has(targetSlug)) {
            matches.push({
              file: entry.name,
              line: i + 1,
              slug: targetSlug,
              lineContent: line.trim(),
            });
          }
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }
  return matches;
}

/**
 * Strips removed slugs from MEMORY.md content while preserving headers and separators.
 */
export function stripSlugsFromMemoryMd(content: string, removedSlugs: Set<string>): string {
  if (removedSlugs.size === 0) return content;

  const lines = content.split("\n");
  const newLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Check if line is a bullet item like `- [slug](slug.md) — description`
    const bulletMatch = trimmed.match(/^- \[([^\]]+)\]\(([^)]+)\)/);
    if (bulletMatch) {
      const slug = bulletMatch[1].trim();
      if (removedSlugs.has(slug)) {
        continue; // Strip this line
      }
      newLines.push(line);
      continue;
    }

    // Check if line contains ` · ` separated slugs
    if (line.includes(" · ")) {
      const parts = line.split(" · ").map((p) => p.trim());
      const remainingParts = parts.filter((slug) => !removedSlugs.has(slug));
      if (remainingParts.length > 0) {
        // Reconstruct line with same leading indentation if any
        const indentMatch = line.match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1] : "";
        newLines.push(indent + remainingParts.join(" · "));
      }
      continue;
    }

    // Single slug line
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-") && !trimmed.startsWith("*") && !trimmed.includes(" ")) {
      if (removedSlugs.has(trimmed)) {
        continue; // Strip single slug line
      }
    }

    newLines.push(line);
  }

  return newLines.join("\n");
}

/**
 * Captures verbatim content of consumed rules into the design document's appendix,
 * and byte-verifies every captured rule against its source.
 */
export function captureAndVerifyRulesInDesignDoc(
  designDocContent: string,
  consumedRules: Array<{ slug: string; target_skill?: string; sourceContent: string }>,
): { updatedContent: string; verifiedCount: number } {
  let content = designDocContent;

  // Ensure Appendix section exists
  if (!content.includes("## Appendix")) {
    content = content.trimEnd() + "\n\n## Appendix - Captured memory rules\n";
  }

  let verifiedCount = 0;

  for (const rule of consumedRules) {
    const { slug, target_skill, sourceContent } = rule;
    const sourceBytes = new TextEncoder().encode(sourceContent);

    const startTag = `<!-- START_CAPTURED_RULE:${slug} -->`;
    const endTag = `<!-- END_CAPTURED_RULE:${slug} -->`;

    // Check if rule is already captured in the design doc
    const startIndex = content.indexOf(startTag);
    const endIndex = content.indexOf(endTag);

    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
      // Existing capture — extract and verify byte count and content
      const capturedText = content.slice(startIndex + startTag.length, endIndex);
      // Strip leading/trailing newlines added during formatting
      const trimmedCaptured = capturedText.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      const capturedBytes = new TextEncoder().encode(trimmedCaptured);

      if (capturedBytes.length !== sourceBytes.length || trimmedCaptured !== sourceContent) {
        throw new Error(
          `Capture byte verification failed for slug '${slug}': source is ${sourceBytes.length} bytes, captured is ${capturedBytes.length} bytes (content mismatch).`,
        );
      }
      verifiedCount++;
    } else {
      // Append new captured section
      const block = `\n### Captured Rule: \`${slug}\`
- **Original slug:** \`${slug}\`
- **Target skill:** \`${target_skill || "N/A"}\`
- **Captured bytes:** \`${sourceBytes.length}\`

${startTag}
${sourceContent}
${endTag}
`;
      content = content.trimEnd() + "\n" + block;

      // Verify immediately
      const newStartIndex = content.indexOf(startTag);
      const newEndIndex = content.indexOf(endTag);
      const newlyCaptured = content.slice(newStartIndex + startTag.length, newEndIndex).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      const newlyCapturedBytes = new TextEncoder().encode(newlyCaptured);

      if (newlyCapturedBytes.length !== sourceBytes.length || newlyCaptured !== sourceContent) {
        throw new Error(
          `Capture byte verification failed for slug '${slug}': source is ${sourceBytes.length} bytes, captured is ${newlyCapturedBytes.length} bytes.`,
        );
      }
      verifiedCount++;
    }
  }

  return { updatedContent: content, verifiedCount };
}

/**
 * Main execution function for memory rule consumption & deletion.
 */
export async function runConsumeMemoryRules(options: {
  planPath: string;
  designDocPath?: string;
  memoryDir?: string;
  delete?: boolean;
}): Promise<{ success: boolean; dryRun: boolean; summary: string }> {
  const dryRun = !options.delete;

  // 1. Read & parse plan file
  let rawPlan: string;
  try {
    rawPlan = await Deno.readTextFile(options.planPath);
  } catch (e) {
    throw new Error(`Unreadable plan file '${options.planPath}': ${e instanceof Error ? e.message : String(e)}`);
  }

  const plan = parsePlanInput(rawPlan);

  const designDocPath = options.designDocPath || plan.design_doc;
  const homeDir = Deno.env.get("HOME") || "/home/joshua";
  const defaultMemoryDir = join(homeDir, ".claude", "projects", "-home-joshua", "memory");
  const memoryDir = resolve(options.memoryDir || plan.memory_dir || defaultMemoryDir);

  // Validate rules
  if (!plan.rules || plan.rules.length === 0) {
    throw new Error("Plan contains no rules to execute.");
  }

  const validDispositions = new Set(["consume", "delete", "split-or-stay", "stay"]);
  for (const rule of plan.rules) {
    if (!validDispositions.has(rule.disposition)) {
      throw new Error(`Invalid disposition '${rule.disposition}' for rule '${rule.slug}'. Must be one of: consume, delete, split-or-stay, stay.`);
    }
  }

  // Verify memory directory exists
  try {
    const stat = await Deno.stat(memoryDir);
    if (!stat.isDirectory) {
      throw new Error(`Memory directory path '${memoryDir}' is not a directory.`);
    }
  } catch (e) {
    throw new Error(`Memory directory '${memoryDir}' is inaccessible or does not exist: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Collect rules by disposition
  const consumeRules = plan.rules.filter((r) => r.disposition === "consume");
  const deleteRules = plan.rules.filter((r) => r.disposition === "delete");
  const removedSlugs = new Set([...consumeRules, ...deleteRules].map((r) => r.slug));

  // 2. Verify all slugs in plan exist on disk
  for (const rule of plan.rules) {
    const fileSlugPath = join(memoryDir, `${rule.slug}.md`);
    try {
      await Deno.stat(fileSlugPath);
    } catch {
      throw new Error(`Slug '${rule.slug}' in approved plan is absent from memory directory at '${fileSlugPath}'.`);
    }
  }

  // 3. Read design document if there are consume rules
  let designDocContent = "";
  if (consumeRules.length > 0) {
    if (!designDocPath) {
      throw new Error("Plan contains 'consume' rules but no design document path was provided via plan or --design-doc.");
    }
    try {
      designDocContent = await Deno.readTextFile(designDocPath);
    } catch (e) {
      throw new Error(`Design document '${designDocPath}' is unreadable or missing: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Read source content for consume rules
  const consumedRulesWithContent: Array<{ slug: string; target_skill?: string; sourceContent: string }> = [];
  for (const rule of consumeRules) {
    const filePath = join(memoryDir, `${rule.slug}.md`);
    const sourceContent = await Deno.readTextFile(filePath);
    consumedRulesWithContent.push({
      slug: rule.slug,
      target_skill: rule.target_skill,
      sourceContent,
    });
  }

  // 4. Capture & byte-verify rules
  let updatedDesignDocContent = designDocContent;
  if (consumedRulesWithContent.length > 0) {
    const captureResult = captureAndVerifyRulesInDesignDoc(designDocContent, consumedRulesWithContent);
    updatedDesignDocContent = captureResult.updatedContent;
  }

  // 5. Inbound [[link]] dangling link report
  const danglingLinks = await findDanglingLinks(memoryDir, removedSlugs);

  // 6. Build summary
  const summaryLines: string[] = [];
  summaryLines.push("=== MEMORY CONSUME/DELETE SURGERY ===");
  summaryLines.push(`Mode: ${dryRun ? "DRY RUN (default - no files modified)" : "EXECUTE (deleting and writing changes)"}`);
  summaryLines.push(`Memory directory: ${memoryDir}`);
  if (designDocPath) summaryLines.push(`Design document: ${designDocPath}`);
  summaryLines.push("");

  summaryLines.push("Plan breakdown:");
  summaryLines.push(`  - Consumed: ${consumeRules.length}`);
  summaryLines.push(`  - Deleted: ${deleteRules.length}`);
  summaryLines.push(`  - Untouched (stay/split-or-stay): ${plan.rules.length - consumeRules.length - deleteRules.length}`);
  summaryLines.push("");

  if (consumeRules.length > 0) {
    summaryLines.push("Captured rules to design doc (byte-verified):");
    for (const r of consumedRulesWithContent) {
      const bytes = new TextEncoder().encode(r.sourceContent).length;
      summaryLines.push(`  - ${r.slug} (${bytes} bytes -> ${r.target_skill || "N/A"})`);
    }
    summaryLines.push("");
  }

  summaryLines.push("Dangling link report:");
  if (danglingLinks.length === 0) {
    summaryLines.push("  - No dangling links found.");
  } else {
    for (const d of danglingLinks) {
      summaryLines.push(`  - ${d.file}:${d.line} -> [[${d.slug}]] ("${d.lineContent}")`);
    }
  }
  summaryLines.push("");

  if (removedSlugs.size > 0) {
    summaryLines.push("Memory files to be trashed:");
    for (const slug of removedSlugs) {
      summaryLines.push(`  - ${join(memoryDir, `${slug}.md`)}`);
    }
    summaryLines.push("");
  }

  // 7. Perform execution if not dry run
  if (!dryRun) {
    // Write design doc
    if (consumeRules.length > 0 && designDocPath) {
      await Deno.writeTextFile(designDocPath, updatedDesignDocContent);
    }

    // Update MEMORY.md
    const memoryMdPath = join(memoryDir, "MEMORY.md");
    try {
      const memoryMdContent = await Deno.readTextFile(memoryMdPath);
      const updatedMemoryMd = stripSlugsFromMemoryMd(memoryMdContent, removedSlugs);
      await Deno.writeTextFile(memoryMdPath, updatedMemoryMd);
      summaryLines.push(`Updated ${memoryMdPath} (stripped ${removedSlugs.size} slugs).`);
    } catch {
      summaryLines.push(`Note: MEMORY.md at '${memoryMdPath}' was not found or unreadable; skipped index update.`);
    }

    // Move files to trash
    for (const slug of removedSlugs) {
      const filePath = join(memoryDir, `${slug}.md`);
      await moveToTrash(filePath);
    }

    summaryLines.push(`Successfully moved ${removedSlugs.size} memory file(s) to trash.`);
  } else {
    summaryLines.push("[DRY RUN COMPLETE] To execute changes, pass --delete (or --no-dry-run).");
  }

  const summary = summaryLines.join("\n");
  return { success: true, dryRun, summary };
}

// CLI entrypoint
if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["plan", "design-doc", "memory-dir"],
    boolean: ["dry-run", "delete", "apply", "execute", "no-dry-run", "help"],
    alias: {
      p: "plan",
      d: "design-doc",
      m: "memory-dir",
      h: "help",
    },
    default: {
      "dry-run": true,
    },
  });

  if (args.help || (args._.length === 0 && !args.plan)) {
    console.log(`
Usage: scripts/consume-memory-rules.sh <plan.json|yaml> [options]
   or: deno run --allow-read --allow-write --allow-env --allow-run scripts/consume_memory_rules.ts <plan.json|yaml> [options]

Options:
  --plan, -p <path>         Path to approved plan JSON/YAML file
  --design-doc, -d <path>   Path to design document markdown file
  --memory-dir, -m <path>   Path to memory directory (defaults to ~/.claude/projects/-home-joshua/memory)
  --dry-run                 Perform all validations, checks & reports without modifying files (default)
  --delete, --apply         Execute real file moves to trash, design-doc capture, and MEMORY.md updates
  --help, -h                Show this help message
`);
    Deno.exit(0);
  }

  const planPath = (args.plan || args._[0]) as string;
  const isDelete = Boolean(args.delete || args.apply || args.execute || args["no-dry-run"]);

  try {
    const result = await runConsumeMemoryRules({
      planPath,
      designDocPath: args["design-doc"],
      memoryDir: args["memory-dir"],
      delete: isDelete,
    });
    console.log(result.summary);
    Deno.exit(0);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
