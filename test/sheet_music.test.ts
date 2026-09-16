// test/sheet_music.test.ts
// Unit tests for sheet music transcription, harmonic transposition, and docx generation (web-jam-tools#770, web-jam-tools#771).

import { assertEquals, assertGreater, assertThrows } from "@std/assert";
import {
  autoTransposeSong,
  transposeChord,
  transposeChordLine,
  transposeNote,
} from "../src/sheet-music/transpose.ts";
import {
  buildSongDocument,
  generateSongDocxBuffer,
  isValidChordToken,
  parseAndLayoutLine,
  validateSongDefinition,
} from "../src/sheet-music/builder.ts";
import { runCli } from "../src/sheet-music/generate_docx.ts";
import type { SongDefinition } from "../src/sheet-music/types.ts";

Deno.test("transposeNote transposes standard notes across octaves", () => {
  assertEquals(transposeNote("C", 2), "D");
  assertEquals(transposeNote("E", 2), "F#");
  assertEquals(transposeNote("D", 2), "E");
  assertEquals(transposeNote("A", 2), "B");
  assertEquals(transposeNote("B", 1), "C");
  assertEquals(transposeNote("G", 5), "C");
  assertEquals(transposeNote("Bb", 2, false), "C");
  assertEquals(transposeNote("Invalid", 2), "Invalid");
});

Deno.test("transposeChord handles roots, qualities, and slash chords", () => {
  // Simple triads
  assertEquals(transposeChord("E", 2), "F#");
  assertEquals(transposeChord("D", 2), "E");
  assertEquals(transposeChord("A", 2), "B");
  assertEquals(transposeChord("G", 2), "A");

  // Minor chords
  assertEquals(transposeChord("Bm", 2), "C#m");
  assertEquals(transposeChord("Em", 2), "F#m");
  assertEquals(transposeChord("Am", 3), "Cm");

  // 7th, sus, and extended chords
  assertEquals(transposeChord("G7", 2), "A7");
  assertEquals(transposeChord("Dsus4", 2), "Esus4");
  assertEquals(transposeChord("Aadd9", 2), "Badd9");
  assertEquals(transposeChord("Cmaj7", 2), "Dmaj7");

  // Slash chords
  assertEquals(transposeChord("D/F#", 2), "E/G#");
  assertEquals(transposeChord("C/E", 2), "D/F#");
  assertEquals(transposeChord("G/B", 2), "A/C#");

  // Empty string
  assertEquals(transposeChord("", 2), "");
});

Deno.test("transposeChordLine preserves exact character starting column alignment", () => {
  const inputLine = "E               D   A";
  const expected = "F#              E   B";
  const actual = transposeChordLine(inputLine, 2);
  assertEquals(actual, expected);

  const slashLine = "D/F#    G       A";
  const expectedSlash = "E/G#    A       B";
  const actualSlash = transposeChordLine(slashLine, 2);
  assertEquals(actualSlash, expectedSlash);

  assertEquals(transposeChordLine("", 2), "");
  assertEquals(transposeChordLine("E   D", 0), "E   D");
});

Deno.test("autoTransposeSong populates bass chords and keys for dual-tier capo songs", () => {
  const song: SongDefinition = {
    metadata: {
      title: "Test Song",
      capo: 2,
      guitarKey: "E",
      mode: "dual-tier",
    },
    sections: [
      {
        title: "Chorus",
        lines: [
          {
            guitarChords: "E               D   A",
            lyrics: "I'll meet you there in the narthex",
          },
        ],
      },
    ],
  };

  const transposed = autoTransposeSong(song);
  assertEquals(transposed.metadata.bassKey, "F#");
  assertEquals(transposed.sections[0].lines[0].bassChords, "F#              E   B");
});

Deno.test("buildSongDocument & generateSongDocxBuffer produce valid docx for dual-tier songs", async () => {
  const song: SongDefinition = {
    metadata: {
      title: "NARTHEX",
      composer: "Jonathan Rundman (2003)",
      capo: 2,
      guitarKey: "E",
      mode: "dual-tier",
      performanceNotes: ["Guitar Capo 2, Bass No Capo"],
    },
    sections: [
      {
        title: "Verse 1",
        lines: [
          {
            guitarChords: "E       D       A       E",
            lyrics: "Shadows are long in the parking lot",
          },
        ],
      },
      {
        title: "Chorus",
        lines: [
          {
            guitarChords: "E               D   A",
            lyrics: "I'll meet you there in the narthex",
            annotation: "[soft]",
          },
        ],
      },
    ],
  };

  const doc = buildSongDocument(song);
  assertEquals(doc !== null, true);

  const buffer = await generateSongDocxBuffer(song);
  assertGreater(buffer.byteLength, 1000);
});

