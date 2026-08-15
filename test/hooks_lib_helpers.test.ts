import { assertEquals, assertNotEquals } from "@std/assert";
import { dropProse, normalize, stripHeredocs } from "../hooks/lib/normalize_command.ts";
import { findBareIssueRefs, stripCode } from "../hooks/lib/detect_bare_issue_refs.ts";
import { findCredentialLiteral } from "../hooks/lib/detect_credential_literal.ts";
import {
  isBlockedContext,
  isDocOrMarkdown,
  loadHumanOnlyCredentials,
} from "../hooks/lib/detect_human_only_credentials.ts";
import {
  findUnresolvableIssuePointers,
  stripCodeAndQuotes,
} from "../hooks/lib/detect_unresolvable_issue_pointers.ts";
import {
  extractEntryText,
  selectLastAssistantEntry,
} from "../hooks/lib/select_transcript_entry.ts";

Deno.test("normalize_command helper", () => {
  const raw = "git commit -m 'feat: add feature' --body 'some body text'";
  const norm = normalize(raw);
  assertEquals(norm, "git commit -m --body");
  assertEquals(dropProse(raw), "git commit -m --body");

  const hd = "cat <<EOF\nsome secret text\nEOF\n";
  const stripped = stripHeredocs(hd);
  assertEquals(stripped.trim(), "cat <<EOF");
});

Deno.test("detect_bare_issue_refs helper", () => {
  const text = 'Here is web-jam-tools#123 "Fix bug" and a bare #456.';
  const refs = findBareIssueRefs(text);
  assertEquals(refs, ["#456"]);

  const codeSpan = "Check `#123` in code";
  assertEquals(findBareIssueRefs(codeSpan), []);
  assertEquals(stripCode(codeSpan).trim(), "Check        in code");
});

Deno.test("detect_credential_literal helper", () => {
  const matchKey = findCredentialLiteral("AIzaSyA123456789012345678901234567890123");
  assertEquals(matchKey, "Google/Gemini API key");

  const matchExport = findCredentialLiteral('export MY_API_KEY="secret_value_123"');
  assertEquals(matchExport, "generic KEY/TOKEN/SECRET/PASSWORD export with a literal value");

  const matchVar = findCredentialLiteral('export MY_API_KEY="$MY_VAR"');
  assertEquals(matchVar, null);

  const matchPlaceholder1 = findCredentialLiteral('export GEMINI_API_KEY="<key>"');
  assertEquals(matchPlaceholder1, null);

  const matchPlaceholder2 = findCredentialLiteral('export GEMINI_API_KEY="..."');
  assertEquals(matchPlaceholder2, null);

  const matchUrlToken = findCredentialLiteral(
    'curl "https://circleci.com/api/output?token=5e47bc7616f91ca5398fad774a186ae3957102a6"',
  );
  assertEquals(matchUrlToken, "URL-embedded token/key/secret parameter with a literal value");

  const matchUrlPlaceholder = findCredentialLiteral(
    'curl "https://circleci.com/api/output?token=<token>"',
  );
  assertEquals(matchUrlPlaceholder, null);

  // --- MongoDB connection string tests ---
  // Must NOT flag (no userinfo, local host):
  assertEquals(findCredentialLiteral("mongodb://localhost:27018/test_db"), null);
  assertEquals(findCredentialLiteral("mongodb://localhost:27019/another_db?replicaSet=rs0"), null);
  assertEquals(findCredentialLiteral("mongodb://127.0.0.1:27017"), null);
  assertEquals(findCredentialLiteral("mongodb://localhost"), null);

  // Must STILL flag:
  assertEquals(
    findCredentialLiteral("mongodb+srv://user:password@cluster.example.invalid/my_db"),
    "MongoDB connection string",
  );
  assertEquals(
    findCredentialLiteral("mongodb://user:password@localhost:27017/my_db"),
    "MongoDB connection string",
  );
  assertEquals(
    findCredentialLiteral("mongodb+srv://user:password@localhost.attacker.example.invalid/my_db"),
    "MongoDB connection string",
  );
  assertEquals(
    findCredentialLiteral("mongodb://cluster.example.invalid:27017/my_db"),
    "MongoDB connection string",
  );
});

Deno.test("detect_human_only_credentials helper", () => {
  const isDoc = isDocOrMarkdown("AGENTS.md", "");
  assertEquals(isDoc, true);

  const blocked = isBlockedContext(".env", "", "SECRET_KEY");
  assertEquals(blocked, true);

  const creds = loadHumanOnlyCredentials("hooks/human-only-credentials.yaml");
  assertNotEquals(creds, null);
});

Deno.test("detect_unresolvable_issue_pointers helper", () => {
  const text = "Please see the comment for details.";
  const pointers = findUnresolvableIssuePointers(text);
  assertEquals(pointers, ["see the comment"]);

  const cleanText = "This issue stands alone without pointer phrases.";
  assertEquals(findUnresolvableIssuePointers(cleanText), []);
  assertEquals(stripCodeAndQuotes('"quote" `code`').trim(), "");
});

Deno.test("select_transcript_entry helper", () => {
  const entries = [
    { type: "user", message: { role: "user", content: "hello" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "real reply" }],
      },
    },
    {
      type: "assistant",
      isSidechain: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "subagent message" }],
      },
    },
  ];
  const selected = selectLastAssistantEntry(entries);
  assertNotEquals(selected, null);
  assertEquals(extractEntryText(selected), "real reply");
});
