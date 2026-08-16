// detect_credential_literal.test.ts — issue-detector-false-positive
//
// Unit tests for hooks/lib/detect_credential_literal.ts's FIXTURE_PRAGMA
// support: a test fixture that must contain a credential-SHAPED literal can
// mark that single literal so the detector does not mistake it for a live
// credential, without narrowing any detection regex and without a blanket
// path-based exemption for test/ (a real credential committed into a test
// file must still be caught).
//
// Every credential value below is SYNTHETIC, assembled at runtime via string
// concatenation — never a complete credential-shaped literal at rest in this
// file — so this file is never mistaken for a leak itself.

import { assertEquals } from "@std/assert";
import {
  findCredentialLiteral,
  FIXTURE_PRAGMA,
  hasDegenerateEntropy,
  hasGenericStandinUserinfo,
  hasPlaceholderWording,
  hasReservedHost,
  isFlaggableMongoDbUri,
} from "../hooks/lib/detect_credential_literal.ts";
import { variedFakeBody } from "./support/varied_fake_value.ts";

// Non-degenerate bodies (see test/support/varied_fake_value.ts for why
// plain .repeat() is no longer safe to use here — the entropy heuristic
// added below would auto-suppress it).
const FAKE = {
  github: "ghp_" + variedFakeBody(36, 0),
  githubOther: "ghp_" + variedFakeBody(36, 1),
};

Deno.test("an unmarked credential-shaped literal is reported", () => {
  const text = `const token = "${FAKE.github}";`;
  assertEquals(findCredentialLiteral(text), "GitHub token");
});

Deno.test("a literal marked with the fixture pragma on the same line is not reported", () => {
  const text = `const token = "${FAKE.github}"; // ${FIXTURE_PRAGMA}`;
  assertEquals(findCredentialLiteral(text), null);
});

Deno.test("a literal marked with the fixture pragma on the line above is not reported", () => {
  const text = `// ${FIXTURE_PRAGMA}\nconst token = "${FAKE.github}";`;
  assertEquals(findCredentialLiteral(text), null);
});

Deno.test("a marked literal does not suppress a different unmarked literal elsewhere in the same input", () => {
  const text = [
    `const fixture = "${FAKE.github}"; // ${FIXTURE_PRAGMA}`,
    `const real = "${FAKE.githubOther}";`,
  ].join("\n");
  assertEquals(findCredentialLiteral(text), "GitHub token");
});

Deno.test("an unmarked literal earlier in the input is still reported even when a later one is marked", () => {
  const text = [
    `const real = "${FAKE.githubOther}";`,
    `const fixture = "${FAKE.github}"; // ${FIXTURE_PRAGMA}`,
  ].join("\n");
  assertEquals(findCredentialLiteral(text), "GitHub token");
});

Deno.test("the pragma two lines above the literal does not suppress the match (adjacency is same-line or one-line-above only)", () => {
  const text = [
    `// ${FIXTURE_PRAGMA}`,
    `// an unrelated comment sits between the marker and the literal`,
    `const token = "${FAKE.github}";`,
  ].join("\n");
  assertEquals(findCredentialLiteral(text), "GitHub token");
});

// --- isFlaggableMongoDbUri: only userinfo makes a mongo URI a credential ---
//
// A bare host (local OR remote) names infrastructure, not a secret. Only a
// `user[:pass]@` authority is a credential literal, and that must be caught
// regardless of whether the host it points at is local or remote.

Deno.test("a remote host with userinfo is flagged", () => {
  assertEquals(isFlaggableMongoDbUri("mongodb+srv://user:pass@cluster.example.invalid/db"), true);
});

Deno.test("a local host with userinfo is flagged", () => {
  assertEquals(isFlaggableMongoDbUri("mongodb://admin:hunter2@localhost:27017/db"), true);
});

Deno.test("a remote host with NO userinfo is not flagged (infrastructure, not a secret)", () => {
  assertEquals(isFlaggableMongoDbUri("mongodb+srv://cluster.example.invalid/db"), false);
});

