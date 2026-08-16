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
  isFlaggableMongoDbUri,
} from "../hooks/lib/detect_credential_literal.ts";

const FAKE = {
  github: "ghp_" + "C".repeat(36),
  githubOther: "ghp_" + "D".repeat(36),
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
