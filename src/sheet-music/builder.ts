/**
 * src/sheet-music/builder.ts
 *
 * Word (.docx) document builder for sheet music lead sheets (web-jam-tools#770, web-jam-tools#771).
 */

import { Document, Packer, PageOrientation, Paragraph, TextRun } from "docx";
import type { ChordLyricLine, SongDefinition } from "./types.ts";
import { autoTransposeSong } from "./transpose.ts";

export const FONT_FAMILY = "Consolas";
export const TITLE_SIZE = 24; // 12pt
export const HEADER_SIZE = 18; // 9pt
export const SECTION_SIZE = 19; // 9.5pt
export const CHORD_SIZE = 18; // 9pt
export const LYRIC_SIZE = 18; // 9pt
export const ANNOTATION_SIZE = 16; // 8pt

// 0.5 inch margins in twentieths of a point (dxa): 0.5 * 1440 = 720 dxa
export const MARGIN_DXA = 720;
// Standard Letter dimensions in dxa (8.5" x 11"):
export const PAGE_WIDTH_DXA = 12240;
export const PAGE_HEIGHT_DXA = 15840;

/**
 * Builds a Word Document instance from a structured SongDefinition.
 */
export function buildSongDocument(songInput: SongDefinition): Document {
  const song = autoTransposeSong(songInput);
  const isDualTier = song.metadata.mode === "dual-tier";
  const capo = song.metadata.capo;

  const children: Paragraph[] = [];

  // 1. Song Title
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: song.metadata.title,
          bold: true,
          size: TITLE_SIZE,
          font: FONT_FAMILY,
        }),
      ],
      spacing: { line: 200, before: 0, after: 20 },
    }),
  );

  // 2. Composer / Credits
  if (song.metadata.composer || song.metadata.copyright) {
    const creditText = [song.metadata.composer, song.metadata.copyright]
      .filter(Boolean)
      .join(" | ");
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: creditText,
            italics: true,
            size: HEADER_SIZE,
            font: FONT_FAMILY,
          }),
        ],
        spacing: { line: 200, before: 0, after: 20 },
      }),
    );
  }

  // 3. Header Instrument Legend
  let legendRuns: TextRun[] = [];
  if (song.metadata.legend) {
    legendRuns = [
      new TextRun({
        text: song.metadata.legend,
        bold: true,
        size: HEADER_SIZE,
        font: FONT_FAMILY,
      }),
    ];
  } else if (isDualTier) {
    const capoLabel = capo ? `Guitar (Capo ${capo})` : "Guitar (Capo)";
    legendRuns = [
      new TextRun({ text: `${capoLabel}: `, bold: true, size: HEADER_SIZE, font: FONT_FAMILY }),
      new TextRun({ text: "Bold  |  ", size: HEADER_SIZE, font: FONT_FAMILY }),
      new TextRun({
        text: "Bass Guitar (No Capo): ",
        italics: true,
        size: HEADER_SIZE,
        font: FONT_FAMILY,
      }),
      new TextRun({ text: "Italic", italics: true, size: HEADER_SIZE, font: FONT_FAMILY }),
    ];
  } else {
    legendRuns = [
      new TextRun({ text: "Chords: ", bold: true, size: HEADER_SIZE, font: FONT_FAMILY }),
      new TextRun({
        text: "Bold  |  Standard Tuning (No Capo)",
        size: HEADER_SIZE,
        font: FONT_FAMILY,
      }),
    ];
  }

  children.push(
    new Paragraph({
      children: legendRuns,
      spacing: { line: 200, before: 0, after: 40 },
    }),
  );

  // 4. Key Summary / Performance Notes
  const keyDetails: string[] = [];
  if (song.metadata.guitarKey) {
    keyDetails.push(`Guitar Shapes: Key of ${song.metadata.guitarKey}`);
  }
  if (isDualTier && song.metadata.bassKey) {
    keyDetails.push(`Bass Sounding: Key of ${song.metadata.bassKey}`);
  }
  if (song.metadata.tempo) {
    keyDetails.push(`Tempo: ${song.metadata.tempo}`);
  }

  if (keyDetails.length > 0) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: keyDetails.join("  |  "),
            size: HEADER_SIZE,
            font: FONT_FAMILY,
          }),
        ],
        spacing: { line: 200, before: 0, after: 40 },
      }),
    );
  }

  if (song.metadata.performanceNotes && song.metadata.performanceNotes.length > 0) {
    for (const note of song.metadata.performanceNotes) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `[Note: ${note}]`,
              italics: true,
              size: ANNOTATION_SIZE,
              font: FONT_FAMILY,
            }),
          ],
          spacing: { line: 200, before: 0, after: 20 },
        }),
      );
    }
  }

  // 5. Song Sections
  for (const section of song.sections) {
    // Section Header
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: section.title.toUpperCase(),
            bold: true,
            size: SECTION_SIZE,
            font: FONT_FAMILY,
          }),
        ],
        spacing: { line: 200, before: 40, after: 0 },
      }),
    );

    // Section Lines
    for (const line of section.lines) {
      const lineParagraphs = buildLineParagraphs(line, isDualTier);
      children.push(...lineParagraphs);
    }
  }

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              width: PAGE_WIDTH_DXA,
              height: PAGE_HEIGHT_DXA,
              orientation: PageOrientation.PORTRAIT,
            },
            margin: {
              top: MARGIN_DXA,
              bottom: MARGIN_DXA,
              left: MARGIN_DXA,
              right: MARGIN_DXA,
            },
          },
        },
        children,
      },
    ],
  });

  return doc;
}

