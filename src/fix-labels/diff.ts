// diff.ts — web-jam-tools#263
//
// Computes GitHub label drift for /fix-labels by comparing
// skills/fix-labels/labels.yaml (the canonical schema) against each repo's
// actual `gh label list` output — replacing the eyeballed prose comparison
// that let real drift (miscolored labels reported as clean, a `blocked`
// that existed miscolored reported as "missing") survive a run that claimed
// success.
//
// `classifyRepoDrift` is a pure function: (schema, repo name, actual labels)
// -> classified drift list. No network, no `gh` — fully unit-testable. Only
// `main()` (and the `fetch*` helpers it calls) touches the network via `gh`.
//
// Run: deno task fix-labels:diff [--json]

import { parse as parseYaml } from "@std/yaml";

// --- Schema types (labels.yaml shape) ---

export interface CanonicalLabel {
  name: string;
  hex: string; // no leading '#'
  /** A repoClasses key, or the literal pseudo-class "all" (frontend + other). */
  repos: string;
  /** Known misnamed variants that should be RENAMED to `name`, not deleted. */
  aliases?: string[];
  /**
   * Never propose ANY change for this label (create/rename/recolor/delete),
   * in any repo. Used for `Fable`: SKILL.md's Non-goals say "Never touches
   * Fable" — stronger than merely "never delete".
   */
  neverTouch?: boolean;
}

export interface Schema {
  repoClasses: Record<string, string[]>;
  labels: CanonicalLabel[];
  /** repo name -> non-canonical label names that are never delete candidates. */
  keep: Record<string, string[]>;
}

export interface ActualLabel {
  name: string;
  color: string; // no leading '#', as `gh label list --json name,color` returns it
}

// --- Drift types ---

export type DriftKind = "missing" | "misnamed" | "miscolored" | "wrong-repo" | "non-canonical";
export type DriftAction = "create" | "rename" | "recolor" | "remove" | "delete";

export interface DriftItem {
  kind: DriftKind;
  action: DriftAction;
  /** Canonical name (create/rename/recolor target) or existing name (remove/delete). */
  name: string;
  /** Canonical hex, when the action sets a color (create/rename/recolor). */
  hex?: string;
  /** Existing name being renamed away from (rename only). */
  fromName?: string;
  /** Existing color being replaced (rename/recolor only). */
  fromHex?: string;
  /** Open-issue count carrying this label — attached only for remove/delete. */
  blastRadius?: number;
}

const ALL_REPOS_KEY = "all";

/** Resolve a label's `repos` field (a repoClasses key, or "all") to a repo name list. */
export function resolveRepos(schema: Schema, key: string): string[] {
  if (key === ALL_REPOS_KEY) {
    return [...schema.repoClasses.frontend, ...schema.repoClasses.other];
  }
  const list = schema.repoClasses[key];
  if (!list) {
    throw new Error(`labels.yaml: label references unknown repos class "${key}"`);
  }
  return list;
}

/** Every repo the schema covers (frontend + other), in schema-file order. */
export function allRepos(schema: Schema): string[] {
  return [...schema.repoClasses.frontend, ...schema.repoClasses.other];
}

/**
 * Pure diff: classify one repo's actual labels against the canonical schema.
 * No network calls — safe to unit test with hand-built fixtures.
 */
export function classifyRepoDrift(
  schema: Schema,
  repo: string,
  actual: ActualLabel[],
): DriftItem[] {
  const drift: DriftItem[] = [];
  const consumed = new Set<string>();
  const keepList = new Set(schema.keep[repo] ?? []);
  const actualByName = new Map(actual.map((l) => [l.name, l]));
  const neverTouchNames = new Set(
    schema.labels.filter((l) => l.neverTouch).map((l) => l.name),
  );

  for (const label of schema.labels) {
    if (label.neverTouch) continue; // e.g. Fable — never propose anything for it
    if (!resolveRepos(schema, label.repos).includes(repo)) continue; // not canonical here

    const exact = actualByName.get(label.name);
    if (exact) {
      consumed.add(exact.name);
      if (exact.color.toUpperCase() !== label.hex.toUpperCase()) {
        drift.push({
          kind: "miscolored",
          action: "recolor",
          name: label.name,
          hex: label.hex,
          fromHex: exact.color,
        });
      }
      continue;
    }

    const aliasMatch = (label.aliases ?? [])
      .map((alias) => actualByName.get(alias))
      .find((found) => found !== undefined);
    if (aliasMatch) {
      consumed.add(aliasMatch.name);
      drift.push({
        kind: "misnamed",
        action: "rename",
        name: label.name,
        hex: label.hex,
        fromName: aliasMatch.name,
        fromHex: aliasMatch.color,
      });
      continue;
    }

    drift.push({ kind: "missing", action: "create", name: label.name, hex: label.hex });
  }

  for (const actualLabel of actual) {
    if (consumed.has(actualLabel.name)) continue;
    if (neverTouchNames.has(actualLabel.name)) continue; // never touches Fable, anywhere
    if (keepList.has(actualLabel.name)) continue; // Josh-vetoed keeper for this repo

    const canonicalElsewhere = schema.labels.some((l) => l.name === actualLabel.name);
    if (canonicalElsewhere) {
      drift.push({ kind: "wrong-repo", action: "remove", name: actualLabel.name });
      continue;
    }

    drift.push({ kind: "non-canonical", action: "delete", name: actualLabel.name });
  }

  return drift;
}

