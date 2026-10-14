// test/sheet_music_lyric_check.test.ts
// Unit and integration tests for sheet music check-lyrics task (web-jam-tools#1013).

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
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

function runLyricCommand(args: string[], env?: Record<string, string>) {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run=tesseract,pdftoppm",
      new URL("../src/sheet-music/lyric_check.ts", import.meta.url).pathname,
      ...args,
    ],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
}

Deno.test("vision readings with no usable words are undeterminable in the loader and CLI", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "vision-empty-" });
  try {
    const visionPath = path.join(tempDir, "vision.txt");
    for (
      const content of [
        "",
        " \n\t",
        "[]",
        '{"words":[]}',
        '{"lines":[]}',
        "!!! ...",
        '[" ", "!!!"]',
      ]
    ) {
      await Deno.writeTextFile(visionPath, content);
      await assertRejects(() => loadVisionWords(visionPath), Error, "contains no usable words");
      const { code, stdout, stderr } = await runLyricCommand([
        "--json",
        JSON.stringify(SYNTHETIC_SONG),
        "--vision",
        visionPath,
      ]);
      assertEquals(code, 2, content);
      assertFalse(new TextDecoder().decode(stdout).includes("[PASS]"));
      assertStringIncludes(new TextDecoder().decode(stderr), "condition undeterminable");
      assertStringIncludes(new TextDecoder().decode(stderr), visionPath);
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("vision JSON refuses malformed lists instead of treating JSON syntax as reading words", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "vision-invalid-" });
  try {
    const visionPath = path.join(tempDir, "vision.json");
    for (const content of ['{"words":', "{}", "[null]", '[{"word":"the"}]']) {
      await Deno.writeTextFile(visionPath, content);
      await assertRejects(() => loadVisionWords(visionPath), Error, visionPath);
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("CLI accepts both --json and its advertised -j alias with matching vision readings", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "lyric-json-alias-" });
  try {
    const visionPath = path.join(tempDir, "vision.json");
    const words = extractSongWords(SYNTHETIC_SONG);
    for (
      const content of [
        JSON.stringify(words),
        JSON.stringify({ words }),
        JSON.stringify({ lines: [words.join(" ")] }),
      ]
    ) {
      await Deno.writeTextFile(visionPath, content);
      for (const flag of ["--json", "-j"]) {
        const { code, stdout, stderr } = await runLyricCommand([
          flag,
          JSON.stringify(SYNTHETIC_SONG),
          "--vision",
          visionPath,
        ]);
        assertEquals(code, 0, new TextDecoder().decode(stderr));
        assertStringIncludes(new TextDecoder().decode(stdout), "[PASS]");
      }
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("CLI refuses empty or entirely filtered OCR even when a usable vision reading is supplied", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "lyric-ocr-empty-" });
  try {
    const tesseractPath = path.join(tempDir, "tesseract");
    await Deno.writeTextFile(
      tesseractPath,
      `#!/bin/sh
if [ "$1" != "--version" ]; then printf '%s\\n' "$LYRIC_TEST_OCR"; fi
`,
    );
    await Deno.chmod(tesseractPath, 0o755);
    const dictPath = path.join(tempDir, "dictionary.txt");
    const visionPath = path.join(tempDir, "vision.txt");
    const imagePath = path.join(tempDir, "scan.png");
    const words = extractSongWords(SYNTHETIC_SONG);
    await Deno.writeTextFile(dictPath, words.join("\n"));
    await Deno.writeTextFile(visionPath, words.join(" "));
    await Deno.writeFile(imagePath, new Uint8Array());
    for (const reading of ["", " \n\t", "C#m7 F#m7 B7 Emaj7 Asus2", words.join(" ")]) {
      const { code, stdout, stderr } = await runLyricCommand([
        "-j",
        JSON.stringify(SYNTHETIC_SONG),
        "--image",
        imagePath,
        "--dict",
        dictPath,
        "--vision",
        visionPath,
      ], {
        PATH: `${tempDir}:${Deno.env.get("PATH") ?? ""}`,
        LYRIC_TEST_OCR: reading,
      });
      if (reading === words.join(" ")) {
        assertEquals(code, 0, new TextDecoder().decode(stderr));
        assertStringIncludes(new TextDecoder().decode(stdout), "[PASS]");
      } else {
        assertEquals(code, 2);
        assertFalse(new TextDecoder().decode(stdout).includes("[PASS]"));
        assertStringIncludes(
          new TextDecoder().decode(stderr),
          "Tesseract reading after filtering contains no usable words",
        );
      }
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

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

Deno.test("loadDictionary refuses empty, whitespace, or punctuation-only files before augmentation (Rule 34)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "lyric-empty-dict-" });
  try {
    for (const content of ["", "   \n\t  \n", "--- \n ... \n !?!"]) {
      const dictPath = path.join(tempDir, "test.dict");
      await Deno.writeTextFile(dictPath, content);
      await assertRejects(
        () => loadDictionary(dictPath, ["extra", "words"]),
        Error,
        "contains no usable words",
      );
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("OCR filtering with empty dictionary refuses as undeterminable rather than falsely passing omitted lines (Codex regression)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "lyric-codex-regression-" });
  try {
    const emptyDict = path.join(tempDir, "empty.dict");
    await Deno.writeTextFile(emptyDict, "");

    const songDef: SongDefinition = {
      metadata: { title: "Bright Morning" },
      sections: [
        {
          title: "VERSE 1",
          lines: [{ lyrics: "bright morning" }],
        },
      ],
    };
    const songFile = path.join(tempDir, "song.json");
    await Deno.writeTextFile(songFile, JSON.stringify(songDef));

    // loadDictionary itself must throw before augmenting with ["bright", "morning"]
    await assertRejects(
      () => loadDictionary(emptyDict, ["bright", "morning"]),
      Error,
      "contains no usable words",
    );

    // checkLyrics must reject with undeterminable condition error
    await assertRejects(
      () =>
        checkLyrics({
          songPath: songFile,
          dictPath: emptyDict,
          imagePath: path.join(tempDir, "dummy.png"),
        }),
      Error,
      "contains no usable words",
    );

    // CLI must exit 2 (undeterminable) rather than falsely reporting pass (exit 0)
    const code = await runCli([
      "--song",
      songFile,
      "--dict",
      emptyDict,
      "--image",
      path.join(tempDir, "dummy.png"),
    ]);
    assertEquals(code, 2);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("deno.json registers sheet-music:check-lyrics via launcher without blanket permissions (Rule 21)", async () => {
  const config = JSON.parse(await Deno.readTextFile("deno.json"));
  const taskCommand = config.tasks?.["sheet-music:check-lyrics"];
  assert(taskCommand, "sheet-music:check-lyrics task must exist in deno.json");
  assertFalse(
    taskCommand.includes("--allow-read ") || taskCommand.endsWith("--allow-read"),
    "Task must not use bare --allow-read (Rule 21)",
  );
  assertFalse(
    taskCommand.includes("--allow-write ") || taskCommand.endsWith("--allow-write"),
    "Task must not use bare --allow-write (Rule 21)",
  );
  assertStringIncludes(taskCommand, "scripts/sheet-music-check-lyrics.sh");
});

Deno.test("scripts/sheet-music-check-lyrics.sh launcher executes end-to-end with scoped permissions", async () => {
  const launcherPath = new URL("../scripts/sheet-music-check-lyrics.sh", import.meta.url).pathname;

  // 1. --help exits 0
  const helpCmd = new Deno.Command("bash", {
    args: [launcherPath, "--help"],
    stdout: "piped",
    stderr: "piped",
  });
  const helpOut = await helpCmd.output();
  assertEquals(helpOut.code, 0);
  assertStringIncludes(
    new TextDecoder().decode(helpOut.stdout),
    "Usage: deno task sheet-music:check-lyrics",
  );

  // 2. Matching vision reading exits 0
  const tempDir = await Deno.makeTempDir({ prefix: "launcher-test-" });
  try {
    const visionPath = path.join(tempDir, "vision.txt");
    await Deno.writeTextFile(
      visionPath,
      "The morning sun rises high above the green mountains\nAnd the river flows peaceful through the quiet valley\nSing aloud to the heavens with a joyful song\nRemember the promises that last so long",
    );

    const passCmd = new Deno.Command("bash", {
      args: [launcherPath, "--json", JSON.stringify(SYNTHETIC_SONG), "--vision", visionPath],
      stdout: "piped",
      stderr: "piped",
    });
    const passOut = await passCmd.output();
    assertEquals(passOut.code, 0);
    assertStringIncludes(new TextDecoder().decode(passOut.stdout), "[PASS]");

    // 3. Dropped line in definition exits 1
    const missingSong: SongDefinition = {
      metadata: { title: "Missing verse" },
      sections: [{
        title: "VERSE 1",
        lines: [{ lyrics: "The morning sun rises high above the green mountains" }],
      }],
    };
    const failCmd = new Deno.Command("bash", {
      args: [launcherPath, "--json", JSON.stringify(missingSong), "--vision", visionPath],
      stdout: "piped",
      stderr: "piped",
    });
    const failOut = await failCmd.output();
    assertEquals(failOut.code, 1);
    assertStringIncludes(new TextDecoder().decode(failOut.stderr), "[FAIL]");

    // 4. Empty dictionary exits 2 (undeterminable)
    const emptyDict = path.join(tempDir, "empty.dict");
    await Deno.writeTextFile(emptyDict, "");
    const emptyDictCmd = new Deno.Command("bash", {
      args: [
        launcherPath,
        "--json",
        JSON.stringify(SYNTHETIC_SONG),
        "--vision",
        visionPath,
        "--dict",
        emptyDict,
        "--image",
        path.join(tempDir, "dummy.png"),
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const emptyDictOut = await emptyDictCmd.output();
    assertEquals(emptyDictOut.code, 2);
    assertStringIncludes(new TextDecoder().decode(emptyDictOut.stderr), "condition undeterminable");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});
