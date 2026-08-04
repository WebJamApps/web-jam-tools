/**
 * Shared human-only credentials detector (web-jam-tools#344).
 *
 * Reads tool execution input from stdin (JSON payload passed to PreToolUse hooks)
 * and checks for registered human-only credentials from hooks/human-only-credentials.yaml.
 *
 * Exit code 2: if a human-only credential is being exported or stored in env files,
 * shell profiles, or config files.
 * Exit code 0: if allowed or not matching.
 */

import * as path from "jsr:@std/path@^1.0.0";

export interface HumanOnlyCredential {
  name: string;
  identifier: string;
  description?: string;
}

export function loadHumanOnlyCredentials(yamlPath: string): HumanOnlyCredential[] {
  try {
    const text = Deno.readTextFileSync(yamlPath);
    const creds: HumanOnlyCredential[] = [];
    let current: Partial<HumanOnlyCredential> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- name:")) {
        if (current.identifier) {
          creds.push(current as HumanOnlyCredential);
        }
        current = { name: trimmed.slice("- name:".length).trim().replace(/^["']|["']$/g, "") };
      } else if (trimmed.startsWith("identifier:")) {
        current.identifier = trimmed.slice("identifier:".length).trim().replace(/^["']|["']$/g, "");
      } else if (trimmed.startsWith("description:")) {
        current.description = trimmed.slice("description:".length).trim().replace(/^["']|["']$/g, "");
      }
    }
    if (current.identifier) {
      creds.push(current as HumanOnlyCredential);
    }
    return creds;
  } catch {
    return [];
  }
}

export function isDocOrMarkdown(filePath: string, cmd: string): boolean {
  const filePathLower = filePath.toLowerCase();
  if (filePathLower) {
    const parts = filePathLower.split("/");
    const base = parts[parts.length - 1];
    if (filePathLower.endsWith(".md") || filePathLower.endsWith(".txt")) {
      return true;
    }
    if (filePathLower.includes("/docs/") || filePathLower.startsWith("docs/") || filePathLower.includes("docs/")) {
      return true;
    }
    if (filePathLower.includes("/skills/") || filePathLower.startsWith("skills/") || filePathLower.includes("skills/")) {
      return true;
    }
    if (filePathLower.includes("/test/") || filePathLower.startsWith("test/") || filePathLower.includes("test/")) {
      return true;
    }
    if (
      [
        "agents.md",
        "claude.md",
        "human-only-credentials.yaml",
        "block-human-only-credentials.sh",
        "detect_human_only_credentials.py",
        "detect_human_only_credentials.ts",
        "josh-manual-controls.md",
        "cross-ai-rules.md",
      ].includes(base)
    ) {
      return true;
    }
  }

  if (cmd) {
    const cmdLower = cmd.toLowerCase();
    if (/\b(docs|skills|test)\/[^\s'"]+\.(md|txt|ts|py|yaml|sh)\b/.test(cmdLower)) {
      if (!/\.(bashrc|zshrc|env)\b/.test(cmdLower)) {
        return true;
      }
    }
    if (
      /\b(agents\.md|claude\.md|josh-manual-controls\.md|cross-ai-rules\.md|human-only-credentials\.yaml)\b/.test(cmdLower)
    ) {
      if (!/\.(bashrc|zshrc|env)\b/.test(cmdLower)) {
        return true;
      }
    }
  }
  return false;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isBlockedContext(targetFile: string, cmd: string, identifier: string): boolean {
  const targetLower = targetFile.toLowerCase();
  const cmdLower = cmd.toLowerCase();
  const identLower = identifier.toLowerCase();

  if (targetLower) {
    const parts = targetLower.split("/");
    const base = parts[parts.length - 1];
    if ([".bashrc", ".zshrc", ".bash_profile", ".profile"].includes(base)) {
      return true;
    }
    if (base === ".env" || base.startsWith(".env.")) {
      return true;
    }
    if (
      base !== "human-only-credentials.yaml" &&
      (base.endsWith(".json") || base.endsWith(".yaml") || base.endsWith(".yml") || base.endsWith(".toml"))
    ) {
      return true;
    }
  }

  if (cmdLower) {
    const escaped = escapeRegExp(identLower);
    if (new RegExp("\\bexport\\s+.*" + escaped).test(cmdLower)) {
      return true;
    }
    if (new RegExp("\\b[a-z0-9_]+\\s*=\\s*['\"]?.*" + escaped).test(cmdLower)) {
      return true;
    }
    if (new RegExp("\\bset\\s+.*" + escaped).test(cmdLower)) {
      return true;
    }
    if (/\.(bashrc|zshrc|env)(\.|\s|$|['"])/.test(cmdLower) && cmdLower.includes(identLower)) {
      return true;
    }
    if (
      /\.(json|yaml|yml|toml)(['"]?\s|$)/.test(cmdLower) &&
      !cmdLower.includes("human-only-credentials.yaml") &&
      cmdLower.includes(identLower)
    ) {
      return true;
    }
  }

  if (targetLower && !isDocOrMarkdown(targetFile, cmd)) {
    const parts = targetLower.split("/");
    const base = parts[parts.length - 1];
    if (
      [".bashrc", ".zshrc", ".bash_profile", ".profile"].includes(base) ||
      base === ".env" ||
      base.startsWith(".env.") ||
      base.endsWith(".json") ||
      base.endsWith(".yaml") ||
      base.endsWith(".yml") ||
      base.endsWith(".toml")
    ) {
      return true;
    }
  }

  return false;
}

export function main(): void {
  const currentFileUrl = new URL(import.meta.url).pathname;
  const hookDir = path.dirname(path.dirname(currentFileUrl));
  const yamlPath = path.join(hookDir, "human-only-credentials.yaml");
  const creds = loadHumanOnlyCredentials(yamlPath);
  if (creds.length === 0) {
    Deno.exit(0);
  }

  let rawInput = "";
  try {
    const decoder = new TextDecoder();
    const buf = new Uint8Array(65536);
    while (true) {
      const n = Deno.stdin.readSync(buf);
      if (n === null || n === 0) break;
      rawInput += decoder.decode(buf.subarray(0, n));
    }
  } catch {
    Deno.exit(0);
  }

  if (!rawInput.trim()) {
    Deno.exit(0);
  }

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(rawInput);
  } catch {
    Deno.exit(0);
  }

  const toolInputRaw = data.tool_input ?? data.input ?? data.arguments ?? {};
  const toolInput = typeof toolInputRaw === "object" && toolInputRaw !== null
    ? (toolInputRaw as Record<string, unknown>)
    : {};

  const cmd = String(toolInput.command ?? toolInput.CommandLine ?? "");
  const filePath = String(
    toolInput.file_path ?? toolInput.path ?? toolInput.TargetFile ?? toolInput.target_file ?? "",
  );
  let content = String(
    toolInput.content ??
      toolInput.CodeContent ??
      toolInput.new_string ??
      toolInput.ReplacementContent ??
      toolInput.replacementContent ??
      "",
  );
  if (!content && toolInput.ReplacementChunks) {
    content = JSON.stringify(toolInput.ReplacementChunks);
  }

  const blob = `${cmd}\n${filePath}\n${content}\n${JSON.stringify(toolInput)}`;
  const blobLower = blob.toLowerCase();

  for (const entry of creds) {
    const ident = (entry.identifier || "").trim();
    const name = (entry.name || "").trim();
    if (!ident) continue;

    if (blobLower.includes(ident.toLowerCase())) {
      if (isDocOrMarkdown(filePath, cmd)) {
        continue;
      }

      if (isBlockedContext(filePath, cmd, ident)) {
        console.error(
          `BLOCKED (human-only-credentials guard): attempted to export or store registered human-only credential '${ident}' (${name}).`,
        );
        console.error(
          "Human-consumed credentials belong in KeePass only and must not be stored in environment files, shell profiles, or configuration files.",
        );
        console.error("(rule: web-jam-tools#344 — human-only-credentials-register)");
        Deno.exit(2);
      }
    }
  }

  Deno.exit(0);
}

if (import.meta.main) {
  main();
}
