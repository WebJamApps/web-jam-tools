/** Shared local Gmail safety classification; surface adapters decide how to ask for Trash. */
export const GMAIL_TOOL_NAMES = [
  "send_email",
  "draft_email",
  "read_email",
  "search_emails",
  "modify_email",
  "delete_email",
  "list_email_labels",
  "batch_modify_emails",
  "batch_delete_emails",
  "create_label",
  "update_label",
  "delete_label",
  "get_or_create_label",
  "create_filter",
  "list_filters",
  "get_filter",
  "delete_filter",
  "create_filter_from_template",
  "download_attachment",
] as const;

export type GmailWriteDecision = "allow" | "deny" | "trash" | "unrelated";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

/**
 * Raw names belong to the local server. Prefixed names must belong to the exact configured
 * server, so an unrelated MCP server's delete_label is never captured. Codex adapters may
 * supply their configured server name; this does not authorize connecting that server.
 * Unknown local tools and malformed safety arguments fail closed. This classifier grants
 * no ordinary action/draft approvals and never reads credentials or calls Gmail.
 */
export function checkGmailWrite(
  toolName: unknown,
  input: unknown,
  serverName = "gmail",
): GmailWriteDecision {
  if (typeof toolName !== "string" || !toolName) return "deny";
  let name = toolName;
  if (name.startsWith("mcp__")) {
    const prefix = `mcp__${serverName}__`;
    if (!name.startsWith(prefix)) return "unrelated";
    name = name.slice(prefix.length);
  }
  if (!GMAIL_TOOL_NAMES.some((known) => known === name)) return "deny";
  switch (name) {
    case "send_email":
    case "delete_email":
    case "batch_delete_emails":
    case "delete_filter":
    case "delete_label":
      return "deny";
  }
  if (!isObject(input)) return "deny";
  if (name !== "modify_email" && name !== "batch_modify_emails") return "allow";

  const batch = name === "batch_modify_emails";
  const fields = batch
    ? ["messageIds", "addLabelIds", "removeLabelIds", "batchSize"]
    : ["messageId", "labelIds", "addLabelIds", "removeLabelIds"];
  if (Object.keys(input).some((key) => !fields.includes(key))) return "deny";
  if (
    batch
      ? !isStringList(input.messageIds)
      : typeof input.messageId !== "string" || !input.messageId
  ) return "deny";
  for (const field of ["labelIds", "addLabelIds", "removeLabelIds"]) {
    if (Object.hasOwn(input, field) && !isStringList(input[field])) return "deny";
  }
  if (
    Object.hasOwn(input, "batchSize") &&
    (typeof input.batchSize !== "number" || !Number.isFinite(input.batchSize) ||
      input.batchSize <= 0)
  ) {
    return "deny";
  }
  // Inspect both supported single-message add fields even if another field overrides one.
  for (const field of ["labelIds", "addLabelIds"]) {
    if (isStringList(input[field]) && input[field].includes("TRASH")) return "trash";
  }
  return "allow";
}

if (import.meta.main) {
  let decision: GmailWriteDecision = "deny";
  try {
    const payload: unknown = JSON.parse(await new Response(Deno.stdin.readable).text());
    if (isObject(payload)) decision = checkGmailWrite(payload.tool_name, payload.tool_input);
  } catch {
    // An unreadable safety payload never authorizes a mail action.
  }
  console.log(decision);
}
