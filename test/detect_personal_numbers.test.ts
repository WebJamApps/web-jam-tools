// detect_personal_numbers.test.ts — web-jam-tools#1860
//
// One Deno test per row of the table of literal cases in "The checker",
// ~/Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.md.
// Every number below is made up.

import { assert, assertEquals } from "@std/assert";
import {
  describeKinds,
  detectPersonalNumbers,
  type PersonalNumberKind,
} from "../hooks/lib/detect_personal_numbers.ts";

const CASES: Array<[string, PersonalNumberKind | null]> = [
  ["SSN: 123-45-6789", "ssn"],
  ["123-45-6789", "ssn"],
  ["social security 123456789", "ssn"],
  ["987-65-4321", "itin"],
  ["ITIN 912-70-1234", "itin"],
  ["000-12-3456", null],
  ["900-12-3456", null],
  ["123-00-4567", null],
  ["Invoice 2026-11-1234", null],
  ["4539 1488 0343 6467", "card"],
  ["4539-1488-0343-6467", "card"],
  ["Visa 4539148803436467", "card"],
  ["<ACCTID>4539148803436467", "card"],
  ["4539148803436467", null], // one unbroken run with no card word
  ["1234 5678 9012 3456", null], // fails the checksum
  ["4111 1111 1111 1111", null], // a published test number
  ["3782 822463 10005", null], // a published test number
  ["media id 17841400008460056", null],
  ["Routing Number: 021000021", "routing"],
  ["<BANKID>021000021", "routing"],
  ["021000021", null], // no routing word
  ["Routing 123456789", null], // fails the routing checksum
  ["Account Number: 1234567890", "account"],
  ["acct # 000123456789", "account"],
  ["<ACCTID>1234567890", "account"],
  ["Account ending in 1234", null],
  ["XXXXXX1234", null],
  ["ONLINE TRANSFER TO CHK ****1234", null],
  ["2026-03-14,PENN STATION,22.86,202603140001", null],
];

for (const [text, expected] of CASES) {
  Deno.test(`checker literal case: ${text} -> ${expected ?? "nothing"}`, () => {
    const findings = detectPersonalNumbers(text);
    assertEquals(findings.map((f) => f.kind), expected ? [expected] : []);
  });
}

Deno.test("checker reports the kind and where, never the number", () => {
  const findings = detectPersonalNumbers("first line\nname: x  SSN: 123-45-6789");
  assertEquals(findings, [{ kind: "ssn", line: 2, column: 15 }]);
  assert(!JSON.stringify(findings).includes("6789"));
});

Deno.test("checker names every kind in the design's order", () => {
  const text =
    "routing number 021000021 account number 1234567890 card 4539 1488 0343 6467 SSN 123-45-6789";
  assertEquals(
    describeKinds(detectPersonalNumbers(text)),
    "a Social Security number and a card number and a routing number and a bank account number",
  );
});

Deno.test("checker: a run that fits two kinds is named by the first in order", () => {
  // Nine digits after both an SSN word and a routing word, valid as an SSN and
  // passing the routing checksum.
  assertEquals(detectPersonalNumbers("routing 122105155").map((f) => f.kind), ["routing"]);
  assertEquals(detectPersonalNumbers("SSN routing 122105155").map((f) => f.kind), ["ssn"]);
  // A card number inside <ACCTID> is a card, not an account number.
  assertEquals(detectPersonalNumbers("<ACCTID>4539148803436467").map((f) => f.kind), ["card"]);
});

Deno.test("checker: keywords only count at word edges and within their distance", () => {
  assertEquals(detectPersonalNumbers("itinerary 912701234"), []);
  assertEquals(detectPersonalNumbers("database 021000021"), []);
  assertEquals(detectPersonalNumbers(`Routing${" ".repeat(31)}021000021`), []);
  assertEquals(detectPersonalNumbers(`Routing${" ".repeat(30)}021000021`).map((f) => f.kind), [
    "routing",
  ]);
  assertEquals(detectPersonalNumbers(`Account Number: ${"1".repeat(18)}`), []);
});

Deno.test("checker: never-issued numbers and other issuers' shapes are not protected", () => {
  assertEquals(detectPersonalNumbers("666-12-3456"), []);
  assertEquals(detectPersonalNumbers("123-45-0000"), []);
  assertEquals(detectPersonalNumbers("SSN 000123456"), []);
  // A Luhn-valid 16-digit number with no issuer prefix is not a card.
  assertEquals(detectPersonalNumbers("1234 5678 9012 3452"), []);
});

Deno.test("checker stays fast on a long text full of keywords and no numbers", () => {
  const text = "account card routing SSN ".repeat(200_000);
  const start = performance.now();
  assertEquals(detectPersonalNumbers(text), []);
  assert(performance.now() - start < 5_000);
});
