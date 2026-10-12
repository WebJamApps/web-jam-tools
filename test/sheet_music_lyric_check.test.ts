// test/sheet_music_lyric_check.test.ts
// Unit and integration tests for sheet music check-lyrics task (web-jam-tools#1013).

import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import * as path from "@std/path";
import {
  alignAndFindMissingRuns,
  assertBinaryRunnable,
  checkLyrics,
  extractSongWords,
  extractWords,
  filterReadingLines,
  joinHyphenatedSyllables,
  loadDictionary,
  loadVisionWords,
  runCli,
} from "../src/sheet-music/lyric_check.ts";
import type { SongDefinition } from "../src/sheet-music/types.ts";

const SYNTHETIC_SONG: SongDefinition = {
  metadata: {
    title: "Synthetic Test Song",
    composer: "Traditional",
  },
  sections: [
    {
      title: "VERSE 1",
      lines: [
        {
          lyrics: "The morning [G]sun rises [D]high above the [Em]green mountains",
        },
        {
          lyrics: "And the [C]river flows [G]peaceful through the [D]quiet valley",
        },
      ],
    },
    {
      title: "CHORUS",
      lines: [
        {
          lyrics: "Sing [C]aloud to the [G]heavens with a [D]joyful song",
        },
        {
          lyrics: "Re - [Em]mem - ber the [C]promises that [D]last so [G]long",
        },
      ],
    },
  ],
};

Deno.test("extractSongWords extracts normalized words and strips chord markers and joins syllables (web-jam-tools#1013)", () => {
  const words = extractSongWords(SYNTHETIC_SONG);
  assert(words.includes("morning"));
  assert(words.includes("sun"));
  assert(words.includes("rises"));
  assert(words.includes("high"));
  assert(words.includes("above"));
  assert(words.includes("green"));
  assert(words.includes("mountains"));
  assert(words.includes("valley"));
  assert(words.includes("remember")); // "Re - mem - ber" joined into "remember"
  assertFalse(words.includes("g"));
  assertFalse(words.includes("em"));
  assertFalse(words.includes("d"));
});

Deno.test("Criterion 1: A line removed from the song definition is flagged as a run of 2 or more words (web-jam-tools#1013)", () => {
  // Reading contains the full text of VERSE 1
  const readingWords = [
    "the",
    "morning",
    "sun",
    "rises",
    "high",
    "above",
    "the",
    "green",
    "mountains",
    "and",
    "the",
    "river",
    "flows",
    "peaceful",
    "through",
    "the",
    "quiet",
    "valley",
  ];

  // Song definition missing the second line ("and the river flows peaceful through the quiet valley")
  const songMissingLine: SongDefinition = {
    metadata: { title: "Missing Line Test" },
    sections: [
      {
        title: "VERSE 1",
        lines: [
          {
            lyrics: "The morning sun rises high above the green mountains",
          },
        ],
      },
    ],
  };

  const defWords = extractSongWords(songMissingLine);
  const flags = alignAndFindMissingRuns(readingWords, defWords, "tesseract");

  assertEquals(flags.length, 1);
  assertEquals(flags[0].source, "tesseract");
  assertEquals(flags[0].words.length, 9);
  assertEquals(
    flags[0].phrase,
    "and the river flows peaceful through the quiet valley",
  );
  assertEquals(flags[0].startIndex, 9);
});

Deno.test("Criterion 2: Hyphenated syllables (re - mem - ber) are joined into words before comparison (web-jam-tools#1013)", () => {
  // Various musical lyric hyphenation formats
  assertEquals(joinHyphenatedSyllables("re - mem - ber"), "remember");
  assertEquals(joinHyphenatedSyllables("Re - mem - ber"), "Remember");
  assertEquals(joinHyphenatedSyllables("re-mem-ber"), "remember");
  assertEquals(joinHyphenatedSyllables("glo - - - ri - a"), "gloria");
  assertEquals(joinHyphenatedSyllables("hal - le - lu - jah"), "hallelujah");
  assertEquals(
    joinHyphenatedSyllables("re - mem - ber the promises of old"),
    "remember the promises of old",
  );

  // When reading has hyphenated syllables and definition has whole words, alignment produces 0 flags
  const readingWithHyphens = [
    "re - mem - ber",
    "the",
    "glo - ri - a",
    "in",
    "the",
    "highest",
  ];
  const normalizedReadingWords = extractWords(
    joinHyphenatedSyllables(readingWithHyphens.join(" ")),
  );
  const definitionWords = ["remember", "the", "gloria", "in", "the", "highest"];

  const flags = alignAndFindMissingRuns(
    normalizedReadingWords,
    definitionWords,
    "tesseract",
  );
  assertEquals(flags.length, 0);
});

