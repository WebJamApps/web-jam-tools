import {
  generateMemoryIndex,
  type MemoryEntry,
  scanMemoryDirectory,
} from "../memory-index/generator.ts";

export interface IndexProjection {
  bytes: number;
  projectedBytes: number;
  lowMark: number;
  approvalRows: string[];
  reachable: boolean;
}

const bytes = (entries: MemoryEntry[]) =>
  new TextEncoder().encode(generateMemoryIndex(entries)).length;

/** Use the real generator, including grouping, UTF-8 and wrapping, for every projection. */
export async function projectIndex(
  dir: string,
  departed: ReadonlySet<string>,
  waiting: string[],
  lowMark: number,
): Promise<{ report: IndexProjection; text: string }> {
  const scan = await scanMemoryDirectory(dir);
  let entries = scan.entries.filter((entry) => !departed.has(entry.slug));
  const initial = bytes(entries);
  const approvalRows: string[] = [];
  for (const slug of waiting) {
    if (bytes(entries) <= lowMark) break;
    if (!entries.some((entry) => entry.slug === slug)) continue;
    entries = entries.filter((entry) => entry.slug !== slug);
    approvalRows.push(slug);
  }
  const projectedBytes = bytes(entries);
  const reachable = projectedBytes <= lowMark && scan.skipped.length === 0;
  const report = { bytes: initial, projectedBytes, lowMark, approvalRows, reachable };
  const text = [
    `Memory index after planned moves: ${initial.toLocaleString("en-US")} bytes; low mark ${
      lowMark.toLocaleString("en-US")
    } bytes.`,
    `Approval rows to reach the low mark: ${
      approvalRows.length ? approvalRows.join(", ") : "none"
    }.`,
    `With those approvals: ${projectedBytes.toLocaleString("en-US")} bytes.`,
    ...scan.skipped.map((entry) => `Cannot inspect ${entry.filename}: ${entry.reason}`),
    ...(!reachable
      ? [
        "Cannot confirm the low mark with these rows; inspect skipped files or propose more eligible removals for Josh's yes.",
      ]
      : []),
  ].join("\n");
  return { report, text };
}

/** Match complete wiki-link destinations, retaining optional headings and display aliases. */
export function repointLinks(raw: string, redirects: ReadonlyMap<string, string>): string {
  return raw.replace(
    /\[\[([^\]#|]+)((?:#[^\]|]*)?(?:\|[^\]]*)?)\]\]/g,
    (whole, slug: string, suffix: string) => {
      let target = slug.endsWith(".md") ? slug.slice(0, -3) : slug;
      const original = target;
      const seen = new Set<string>();
      while (redirects.has(target) && !seen.has(target)) {
        seen.add(target);
        target = redirects.get(target)!;
      }
      return target === original ? whole : `[[${target}${suffix}]]`;
    },
  );
}
