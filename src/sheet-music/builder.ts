/**
 * src/sheet-music/builder.ts
 *
 * Word (.docx) document builder for sheet music lead sheets (web-jam-tools#770, web-jam-tools#771, web-jam-tools#1010).
 */

import { Document, Packer, PageOrientation, Paragraph, TextRun } from "docx";
import type { ChordLyricLine, ParseLineOptions, RenderedLine, SongDefinition } from "./types.ts";
import { autoTransposeSong, soundingPrefersSharps, transposeChord } from "./transpose.ts";

export const FONT_FAMILY = "Consolas";
export const TITLE_SIZE = 32; // 16pt
export const HEADER_SIZE = 22; // 11pt
export const SECTION_SIZE = 24; // 12pt
export const CHORD_SIZE = 24; // 12pt (minimum flex size)
export const LYRIC_SIZE = 24; // 12pt (minimum flex size)
export const ANNOTATION_SIZE = 20; // 10pt

// 0.5 inch margins in twentieths of a point (dxa): 0.5 * 1440 = 720 dxa
export const MARGIN_DXA = 720;
// Standard Letter dimensions in dxa (8.5" x 11"):
export const PAGE_WIDTH_DXA = 12240;
export const PAGE_HEIGHT_DXA = 15840;

/**
 * Valid chord symbol regex matching standard roots, qualities, and slash chords, including 6/9
 * chords, the diminished (°) and half-diminished (ø) symbols, and altered dominants (alt).
 */
export const CHORD_REGEX =
  /^[A-G](?:#|b)?(?:maj|min|m|M|dim|aug|sus|add|alt|6\/9|°|ø|\(|\)|[0-9]|b|#|\+|-)*(?:\/[A-G](?:#|b)?)?$/;

/**
 * Validates whether a token represents a legitimate chord symbol.
 */
export function isValidChordToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  return CHORD_REGEX.test(trimmed);
}

/**
 * Validates a structured SongDefinition, failing closed with clear errors on malformed structure or lines.
 */
export function validateSongDefinition(songInput: unknown): SongDefinition {
  if (!songInput || typeof songInput !== "object") {
    throw new Error("Invalid song definition: expected an object");
  }
  const song = songInput as Record<string, unknown>;
  if (!song.metadata || typeof song.metadata !== "object") {
    throw new Error("SongDefinition must contain a metadata object");
  }
  const meta = song.metadata as Record<string, unknown>;
  if (!meta.title || typeof meta.title !== "string" || meta.title.trim() === "") {
    throw new Error("SongDefinition must contain a metadata.title property");
  }
  if (!Array.isArray(song.sections)) {
    throw new Error("SongDefinition must contain a sections array");
  }
  for (let s = 0; s < song.sections.length; s++) {
    const sec = song.sections[s];
    if (!sec || typeof sec !== "object") {
      throw new Error(`Section ${s + 1} is not an object`);
    }
    const secTitle = (sec as Record<string, unknown>).title
      ? String((sec as Record<string, unknown>).title)
      : `Section ${s + 1}`;
    const lines = (sec as Record<string, unknown>).lines;
    if (!Array.isArray(lines)) {
      throw new Error(`Section "${secTitle}" must contain a lines array`);
    }
    for (let l = 0; l < lines.length; l++) {
      const line = lines[l];
      if (!line || typeof line !== "object") {
        throw new Error(`Section "${secTitle}", line ${l + 1}: expected an object`);
      }
      const lyricsVal = (line as Record<string, unknown>).lyrics;
      if (typeof lyricsVal !== "string") {
        throw new Error(
          `Section "${secTitle}", line ${l + 1}: "lyrics" field must be a string, got ${
            lyricsVal === undefined ? "undefined" : typeof lyricsVal
          }`,
        );
      }
    }
  }
  return songInput as SongDefinition;
}

interface RawToken {
  type: "text" | "marker";
  text?: string;
  guitar?: string;
  bass?: string;
}

interface MarkerChord {
  guitar: string;
  bass: string;
}

interface Syllable {
  text: string;
  chord?: MarkerChord;
}

interface Word {
  leadingWhitespace: string;
  gapChords: MarkerChord[];
  syllables: Syllable[];
  trailingChords: MarkerChord[];
}

interface PlacedChord {
  guitar: string;
  bass: string;
  colOffset: number; // offset relative to start of word's text
}

interface PlacedGapChord {
  guitar: string;
  bass: string;
  colOffset: number; // offset relative to start of leadingWhitespace
}

