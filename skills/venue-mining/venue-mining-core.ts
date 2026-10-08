// skills/venue-mining/venue-mining-core.ts
// Core data structures, venueType inference, proposal table rendering, and POST /venue payload generation.
// References: Decision D-78 in ~/Dropbox/web-jam-llms/gig-outreach/gig-outreach-design-2026-09-18.md
import { type CanonicalVenueType, classifyVenue } from "../../src/venue-tag/backfill.ts";

export type { CanonicalVenueType };

export const CANONICAL_VENUE_TYPES: readonly CanonicalVenueType[] = [
  "PubFestivalBrewery",
  "MidRangeCafeBar",
  "Originals",
] as const;

export function isCanonicalVenueType(value: unknown): value is CanonicalVenueType {
  return (
    value === "PubFestivalBrewery" ||
    value === "MidRangeCafeBar" ||
    value === "Originals"
  );
}

export interface MinedVenueCandidate {
  _id?: string;
  name: string;
  city?: string;
  usState?: string;
  address?: string;
  streetAddress?: string;
  email?: string;
  emailSource?: string;
  phone?: string | null;
  website?: string;
  genre?: string | string[];
  description?: string;
  notes?: string;
  type?: string;
  venueType?: CanonicalVenueType | string | null;
  outreachEligible?: boolean;
  status?: string;
  [key: string]: unknown;
}

export interface ClassificationMatch {
  type: CanonicalVenueType | null;
  reason: string;
}

export interface VenueTypeInferenceOptions {
  fallbackType?: CanonicalVenueType;
  contextualResolver?: (candidate: MinedVenueCandidate) => CanonicalVenueType | null;
}

/**
 * Validates whether an address string represents a usable physical street address.
 * Rejects empty values, placeholder strings (TBD, N/A, None, Pending, Unknown),
 * PO Boxes (P.O. Box, Post Office Box), and generic downtown descriptors per Rule 21 and SKILL.md.
 */
export function isUsableStreetAddress(address: unknown): boolean {
  if (typeof address !== "string") {
    return false;
  }
  const trimmed = address.trim();
  if (!trimmed) {
    return false;
  }

  // Reject placeholder strings
  const placeholderPattern = /^(?:tbd|n\/?a|none|unknown|pending|null|-)$/i;
  if (placeholderPattern.test(trimmed)) {
    return false;
  }

  // Reject PO Box / Post Office Box
  const poBoxPattern = /\b(?:P\.?O\.?\s*Box|Post\s*Office\s*Box)\b/i;
  if (poBoxPattern.test(trimmed)) {
    return false;
  }

  // Reject generic downtown strings without street number/name
  const downtownPattern = /^downtown\s+[a-z\s,.-]+$/i;
  if (downtownPattern.test(trimmed)) {
    return false;
  }

  return true;
}

export interface VenueTypeInferenceResult {
  venueType?: CanonicalVenueType;
  reason: string;
  isFallback: boolean;
  confidence: "high" | "contextual" | "fallback" | "unresolved";
}

export interface CreateVenuePayload {
  name: string;
  city: string;
  usState: string;
  address: string;
  email?: string;
  phone?: string | null;
  website?: string;
  venueType: CanonicalVenueType;
  outreachEligible: boolean;
  notes: string;
}

/**
 * Classifies a candidate venue using deterministic keyword rules.
 * Returns { type: CanonicalVenueType, reason: string } on unique match,
 * or { type: null, reason: string } on competing categories or zero matches.
 */
export function classifyVenueCandidate(
  candidate: MinedVenueCandidate,
): ClassificationMatch {
  return classifyVenue({
    _id: (candidate._id as string) ?? "candidate",
    name: candidate.name,
    city: candidate.city,
    usState: candidate.usState,
    type: candidate.type,
    venueType: candidate.venueType,
    genre: candidate.genre,
    notes: candidate.notes,
    description: candidate.description,
    website: candidate.website,
  });
}

/**
 * Infers a canonical venueType for a mined venue candidate during Step 4 (Verify/Enrich).
 * Follows D-78:
 * 1. Preserves already-set canonical venueType.
 * 2. Deterministic keyword matching (PubFestivalBrewery, MidRangeCafeBar, Originals).
 * 3. Contextual LLM fallback if keyword rules match competing categories or zero categories.
 * 4. Fallback default (MidRangeCafeBar or options.fallbackType).
 */
export function inferVenueType(
  candidate: MinedVenueCandidate,
  options?: VenueTypeInferenceOptions,
): VenueTypeInferenceResult {
  // 1. Preserves already-set canonical venueType if present
  if (candidate.venueType && isCanonicalVenueType(candidate.venueType)) {
    return {
      venueType: candidate.venueType,
      reason: `pre-set canonical venueType "${candidate.venueType}"`,
      isFallback: false,
      confidence: "high",
    };
  }

  // 2. Deterministic keyword classification
  const match = classifyVenueCandidate(candidate);
  if (match.type !== null) {
    return {
      venueType: match.type,
      reason: match.reason,
      isFallback: false,
      confidence: "high",
    };
  }

  // 3. Contextual LLM fallback if resolver provided
  if (options?.contextualResolver) {
    const contextualType = options.contextualResolver(candidate);
    if (contextualType && isCanonicalVenueType(contextualType)) {
      return {
        venueType: contextualType,
        reason: `contextual LLM inference: ${match.reason}`,
        isFallback: true,
        confidence: "contextual",
      };
    }
  }

  // 4. Configured fallback type
  if (options?.fallbackType && isCanonicalVenueType(options.fallbackType)) {
    return {
      venueType: options.fallbackType,
      reason: `configured fallback (${options.fallbackType}): ${match.reason}`,
      isFallback: true,
      confidence: "fallback",
    };
  }

  // 5. Unresolved when ambiguous or unmatched without contextual resolution (D-78)
  return {
    venueType: undefined,
    reason:
      `unresolved venueType (requires contextual resolution or human review): ${match.reason}`,
    isFallback: false,
    confidence: "unresolved",
  };
}

