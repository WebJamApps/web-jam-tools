/**
 * json_escape.ts — web-jam-tools#456
 *
 * Helper to JSON-escape string content for inclusion in JSON literals.
 * Reads raw text from stdin, environment variable INPUT_TEXT, or arguments and prints
 * the JSON-escaped string body (without outer quotes) so callers can interpolate
 * it safely into JSON strings.
 */

export function jsonEscapeString(str: string): string {
  return JSON.stringify(str).slice(1, -1);
}

if (import.meta.main) {
  let input = Deno.env.get("INPUT_TEXT") ?? Deno.args[0];
  if (input === undefined) {
    input = await new Response(Deno.stdin.readable).text();
  }
  await Deno.stdout.write(new TextEncoder().encode(jsonEscapeString(input)));
}