interface ProcessedWord {
  leadingWhitespace: string;
  gapChords: PlacedGapChord[];
  text: string;
  chords: PlacedChord[];
  trailingChords: PlacedChord[];
  hasPunctuation: boolean;
}

/**
 * Parses raw lyric line text with inline chord markers (e.g. "re[C/E]member", "[C/D]O[D]ceans rise,")
 * into column-aligned, widened, and line-broken RenderedLine blocks.
 */
export function parseAndLayoutLine(
  lineInput: string | ChordLyricLine,
  options?: ParseLineOptions,
): RenderedLine[] {
  let rawLyrics: string;
  let annotation: string | undefined;

  if (typeof lineInput === "object" && lineInput !== null) {
    if (typeof lineInput.lyrics !== "string") {
      throw new Error('"lyrics" field must be a string');
    }
    rawLyrics = lineInput.lyrics;
    annotation = lineInput.annotation;

    // Backward-compatibility: if no inline chord markers present, preserve legacy space-padded chord strings
    if (!rawLyrics.includes("[") && (lineInput.guitarChords || lineInput.chords)) {
      return [
        {
          lyrics: lineInput.lyrics,
          guitarChords: lineInput.guitarChords || lineInput.chords || " ",
          bassChords: lineInput.bassChords,
          chords: lineInput.chords || lineInput.guitarChords,
          annotation: lineInput.annotation,
        },
      ];
    }
  } else if (typeof lineInput === "string") {
    rawLyrics = lineInput;
  } else {
    throw new Error(
      'Invalid input: expected a string or ChordLyricLine object with a "lyrics" field',
    );
  }

  const mode = options?.mode || "single-tier";
  const capo = options?.capo;
  const maxLineWidth = options?.maxLineWidth ?? 75;

  // 1. Tokenize into plain text and bracketed chord markers with strict syntax validation
  const tokens: RawToken[] = [];
  let i = 0;
  let textBuf = "";
  let lastWasMarker = false;
  let lastMarkerRaw = "";

  while (i < rawLyrics.length) {
    const ch = rawLyrics[i];
    if (ch === "[") {
      const closeIdx = rawLyrics.indexOf("]", i);
      const thisRaw = closeIdx !== -1 ? rawLyrics.slice(i, closeIdx + 1) : rawLyrics.slice(i);
      if (lastWasMarker) {
        throw new Error(
          `Multiple chord markers at the same position ("${lastMarkerRaw}${thisRaw}"): place each chord at its own syllable, gap, or line end.`,
        );
      }
      if (closeIdx === -1) {
        throw new Error(`Unclosed chord marker: "${rawLyrics.slice(i)}"`);
      }
      if (textBuf.length > 0) {
        tokens.push({ type: "text", text: textBuf });
        textBuf = "";
      }
      const markerContent = rawLyrics.slice(i + 1, closeIdx);
      if (markerContent.trim() === "") {
        throw new Error('Empty chord marker "[]" is not allowed');
      }

      let guitarChord = "";
      let bassChord = "";
      if (markerContent.includes("|")) {
        const parts = markerContent.split("|");
        if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
          throw new Error(
            `Invalid chord marker "[${markerContent}]": performance annotations are not chord markers. Use the line's "annotation" field instead.`,
          );
        }
        guitarChord = parts[0].trim();
        bassChord = parts[1].trim();
        if (!isValidChordToken(guitarChord) || !isValidChordToken(bassChord)) {
          throw new Error(
            `Invalid chord marker "[${markerContent}]": performance annotations are not chord markers. Use the line's "annotation" field instead.`,
          );
        }
      } else {
        guitarChord = markerContent.trim();
        if (!isValidChordToken(guitarChord)) {
          throw new Error(
            `Invalid chord marker "[${markerContent}]": performance annotations are not chord markers. Use the line's "annotation" field instead.`,
          );
        }
        if (mode === "dual-tier" && capo && capo > 0) {
          bassChord = transposeChord(guitarChord, capo, options?.preferSharps);
        } else {
          bassChord = guitarChord;
        }
      }

      tokens.push({ type: "marker", guitar: guitarChord, bass: bassChord });
      lastWasMarker = true;
      lastMarkerRaw = `[${markerContent}]`;
      i = closeIdx + 1;
    } else if (ch === "]") {
      throw new Error('Stray closing bracket "]" without matching opening bracket');
    } else {
      textBuf += ch;
      lastWasMarker = false;
      i++;
    }
  }

  if (textBuf.length > 0) {
    tokens.push({ type: "text", text: textBuf });
  }

  if (tokens.length === 0) {
    return [
      {
        lyrics: " ",
        guitarChords: " ",
        bassChords: mode === "dual-tier" ? " " : undefined,
        chords: " ",
        annotation,
      },
    ];
  }

  // 2. Group into Words and Syllables
  const words: Word[] = [];
  let curLeadingSpace = "";
  let curGapChords: MarkerChord[] = [];
  let curSyllables: Syllable[] = [];
  let curWordText = "";
  let pendingChord: MarkerChord | null = null;

  for (const tok of tokens) {
    if (tok.type === "marker") {
      const chord: MarkerChord = { guitar: tok.guitar!, bass: tok.bass! };
      if (curWordText.length > 0) {
        curSyllables.push({ text: curWordText, chord: pendingChord || undefined });
        pendingChord = null;
        curWordText = "";
      }
      pendingChord = chord;
    } else {
      const text = tok.text!;
      for (let c = 0; c < text.length; c++) {
        const char = text[c];
        if (/\s/.test(char)) {
          if (
            curWordText.length > 0 || curSyllables.length > 0 ||
            (words.length === 0 && pendingChord)
          ) {
            if (curWordText.length > 0 || (words.length === 0 && pendingChord)) {
              curSyllables.push({ text: curWordText, chord: pendingChord || undefined });
              pendingChord = null;
              curWordText = "";
            }
            words.push({
              leadingWhitespace: curLeadingSpace,
              gapChords: curGapChords,
              syllables: curSyllables,
              trailingChords: [],
            });
            curLeadingSpace = "";
            curGapChords = [];
            curSyllables = [];
          } else if (pendingChord) {
            curGapChords.push(pendingChord);
            pendingChord = null;
          }
          curLeadingSpace += char;
        } else {
          curWordText += char;
        }
      }
    }
  }

  if (curWordText.length > 0 || curSyllables.length > 0) {
    if (curWordText.length > 0) {
      curSyllables.push({ text: curWordText, chord: pendingChord || undefined });
      pendingChord = null;
      curWordText = "";
    }
    words.push({
      leadingWhitespace: curLeadingSpace,
      gapChords: curGapChords,
      syllables: curSyllables,
      trailingChords: [],
    });
    curLeadingSpace = "";
    curGapChords = [];
  }

  const trailing: MarkerChord[] = [...curGapChords];
  if (pendingChord) {
    trailing.push(pendingChord);
    pendingChord = null;
  }
  curGapChords = [];

  if (trailing.length > 0) {
    if (words.length === 0) {
      words.push({
        leadingWhitespace: curLeadingSpace,
        gapChords: [],
        syllables: [{ text: "", chord: trailing.shift() }],
        trailingChords: trailing,
      });
      curLeadingSpace = "";
    } else {
      words[words.length - 1].trailingChords.push(...trailing);
    }
  }

  // 3. Process each word: widen intra-word syllables with " - " and inter-word gaps
  const processedWords: ProcessedWord[] = [];
  let currentCol = 0;
  let lastChordCol = -1;
  let lastChordLen = 0;

  for (let w = 0; w < words.length; w++) {
    const word = words[w];
    let leadingWhitespace = word.leadingWhitespace;
    if (w > 0 && leadingWhitespace.length === 0) {
      leadingWhitespace = " ";
    }

    const placedGapChords: PlacedGapChord[] = [];

    // Handle gap chords (chords in the whitespace between words)
    if (word.gapChords.length > 0) {
      for (const gc of word.gapChords) {
        const chordLen = Math.max(gc.guitar.length, gc.bass.length);
        const minChordCol = lastChordCol !== -1 ? lastChordCol + lastChordLen + 1 : currentCol + 1;
        const targetChordCol = Math.max(minChordCol, currentCol + 1);

        const offsetInGap = targetChordCol - currentCol;
        placedGapChords.push({
          guitar: gc.guitar,
          bass: gc.bass,
          colOffset: offsetInGap,
        });

        lastChordCol = targetChordCol;
        lastChordLen = chordLen;
      }

      // Ensure leading whitespace extends past the last gap chord + 1 space
      const minWordCol = lastChordCol + lastChordLen + 1;
      const neededGapLen = minWordCol - currentCol;
      if (leadingWhitespace.length < neededGapLen) {
        leadingWhitespace = " ".repeat(neededGapLen);
      }
    }

    currentCol += leadingWhitespace.length;

    // Intra-word syllable widening
    let widenedText = "";
    const placedChords: PlacedChord[] = [];

    for (let s = 0; s < word.syllables.length; s++) {
      const syl = word.syllables[s];

      // If this is the first syllable of the word and it carries a chord:
      if (s === 0 && syl.chord) {
        if (lastChordCol !== -1) {
          const minCol = lastChordCol + lastChordLen + 1;
          if (currentCol < minCol) {
            const extraSpaces = minCol - currentCol;
            leadingWhitespace += " ".repeat(extraSpaces);
            currentCol = minCol;
          }
        }
      }

      const sylStartOffset = widenedText.length;
      if (syl.chord) {
        placedChords.push({
          guitar: syl.chord.guitar,
          bass: syl.chord.bass,
          colOffset: sylStartOffset,
        });
        const chordLen = Math.max(syl.chord.guitar.length, syl.chord.bass.length);
        lastChordCol = currentCol + sylStartOffset;
        lastChordLen = chordLen;
      }

      widenedText += syl.text;

      // Check if widening needed before next syllable in the same word
      if (s < word.syllables.length - 1 && syl.chord) {
        const chordLen = Math.max(syl.chord.guitar.length, syl.chord.bass.length);
        const minNextOffset = sylStartOffset + chordLen + 1;
        const currentOffset = widenedText.length;
        if (currentOffset < minNextOffset) {
          const gapNeeded = minNextOffset - currentOffset;
          let hyphenSplit = " - ";
          if (gapNeeded <= 3) {
            hyphenSplit = " - ";
          } else {
            const left = Math.floor((gapNeeded - 1) / 2);
            const right = gapNeeded - 1 - left;
            hyphenSplit = " ".repeat(left) + "-" + " ".repeat(right);
          }
          widenedText += hyphenSplit;
        }
      }
    }

    // Trailing chords attached after word text
    const placedTrailingChords: PlacedChord[] = [];
    if (word.trailingChords.length > 0) {
      let curTrailingOffset = widenedText.length;
      for (const tc of word.trailingChords) {
        const chordLen = Math.max(tc.guitar.length, tc.bass.length);
        const minCol = lastChordCol !== -1
          ? lastChordCol + lastChordLen + 1
          : currentCol + curTrailingOffset + 1;
        const targetCol = Math.max(minCol, currentCol + curTrailingOffset + 1);
        const offsetFromWordStart = targetCol - currentCol;

        placedTrailingChords.push({
          guitar: tc.guitar,
          bass: tc.bass,
          colOffset: offsetFromWordStart,
        });

        lastChordCol = targetCol;
        lastChordLen = chordLen;
        curTrailingOffset = offsetFromWordStart + chordLen;
      }
    }

    currentCol += widenedText.length;

    processedWords.push({
      leadingWhitespace,
      gapChords: placedGapChords,
      text: widenedText,
      chords: placedChords,
      trailingChords: placedTrailingChords,
      hasPunctuation: /[.,!?;:—\-]$/.test(widenedText.trim()),
    });
  }

  // 4. Line Re-breaking at about 75 characters preferring a gap after punctuation
  const renderedLines = breakWordsIntoLines(processedWords, maxLineWidth);
  if (annotation && renderedLines.length > 0) {
    renderedLines[0].annotation = annotation;
  }
  return renderedLines;
}

