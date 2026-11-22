import {
  checkGmailWrite,
  type GMAIL_TOOL_NAMES,
  type GmailWriteDecision,
} from "./check_gmail_write.ts";

const PREFIX = "mcp__codex_apps__gmail_";

// Translate the hosted plugin's vocabulary to the shared classifier's operations.
const aliases = new Map<string, typeof GMAIL_TOOL_NAMES[number]>([
  ["batch_read_email", "read_email"],
  ["batch_read_email_threads", "read_email"],
  ["create_draft", "draft_email"],
  ["create_label", "create_label"],
  ["forward_emails", "send_email"],
  ["get_profile", "list_email_labels"],
  ["list_drafts", "read_email"],
  ["list_labels", "list_email_labels"],
  ["read_attachment", "download_attachment"],
  ["read_email", "read_email"],
  ["read_email_thread", "read_email"],
  ["search_email_ids", "search_emails"],
  ["search_emails", "search_emails"],
  ["send_draft", "send_email"],
  ["send_email", "send_email"],
  ["update_draft", "draft_email"],
]);

function isObject(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

function normalizeLabelName(name: unknown): unknown {
  // Label-by-name tools may resolve a display name to a system label.
  return typeof name === "string" ? name.trim().toUpperCase() : name;
}

function labelBatch(
  input: Record<string, unknown>,
  addField: string,
  removeField: string,
  byName = false,
): GmailWriteDecision {
  const keys = ["message_ids", addField, removeField];
  if (byName) keys.push("create_missing_labels");
  if (Object.keys(input).some((key) => !keys.includes(key))) return "deny";
  if (
    Object.hasOwn(input, "create_missing_labels") &&
    typeof input.create_missing_labels !== "boolean"
  ) {
    return "deny";
  }

  const added = input[addField];
  const removed = input[removeField];
  return checkGmailWrite("batch_modify_emails", {
    messageIds: input.message_ids,
    // The plugin uses null for absent optional label lists.
    ...(added == null ? {} : {
      addLabelIds: byName && Array.isArray(added) ? added.map(normalizeLabelName) : added,
    }),
    ...(removed == null ? {} : { removeLabelIds: removed }),
  });
}

export function checkCodexGmailWrite(tool: unknown, input: unknown): GmailWriteDecision {
  if (typeof tool !== "string" || !tool) return "deny";
  if (!tool.startsWith(PREFIX)) return "unrelated";
  const name = tool.slice(PREFIX.length);
  const alias = aliases.get(name);
  if (alias) return checkGmailWrite(alias, input);
  if (!isObject(input)) return "deny";

  switch (name) {
    case "archive_emails":
      if (Object.keys(input).some((key) => key !== "thread_ids")) return "deny";
      if (
        !Array.isArray(input.thread_ids) ||
        input.thread_ids.some((id) => typeof id !== "string")
      ) return "deny";
      // Archiving removes INBOX from the messages in the selected threads. The connector ignores
      // empty thread IDs, so they are left out of the classification too.
      return checkGmailWrite("batch_modify_emails", {
        messageIds: input.thread_ids.filter((id) => id !== ""),
        removeLabelIds: ["INBOX"],
      });
    case "delete_emails":
      if (Object.keys(input).some((key) => key !== "message_ids")) return "deny";
      return checkGmailWrite("batch_modify_emails", {
        messageIds: input.message_ids,
        addLabelIds: ["TRASH"],
      });
    case "batch_modify_email":
      return labelBatch(input, "add_labels", "remove_labels");
    case "apply_labels_to_emails":
      return labelBatch(input, "add_label_names", "remove_label_names", true);
    case "bulk_label_matching_emails":
      if (
        Object.keys(input).some((key) =>
          !["label_name", "query", "archive", "create_label_if_missing"].includes(key)
        ) || typeof input.query !== "string" ||
        ["archive", "create_label_if_missing"].some((key) =>
          Object.hasOwn(input, key) && typeof input[key] !== "boolean"
        )
      ) return "deny";
      // The plugin resolves the query to message IDs after the hook runs.
      return checkGmailWrite("batch_modify_emails", {
        messageIds: [],
        addLabelIds: [normalizeLabelName(input.label_name)],
      });
    default:
      return "deny";
  }
}

if (import.meta.main) {
  let decision: GmailWriteDecision = "deny";
  try {
    const payload: unknown = JSON.parse(await new Response(Deno.stdin.readable).text());
    if (isObject(payload)) decision = checkCodexGmailWrite(payload.tool_name, payload.tool_input);
  } catch {
    // Refuse an unreadable payload without printing mail content.
  }

  if (decision === "trash") {
    console.error(
      "BLOCKED (Codex Gmail safety fence): moving mail to Trash requires a verified permission prompt. Codex has no verified hook prompt for this action; ask Josh to handle it.",
    );
  } else if (decision === "deny") {
    console.error(
      "BLOCKED (Codex Gmail safety fence): sending mail is prohibited, and an unclassifiable safety payload is refused. Stop and report this refusal to Josh; do not retry the action through another route.",
    );
  } else {
    Deno.exit(0);
  }
  Deno.exit(2);
}