// --- Schema loading ---

export async function loadSchema(path: string): Promise<Schema> {
  const text = await Deno.readTextFile(path);
  const parsed = parseYaml(text) as Schema;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${path}: did not parse to an object`);
  }
  if (!parsed.repoClasses?.frontend || !parsed.repoClasses?.other) {
    throw new Error(`${path}: missing repoClasses.frontend / repoClasses.other`);
  }
  if (!Array.isArray(parsed.labels) || parsed.labels.length === 0) {
    throw new Error(`${path}: missing or empty top-level "labels" array`);
  }
  if (!parsed.keep || typeof parsed.keep !== "object") {
    parsed.keep = {};
  }
  return parsed;
}

// --- `gh` shell-outs (main() only — never called from the pure function) ---

async function runGh(args: string[]): Promise<string> {
  const cmd = new Deno.Command("gh", { args, stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed (exit ${code}): ${new TextDecoder().decode(stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(stdout);
}

export async function fetchActualLabels(repo: string): Promise<ActualLabel[]> {
  const out = await runGh([
    "label",
    "list",
    "--repo",
    `WebJamApps/${repo}`,
    "--json",
    "name,color",
    "--limit",
    "200",
  ]);
  const parsed = JSON.parse(out) as Array<{ name: string; color: string }>;
  return parsed.map((l) => ({ name: l.name, color: l.color }));
}

export async function fetchBlastRadius(repo: string, label: string): Promise<number> {
  const out = await runGh([
    "issue",
    "list",
    "--repo",
    `WebJamApps/${repo}`,
    "--label",
    label,
    "--state",
    "open",
    "--json",
    "number",
    "-q",
    "length",
  ]);
  const n = Number(out.trim());
  if (!Number.isFinite(n)) {
    throw new Error(`blast radius for "${label}" in ${repo}: unexpected gh output "${out.trim()}"`);
  }
  return n;
}

/** Attach blast radius (open-issue count) to every remove/delete drift item. */
export async function attachBlastRadius(repo: string, items: DriftItem[]): Promise<DriftItem[]> {
  const out: DriftItem[] = [];
  for (const item of items) {
    if (item.action === "remove" || item.action === "delete") {
      out.push({ ...item, blastRadius: await fetchBlastRadius(repo, item.name) });
    } else {
      out.push(item);
    }
  }
  return out;
}

export async function scanRepo(schema: Schema, repo: string): Promise<DriftItem[]> {
  const actual = await fetchActualLabels(repo);
  const drift = classifyRepoDrift(schema, repo, actual);
  return await attachBlastRadius(repo, drift);
}

// --- Report formatting ---

function formatDriftLine(item: DriftItem): string {
  switch (item.action) {
    case "create":
      return `- CREATE \`${item.name}\` (#${item.hex}) — missing`;
    case "rename":
      return `- RENAME \`${item.fromName}\` → \`${item.name}\` (color also updates to #${item.hex})`;
    case "recolor":
      return `- RECOLOR \`${item.name}\` #${item.fromHex} → #${item.hex} — miscolored`;
    case "remove":
      return `- REMOVE \`${item.name}\` — wrong-repo (not canonical for this repo) — ${item.blastRadius} open issues carry this label`;
    case "delete":
      return `- DELETE \`${item.name}\` — non-canonical — ${item.blastRadius} open issues carry this label`;
  }
}

export function formatReport(perRepo: Record<string, DriftItem[]>, now: Date = new Date()): string {
  const lines: string[] = [`## fix-labels report — ${now.toISOString()}`, ""];
  for (const [repo, items] of Object.entries(perRepo)) {
    lines.push(`### ${repo}`);
    if (items.length === 0) {
      lines.push("no changes");
    } else {
      for (const item of items) lines.push(formatDriftLine(item));
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// --- main() ---

const DEFAULT_SCHEMA_PATH =
  new URL("../../skills/fix-labels/labels.yaml", import.meta.url).pathname;

export async function main(args: string[] = Deno.args): Promise<number> {
  const jsonOutput = args.includes("--json");

  let schema: Schema;
  try {
    schema = await loadSchema(DEFAULT_SCHEMA_PATH);
  } catch (err) {
    console.error(
      `fix-labels:diff: failed to load schema: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }

  const perRepo: Record<string, DriftItem[]> = {};
  try {
    for (const repo of allRepos(schema)) {
      perRepo[repo] = await scanRepo(schema, repo);
    }
  } catch (err) {
    console.error(`fix-labels:diff: scan failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  if (jsonOutput) {
    console.log(JSON.stringify(perRepo, null, 2));
  } else {
    console.log(formatReport(perRepo));
  }
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
