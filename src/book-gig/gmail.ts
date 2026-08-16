// src/book-gig/gmail.ts — Gmail draft creation and run logging for /book-gig

import type { BookGigResult, PitchEmail } from "./types.ts";

export interface CreateDraftResult {
  venueId: string;
  venueName: string;
  to: string;
  subject: string;
  draftCreated: boolean;
  draftId?: string;
  error?: string;
}

/**
 * Format a pitch as a Gmail draft object (ready for Gmail API or MCP)
 */
export function formatDraftPayload(pitch: PitchEmail): {
  to: string;
  cc?: string;
  subject: string;
  body: string;
} {
  return {
    to: pitch.to,
    cc: pitch.secondaryTo,
    subject: pitch.subject,
    body: pitch.body,
  };
}

/**
 * Record an outreach run log in Dropbox for Josh's records
 */
export async function writeDropboxRunLog(
  result: BookGigResult,
  outputDir = `${Deno.env.get("HOME")}/Dropbox/web-jam-llms/gig-outreach`,
): Promise<string | null> {
  try {
    await Deno.mkdir(outputDir, { recursive: true });
    const dateSlug = `${result.weekend.start}-to-${result.weekend.end}`;
    const filePath = `${outputDir}/book-gig-run-${dateSlug}.md`;

    const candidateRows = result.candidates.map((c, i) =>
      `| ${i + 1} | ${c.name} | ${c.city || "—"}, ${c.usState || "—"} | ${c.email || "—"} | ${
        c.reason?.spacingNote || "—"
      } |`
    ).join("\n");

    const pitchBlocks = result.pitches.map((p, i) =>
      `### Pitch ${i + 1}: ${p.venueName}
- **To:** \`${p.to}\`${p.secondaryTo ? ` (CC: \`${p.secondaryTo}\`)` : ""}
- **Subject:** ${p.subject}

\`\`\`text
${p.body}
\`\`\`
`
    ).join("\n\n");

    const content = `# \`book-gig\` Run Record: ${result.weekend.label}

**Run Timestamp:** ${new Date().toISOString()}  
**Target Weekend:** ${result.weekend.start} to ${result.weekend.end} (${result.weekend.label})  
**Target Location Filter:** ${
      result.location ? result.location.raw : "All Regional Metros (~3.5h drive)"
    }  
**Candidates Found:** ${result.candidates.length} (Sparse: ${
      result.density.isSparse ? "Yes" : "No"
    })  
**Pitches Drafted:** ${result.pitches.length}

---

## 1. Candidate Venues Evaluated

| # | Venue Name | Location | Booking Email | Spacing Note |
|---|---|---|---|---|
${candidateRows || "| — | No candidates found | — | — | — |"}

---

## 2. Generated Gmail Pitches

${pitchBlocks || "*No pitches generated.*"}

---

*Note: All pitch emails are created as Gmail Drafts for Josh's manual review. No automated sending was performed.*
`;

    await Deno.writeTextFile(filePath, content);
    return filePath;
  } catch (err) {
    console.warn(`[book-gig] Failed to write run log to Dropbox: ${(err as Error).message}`);
    return null;
  }
}
