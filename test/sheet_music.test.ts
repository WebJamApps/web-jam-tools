// test/sheet_music.test.ts
// Unit tests for sheet music transcription, harmonic transposition, and docx generation (web-jam-tools#770, web-jam-tools#771).

import { assert, assertEquals, assertGreater } from "@std/assert";
import * as path from "@std/path";
import { Packer } from "docx";
import {
  autoTransposeSong,
  transposeChord,
  transposeChordLine,
  transposeNote,
} from "../src/sheet-music/transpose.ts";
import { buildSongDocument, generateSongDocxBuffer } from "../src/sheet-music/builder.ts";
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
