// web-jam-tools#1202: the medium Flash level is retired and `Flash High` is renamed `Flash`.
// No shipped file may bring either name back, with one exemption: the `aliases:` line of the
// `Flash` entry in skills/fix-labels/labels.yaml, which is how /fix-labels renames the old
// label in place instead of deleting it and creating a new one.

import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url));
const SCANNED = ["docs", "skills", "scripts", "src", "hooks", "AGENTS.md"];
const RETIRED = /Flash Med(?:ium)?|Flash High/i;
const ALIAS_LINE_FILE = "skills/fix-labels/labels.yaml";

async function* filesUnder(rel: string): AsyncGenerator<string> {
  const info = await Deno.stat(`${REPO_ROOT}${rel}`);
  if (info.isFile) {
    yield rel;
    return;
  }
  for await (const entry of Deno.readDir(`${REPO_ROOT}${rel}`)) {
    yield* filesUnder(`${rel}/${entry.name}`);
  }
}

async function* scannedFiles(): AsyncGenerator<string> {
  for (const entry of SCANNED) yield* filesUnder(entry);
}

Deno.test("no shipped file names the retired Flash Med, Flash Medium or Flash High level", async () => {
  const offenders: string[] = [];
  for await (const rel of scannedFiles()) {
    let text: string;
    try {
      text = await Deno.readTextFile(`${REPO_ROOT}${rel}`);
    } catch {
      continue; // binary or unreadable: nothing to scan
    }
    text.split("\n").forEach((line, i) => {
      if (!RETIRED.test(line)) return;
      if (rel === ALIAS_LINE_FILE && /^\s*aliases:\s*\["Flash High"\]\s*$/.test(line)) return;
      offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assertEquals(offenders, [], `retired Flash names found:\n${offenders.join("\n")}`);
});