/**
 * Renders a contiguous sub-slice of ProcessedWords into a single RenderedLine.
 */
function renderSubline(
  words: ProcessedWord[],
  startIdx: number,
  endIdx: number,
): RenderedLine {
  let lyricLine = "";
  let guitarLine = "";
  let bassLine = "";

  const setChordAt = (str: string, chord: string, col: number): string => {
    const chars = str.split("");
    while (chars.length < col) chars.push(" ");
    for (let c = 0; c < chord.length; c++) {
      chars[col + c] = chord[c];
    }
    return chars.join("");
  };

  let col = 0;
  for (let w = startIdx; w < endIdx; w++) {
    const word = words[w];
    if (w > startIdx) {
      for (const gc of word.gapChords) {
        guitarLine = setChordAt(guitarLine, gc.guitar, col + gc.colOffset);
        bassLine = setChordAt(bassLine, gc.bass, col + gc.colOffset);
      }
      lyricLine += word.leadingWhitespace;
      col += word.leadingWhitespace.length;
    } else {
      for (const gc of word.gapChords) {
        guitarLine = setChordAt(guitarLine, gc.guitar, gc.colOffset);
        bassLine = setChordAt(bassLine, gc.bass, gc.colOffset);
      }
    }

    const wordStartCol = col;
    for (const ch of word.chords) {
      guitarLine = setChordAt(guitarLine, ch.guitar, wordStartCol + ch.colOffset);
      bassLine = setChordAt(bassLine, ch.bass, wordStartCol + ch.colOffset);
    }
    lyricLine += word.text;
    col += word.text.length;

    if (w === words.length - 1 && word.trailingChords.length > 0) {
      for (const tc of word.trailingChords) {
        guitarLine = setChordAt(guitarLine, tc.guitar, wordStartCol + tc.colOffset);
        bassLine = setChordAt(bassLine, tc.bass, wordStartCol + tc.colOffset);
      }
    }
  }

  return {
    lyrics: lyricLine,
    guitarChords: guitarLine.trimEnd(),
    bassChords: bassLine.trimEnd(),
    chords: guitarLine.trimEnd(),
  };
}

