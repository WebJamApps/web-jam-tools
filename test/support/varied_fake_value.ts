// varied_fake_value.ts — shared test helper (issue-detector-false-positive item 4)
//
// hooks/lib/detect_credential_literal.ts's synthetic-value heuristic treats a
// long run of the same repeated character (or a strictly-sequential run,
// e.g. "12345678") as self-evidently NOT a live secret and auto-suppresses
// it. A `"C".repeat(36)`-style fixture — the pattern used throughout this
// suite before that heuristic existed — is now indistinguishable from that
// auto-suppression, which defeats any test whose whole point is proving the
// detector STILL catches an unmarked, realistic-looking credential.
//
// variedFakeBody produces a fixed, reproducible (same offset -> same output),
// non-repeating, non-sequential alphanumeric string instead. It is still
// assembled at RUNTIME — never a literal credential-shaped string at rest in
// any file that imports it — just not degenerate.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// 62 = 2 x 31. A step coprime to both factors (17 is prime, and neither 2
// nor 31) walks every index exactly once before repeating, so for any
// length <= ALPHABET.length the output characters are pairwise distinct —
// which trivially rules out both a repeated-character run and, because
// consecutive picks land 17 positions apart in a string that is not sorted
// by code point, a sequential-code-point run.
const STEP = 17;

/**
 * A deterministic, non-degenerate alphanumeric string of `length` characters
 * (<= 62). Pass a different `offset` to get a different-looking string from
 * the same generator (e.g. one per fixture in a file) without risking a
 * collision with the entropy heuristic.
 */
export function variedFakeBody(length: number, offset = 0): string {
  if (length > ALPHABET.length) {
    throw new Error(
      `variedFakeBody: length ${length} exceeds the ${ALPHABET.length}-char single-cycle limit`,
    );
  }
  let out = "";
  for (let i = 0; i < length; i++) {
    const idx = (offset + i * STEP) % ALPHABET.length;
    out += ALPHABET[idx];
  }
  return out;
}

// AWS access key IDs are uppercase-digits only (`[0-9A-Z]{16}`) — a distinct,
// smaller alphabet, so it needs its own single-cycle generator and step.
// 36 = 2^2 x 3^2; 7 shares no factor with either.
const UPPER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const UPPER_STEP = 7;

/** Same idea as variedFakeBody, restricted to uppercase letters + digits (<= 36 chars). */
export function variedFakeBodyUpper(length: number, offset = 0): string {
  if (length > UPPER_ALPHABET.length) {
    throw new Error(
      `variedFakeBodyUpper: length ${length} exceeds the ${UPPER_ALPHABET.length}-char single-cycle limit`,
    );
  }
  let out = "";
  for (let i = 0; i < length; i++) {
    const idx = (offset + i * UPPER_STEP) % UPPER_ALPHABET.length;
    out += UPPER_ALPHABET[idx];
  }
  return out;
}