Deno.test("buildSongDocument & generateSongDocxBuffer produce valid docx for single-tier songs", async () => {
  const song: SongDefinition = {
    metadata: {
      title: "AMAZING GRACE",
      composer: "John Newton",
      guitarKey: "G",
      mode: "single-tier",
    },
    sections: [
      {
        title: "Verse 1",
        lines: [
          {
            chords: "G               C       G",
            lyrics: "Amazing grace how sweet the sound",
          },
        ],
      },
    ],
  };

  const buffer = await generateSongDocxBuffer(song);
  assertGreater(buffer.byteLength, 1000);
});

Deno.test("generate_docx CLI runs with --json and generates output file", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".docx" });
  const songJson = JSON.stringify({
    metadata: {
      title: "CLI Test Song",
      capo: 2,
    },
    sections: [
      {
        title: "Verse 1",
        lines: [
          {
            guitarChords: "E       D",
            lyrics: "Test lyrics line",
          },
        ],
      },
    ],
  });

  const exitCode = await runCli(["--json", songJson, "--output", tmpFile]);
  assertEquals(exitCode, 0);

  const fileInfo = await Deno.stat(tmpFile);
  assertGreater(fileInfo.size, 1000);

  await Deno.remove(tmpFile);
});

Deno.test("generate_docx CLI shows help or handles errors on invalid input", async () => {
  const helpCode = await runCli(["--help"]);
  assertEquals(helpCode, 0);

  const badCode = await runCli(["--input", "/non/existent/path/song.json"]);
  assertEquals(badCode, 1);

  const badJsonCode = await runCli(["--json", "{ invalid json"]);
  assertEquals(badJsonCode, 1);

  const missingTitleCode = await runCli(["--json", JSON.stringify({ metadata: {} })]);
  assertEquals(missingTitleCode, 1);
});

Deno.test("generate_docx CLI auto-computes destination from input file path and json", async () => {
  const tmpJson = await Deno.makeTempFile({ suffix: ".json" });
  const songJson = JSON.stringify({
    metadata: {
      title: "File Auto Dest Song",
      guitarKey: "C",
    },
    sections: [
      {
        title: "Verse 1",
        lines: [{ lyrics: "Hello world" }],
      },
    ],
  });
  await Deno.writeTextFile(tmpJson, songJson);

  const expectedDocx = tmpJson.replace(/\.json$/, ".docx");
  const exitCode = await runCli(["--input", tmpJson]);
  assertEquals(exitCode, 0);

  const stat = await Deno.stat(expectedDocx);
  assertGreater(stat.size, 500);

  await Deno.remove(tmpJson);
  await Deno.remove(expectedDocx);
});

Deno.test("buildSongDocument supports custom legend and tempo details", async () => {
  const song: SongDefinition = {
    metadata: {
      title: "CUSTOM LEGEND SONG",
      composer: "Artist",
      copyright: "2026",
      tempo: "Bright 140",
      guitarKey: "D",
      bassKey: "E",
      legend: "Custom Instrument Setup",
    },
    sections: [
      {
        title: "Intro",
        lines: [
          {
            chords: "D   A",
            lyrics: "Instrumental",
          },
        ],
      },
    ],
  };

  const buffer = await generateSongDocxBuffer(song);
  assertGreater(buffer.byteLength, 1000);
});

// web-jam-tools#1010: Syllable marker parsing, chord column calculation, lyric widening, word splitting, and validation

Deno.test("Criterion 1 & Check 2: re[C/E]member computes C/E column equal to m in member", () => {
  const result = parseAndLayoutLine("re[C/E]member");
  assertEquals(result.length, 1);
  assertEquals(result[0].lyrics, "remember");
  assertEquals(result[0].guitarChords, "  C/E");

  const mCol = result[0].lyrics.indexOf("member");
  const chordCol = result[0].guitarChords.indexOf("C/E");
  assertEquals(chordCol, mCol);
});

Deno.test("Criterion 2: [C/D]O[D]ceans rise, widens with ' - ' word splitting", () => {
  const result = parseAndLayoutLine("[C/D]O[D]ceans rise,");
  assertEquals(result.length, 1);
  assertEquals(result[0].guitarChords, "C/D D");
  assertEquals(result[0].lyrics, "O - ceans rise,");
});