/**
 * Breaks processed words into multiple lines when total width exceeds maxLineWidth (75 characters),
 * preferring breaks at gaps after punctuation and keeping each chord on its syllable.
 */
function breakWordsIntoLines(
  words: ProcessedWord[],
  maxLineWidth: number,
): RenderedLine[] {
  if (words.length === 0) {
    return [{ lyrics: "", guitarChords: "", bassChords: "", chords: "" }];
  }

  const lines: RenderedLine[] = [];
  let startIdx = 0;

  while (startIdx < words.length) {
    const fullRest = renderSubline(words, startIdx, words.length);
    const restWidth = Math.max(
      fullRest.lyrics.trimEnd().length,
      fullRest.guitarChords.trimEnd().length,
      fullRest.bassChords?.trimEnd().length || 0,
    );

    if (restWidth <= maxLineWidth || startIdx === words.length - 1) {
      lines.push(fullRest);
      break;
    }

    let bestFittingIdx = -1;
    let bestPunctuationIdx = -1;

    for (let endIdx = startIdx + 1; endIdx < words.length; endIdx++) {
      const cand = renderSubline(words, startIdx, endIdx);
      const candWidth = Math.max(
        cand.lyrics.trimEnd().length,
        cand.guitarChords.trimEnd().length,
        cand.bassChords?.trimEnd().length || 0,
      );

      if (candWidth <= maxLineWidth) {
        bestFittingIdx = endIdx;
        if (words[endIdx - 1].hasPunctuation) {
          bestPunctuationIdx = endIdx;
        }
      }
    }

    const breakIdx = bestPunctuationIdx !== -1
      ? bestPunctuationIdx
      : (bestFittingIdx !== -1 ? bestFittingIdx : startIdx + 1);

    const sub = renderSubline(words, startIdx, breakIdx);
    lines.push(sub);
    startIdx = breakIdx;
  }

  return lines;
}

