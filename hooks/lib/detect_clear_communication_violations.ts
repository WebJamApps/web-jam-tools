/**
 * Shared clear-communication violation detector (web-jam-tools#531).
 *
 * Used by hooks/require-clear-communication.sh (a BLOCKING Stop hook) to
 * answer "does this reply violate one of the three mechanically-decidable
 * chat-communication rules?" — same shape as
 * hooks/lib/detect_bare_issue_refs.ts's "does this text cite an issue/PR
 * without its title?".
 *
 * Only mechanically checkable things are checked here (counting `?`,
 * measuring content length after the last surviving `?`, matching a
 * configured keyword list against paragraph position) — never a judgment
 * call about importance or tone, per the issue's design constraints.
 *
 * Rule 1 — more than one open question to Josh in the same reply.
 * Rule 2 — a question followed by more than a configurable amount of
 *          content; a question must be the last thing in the message,
 *          measured from the LAST surviving question mark (not the first —
 *          a reply may legitimately contain an early quoted/rhetorical
 *          question and a real ask at the end).
 * Rule 3 — a safety-critical finding (security / data-loss / credential /
 *          prod / money) appearing outside the final paragraph-delimited
 *          section of the reply.
 *
 * DECISION on "rhetorical questions" (design-constraints text lists these
 * alongside quoted/coded/URL question marks as a false-positive risk for
 * rules 1/2): whether a bare, unquoted question mark in prose is
 * "rhetorical" or a genuine ask is exactly the kind of judgment call this
 * issue's Out of Scope section rules out ("Any rule requiring a judgment
 * call about importance or tone"). Rhetorical questions are therefore only
 * exempted to the extent they are already inside quoted text, fenced/inline
 * code, or a URL — the same exemptions rule 1/2 apply for other reasons. A
 * bare rhetorical "?" in ordinary prose is indistinguishable from a real one
 * and is intentionally NOT special-cased; it costs an occasional rewrite,
 * which is the same trade-off require-issue-citation-titles.sh already made
 * for milestone/ordinal parentheticals like "(#2)".
 *
 * Exit code of the CLI entry point is always 0 — this is a detector, not a
 * gate; the calling hook decides what non-empty stdout means.
 */

import * as path from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { stripCode } from "./detect_bare_issue_refs.ts";

// --- text sanitization (shared by rules 1 and 2) ---
//
// stripCode() (imported, not re-implemented) already blanks fenced code
// blocks and inline backticks while preserving text LENGTH, so positions
// computed on the sanitized text map 1:1 back to offsets in the original
// message. The regexes below extend that same length-preserving approach to
// double-quoted text (covers both quoted material and a cited
// `repo#number "title"`), blockquote lines, and URLs — none of the three can
// contain a literal newline by construction, so a uniform space-fill never
// disturbs surrounding line structure.
const DOUBLE_QUOTE_RE = /"[^"\n]*"/g;
const URL_RE = /https?:\/\/[^\s)>\]"'`]+/g;
const BLOCKQUOTE_LINE_RE = /^>.*$/gm;

function blank(match: string): string {
  return " ".repeat(match.length);
}

/** Strip quoted text, URLs, and blockquote lines, length-preserving. */
export function stripQuotesAndUrls(text: string): string {
  return text
    .replace(DOUBLE_QUOTE_RE, blank)
    .replace(URL_RE, blank)
    .replace(BLOCKQUOTE_LINE_RE, blank);
}

/** Full sanitization used by rules 1 and 2: code, then quotes/URLs/blockquotes. */
export function stripNonProse(text: string): string {
  return stripQuotesAndUrls(stripCode(text));
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snippetAround(original: string, index: number, radius = 60): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(original.length, index + 1);
  let snippet = original.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "…" + snippet;
  return snippet;
}

// --- rule 1 & 2: question detection ---

/** Character offsets of every surviving `?` (real prose, not code/quote/URL). */
export function findQuestionPositions(text: string): number[] {
  const cleaned = stripNonProse(text);
  const positions: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "?") positions.push(i);
  }
  return positions;
}

/** Rule 1: more than one open question. Returns one snippet per question (empty if <=1). */
export function findMultipleQuestionViolations(text: string): string[] {
  const positions = findQuestionPositions(text);
  if (positions.length <= 1) return [];
  return positions.map((p) => snippetAround(text, p));
}

export interface TrailingContentViolation {
  trailingChars: number;
  snippet: string;
}

/**
 * Rule 2: content following the LAST surviving question mark, measured
 * against `thresholdChars`. Deliberately anchored on the last position, not
 * the first — an early question (quoted, rhetorical, or otherwise) must not
 * make a genuinely-trailing final question look like it has content after
 * it when it doesn't.
 */
export function findTrailingContentViolation(
  text: string,
  thresholdChars: number,
): TrailingContentViolation | null {
  const cleaned = stripNonProse(text);
  const positions = findQuestionPositions(text);
  if (positions.length === 0) return null;
  const lastPos = positions[positions.length - 1];
  const trailingRaw = cleaned.slice(lastPos + 1);
  const trailing = trailingRaw.replace(/\s+/g, " ").trim();
  if (trailing.length <= thresholdChars) return null;
  const snippet = trailing.length > 100 ? trailing.slice(0, 100) + "…" : trailing;
  return { trailingChars: trailing.length, snippet };
}

// --- rule 3: safety keyword outside the final section ---