Deno.test("Criterion 3: love's [G/F] not positions G/F in the gap between words", () => {
  const result = parseAndLayoutLine("love's [G/F] not");
  assertEquals(result.length, 1);
  assertEquals(result[0].lyrics, "love's     not");
  assertEquals(result[0].guitarChords, "       G/F");

  const lovesEnd = result[0].lyrics.indexOf("love's") + "love's".length;
  const notStart = result[0].lyrics.indexOf("not");
  const chordStart = result[0].guitarChords.indexOf("G/F");
  const chordEnd = chordStart + "G/F".length;

  assertEquals(chordStart >= lovesEnd, true);
  assertEquals(chordEnd <= notStart, true);
});

Deno.test("Criterion 4: willing to pay. [Am7] [C/D] positions both chords after pay.", () => {
  const result = parseAndLayoutLine("willing to pay. [Am7] [C/D]");
  assertEquals(result.length, 1);
  assertEquals(result[0].lyrics, "willing to pay.");

  const payEnd = result[0].lyrics.indexOf("pay.") + "pay.".length;
  const am7Start = result[0].guitarChords.indexOf("Am7");
  const cdStart = result[0].guitarChords.indexOf("C/D");

  assertEquals(am7Start > payEnd, true);
  assertEquals(cdStart > am7Start + "Am7".length, true);
});

Deno.test("Criterion 5: [Am7b5]dat [Cm/D]da [D]ya-da! widens word spaces", () => {
  const result = parseAndLayoutLine("[Am7b5]dat [Cm/D]da [D]ya-da!");
  assertEquals(result.length, 1);
  assertEquals(result[0].guitarChords, "Am7b5 Cm/D D");
  assertEquals(result[0].lyrics, "dat   da   ya-da!");
});

Deno.test("Criterion 6: Dual-tier [G|A]You say positions guitar G bold and bass A italic in same column", () => {
  const result = parseAndLayoutLine("[G|A]You say", { mode: "dual-tier" });
  assertEquals(result.length, 1);
  assertEquals(result[0].guitarChords, "G");
  assertEquals(result[0].bassChords, "A");
  assertEquals(result[0].lyrics, "You say");
  assertEquals(result[0].guitarChords.indexOf("G"), 0);
  assertEquals(result[0].bassChords?.indexOf("A"), 0);
});

Deno.test("Criterion 7: Dual-tier capo 2, [G]You say transposes bass to A", () => {
  const result = parseAndLayoutLine("[G]You say", { mode: "dual-tier", capo: 2 });
  assertEquals(result.length, 1);
  assertEquals(result[0].guitarChords, "G");
  assertEquals(result[0].bassChords, "A");
  assertEquals(result[0].lyrics, "You say");
});

Deno.test("Criterion 8: Dual-tier capo 2, [D/F#] transposes bass to E/G# and reserves longer chord space", () => {
  const result = parseAndLayoutLine("[D/F#]", { mode: "dual-tier", capo: 2 });
  assertEquals(result.length, 1);
  assertEquals(result[0].guitarChords, "D/F#");
  assertEquals(result[0].bassChords, "E/G#");

  const multiResult = parseAndLayoutLine("[D/F#] [G]", { mode: "dual-tier", capo: 2 });
  assertEquals(multiResult.length, 1);
  assertEquals(multiResult[0].guitarChords, "D/F# G");
  assertEquals(multiResult[0].bassChords, "E/G# A");
  // D/F# length is 4, space is 1, G is at index 5
  assertEquals(multiResult[0].guitarChords.indexOf("G"), 5);
  assertEquals(multiResult[0].bassChords?.indexOf("A"), 5);
});

Deno.test("Criterion 9: Chord names [C(add2)], [D9sus], [Cmaj7/E], [Am7b5], [Cm/Eb] parse successfully", () => {
  const chords = ["[C(add2)]", "[D9sus]", "[Cmaj7/E]", "[Am7b5]", "[Cm/Eb]"];
  const expected = ["C(add2)", "D9sus", "Cmaj7/E", "Am7b5", "Cm/Eb"];
  for (let i = 0; i < chords.length; i++) {
    assertEquals(isValidChordToken(expected[i]), true);
    const res = parseAndLayoutLine(chords[i]);
    assertEquals(res.length, 1);
    assertEquals(res[0].guitarChords, expected[i]);
  }
});