/**
 * Builds paragraph blocks for a rendered line item.
 */
export function buildRenderedLineParagraphs(
  rend: RenderedLine,
  isDualTier: boolean,
  annotation?: string,
): Paragraph[] {
  const paras: Paragraph[] = [];
  const annotText = annotation || rend.annotation;
  const hasAnnotation = Boolean(annotText);

  if (isDualTier) {
    // Line 1: Guitar Capo Chords (Bold) + optional annotation
    const guitarRuns: TextRun[] = [
      new TextRun({
        text: rend.guitarChords || " ",
        bold: true,
        size: CHORD_SIZE,
        font: FONT_FAMILY,
      }),
    ];
    if (hasAnnotation) {
      guitarRuns.push(
        new TextRun({
          text: `  ${annotText}`,
          italics: true,
          size: ANNOTATION_SIZE,
          font: FONT_FAMILY,
        }),
      );
    }

    paras.push(
      new Paragraph({
        children: guitarRuns,
        keepNext: true,
        keepLines: true,
        spacing: { line: 240, before: 0, after: 0 },
      }),
    );

    // Line 2: Bass No-Capo Chords (Italic)
    paras.push(
      new Paragraph({
        children: [
          new TextRun({
            text: rend.bassChords || rend.guitarChords || " ",
            italics: true,
            size: CHORD_SIZE,
            font: FONT_FAMILY,
          }),
        ],
        keepNext: true,
        keepLines: true,
        spacing: { line: 240, before: 0, after: 0 },
      }),
    );

    // Line 3: Lyrics (Regular) - 1 full line space after (200 dxa)
    paras.push(
      new Paragraph({
        children: [
          new TextRun({
            text: rend.lyrics || " ",
            size: LYRIC_SIZE,
            font: FONT_FAMILY,
          }),
        ],
        keepLines: true,
        spacing: { line: 240, before: 0, after: 200 },
      }),
    );
  } else {
    // Single-Tier: Line 1 = Chords (Bold) + optional annotation
    const chordRuns: TextRun[] = [
      new TextRun({
        text: rend.chords || rend.guitarChords || " ",
        bold: true,
        size: CHORD_SIZE,
        font: FONT_FAMILY,
      }),
    ];
    if (hasAnnotation) {
      chordRuns.push(
        new TextRun({
          text: `  ${annotText}`,
          italics: true,
          size: ANNOTATION_SIZE,
          font: FONT_FAMILY,
        }),
      );
    }

    paras.push(
      new Paragraph({
        children: chordRuns,
        keepNext: true,
        keepLines: true,
        spacing: { line: 240, before: 0, after: 0 },
      }),
    );

    // Line 2: Lyrics (Regular) - 1 full line space after (200 dxa)
    paras.push(
      new Paragraph({
        children: [
          new TextRun({
            text: rend.lyrics || " ",
            size: LYRIC_SIZE,
            font: FONT_FAMILY,
          }),
        ],
        keepLines: true,
        spacing: { line: 240, before: 0, after: 200 },
      }),
    );
  }

  return paras;
}

