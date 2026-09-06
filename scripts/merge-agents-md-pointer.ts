import { dirname } from "@std/path";

export const POINTER_HEADER = "## Cross-AI hard rules";

export const POINTER_BLOCK = `## Cross-AI hard rules

The cross-AI hard rules that bind every agent on every surface are NOT duplicated here. They live
in exactly one file: \`docs/cross-ai-rules.md\` in the **\`web-jam-tools\` repository**, which normally
sits alongside this repository — \`../web-jam-tools/docs/cross-ai-rules.md\`, and on Josh's laptop
\`/home/joshua/WebJamApps/web-jam-tools/docs/cross-ai-rules.md\`.

Read that file before acting. If you cannot find it, STOP and say so — do not proceed without the
rules and do not reconstruct them from memory or from this file.`;

export function mergePointerContent(content: string): { updated: string; changed: boolean } {
  if (content.includes(POINTER_HEADER)) {
    if (content.includes(POINTER_BLOCK)) {
      return { updated: content, changed: false };
    }
    const headerIdx = content.indexOf(POINTER_HEADER);
    const nextHeaderMatch = content.slice(headerIdx + POINTER_HEADER.length).match(/\n(?=#{1,6} )/);
    let endIdx = content.length;
    if (nextHeaderMatch && nextHeaderMatch.index !== undefined) {
      endIdx = headerIdx + POINTER_HEADER.length + nextHeaderMatch.index;
    }
    const before = content.slice(0, headerIdx).trimEnd();
    const after = content.slice(endIdx).trimStart();
    const updated = [before, POINTER_BLOCK, after].filter(Boolean).join("\n\n") + "\n";
    return { updated, changed: true };
  }

  const firstSubheaderMatch = content.match(/\n(?=## )/);
  if (firstSubheaderMatch && firstSubheaderMatch.index !== undefined) {
    const insertPos = firstSubheaderMatch.index;
    const before = content.slice(0, insertPos).trimEnd();
    const after = content.slice(insertPos).trimStart();
    const updated = [before, POINTER_BLOCK, after].filter(Boolean).join("\n\n") + "\n";
    return { updated, changed: true };
  }

  const before = content.trimEnd();
  const updated = before ? `${before}\n\n${POINTER_BLOCK}\n` : `${POINTER_BLOCK}\n`;
  return { updated, changed: true };
}

if (import.meta.main) {
  const args = Deno.args;
  let checkMode = false;
  let targetPath = "";

  for (const arg of args) {
    if (arg === "--check") {
      checkMode = true;
    } else if (!arg.startsWith("-")) {
      targetPath = arg;
    }
  }

  if (!targetPath) {
    console.error("error: missing target file path argument");
    Deno.exit(1);
  }

  let existing = "";
  let exists = false;
  try {
    existing = await Deno.readTextFile(targetPath);
    exists = true;
  } catch {
    exists = false;
  }

  const { updated, changed } = mergePointerContent(existing);

  if (checkMode) {
    if (!exists || changed) {
      console.error(`drift: ${targetPath} is missing or has out-of-date rules pointer`);
      Deno.exit(1);
    }
    console.log(`agents-md-pointer: check passed (no drift) for ${targetPath}`);
    Deno.exit(0);
  }

  if (changed) {
    await Deno.mkdir(dirname(targetPath), { recursive: true });
    await Deno.writeTextFile(targetPath, updated);
    console.log(`agents-md-pointer: merged rules pointer into ${targetPath}`);
  } else {
    console.log(`agents-md-pointer: rules pointer already up-to-date in ${targetPath}`);
  }
}