Deno.test("Criterion 10: Rendered line wider than 75 characters re-breaks preferring punctuation and keeps chords on syllables", () => {
  const longLine =
    "[G]Every valley [D]shall be exalted, [C]and every mountain [G]and hill made [D]low; [C]the crooked straight,";
  const result = parseAndLayoutLine(longLine);
  assertEquals(result.length, 2);

  // Line 1 should break at the semicolon after "low;"
  assertEquals(
    result[0].lyrics,
    "Every valley shall be exalted, and every mountain and hill made low;",
  );
  assertEquals(
    result[0].guitarChords,
    "G            D                 C                  G             D",
  );
  assertEquals(result[0].lyrics.length <= 75, true);

  // Line 2 starts with "the crooked straight," and chord C is on "the"
  assertEquals(result[1].lyrics, "the crooked straight,");
  assertEquals(result[1].guitarChords, "C");
  assertEquals(result[1].guitarChords.indexOf("C"), result[1].lyrics.indexOf("the"));

  // Without punctuation, it re-breaks at the last fitting word gap
  const longLineNoPunct =
    "[G]Every valley [D]shall be exalted [C]and every mountain [G]and hill made [D]low [C]the crooked straight";
  const resultNoPunct = parseAndLayoutLine(longLineNoPunct);
  assertEquals(resultNoPunct.length, 2);
  assertEquals(resultNoPunct[0].lyrics.length <= 75, true);
});

Deno.test("Criterion 11: Guard outcome valid — all valid inputs parse and lay out in full document", async () => {
  const song: SongDefinition = {
    metadata: {
      title: "Valid Lead Sheet Test",
      capo: 2,
      guitarKey: "D",
      mode: "dual-tier",
    },
    sections: [
      {
        title: "Verse",
        lines: [
          { lyrics: "re[C/E]member" },
          { lyrics: "[C/D]O[D]ceans rise," },
          { lyrics: "love's [G/F] not" },
          { lyrics: "willing to pay. [Am7] [C/D]" },
          { lyrics: "[Am7b5]dat [Cm/D]da [D]ya-da!" },
          { lyrics: "[G|A]You say" },
          { lyrics: "[D/F#]" },
          { lyrics: "[C(add2)] [D9sus] [Cmaj7/E]" },
        ],
      },
    ],
  };

  const doc = buildSongDocument(song);
  assertEquals(doc !== null, true);
  const buf = await generateSongDocxBuffer(song);
  assertGreater(buf.byteLength, 1000);
});

Deno.test("Criterion 12: Guard outcome invalid — performance annotations and malformed brackets rejected with named errors", () => {
  // Performance annotations inside lyric text rejected with error naming annotation field
  assertThrows(
    () => parseAndLayoutLine("[Everybody!]"),
    Error,
    'Invalid chord marker "[Everybody!]": performance annotations are not chord markers. Use the line\'s "annotation" field instead.',
  );
  assertThrows(
    () => parseAndLayoutLine("hold [hold] on"),
    Error,
    'Invalid chord marker "[hold]": performance annotations are not chord markers. Use the line\'s "annotation" field instead.',
  );

  // Empty marker []
  assertThrows(
    () => parseAndLayoutLine("empty []"),
    Error,
    'Empty chord marker "[]" is not allowed',
  );

  // Unclosed [G
  assertThrows(
    () => parseAndLayoutLine("unclosed [G"),
    Error,
    'Unclosed chord marker: "[G"',
  );

  // Stray close G]
  assertThrows(
    () => parseAndLayoutLine("stray G]"),
    Error,
    'Stray closing bracket "]" without matching opening bracket',
  );

  // Multiple markers at same position [G][C]word
  assertThrows(
    () => parseAndLayoutLine("[G][C]word"),
    Error,
    'Multiple chord markers at the same position ("[G][C]"): place each chord at its own syllable, gap, or line end.',
  );
});

Deno.test("Criterion 13: Guard outcome undeterminable — non-string lyric field refused with clear line identification", () => {
  assertThrows(
    () =>
      validateSongDefinition({
        metadata: { title: "Bad Song" },
        sections: [
          {
            title: "Verse 1",
            lines: [{ lyrics: 12345 }],
          },
        ],
      }),
    Error,
    'Section "Verse 1", line 1: "lyrics" field must be a string, got number',
  );

  assertThrows(
    () =>
      validateSongDefinition({
        metadata: { title: "Bad Song 2" },
        sections: [
          {
            title: "Chorus",
            lines: [
              { lyrics: "valid line" },
              { lyrics: null },
            ],
          },
        ],
      }),
    Error,
    'Section "Chorus", line 2: "lyrics" field must be a string, got object',
  );

  assertThrows(
    () =>
      validateSongDefinition({
        metadata: { title: "Missing Lyrics Field" },
        sections: [
          {
            title: "Bridge",
            lines: [{}],
          },
        ],
      }),
    Error,
    'Section "Bridge", line 1: "lyrics" field must be a string, got undefined',
  );
});
