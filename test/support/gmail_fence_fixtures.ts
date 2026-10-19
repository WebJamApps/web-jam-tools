import type { GmailWriteDecision } from "../../hooks/lib/check_gmail_write.ts";

export const GMAIL_SCHEMA_INPUTS: Record<string, Record<string, unknown>> = {
  send_email: { to: [], subject: "fence probe", body: "fence probe" },
  draft_email: { to: [], subject: "fence probe", body: "fence probe" },
  read_email: { messageId: "design-probe-nonexistent" },
  search_emails: { query: "subject:fence-probe" },
  modify_email: { messageId: "design-probe-nonexistent", addLabelIds: ["IMPORTANT"] },
  delete_email: { messageId: "design-probe-nonexistent" },
  list_email_labels: {},
  batch_modify_emails: { messageIds: ["design-probe-nonexistent"], removeLabelIds: ["INBOX"] },
  batch_delete_emails: { messageIds: ["design-probe-nonexistent"] },
  create_label: { name: "fence-probe" },
  update_label: { id: "design-probe-nonexistent", name: "fence-probe" },
  delete_label: { id: "design-probe-nonexistent" },
  get_or_create_label: { name: "fence-probe" },
  create_filter: { criteria: { subject: "fence-probe" }, action: { addLabelIds: ["IMPORTANT"] } },
  list_filters: {},
  get_filter: { filterId: "design-probe-nonexistent" },
  delete_filter: { filterId: "design-probe-nonexistent" },
  create_filter_from_template: {
    template: "fromSender",
    parameters: { senderEmail: "probe@example.com" },
  },
  download_attachment: {
    messageId: "design-probe-nonexistent",
    attachmentId: "design-probe-nonexistent",
  },
};

export const IRREVERSIBLE_GMAIL_TOOLS = [
  "send_email",
  "delete_email",
  "batch_delete_emails",
  "delete_filter",
  "delete_label",
];

/** Literal Fence verification cases; these are inspected as data, never sent to Gmail. */
export const GMAIL_FENCE_CASES: Array<{
  tool: string;
  input: unknown;
  decision: GmailWriteDecision;
}> = [
  ...IRREVERSIBLE_GMAIL_TOOLS.map((tool) => ({
    tool,
    input: GMAIL_SCHEMA_INPUTS[tool],
    decision: "deny" as const,
  })),
  {
    tool: "modify_email",
    input: { messageId: "design-probe-nonexistent", addLabelIds: ["TRASH"] },
    decision: "trash",
  },
  {
    tool: "modify_email",
    input: { messageId: "design-probe-nonexistent", labelIds: ["TRASH"] },
    decision: "trash",
  },
  {
    tool: "modify_email",
    input: { messageId: "design-probe-nonexistent", addLabelIds: ["IMPORTANT", "TRASH"] },
    decision: "trash",
  },
  {
    tool: "batch_modify_emails",
    input: { messageIds: ["design-probe-nonexistent"], addLabelIds: ["TRASH"] },
    decision: "trash",
  },
  {
    tool: "batch_modify_emails",
    input: { messageIds: ["design-probe-nonexistent"], labelIds: ["TRASH"] },
    decision: "deny",
  },
  {
    tool: "modify_email",
    input: { messageId: "design-probe-nonexistent", removeLabelIds: ["TRASH"] },
    decision: "allow",
  },
  {
    tool: "modify_email",
    input: { messageId: "design-probe-nonexistent", removeLabelIds: ["INBOX"] },
    decision: "allow",
  },
  {
    tool: "modify_email",
    input: { messageId: "design-probe-nonexistent", addLabelIds: "TRASH" },
    decision: "deny",
  },
  { tool: "modify_email", input: null, decision: "deny" },
  ...["list_email_labels", "read_email", "draft_email"].map((tool) => ({
    tool,
    input: GMAIL_SCHEMA_INPUTS[tool],
    decision: "allow" as const,
  })),
];