Deno.test("Criterion 3: A reading line under 70% dictionary words is discarded before alignment (web-jam-tools#1013)", () => {
  const dictionary = new Set([
    "the",
    "morning",
    "sun",
    "rises",
    "high",
    "and",
    "river",
    "flows",
    "peaceful",
    "remember",
    "days",
    "of",
    "old",
    "sweet",
    "sound",
  ]);

  const rawLines = [
    // 100% dictionary words -> kept
    "The morning sun rises high",
    // 0% dictionary words (chords) -> discarded
    "C#m7 F#m7 B7 Emaj7 Asus2",
    // 33% dictionary words (OCR garbage) -> discarded
    "xgqpl zrtbv jfkdl sweet the sound",
    // 100% dictionary words with hyphens -> kept
    "re - mem - ber the days of old",
    // Dynamics & tempo markings (<70%) -> discarded
    "f cresc. p Allegro 120",
    // 100% dictionary words -> kept
    "and river flows peaceful",
  ];

  const kept = filterReadingLines(rawLines, dictionary, 0.7);
  assertEquals(kept.length, 3);
  assertEquals(kept[0], "The morning sun rises high");
  assertEquals(kept[1], "remember the days of old");
  assertEquals(kept[2], "and river flows peaceful");
});

Deno.test("Criterion 4: A vision word-list file is compared against the definition using the same alignment logic (web-jam-tools#1013)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "vision-test-" });
  try {
    const visionFile = path.join(tempDir, "vision_words.txt");
    await Deno.writeTextFile(
      visionFile,
      "The morning sun rises high above the green mountains and the river flows peaceful through the quiet valley",
    );

    // Song missing the phrase "above the green mountains"
    const songMissingPhrase: SongDefinition = {
      metadata: { title: "Vision Test" },
      sections: [
        {
          title: "VERSE 1",
          lines: [
            {
              lyrics:
                "The morning sun rises high and the river flows peaceful through the quiet valley",
            },
          ],
        },
      ],
    };

    const songFile = path.join(tempDir, "song.json");
    await Deno.writeTextFile(songFile, JSON.stringify(songMissingPhrase));

    const result = await checkLyrics({
      songPath: songFile,
      visionPath: visionFile,
    });

    assertFalse(result.ok);
    assertEquals(result.flags.length, 1);
    assertEquals(result.flags[0].source, "vision");
    assertEquals(result.flags[0].phrase, "above the green mountains");
    assertEquals(result.flags[0].words.length, 4);

    // Also test JSON array vision word-list format
    const visionJsonFile = path.join(tempDir, "vision_words.json");
    await Deno.writeTextFile(
      visionJsonFile,
      JSON.stringify([
        "The",
        "morning",
        "sun",
        "rises",
        "high",
        "above",
        "the",
        "green",
        "mountains",
      ]),
    );

    const loadedJsonWords = await loadVisionWords(visionJsonFile);
    assertEquals(loadedJsonWords.length, 9);
    assertEquals(loadedJsonWords[0], "the");
    assertEquals(loadedJsonWords[8], "mountains");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("Criterion 5: Guard outcome — condition holds (no confirmed flags): task exits 0 (web-jam-tools#1013)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "guard-pass-test-" });
  try {
    const songFile = path.join(tempDir, "song.json");
    await Deno.writeTextFile(songFile, JSON.stringify(SYNTHETIC_SONG));

    const visionFile = path.join(tempDir, "vision.txt");
    const fullText =
      "The morning sun rises high above the green mountains and the river flows peaceful through the quiet valley " +
      "Sing aloud to the heavens with a joyful song remember the promises that last so long";
    await Deno.writeTextFile(visionFile, fullText);

    // Run checkLyrics
    const result = await checkLyrics({
      songPath: songFile,
      visionPath: visionFile,
    });
    assert(result.ok);
    assertEquals(result.flags.length, 0);

    // Run CLI
    const code = await runCli([
      "--song",
      songFile,
      "--vision",
      visionFile,
    ]);
    assertEquals(code, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("Criterion 6: Guard outcome — condition fails (flags found): task exits non-zero and prints flagged runs (web-jam-tools#1013)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "guard-fail-test-" });
  try {
    const songFile = path.join(tempDir, "song.json");
    // Song is missing the second line
    const truncatedSong: SongDefinition = {
      metadata: { title: "Truncated" },
      sections: [
        {
          title: "VERSE 1",
          lines: [
            {
              lyrics: "The morning sun rises high above the green mountains",
            },
          ],
        },
      ],
    };
    await Deno.writeTextFile(songFile, JSON.stringify(truncatedSong));

    const visionFile = path.join(tempDir, "vision.txt");
    await Deno.writeTextFile(
      visionFile,
      "The morning sun rises high above the green mountains and the river flows peaceful through the quiet valley",
    );

    const result = await checkLyrics({
      songPath: songFile,
      visionPath: visionFile,
    });
    assertFalse(result.ok);
    assertEquals(result.flags.length, 1);
    assertEquals(result.flags[0].phrase, "and the river flows peaceful through the quiet valley");

    // CLI returns exit code 1
    const code = await runCli([
      "--song",
      songFile,
      "--vision",
      visionFile,
    ]);
    assertEquals(code, 1);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("Criterion 7: Guard outcome — condition undeterminable (refuses, fails closed) (web-jam-tools#1013)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "guard-refusal-test-" });
  try {
    const validSongFile = path.join(tempDir, "song.json");
    await Deno.writeTextFile(validSongFile, JSON.stringify(SYNTHETIC_SONG));

    // 7a. Missing dictionary file throws error naming the dictionary path
    const missingDictPath = path.join(tempDir, "non_existent_dict.txt");
    await assertRejects(
      async () => {
        await loadDictionary(missingDictPath);
      },
      Error,
      missingDictPath,
    );

    // 7b. Missing vision file throws error naming the vision path
    const missingVisionPath = path.join(tempDir, "non_existent_vision.txt");
    await assertRejects(
      async () => {
        await loadVisionWords(missingVisionPath);
      },
      Error,
      missingVisionPath,
    );

    // 7c. Missing binary throws error naming the binary
    await assertRejects(
      async () => {
        await assertBinaryRunnable("non_existent_pdftoppm_binary_999");
      },
      Error,
      "non_existent_pdftoppm_binary_999",
    );

    // 7d. CLI returns exit code 2 when condition is undeterminable
    const code = await runCli([
      "--song",
      validSongFile,
      "--vision",
      missingVisionPath,
    ]);
    assertEquals(code, 2);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("Criterion 8: Local integration test running pdftoppm and tesseract on generated PDF, skipped when tesseract is absent (web-jam-tools#1013)", async () => {
  // Check if tesseract and pdftoppm are installed on this machine
  let tesseractAvailable = false;
  let pdftoppmAvailable = false;
  try {
    const tessCmd = new Deno.Command("tesseract", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    const tessOut = await tessCmd.output();
    tesseractAvailable = tessOut.success;
  } catch {
    tesseractAvailable = false;
  }

  try {
    const pdfCmd = new Deno.Command("pdftoppm", { args: ["-v"], stdout: "null", stderr: "null" });
    const pdfOut = await pdfCmd.output();
    pdftoppmAvailable = pdfOut.success;
  } catch {
    pdftoppmAvailable = false;
  }

  if (!tesseractAvailable || !pdftoppmAvailable) {
    console.log("Skipping integration test: tesseract or pdftoppm is absent from machine.");
    return;
  }

  const tempDir = await Deno.makeTempDir({ prefix: "integration-test-" });
  try {
    // Generate a minimal valid PDF containing clean synthetic text
    const minimalPdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 54 >>
stream
BT
/F1 24 Tf
100 700 Td
(Amazing grace how sweet) Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000348 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
427
%%EOF
`;
    const pdfPath = path.join(tempDir, "test.pdf");
    await Deno.writeTextFile(pdfPath, minimalPdf);

    // Matching song definition
    const matchingSong: SongDefinition = {
      metadata: { title: "Grace Test" },
      sections: [
        {
          title: "VERSE 1",
          lines: [
            {
              lyrics: "Amazing [C]grace how [G]sweet",
            },
          ],
        },
      ],
    };

    const songFile = path.join(tempDir, "song.json");
    await Deno.writeTextFile(songFile, JSON.stringify(matchingSong));

    // Run end-to-end checkLyrics with real pdftoppm + tesseract execution
    const result = await checkLyrics({
      songPath: songFile,
      pdfPath: pdfPath,
    });

    assert(result.ok);
    assertEquals(result.flags.length, 0);

    // Now test with a dropped line from definition
    const songMissingText: SongDefinition = {
      metadata: { title: "Grace Missing Text" },
      sections: [
        {
          title: "VERSE 1",
          lines: [
            {
              lyrics: "Amazing",
            },
          ],
        },
      ],
    };

    const songMissingFile = path.join(tempDir, "song_missing.json");
    await Deno.writeTextFile(songMissingFile, JSON.stringify(songMissingText));

    const resultMissing = await checkLyrics({
      songPath: songMissingFile,
      pdfPath: pdfPath,
    });

    assertFalse(resultMissing.ok);
    assertEquals(resultMissing.flags.length, 1);
    assertEquals(resultMissing.flags[0].source, "tesseract");
    assert(resultMissing.flags[0].phrase.includes("grace"));
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});