Deno.test("a local host with no userinfo is not flagged", () => {
  assertEquals(isFlaggableMongoDbUri("mongodb://localhost:27018/test_db"), false);
});

Deno.test("a bare '@' with no user portion before it is not flagged", () => {
  assertEquals(isFlaggableMongoDbUri("mongodb://@cluster.example.invalid/db"), false);
});

// --- synthetic-value heuristic (item 4): each rule proven both directions ---

// Rule 1: reserved/non-resolvable host (RFC 2606/6761)

Deno.test("hasReservedHost: a .invalid / .example / .test / .localhost host is reserved", () => {
  assertEquals(hasReservedHost("mongodb+srv://user:pw@cluster.invalid/db"), true);
  assertEquals(hasReservedHost("mongodb+srv://user:pw@cluster.example/db"), true);
  assertEquals(hasReservedHost("mongodb+srv://user:pw@cluster.test/db"), true);
  assertEquals(hasReservedHost("mongodb://user:pw@db.localhost:27017/db"), true);
  assertEquals(hasReservedHost("mongodb+srv://user:pw@cluster.example.com/db"), true);
});

Deno.test("hasReservedHost: a resolvable-looking production host is NOT reserved", () => {
  assertEquals(hasReservedHost("mongodb+srv://user:pw@prodcluster7.mongodb.net/db"), false);
});

Deno.test("a userinfo-bearing mongo URI on a reserved host is suppressed end to end", () => {
  const text = "mongodb+srv://svc:tK9mP2xQ7wR4nL8vB@cluster.example.invalid/db";
  assertEquals(findCredentialLiteral(text), null);
});

Deno.test("a userinfo-bearing mongo URI on a resolvable host with high-entropy credentials is still caught", () => {
  const pw = variedFakeBody(24, 5);
  const text = `mongodb+srv://svcAcct7x:${pw}@prodcluster7.mongodb.net/db`;
  assertEquals(findCredentialLiteral(text), "MongoDB connection string");
});

// Rule 2: placeholder wording (general words, and userinfo generic standins)

Deno.test("hasPlaceholderWording: recognizes each placeholder word, a your_ prefix, and angle brackets", () => {
  assertEquals(hasPlaceholderWording("ghp_exampleTokenValueHere000000000000"), true);
  assertEquals(hasPlaceholderWording("ghp_fixtureTokenValueHere000000000000"), true);
  assertEquals(hasPlaceholderWording("ghp_dummyTokenValueHere0000000000000"), true);
  assertEquals(hasPlaceholderWording("ghp_placeholderTokenHere0000000000000"), true);
  assertEquals(hasPlaceholderWording("ghp_redactedTokenValueHere00000000000"), true);
  assertEquals(hasPlaceholderWording("ghp_changemeTokenValueHere00000000000"), true);
  assertEquals(hasPlaceholderWording("ghp_xxxTokenValueHere00000000000000000"), true);
  assertEquals(hasPlaceholderWording("your_github_token_goes_here_1234567890"), true);
  assertEquals(hasPlaceholderWording("<a-real-looking-but-bracketed-value>"), true);
});

Deno.test("hasPlaceholderWording: a realistic high-entropy value carries none of these words", () => {
  assertEquals(hasPlaceholderWording("ghp_" + variedFakeBody(36, 2)), false);
});

Deno.test("hasGenericStandinUserinfo: 'user'/'password'/'secret'/'token' as the WHOLE segment is a standin", () => {
  assertEquals(hasGenericStandinUserinfo("user:password"), true);
  assertEquals(hasGenericStandinUserinfo("token"), true);
  assertEquals(hasGenericStandinUserinfo("secret:anything"), true);
});

Deno.test("hasGenericStandinUserinfo: a real-looking username/password is NOT a standin", () => {
  assertEquals(hasGenericStandinUserinfo("svcAcct7x:tK9mP2xQ7wR4nL8vB"), false);
});

