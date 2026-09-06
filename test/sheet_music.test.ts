// test/sheet_music.test.ts
// Unit tests for sheet music transcription, harmonic transposition, and docx generation (web-jam-tools#770, web-jam-tools#771).

import { assertEquals, assertGreater } from "@std/assert";
import {
  autoTransposeSong,
  transposeChord,
  transposeChordLine,
  transposeNote,
} from "../src/sheet-music/transpose.ts";
import { buildSongDocument, generateSongDocxBuffer } from "../src/sheet-music/builder.ts";
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