export interface SafetyKeywordViolation {
  keyword: string;
  sectionIndex: number;
  totalSections: number;
}

/**
 * Splits the (code-stripped) message into paragraphs on blank lines. A
 * safety keyword matched anywhere except the LAST non-empty paragraph is a
 * violation. Empty paragraphs (e.g. trailing blank lines) are dropped before
 * indexing so a trailing newline can't masquerade as an empty "final
 * section" and wrongly flag the real last paragraph.
 */
export function findSafetyKeywordViolations(
  text: string,
  keywords: string[],
): SafetyKeywordViolation[] {
  const cleaned = stripCode(text);
  const sections = cleaned.split(/\n\s*\n/).filter((s) => s.trim().length > 0);
  if (sections.length <= 1) return [];

  const lastIndex = sections.length - 1;
  const violations: SafetyKeywordViolation[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lastIndex; i++) {
    const sectionLower = sections[i].toLowerCase();
    for (const kw of keywords) {
      const kwLower = kw.trim().toLowerCase();
      if (!kwLower) continue;
      const re = new RegExp(`\\b${escapeRegExp(kwLower)}\\b`, "i");
      if (re.test(sectionLower)) {
        const key = `${kwLower}#${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          violations.push({ keyword: kw, sectionIndex: i + 1, totalSections: sections.length });
        }
      }
    }
  }

  return violations;
}

// --- config ---

export interface ClearCommunicationConfig {
  trailingContentThresholdChars: number;
  safetyKeywords: string[];
}

// Used only if hooks/clear-communication.yaml cannot be read (missing,
// unparsable). Mirrors the checked-in file's values so the mechanism still
// functions rather than going silently dark.
export const DEFAULT_CONFIG: ClearCommunicationConfig = {
  trailingContentThresholdChars: 80,
  safetyKeywords: [
    "security",
    "vulnerability",
    "breach",
    "exploit",
    "data loss",
    "data-loss",
    "deleted data",
    "lost data",
    "wiped",
    "overwritten",
    "credential",
    "credentials",
    "password",
    "secret key",
    "api key",
    "leaked",
    "prod",
    "production",
    "outage",
    "regression",
    "money",
    "billing",
    "payment",
    "financial",
    "invoice",
    "cost overrun",
    "force-push",
    "force push",
    "irreversible",
  ],
};

export function loadConfig(yamlPath: string): ClearCommunicationConfig {
  try {
    const text = Deno.readTextFileSync(yamlPath);
    const data = parseYaml(text) as Record<string, unknown>;
    const threshold = typeof data.trailing_content_threshold_chars === "number"
      ? data.trailing_content_threshold_chars
      : DEFAULT_CONFIG.trailingContentThresholdChars;
    const keywords = Array.isArray(data.safety_keywords)
      ? data.safety_keywords.filter((k): k is string => typeof k === "string" && k.trim() !== "")
      : DEFAULT_CONFIG.safetyKeywords;
    return { trailingContentThresholdChars: threshold, safetyKeywords: keywords };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// --- report formatting ---

/**
 * Runs all three rules against `text` and returns a fully-formatted,
 * human-readable report body naming every offending rule + token, or ""
 * if nothing fired. The calling hook wraps this with a generic
 * BLOCKED/rewrite header and footer (same split as detect_bare_issue_refs.ts,
 * where the detector finds offenders and the hook shell script owns the
 * envelope).
 */
export function buildReport(text: string, config: ClearCommunicationConfig): string {
  const lines: string[] = [];

  const questionViolations = findMultipleQuestionViolations(text);
  if (questionViolations.length > 0) {
    lines.push(
      `Rule 1 — more than one open question to Josh (${questionViolations.length} found):`,
    );
    for (const snippet of questionViolations) {
      lines.push(`  - "${snippet}"`);
    }
    lines.push(
      "(rule: at-most-one-open-question — end with a single question; state or defer the rest as statements)",
    );
    lines.push("");
  }

  const trailing = findTrailingContentViolation(text, config.trailingContentThresholdChars);
  if (trailing) {
    lines.push("Rule 2 — a question must be the last thing in the message:");
    lines.push(
      `  - ${trailing.trailingChars} characters follow the last question mark (threshold: ${config.trailingContentThresholdChars}): "${trailing.snippet}"`,
    );
    lines.push(
      "(rule: question-must-be-last — move the question to the end, or drop it and state findings instead)",
    );
    lines.push("");
  }

  const keywordViolations = findSafetyKeywordViolations(text, config.safetyKeywords);
  if (keywordViolations.length > 0) {
    lines.push("Rule 3 — a safety-critical finding appears outside the final section:");
    for (const v of keywordViolations) {
      lines.push(
        `  - "${v.keyword}" found in section ${v.sectionIndex} of ${v.totalSections} (not the final section)`,
      );
    }
    lines.push(
      "(rule: safety-finding-must-be-final — move the security/data-loss/credential/prod/money finding to the final section, or lead with it)",
    );
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

if (import.meta.main) {
  const currentFileUrl = new URL(import.meta.url).pathname;
  const hookDir = path.dirname(path.dirname(currentFileUrl)); // hooks/lib -> hooks
  const yamlPath = path.join(hookDir, "clear-communication.yaml");
  const config = loadConfig(yamlPath);
  const raw = Deno.env.get("MSG_FOR_PY") || Deno.args[0] || "";
  const report = buildReport(raw, config);
  if (report) {
    console.log(report);
  }
}
