/** Validate agy permission evidence before the installer adds its one allow entry. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateSettings(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("Settings must be an object");
  if (value.permissions !== undefined) {
    if (!isObject(value.permissions)) throw new Error("Permissions must be an object");
    for (const kind of ["allow", "deny", "ask"]) {
      const entries = value.permissions[kind];
      if (
        entries !== undefined &&
        (!Array.isArray(entries) || entries.some((e) => typeof e !== "string"))
      ) {
        throw new Error("Permission lists must contain strings");
      }
    }
  }
  return value;
}

export function parsePermissionOutput(output: string): string[] {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/);
  const allow: string[] = [];
  for (const line of lines) {
    const match = /^(global|workspace|session)\s+(allow|deny|ask)\s+(.+)$/.exec(line.trim());
    if (!match) throw new Error("Unreadable permission output");
    if (match[1] === "global" && match[2] === "allow") allow.push(match[3]);
  }
  return allow;
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    return validateSettings(JSON.parse(await Deno.readTextFile(path)));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
}

export async function run(args: string[]): Promise<void> {
  if (args[0] === "parse-cli") {
    console.log(parsePermissionOutput(await new Response(Deno.stdin.readable).text()).join("\n"));
    return;
  }
  if (args[0] !== "read-settings" && args[0] !== "add-allow") throw new Error("Unknown operation");
  const path = args[1];
  const settings = await readSettings(path);
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  const allow = (permissions.allow ?? []) as string[];
  if (args[0] === "read-settings") {
    console.log(allow.join("\n"));
  } else {
    const entry = args[2];
    if (!entry) throw new Error("Allow entry is required");
    if (!allow.includes(entry)) {
      settings.permissions = { ...permissions, allow: [...allow, entry] };
      const slash = path.lastIndexOf("/");
      await Deno.mkdir(slash < 0 ? "." : path.slice(0, slash) || "/", { recursive: true });
      await Deno.writeTextFile(path, JSON.stringify(settings, null, 2) + "\n");
      console.log("agy settings.json: added allow-list entry " + entry);
    }
  }
}

if (import.meta.main) {
  try {
    await run(Deno.args);
  } catch {
    console.error("error: unreadable agy permission evidence");
    Deno.exit(3);
  }
}
