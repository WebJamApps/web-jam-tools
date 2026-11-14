import * as path from "@std/path";

export function isDesignDocFilename(filename: string): boolean {
  return /-design(?:-\d{4}-\d{2}-\d{2})?\.md$/i.test(filename);
}

/** Full home-relative design paths. Keep written paths for lookup diagnostics. */
export function designPathsInBody(body: string): string[] {
  const home = Deno.env.get("HOME") || "/home/joshua";
  const rawPaths: string[] = [];
  const remainder = body.replace(/[`"'<]((?:~\/|\/)[^`"'<>\r\n]+\.md)[`"'>]/g, (_, value) => {
    rawPaths.push(value);
    return " ";
  });
  for (const match of remainder.matchAll(/(?:~\/|\/)[^\s`<>"'|)\]]+/g)) {
    rawPaths.push(match[0].replace(/[.,;:!?]+$/, ""));
  }
  const paths = new Set<string>();
  for (const raw of rawPaths) {
    if (!raw.startsWith("~/") && !raw.startsWith(home + "/")) continue;
    if (!isDesignDocFilename(path.basename(raw))) continue;
    paths.add(path.resolve(raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw));
  }
  return [...paths].sort();
}

/** Two paths to the same existing file count once when checking a body. */
async function designDestinations(body: string): Promise<string[]> {
  const paths = new Set<string>();
  for (const expanded of designPathsInBody(body)) {
    try {
      paths.add(await Deno.realPath(expanded));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      paths.add(expanded);
    }
  }
  return [...paths].sort();
}

export async function checkDesignBody(body: string, currentBody?: string): Promise<void> {
  const paths = await designDestinations(body);
  if (paths.length <= 1) return;
  if (currentBody !== undefined && paths.length <= (await designDestinations(currentBody)).length) {
    return;
  }
  throw new Error(`Issue body names more than one design document: ${paths.join(", ")}`);
}