Deno.test("placeholder-worded GitHub-token-shaped literal is suppressed end to end (word alone, not entropy, causes it)", () => {
  // "example" + a varied (non-degenerate) 29-char tail = 36 chars, so the
  // base pattern matches on length alone — isolates the placeholder-word
  // trigger from the entropy trigger (proven separately below).
  const body = "example" + variedFakeBody(29, 20);
  assertEquals(hasDegenerateEntropy(body), false); // sanity: entropy rule is NOT what's firing here
  const text = `const t = "ghp_${body}";`;
  assertEquals(findCredentialLiteral(text), null);
});

Deno.test("a realistic high-entropy GitHub-token-shaped literal with no placeholder word is still caught", () => {
  const text = `const t = "ghp_${variedFakeBody(36, 3)}";`;
  assertEquals(findCredentialLiteral(text), "GitHub token");
});

// Rule 3: degenerate entropy (repeated-char run, or sequential run, >= 8)

Deno.test("hasDegenerateEntropy: an 8+ repeated-character run is degenerate", () => {
  assertEquals(hasDegenerateEntropy("ghp_" + "Z".repeat(8)), true);
});

Deno.test("hasDegenerateEntropy: an 8+ strictly-sequential run is degenerate", () => {
  assertEquals(hasDegenerateEntropy("ghp_12345678"), true);
  assertEquals(hasDegenerateEntropy("ghp_abcdefgh"), true);
});

Deno.test("hasDegenerateEntropy: runs just under the threshold (7) are NOT degenerate", () => {
  assertEquals(hasDegenerateEntropy("ghp_" + "Z".repeat(7)), false);
  assertEquals(hasDegenerateEntropy("ghp_1234567"), false);
});

Deno.test("hasDegenerateEntropy: a varied, non-repeating, non-sequential body is NOT degenerate", () => {
  assertEquals(hasDegenerateEntropy(variedFakeBody(36, 4)), false);
});

Deno.test("a degenerate (repeated-char) GitHub-token-shaped literal is suppressed end to end", () => {
  assertEquals(findCredentialLiteral("ghp_" + "Q".repeat(36)), null);
});

Deno.test("a degenerate (sequential-digit) Google-API-key-shaped literal is suppressed end to end", () => {
  // Same shape as the pre-existing fixture in test/hooks_lib_helpers.test.ts —
  // proves the heuristic independently covers that fixture (see PR notes on
  // which markers were kept vs. found redundant).
  assertEquals(findCredentialLiteral("AIzaSyA123456789012345678901234567890123"), null);
});

Deno.test("a degenerate (sequential-digit) GitHub-token-shaped literal is suppressed end to end (proves a pragma marker is redundant on it)", () => {
  // Same shape as the pre-existing fixture in
  // test/block_human_only_credentials_hook.test.ts ("export
  // GITHUB_TOKEN=ghp_123456789012345678901234567890123456") — proves the
  // heuristic alone covers that fixture, so its pragma marker was dropped.
  const digits = "123456789012345678901234567890123456";
  assertEquals(findCredentialLiteral("ghp_" + digits), null);
});

Deno.test("a realistic high-entropy value of the SAME shape (no repeat/sequence/placeholder word) is still caught end to end", () => {
  const text = `const t = "ghp_${variedFakeBody(36, 6)}";`;
  assertEquals(findCredentialLiteral(text), "GitHub token");
});

// --- conservatism: path is never evidence, only the value's own shape is ---

Deno.test("a high-entropy value is still caught even when everything ABOUT the surrounding text says 'test fixture'", () => {
  const text = [
    "// test/fixtures/credentials.ts — DELIBERATE TEST FIXTURE FILE",
    `const token = "ghp_${variedFakeBody(36, 8)}";`,
  ].join("\n");
  assertEquals(findCredentialLiteral(text), "GitHub token");
});
