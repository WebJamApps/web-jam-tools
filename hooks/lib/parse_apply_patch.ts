/**
 * Shared patch-header parser for Codex apply_patch payloads (web-jam-tools#1138).
 *
 * Codex edits files with tool_name === "apply_patch", carrying the patch text in
 * tool_input.command instead of tool_input.file_path.
 *
 * Header lines parsed:
 *   - *** Add File: <path>
 *   - *** Update File: <path>
 *   - *** Delete File: <path>
 *   - *** Move to: <path>
 */

const PATCH_HEADER_RE = /^\*\*\*\s*(?:Add File|Update File|Delete File|Move to):\s*(.+)$/;

/**
 * Extracts all unique file paths from Codex apply_patch text.
 * Returns an array of paths, or an empty array if none could be parsed.
 */
export function parseApplyPatchFilePaths(patchText: string): string[] {
  if (!patchText || typeof patchText !== "string") {
    return [];
  }

  const paths: string[] = [];
  const lines = patchText.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(PATCH_HEADER_RE);
    if (match) {
      const raw = match[1].trim().replace(/^["']|["']$/g, "").trim();
      if (raw.length > 0 && !paths.includes(raw)) {
        paths.push(raw);
      }
    }
  }

  return paths;
}

/**
 * CLI interface: reads PreToolUse JSON payload from stdin (or raw patch text),
 * parses file paths from apply_patch, and prints each path on a newline.
 *
 * Exits with:
 *   - 0: file paths successfully parsed (printed on stdout), or not apply_patch
 *   - 2: apply_patch with no parseable file paths (fails closed on malformed patch)
 */
if (import.meta.main) {
  let raw = "";
  try {
    const decoder = new TextDecoder();
    const buf = new Uint8Array(65536);
    while (true) {
      const n = Deno.stdin.readSync(buf);
      if (n === null || n === 0) break;
      raw += decoder.decode(buf.subarray(0, n));
    }
  } catch {
    Deno.exit(0);
  }

  if (!raw.trim()) {
    Deno.exit(0);
  }

  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // raw might be patch text directly
  }

  if (data && typeof data === "object") {
    const toolName = String(data.tool_name ?? data.name ?? "").trim();
    if (toolName === "apply_patch") {
      const toolInputRaw = data.tool_input ?? data.input ?? data.arguments ?? {};
      const toolInput = typeof toolInputRaw === "object" && toolInputRaw !== null
        ? (toolInputRaw as Record<string, unknown>)
        : {};
      const command = String(toolInput.command ?? "");
      const paths = parseApplyPatchFilePaths(command);
      if (paths.length === 0) {
        console.error("BLOCKED: apply_patch contains no parseable file path");
        Deno.exit(2);
      }
      for (const p of paths) {
        console.log(p);
      }
      Deno.exit(0);
    }
  } else {
    // If not JSON, parse as raw patch text
    const paths = parseApplyPatchFilePaths(raw);
    if (paths.length === 0) {
      Deno.exit(2);
    }
    for (const p of paths) {
      console.log(p);
    }
    Deno.exit(0);
  }
}
