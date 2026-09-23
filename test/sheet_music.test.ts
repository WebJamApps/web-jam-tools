// test/sheet_music.test.ts
// Unit tests for sheet music transcription, harmonic transposition, and docx generation (web-jam-tools#770, web-jam-tools#771).

import { assert, assertEquals, assertGreater, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { Packer } from "docx";
import {
  autoTransposeSong,
  keyPrefersSharps,
  songGuitarKey,
  soundingPrefersSharps,
  transposeChord,
  transposeChordLine,
  transposeKey,
  transposeNote,
} from "../src/sheet-music/transpose.ts";
import {
  buildSongDocument,
  generateSongDocxBuffer,
  isValidChordToken,
  parseAndLayoutLine,
  validateSongDefinition,
} from "../src/sheet-music/builder.ts";
import {
  findNextAvailablePath,
  generateFingerprintedDocx,
  inspectExistingDocx,
  parseCustomProperties,
  readDocxEntries,
  runCli,
  writeSongDocx,
} from "../src/sheet-music/generate_docx.ts";
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
  await Deno.remove(tmpFile);
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

const sampleSong: SongDefinition = {
  metadata: {
    title: "PROTECTED LEAD SHEET",
    composer: "Composer Name",
    guitarKey: "G",
    mode: "single-tier",
  },
  sections: [
    {
      title: "Verse 1",
      lines: [
        {
          chords: "G       C       G",
          lyrics: "First lyric line for testing",
        },
      ],
    },
  ],
};

Deno.test("generateFingerprintedDocx produces stamped docx buffer with valid fingerprint", async () => {
  const { buffer, fingerprint } = await generateFingerprintedDocx(sampleSong);
  assertGreater(buffer.byteLength, 1000);
  assertEquals(typeof fingerprint, "string");
  assertEquals(fingerprint.length, 64);

  const entries = await readDocxEntries(buffer);
  assert(entries.docXml !== undefined);
  assert(entries.customXml !== undefined);
  const customProps = parseCustomProperties(new TextDecoder().decode(entries.customXml));
  assertEquals(customProps.get("sheetMusicGenerator"), "web-jam-tools");
  assertEquals(customProps.get("sheetMusicFingerprint"), fingerprint);
});

Deno.test("Guard outcome 1: output path absent -> file is written with generator and fingerprint properties", async () => {
  const tempDir = await Deno.makeTempDir();
  const destPath = path.join(tempDir, "Absent Song.docx");

  const result = await writeSongDocx(sampleSong, destPath);
  assertEquals(result.action, "created");
  assertEquals(result.actualPath, destPath);
  assertGreater(result.bytesWritten, 1000);

  const inspection = await inspectExistingDocx(destPath);
  assertEquals(inspection.status, "can_replace");
  assertEquals(inspection.generator, "web-jam-tools");
  assertEquals(typeof inspection.fingerprint, "string");
  assertEquals(inspection.fingerprint!.length, 64);
  assertEquals(inspection.fingerprint, inspection.currentSha256);

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("Guard outcome 2: existing file carries tag and matching fingerprint -> replaced in place", async () => {
  const tempDir = await Deno.makeTempDir();
  const destPath = path.join(tempDir, "Replaceable Song.docx");

  const res1 = await writeSongDocx(sampleSong, destPath);
  assertEquals(res1.action, "created");

  const updatedSong: SongDefinition = {
    ...sampleSong,
    sections: [
      {
        title: "Verse 1",
        lines: [
          {
            chords: "G       D       G",
            lyrics: "Updated lyric line for in-place replacement",
          },
        ],
      },
    ],
  };

  const res2 = await writeSongDocx(updatedSong, destPath);
  assertEquals(res2.action, "replaced");
  assertEquals(res2.actualPath, destPath);

  // Assert no (2) file was created
  const candidate2 = path.join(tempDir, "Replaceable Song (2).docx");
  let candidate2Exists = true;
  try {
    await Deno.stat(candidate2);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      candidate2Exists = false;
    }
  }
  assertEquals(candidate2Exists, false);

  const inspection2 = await inspectExistingDocx(destPath);
  assertEquals(inspection2.status, "can_replace");
  assertEquals(inspection2.fingerprint, res2.fingerprint);

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("Guard outcome 3: existing file carries tag but fingerprint mismatch -> left untouched, (2) written and reported", async () => {
  const tempDir = await Deno.makeTempDir();
  const destPath = path.join(tempDir, "Hand Edited Song.docx");

  // Build document with generator tag but an outdated/mismatched fingerprint
  const doc = buildSongDocument(sampleSong);
  const cp = (doc as unknown as {
    customProperties?: { addCustomProperty: (p: { name: string; value: string }) => void };
  }).customProperties;
  cp?.addCustomProperty({ name: "sheetMusicGenerator", value: "web-jam-tools" });
  cp?.addCustomProperty({
    name: "sheetMusicFingerprint",
    value: "0000000000000000000000000000000000000000000000000000000000000000",
  });
  const nodeBuf = await Packer.toBuffer(doc);
  const initialBytes = new Uint8Array(nodeBuf.buffer, nodeBuf.byteOffset, nodeBuf.byteLength);
  await Deno.writeFile(destPath, initialBytes);

  const result = await writeSongDocx(sampleSong, destPath);
  assertEquals(result.action, "protected_modified");
  const expectedPath = path.join(tempDir, "Hand Edited Song (2).docx");
  assertEquals(result.actualPath, expectedPath);

  // Assert original file is completely untouched
  const destBytesAfter = await Deno.readFile(destPath);
  assertEquals(destBytesAfter, initialBytes);

  // Assert new file exists and is fingerprinted
  const statNew = await Deno.stat(expectedPath);
  assertGreater(statNew.size, 1000);

  // Assert report mentions refusal and target path
  assert(result.message.includes("Refusing to overwrite hand-edited file"));
  assert(result.message.includes(expectedPath));

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("Guard outcome 4: existing file is untagged -> left untouched, (2) used and reported", async () => {
  const tempDir = await Deno.makeTempDir();
  const destPath = path.join(tempDir, "Untagged Song.docx");

  // Build untagged docx
  const untaggedBytes = await generateSongDocxBuffer(sampleSong);
  await Deno.writeFile(destPath, untaggedBytes);

  const result = await writeSongDocx(sampleSong, destPath);
  assertEquals(result.action, "protected_untagged");
  const expectedPath = path.join(tempDir, "Untagged Song (2).docx");
  assertEquals(result.actualPath, expectedPath);

  // Original file untouched
  const destBytesAfter = await Deno.readFile(destPath);
  assertEquals(destBytesAfter, untaggedBytes);

  assert(result.message.includes("Refusing to overwrite untagged file"));
  assert(result.message.includes(expectedPath));

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("Guard outcome 5: (2) already taken -> (3) used", async () => {
  const tempDir = await Deno.makeTempDir();
  const destPath = path.join(tempDir, "Collision Song.docx");
  const path2 = path.join(tempDir, "Collision Song (2).docx");

  const dummyBytes = await generateSongDocxBuffer(sampleSong);
  await Deno.writeFile(destPath, dummyBytes);
  await Deno.writeFile(path2, dummyBytes);

  const result = await writeSongDocx(sampleSong, destPath);
  const expectedPath = path.join(tempDir, "Collision Song (3).docx");
  assertEquals(result.actualPath, expectedPath);

  const stat3 = await Deno.stat(expectedPath);
  assertGreater(stat3.size, 1000);

  // Assert destPath and (2) untouched
  assertEquals(await Deno.readFile(destPath), dummyBytes);
  assertEquals(await Deno.readFile(path2), dummyBytes);

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("Guard outcome 6: condition undeterminable -> left untouched, (2) used and distinct read failure reported", async () => {
  const tempDir = await Deno.makeTempDir();
  const destPath = path.join(tempDir, "Corrupted Song.docx");
  const corruptContent = new TextEncoder().encode("This is not a valid zip archive");
  await Deno.writeFile(destPath, corruptContent);

  const result = await writeSongDocx(sampleSong, destPath);
  assertEquals(result.action, "protected_unreadable");
  const expectedPath = path.join(tempDir, "Corrupted Song (2).docx");
  assertEquals(result.actualPath, expectedPath);

  // Assert original file content is untouched
  assertEquals(await Deno.readFile(destPath), corruptContent);

  // Assert read failure is reported distinctly
  assert(result.message.includes("Unable to read existing file"));
  assert(!result.message.includes("Protected untagged file"));

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("generate_docx CLI re-run against same output path replaces file in place without (2)", async () => {
  const tempDir = await Deno.makeTempDir();
  const outDocx = path.join(tempDir, "Cli Song.docx");
  const songJson = JSON.stringify(sampleSong);

  // First CLI run generates initial file
  const code1 = await runCli(["--json", songJson, "--output", outDocx]);
  assertEquals(code1, 0);

  const stat1 = await Deno.stat(outDocx);
  assertGreater(stat1.size, 1000);

  // Second CLI run with identical song against same path replaces in place
  const code2 = await runCli(["--json", songJson, "--output", outDocx]);
  assertEquals(code2, 0);

  // (2) file must NOT exist
  const candidate2 = path.join(tempDir, "Cli Song (2).docx");
  let candidate2Exists = true;
  try {
    await Deno.stat(candidate2);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      candidate2Exists = false;
    }
  }
  assertEquals(candidate2Exists, false);

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("findNextAvailablePath increments sequentially from plain or numbered names", async () => {
  const tempDir = await Deno.makeTempDir();
  const file1 = path.join(tempDir, "Song.docx");
  await Deno.writeTextFile(file1, "dummy");

  const next1 = await findNextAvailablePath(file1);
  assertEquals(next1, path.join(tempDir, "Song (2).docx"));

  await Deno.writeTextFile(next1, "dummy");
  const next2 = await findNextAvailablePath(file1);
  assertEquals(next2, path.join(tempDir, "Song (3).docx"));

  const fromNumbered = await findNextAvailablePath(path.join(tempDir, "Song (2).docx"));
  assertEquals(fromNumbered, path.join(tempDir, "Song (3).docx"));

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("parseCustomProperties and readDocxEntries handle malformed XML and archive bounds", async () => {
  const emptyMap = parseCustomProperties("<InvalidXmlWithoutProps>");
  assertEquals(emptyMap.size, 0);

  const parsedProps = parseCustomProperties(
    `<Properties><property name="sheetMusicGenerator"><vt:lpwstr>test</vt:lpwstr></property></Properties>`,
  );
  assertEquals(parsedProps.get("sheetMusicGenerator"), "test");

  // Read small buffer should throw
  let smallThrew = false;
  try {
    await readDocxEntries(new Uint8Array([1, 2, 3]));
  } catch (_err) {
    smallThrew = true;
  }
  assertEquals(smallThrew, true);

  // Read non-zip 30 bytes should throw signature not found
  let sigThrew = false;
  try {
    await readDocxEntries(new Uint8Array(30));
  } catch (_err) {
    sigThrew = true;
  }
  assertEquals(sigThrew, true);
});

Deno.test("inspectExistingDocx handles generator tag without fingerprint as modified", async () => {
  const tempDir = await Deno.makeTempDir();
  const destPath = path.join(tempDir, "NoFingerprint.docx");
  const doc = buildSongDocument(sampleSong);
  const cp = (doc as unknown as {
    customProperties?: { addCustomProperty: (p: { name: string; value: string }) => void };
  }).customProperties;
  cp?.addCustomProperty({ name: "sheetMusicGenerator", value: "web-jam-tools" });
  const nodeBuf = await Packer.toBuffer(doc);
  await Deno.writeFile(
    destPath,
    new Uint8Array(nodeBuf.buffer, nodeBuf.byteOffset, nodeBuf.byteLength),
  );

  const inspection = await inspectExistingDocx(destPath);
  assertEquals(inspection.status, "modified");
  assertEquals(inspection.generator, "web-jam-tools");
  assertEquals(inspection.fingerprint, undefined);

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("inspectExistingDocx returns absent for non-existent file", async () => {
  const inspection = await inspectExistingDocx("/non/existent/path/song.docx");
  assertEquals(inspection.status, "absent");
});

Deno.test("runCli auto-computes safe title destination when output path omitted", async () => {
  const songJson = JSON.stringify({
    metadata: { title: "Auto Title Test Song" },
    sections: [{ title: "Verse", lines: [{ lyrics: "La la la" }] }],
  });
  const expectedPath = "./Auto_Title_Test_Song.docx";
  try {
    await Deno.remove(expectedPath);
  } catch (_err) {
    // ignore
  }

  const exitCode = await runCli(["--json", songJson]);
  assertEquals(exitCode, 0);

  const stat = await Deno.stat(expectedPath);
  assertGreater(stat.size, 1000);
  await Deno.remove(expectedPath);
});

Deno.test("runCli handles error when write target is invalid", async () => {
  const songJson = JSON.stringify(sampleSong);
  const exitCode = await runCli(["--json", songJson, "--output", "/dev/null/cannot/write.docx"]);
  assertEquals(exitCode, 1);
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

Deno.test("Chord names G6/9, C6/9, C°7, Cø7 and G7alt parse; performance annotations are still refused", () => {
  for (const chord of ["G6/9", "C6/9", "C°7", "Cø7", "G7alt"]) {
    assert(isValidChordToken(chord), chord);
    const result = parseAndLayoutLine(`[${chord}]word`);
    assertEquals(result[0].guitarChords, chord);
  }
  for (const annotation of ["[Everybody!]word", "[hold]word"]) {
    assertThrows(() => parseAndLayoutLine(annotation), Error, "performance annotations");
  }
});

Deno.test("transposeChord and transposeChordLine carry 6/9, °, ø and alt chords through a capo", () => {
  assertEquals(transposeChord("G6/9", 2), "A6/9");
  assertEquals(transposeChord("G6/9/B", 2), "A6/9/C#");
  assertEquals(transposeChord("C°7", 2), "D°7");
  assertEquals(transposeChord("Cø7", 2), "Dø7");
  assertEquals(transposeChord("G7alt", 2), "A7alt");
  assertEquals(transposeChordLine("G6/9  C°7", 2), "A6/9  D°7");
  const dual = parseAndLayoutLine("[G6/9]You [C°7]say", { mode: "dual-tier", capo: 2 });
  assertEquals(dual[0].bassChords?.trim().split(/\s+/), ["A6/9", "D°7"]);
});

Deno.test("transposeKey names the result with the fewest accidentals, and keyPrefersSharps follows the key signature", () => {
  assertEquals(transposeKey("G", 3), "Bb");
  assertEquals(transposeKey("Em", 3), "Gm");
  assertEquals(transposeKey("E", 2), "F#");
  assertEquals(transposeKey("G major", 2), "A major");
  assertEquals(transposeKey("Dmaj7", 1), "Ebmaj7");
  assertEquals(transposeKey("hold", 1), undefined);
  assertEquals(keyPrefersSharps("Bb"), false);
  assertEquals(keyPrefersSharps("Gm"), false);
  assertEquals(keyPrefersSharps("A"), true);
  assertEquals(keyPrefersSharps("F#m"), true);
  assertEquals(keyPrefersSharps("C"), undefined);
  assertEquals(keyPrefersSharps("Am"), undefined);
});

Deno.test("capo spelling follows the sounding key: G shapes at capo 3 print Bb, Eb, Gm and F/A", () => {
  const flats = parseAndLayoutLine("[G]one [C]two [Em]three [D/F#]four", {
    mode: "dual-tier",
    capo: 3,
    preferSharps: false,
  });
  assertEquals(flats[0].bassChords?.trim().split(/\s+/), ["Bb", "Eb", "Gm", "F/A"]);
  const sharps = parseAndLayoutLine("[E]one [A]two [B]three [C#m]four", {
    mode: "dual-tier",
    capo: 2,
    preferSharps: true,
  });
  assertEquals(sharps[0].bassChords?.trim().split(/\s+/), ["F#", "B", "C#", "D#m"]);
});

Deno.test("soundingPrefersSharps reads guitarKey, else the song's first chord", () => {
  const song = (guitarKey: string | undefined, lyrics: string): SongDefinition => ({
    metadata: {
      title: "Spelling",
      capo: 3,
      mode: "dual-tier",
      ...(guitarKey ? { guitarKey } : {}),
    },
    sections: [{ title: "Verse", lines: [{ lyrics }] }],
  } as SongDefinition);
  assertEquals(songGuitarKey(song("E", "[G]one")), "E");
  assertEquals(songGuitarKey(song(undefined, "no chord here\n")), undefined);
  assertEquals(soundingPrefersSharps(song(undefined, "[G]one [C]two"), 3), false);
  assertEquals(soundingPrefersSharps(song("E", "[G]one"), 2), true);
  assertEquals(soundingPrefersSharps(song(undefined, "no chords"), 3), undefined);
});

Deno.test("buildSongDocument spells capo-3 G shapes in Bb, and autoTransposeSong names the bass key Bb", async () => {
  const song = {
    metadata: { title: "Spelling", capo: 3, mode: "dual-tier", guitarKey: "G" },
    sections: [{ title: "Verse", lines: [{ lyrics: "[G]one [C]two [D/F#]three" }] }],
  } as SongDefinition;
  assertEquals(autoTransposeSong(song).metadata.bassKey, "Bb");
  const buffer = await Packer.toBuffer(buildSongDocument(song));
  const entries = await readDocxEntries(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );
  const xml = new TextDecoder().decode(entries.docXml);
  assert(xml.includes("Bb"), "bass line spelled Bb");
  assert(xml.includes("F/A"), "slash bass spelled F/A");
  assert(!xml.includes("A#") && !xml.includes("D#"), "no sharps in a Bb chart");
});

Deno.test("buildSongDocument writes custom properties passed to it through the Document options, and none by default", async () => {
  const song = {
    metadata: { title: "Stamp", mode: "single-tier" },
    sections: [{ title: "Verse", lines: [{ lyrics: "[G]one" }] }],
  } as SongDefinition;
  const read = async (doc: ReturnType<typeof buildSongDocument>) => {
    const buffer = await Packer.toBuffer(doc);
    const entries = await readDocxEntries(
      new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    );
    return entries.customXml
      ? parseCustomProperties(new TextDecoder().decode(entries.customXml))
      : new Map<string, string>();
  };
  const stamped = await read(
    buildSongDocument(song, [{ name: "sheetMusicGenerator", value: "web-jam-tools" }]),
  );
  assertEquals(stamped.get("sheetMusicGenerator"), "web-jam-tools");
  const plain = await read(buildSongDocument(song));
  assertEquals(plain.get("sheetMusicGenerator"), undefined);
});
