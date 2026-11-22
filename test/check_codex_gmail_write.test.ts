import { assertEquals } from "@std/assert";
import { checkCodexGmailWrite } from "../hooks/lib/check_codex_gmail_write.ts";
import type { GmailWriteDecision } from "../hooks/lib/check_gmail_write.ts";

const prefix = "mcp__codex_apps__gmail_";
const id = "fixture-message";
const draft = {
  subject: "Fixture only",
  payload: { mime_type: "text/plain", body: { content: "Synthetic message" } },
};

const pluginFixtures: [string, unknown, GmailWriteDecision][] = [
  ["apply_labels_to_emails", { message_ids: [id], add_label_names: ["Project"] }, "allow"],
  ["archive_emails", { thread_ids: ["fixture-thread"] }, "allow"],
  ["batch_modify_email", { message_ids: [id], add_labels: ["IMPORTANT"] }, "allow"],
  ["batch_read_email", { message_ids: [id] }, "allow"],
  ["batch_read_email_threads", { thread_ids: ["fixture-thread"], max_messages: 1 }, "allow"],
  ["bulk_label_matching_emails", { query: "is:unread", label_name: "Project" }, "allow"],
  ["create_draft", draft, "allow"],
  ["create_label", { name: "Project" }, "allow"],
  ["delete_emails", { message_ids: [id] }, "trash"],
  ["forward_emails", { message_ids: [id], to: "" }, "deny"],
  ["get_profile", {}, "allow"],
  ["list_drafts", { max_results: 1 }, "allow"],
  ["list_labels", {}, "allow"],
  ["read_attachment", { message_id: id, attachment_id: "fixture-attachment" }, "allow"],
  ["read_email", { message_id: id, format: "metadata" }, "allow"],
  ["read_email_thread", { thread_id: "fixture-thread" }, "allow"],
  ["search_email_ids", { query: "is:unread", max_results: 1 }, "allow"],
  ["search_emails", { query: "is:unread", max_results: 1 }, "allow"],
  ["send_draft", { draft_id: "fixture-draft" }, "deny"],
  ["send_email", { ...draft, to: "" }, "deny"],
  ["update_draft", { draft_id: "fixture-draft", ...draft }, "allow"],
];

for (const [name, input, expected] of pluginFixtures) {
  Deno.test(`Codex Gmail classifier handles ${name}`, () => {
    assertEquals(checkCodexGmailWrite(prefix + name, input), expected);
  });
}

Deno.test("Codex Gmail classifier routes every send to the shared refusal regardless of input", () => {
  for (const name of ["send_email", "send_draft", "forward_emails"]) {
    for (const input of [null, undefined, [], {}]) {
      assertEquals(checkCodexGmailWrite(prefix + name, input), "deny");
    }
  }
});

Deno.test("Codex Gmail classifier distinguishes Trash additions, removals and nullable fields", () => {
  for (
    const [input, expected] of [
      [{ message_ids: [id], add_labels: ["IMPORTANT", "TRASH"] }, "trash"],
      [{ message_ids: [id], add_labels: ["TRASH"], remove_labels: ["TRASH"] }, "trash"],
      [{ message_ids: [id], add_labels: null, remove_labels: ["TRASH"] }, "allow"],
      [{ message_ids: [id], add_labels: ["IMPORTANT"], remove_labels: null }, "allow"],
    ] as const
  ) {
    assertEquals(checkCodexGmailWrite(prefix + "batch_modify_email", input), expected);
  }
  assertEquals(
    checkCodexGmailWrite(prefix + "apply_labels_to_emails", {
      message_ids: [id],
      add_label_names: ["Project", "Trash"],
      create_missing_labels: false,
    }),
    "trash",
  );
  assertEquals(
    checkCodexGmailWrite(prefix + "apply_labels_to_emails", {
      message_ids: [id],
      remove_label_names: ["Trash"],
    }),
    "allow",
  );
  assertEquals(
    checkCodexGmailWrite(prefix + "bulk_label_matching_emails", {
      query: "is:read",
      label_name: "Trash",
    }),
    "trash",
  );
});

Deno.test("Codex Gmail classifier denies unreadable or unsupported safety input", () => {
  for (
    const input of [
      null,
      [],
      {},
      { message_ids: "fixture-message", add_labels: ["TRASH"] },
      { message_ids: [id], add_labels: "TRASH" },
      { message_ids: [id], addLabelIds: ["TRASH"] },
      { message_ids: [id], add_labels: ["IMPORTANT"], remove_labels: ["TRASH", false] },
    ]
  ) {
    assertEquals(checkCodexGmailWrite(prefix + "batch_modify_email", input), "deny");
  }
  assertEquals(checkCodexGmailWrite(prefix + "delete_emails", {}), "deny");
  assertEquals(checkCodexGmailWrite(prefix + "unknown", {}), "deny");
  assertEquals(checkCodexGmailWrite(undefined, {}), "deny");
  assertEquals(checkCodexGmailWrite(prefix + "constructor", {}), "deny");
  assertEquals(checkCodexGmailWrite("mcp__gmail__send_email", {}), "unrelated");
  assertEquals(checkCodexGmailWrite("mcp__codex_apps__google_drive_list_files", {}), "unrelated");
});