/**
 * Builds the paragraph block for a single chord/lyric line.
 */
export function buildLineParagraphs(
  line: ChordLyricLine,
  isDualTier: boolean,
  capo?: number,
  preferSharps?: boolean,
): Paragraph[] {
  const renderedLines = parseAndLayoutLine(line, {
    mode: isDualTier ? "dual-tier" : "single-tier",
    capo: capo,
    preferSharps,
  });

  const paras: Paragraph[] = [];
  for (let r = 0; r < renderedLines.length; r++) {
    const rend = renderedLines[r];
    const annot = r === 0 ? line.annotation : undefined;
    paras.push(...buildRenderedLineParagraphs(rend, isDualTier, annot));
  }
  return paras;
}

/**
 * Builds a Word Document instance from a structured SongDefinition.
 */
export function buildSongDocument(
  songInput: SongDefinition,
  customProperties: ReadonlyArray<{ name: string; value: string }> = [],
): Document {
  validateSongDefinition(songInput);
  const song = autoTransposeSong(songInput);
  const isDualTier = song.metadata.mode === "dual-tier";
  const capo = song.metadata.capo;
  const preferSharps = capo ? soundingPrefersSharps(song, capo) : undefined;

  const children: Paragraph[] = [];

  // 1. Song Title & Composer / Author (on the same line)
  const titleRuns: TextRun[] = [
    new TextRun({
      text: song.metadata.title,
      bold: true,
      size: TITLE_SIZE,
      font: FONT_FAMILY,
    }),
  ];

  if (song.metadata.composer || song.metadata.copyright) {
    const creditText = [song.metadata.composer, song.metadata.copyright]
      .filter(Boolean)
      .join(" | ");
    titleRuns.push(
      new TextRun({
        text: `   (${creditText})`,
        italics: true,
        size: HEADER_SIZE,
        font: FONT_FAMILY,
      }),
    );
  }

  children.push(
    new Paragraph({
      children: titleRuns,
      spacing: { line: 280, before: 60, after: 20 },
    }),
  );

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
      spacing: { line: 220, before: 0, after: 40 },
    }),
  );

  // 4. Song Sections
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
        keepNext: true,
        keepLines: true,
        spacing: { line: 220, before: 60, after: 0 },
      }),
    );

    // Section Lines
    for (const line of section.lines) {
      const lineParagraphs = buildLineParagraphs(line, isDualTier, capo, preferSharps);
      children.push(...lineParagraphs);
    }
  }

  const doc = new Document({
    customProperties,
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
 * Generates a binary Uint8Array buffer for the given SongDefinition.
 */
export async function generateSongDocxBuffer(song: SongDefinition): Promise<Uint8Array> {
  const doc = buildSongDocument(song);
  const nodeBuffer = await Packer.toBuffer(doc);
  return new Uint8Array(nodeBuffer.buffer, nodeBuffer.byteOffset, nodeBuffer.byteLength);
}