/**
 * Formats a Step 5 proposal table for chat review, rendering the inferred venueType
 * in a dedicated column alongside contact information.
 * Follows D-78 / Section 673 format:
 * | # | Venue Name | City, ST | Type | Booking Email | Phone | Status |
 */
export function formatProposalTable(
  candidates: readonly MinedVenueCandidate[],
  options?: { detailed?: boolean },
): string {
  if (candidates.length === 0) {
    return "_No candidates to propose._";
  }

  // Detailed mode includes full evidence columns (Address, Email Source, Website)
  // Defaults to true per Step 5 evidence table requirements unless explicitly set to false
  const isDetailed = options?.detailed !== false;

  if (isDetailed) {
    const header =
      "| # | Venue Name | City, ST | Address | Type | Booking Email | Email Source | Phone | Website | Status |\n" +
      "|---|---|---|---|---|---|---|---|---|---|";
    const rows = candidates.map((c, i) => {
      const citySt = [c.city, c.usState].filter(Boolean).join(", ") || "-";
      const addr = c.address || c.streetAddress || "-";
      const typeStr = c.venueType ? `\`${c.venueType}\`` : "_unset_";
      const email = c.email || "-";
      const emailSrc = c.emailSource || "-";
      const phone = c.phone || "-";
      const website = c.website ? `[Link](${c.website})` : "-";
      const status = c.status || (c.address || c.streetAddress ? "Ready" : "Missing Address");
      return `| ${
        i + 1
      } | ${c.name} | ${citySt} | ${addr} | ${typeStr} | ${email} | ${emailSrc} | ${phone} | ${website} | ${status} |`;
    });
    return [header, ...rows].join("\n");
  }

  const header = "| # | Venue Name | City, ST | Type | Booking Email | Phone | Status |\n" +
    "|---|---|---|---|---|---|---|";
  const rows = candidates.map((c, i) => {
    const citySt = [c.city, c.usState].filter(Boolean).join(", ") || "-";
    const typeStr = c.venueType ? `\`${c.venueType}\`` : "_unset_";
    const email = c.email || "-";
    const phone = c.phone || "-";
    const status = c.status || (c.address || c.streetAddress ? "Ready" : "Missing Address");
    return `| ${i + 1} | ${c.name} | ${citySt} | ${typeStr} | ${email} | ${phone} | ${status} |`;
  });
  return [header, ...rows].join("\n");
}

/**
 * Builds and validates a POST /venue ingestion payload from an approved candidate record.
 * Ensures required fields (name, city, usState, address, venueType) are present and valid.
 * Street address is mandatory per SKILL.md.
 */
export function buildCreateVenuePayload(
  candidate: MinedVenueCandidate,
): CreateVenuePayload {
  const name = (candidate.name || "").trim();
  if (!name) {
    throw new Error("Cannot build venue payload: 'name' is required.");
  }

  const city = (candidate.city || "").trim();
  if (!city) {
    throw new Error(`Cannot build venue payload for "${name}": 'city' is required.`);
  }

  const usState = (candidate.usState || "").trim();
  if (!usState) {
    throw new Error(`Cannot build venue payload for "${name}": 'usState' is required.`);
  }

  const address = (candidate.address || candidate.streetAddress || "").trim();
  if (!address) {
    throw new Error(
      `Cannot build venue payload for "${name}": street address is required per Rule 21 and SKILL.md.`,
    );
  }

  if (!isUsableStreetAddress(address)) {
    throw new Error(
      `Cannot build venue payload for "${name}": valid physical street address is required per Rule 21 and SKILL.md (received "${address}").`,
    );
  }

  const rawType = candidate.venueType;
  const inferred = (rawType && isCanonicalVenueType(rawType))
    ? rawType
    : inferVenueType(candidate).venueType;

  if (!inferred || !isCanonicalVenueType(inferred)) {
    throw new Error(
      `Cannot build venue payload for "${name}": 'venueType' is required and could not be resolved. Specify venueType or resolve ambiguity.`,
    );
  }

  const venueType: CanonicalVenueType = inferred;

  const payload: CreateVenuePayload = {
    name,
    city,
    usState,
    address,
    venueType,
    outreachEligible: Boolean(candidate.outreachEligible),
    notes: (candidate.notes || "").trim(),
  };

  if (candidate.email && typeof candidate.email === "string" && candidate.email.trim()) {
    payload.email = candidate.email.trim();
  }
  if (candidate.phone && typeof candidate.phone === "string" && candidate.phone.trim()) {
    payload.phone = candidate.phone.trim();
  } else if (candidate.phone === null) {
    payload.phone = null;
  }
  if (candidate.website && typeof candidate.website === "string" && candidate.website.trim()) {
    payload.website = candidate.website.trim();
  }

  return payload;
}
