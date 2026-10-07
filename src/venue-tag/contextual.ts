// D-78 contextual fallback is performed by the running agent, then approved in the CLI.
import type { CanonicalVenueType, VenueRecord } from "./backfill.ts";

export interface ContextualClassification {
  venueId: string;
  contextHash: string;
  type: CanonicalVenueType;
  reason: string;
}

export interface ContextRequest {
  venueId: string;
  contextHash: string;
  context: Record<string, unknown>;
}

export function isCanonicalType(value: unknown): value is CanonicalVenueType {
  return value === "Originals" || value === "PubFestivalBrewery" || value === "MidRangeCafeBar";
}

/** Export only classification context; never include credentials or contact fields. */
export async function createContextRequest(venue: VenueRecord): Promise<ContextRequest> {
  const context = {
    name: venue.name ?? null,
    city: venue.city ?? null,
    usState: venue.usState ?? null,
    type: venue.type ?? null,
    venueType: venue.venueType ?? null,
    genre: venue.genre ?? null,
    notes: venue.notes ?? null,
    description: venue.description ?? null,
    website: venue.website ?? null,
    status: venue.status ?? null,
    bookingStatus: typeof venue.bookingStatus === "string" ? venue.bookingStatus : null,
    audienceAttention: typeof venue.audienceAttention === "string" ? venue.audienceAttention : null,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(context));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const contextHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { venueId: venue._id, contextHash, context };
}

export function validateContextualClassifications(value: unknown): ContextualClassification[] {
  if (!Array.isArray(value)) throw new Error("Contextual classifications must be a JSON array.");
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Each contextual classification must be an object.");
    }
    const { venueId, contextHash, type, reason } = entry as Record<string, unknown>;
    if (typeof venueId !== "string" || !venueId.trim() || ids.has(venueId)) {
      throw new Error("Contextual classifications require unique, nonempty venueId values.");
    }
    if (typeof contextHash !== "string" || !/^[a-f0-9]{64}$/.test(contextHash)) {
      throw new Error("Contextual classifications require the exported contextHash.");
    }
    if (!isCanonicalType(type)) {
      throw new Error("Contextual classifications require a canonical venue type.");
    }
    if (typeof reason !== "string" || !reason.trim() || reason.length > 2000) {
      throw new Error(
        "Contextual classifications require a nonempty explanation (up to 2000 characters).",
      );
    }
    ids.add(venueId);
    return { venueId, contextHash, type, reason };
  });
}

export function parseContextualClassifications(json: string): ContextualClassification[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Contextual classifications must be valid JSON.");
  }
  return validateContextualClassifications(value);
}