/**
 * Builds the paragraph block for a single chord/lyric line.
 */
function buildLineParagraphs(line: ChordLyricLine, isDualTier: boolean): Paragraph[] {
  const paras: Paragraph[] = [];
  const hasAnnotation = Boolean(line.annotation);

  if (isDualTier) {
    // Line 1: Guitar Capo Chords (Bold) + optional annotation
    const guitarRuns: TextRun[] = [
      new TextRun({
        text: line.guitarChords || " ",
        bold: true,
        size: CHORD_SIZE,
        font: FONT_FAMILY,
      }),
    ];
    if (hasAnnotation) {
      guitarRuns.push(
        new TextRun({
          text: `  ${line.annotation}`,
          italics: true,
          size: ANNOTATION_SIZE,
          font: FONT_FAMILY,
        }),
      );
    }

    paras.push(
      new Paragraph({
        children: guitarRuns,
        spacing: { line: 200, before: 0, after: 0 },
      }),
    );

    // Line 2: Bass No-Capo Chords (Italic)
    paras.push(
      new Paragraph({
        children: [
          new TextRun({
            text: line.bassChords || " ",
            italics: true,
            size: CHORD_SIZE,
            font: FONT_FAMILY,
          }),
        ],
        spacing: { line: 200, before: 0, after: 0 },
      }),
    );

    // Line 3: Lyrics (Regular)
    paras.push(
      new Paragraph({
        children: [
          new TextRun({
            text: line.lyrics || " ",
            size: LYRIC_SIZE,
            font: FONT_FAMILY,
          }),
        ],
        spacing: { line: 200, before: 0, after: 20 },
      }),
    );
  } else {
    // Single-Tier: Line 1 = Chords (Bold) + optional annotation
    const chordRuns: TextRun[] = [
      new TextRun({
        text: line.chords || line.guitarChords || " ",
        bold: true,
        size: CHORD_SIZE,
        font: FONT_FAMILY,
      }),
    ];
    if (hasAnnotation) {
      chordRuns.push(
        new TextRun({
          text: `  ${line.annotation}`,
          italics: true,
          size: ANNOTATION_SIZE,
          font: FONT_FAMILY,
        }),
      );
    }

    paras.push(
      new Paragraph({
        children: chordRuns,
        spacing: { line: 200, before: 0, after: 0 },
      }),
    );

    // Line 2: Lyrics (Regular)
    paras.push(
      new Paragraph({
        children: [
          new TextRun({
            text: line.lyrics || " ",
            size: LYRIC_SIZE,
            font: FONT_FAMILY,
          }),
        ],
        spacing: { line: 200, before: 0, after: 20 },
      }),
    );
  }

  return paras;
}

/**
 * Generates a binary Uint8Array buffer for the given SongDefinition.
 */
export async function generateSongDocxBuffer(song: SongDefinition): Promise<Uint8Array> {
  const doc = buildSongDocument(song);
  const nodeBuffer = await Packer.toBuffer(doc);
  return new Uint8Array(nodeBuffer.buffer, nodeBuffer.byteOffset, nodeBuffer.byteLength);
}
