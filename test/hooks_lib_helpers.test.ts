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
import { variedFakeBody } from "./support/varied_fake_value.ts";

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
  // Varied, not sequential/repeated — the credential detector's
  // synthetic-value heuristic would otherwise auto-suppress a run of 8+
  // sequential digits (the original literal here was "123456789012345...",
  // itself exactly such a run), defeating this "must be detected" case.
  const matchKey = findCredentialLiteral("AIza" + variedFakeBody(35, 90)); // webjam-fixture-ok
  assertEquals(matchKey, "Google/Gemini API key");

  const matchExport = findCredentialLiteral('export MY_API_KEY="secret_value_123"'); // webjam-fixture-ok
  assertEquals(matchExport, "generic KEY/TOKEN/SECRET/PASSWORD export with a literal value");

  const matchVar = findCredentialLiteral('export MY_API_KEY="$MY_VAR"');
  assertEquals(matchVar, null);

  const matchPlaceholder1 = findCredentialLiteral('export GEMINI_API_KEY="<key>"');
  assertEquals(matchPlaceholder1, null);

  const matchPlaceholder2 = findCredentialLiteral('export GEMINI_API_KEY="..."');
  assertEquals(matchPlaceholder2, null);

  const matchUrlToken = findCredentialLiteral(
    'curl "https://circleci.com/api/output?token=5e47bc7616f91ca5398fad774a186ae3957102a6"', // webjam-fixture-ok
  );
  assertEquals(matchUrlToken, "URL-embedded token/key/secret parameter with a literal value");

  const matchUrlPlaceholder = findCredentialLiteral(
    'curl "https://circleci.com/api/output?token=<token>"',
  );
  assertEquals(matchUrlPlaceholder, null);

  // --- MongoDB connection string tests ---
  // A mongo URI is only a credential LITERAL when it carries userinfo
  // (`user[:pass]@`). A bare host — local OR remote — names infrastructure,
  // not a secret, and must NOT flag regardless of where it points.
  assertEquals(findCredentialLiteral("mongodb://localhost:27018/test_db"), null);
  assertEquals(findCredentialLiteral("mongodb://localhost:27019/another_db?replicaSet=rs0"), null);
  assertEquals(findCredentialLiteral("mongodb://127.0.0.1:27017"), null);
  assertEquals(findCredentialLiteral("mongodb://localhost"), null);
  assertEquals(findCredentialLiteral("mongodb://cluster.example.invalid:27017/my_db"), null);

  // A userinfo-bearing URI must STILL flag, whether the host is remote OR
  // local. Realistic (non-reserved-host, non-generic-standin-userinfo)
  // values, not "user:password@...example.invalid" — those specific shapes
  // are now independently caught by the synthetic-value heuristic itself
  // (proven in test/detect_credential_literal.test.ts), so a "must still
  // flag" case here needs a value the heuristic does NOT cover.
  assertEquals(
    findCredentialLiteral(
      "mongodb+srv://svcAcct7x:" + variedFakeBody(20, 91) + "@prodcluster1.mongodb.net/my_db",
    ), // webjam-fixture-ok
    "MongoDB connection string",
  );
  assertEquals(
    findCredentialLiteral(
      "mongodb://svcAcct7x:" + variedFakeBody(20, 92) + "@localhost:27017/my_db",
    ), // webjam-fixture-ok
    "MongoDB connection string",
  );
  assertEquals(
    findCredentialLiteral(
      "mongodb+srv://svcAcct7x:" + variedFakeBody(20, 93) + "@localhost.attacker-corp.net/my_db",
    ), // webjam-fixture-ok
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
