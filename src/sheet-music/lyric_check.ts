#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=pdftoppm,tesseract
/**
 * src/sheet-music/lyric_check.ts
 *
 * Compares song definition lyrics against independent source scan readings (Tesseract OCR and vision word-list)
 * to detect dropped lyric lines before .docx generation (web-jam-tools#1013).
 */

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import type { SongDefinition } from "./types.ts";

export interface CheckLyricsOptions {
  songPath?: string;
  songJson?: string;
  pdfPath?: string;
  imagePath?: string;
  visionPath?: string;
  dictPath?: string;
}

export interface FlaggedRun {
  source: string;
  words: string[];
  phrase: string;
  startIndex: number;
}

export interface CheckLyricsResult {
  ok: boolean;
  flags: FlaggedRun[];
  tesseractWords?: string[];
  visionWords?: string[];
  definitionWords: string[];
}

/**
 * Joins hyphenated syllables (e.g. "re - mem - ber" -> "remember") into whole words.
 * Handles multiple dashes and whitespace variations found in sheet music lyric engravings.
 */
export function joinHyphenatedSyllables(text: string): string {
  let prev = text;
  while (true) {
    const next = prev.replace(
      /\b([a-zA-Z0-9]+)\s*[-–—]+(?:\s*[-–—]+)*\s*([a-zA-Z0-9]+)\b/g,
      "$1$2",
    );
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

/**
 * Tokenizes text into normalized lowercase words with leading/trailing punctuation stripped.
 * Preserves internal punctuation like apostrophes ("don't", "it's").
 */
export function extractWords(text: string): string[] {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  const words: string[] = [];
  for (const token of tokens) {
    const clean = token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (clean.length > 0) {
      words.push(clean);
    }
  }
  return words;
}

/**
 * Extracts all lyric words from a SongDefinition in sequence, stripping inline chord markers
 * and joining hyphenated syllables.
 */
export function extractSongWords(song: SongDefinition): string[] {
  const words: string[] = [];
  if (!song || !Array.isArray(song.sections)) {
    return words;
  }
  for (const section of song.sections) {
    if (!Array.isArray(section.lines)) continue;
    for (const line of section.lines) {
      if (!line || typeof line.lyrics !== "string") continue;
      // Strip inline chord markers like [C/E], [G], etc.
      const textWithoutChords = line.lyrics.replace(/\[[^\]]+\]/g, "");
      const textJoined = joinHyphenatedSyllables(textWithoutChords);
      words.push(...extractWords(textJoined));
    }
  }
  return words;
}

/**
 * Filters OCR reading lines to those with at least 70% dictionary words.
 * Discards musical notation noise, chord rows, dynamics, and unreadable lines.
 */
export function filterReadingLines(
  lines: string[],
  dictionary: Set<string>,
  threshold = 0.7,
): string[] {
  const kept: string[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const lineWithJoinedSyllables = joinHyphenatedSyllables(trimmed);
    const tokens = lineWithJoinedSyllables.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;

    let dictWords = 0;
    for (const token of tokens) {
      const clean = token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
      if (clean.length > 0 && dictionary.has(clean)) {
        dictWords++;
      }
    }
    const ratio = dictWords / tokens.length;
    if (ratio >= threshold) {
      kept.push(lineWithJoinedSyllables);
    }
  }
  return kept;
}

/**
 * Loads dictionary words from disk and augments the set with words from the song definition.
 * Fails closed if the dictionary file cannot be read.
 */
export async function loadDictionary(
  dictPath: string = "/usr/share/dict/american-english",
  extraWords?: Iterable<string>,
): Promise<Set<string>> {
  let content: string;
  try {
    content = await Deno.readTextFile(dictPath);
  } catch (err) {
    throw new Error(
      `Dictionary file could not be read at ${dictPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const set = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const word = line.trim().toLowerCase();
    if (word.length > 0) {
      set.add(word);
    }
  }

  if (extraWords) {
    for (const w of extraWords) {
      const clean = w.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
      if (clean.length > 0) {
        set.add(clean);
      }
    }
  }

  return set;
}

/**
 * Reads a vision word-list file (plain text or JSON format) and extracts words.
 * Fails closed if the file cannot be read or contains no usable words.
 */
export async function loadVisionWords(visionPath: string): Promise<string[]> {
  let content: string;
  try {
    content = await Deno.readTextFile(visionPath);
  } catch (err) {
    throw new Error(
      `Vision word-list file could not be read at ${visionPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const trimmed = content.trim();
  let reading = content;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Vision word-list at ${visionPath} is not valid JSON`);
    }
    const entries = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).words ?? (parsed as Record<string, unknown>).lines
      : undefined;
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) {
      throw new Error(`Vision word-list at ${visionPath} must contain an array of strings`);
    }
    reading = entries.join(" ");
  }

  return requireReadingWords(
    extractWords(joinHyphenatedSyllables(reading)),
    `Vision word-list at ${visionPath}`,
  );
}

function requireReadingWords(words: string[], source: string): string[] {
  if (words.length === 0) {
    throw new Error(`${source} contains no usable words`);
  }
  return words;
}

/**
 * Reads and parses a SongDefinition from a file or JSON string.
 * Fails closed if missing, unreadable, or malformed JSON.
 */
export async function loadSongDefinition(
  options: { songPath?: string; songJson?: string },
): Promise<SongDefinition> {
  if (options.songJson) {
    try {
      return JSON.parse(options.songJson) as SongDefinition;
    } catch (err) {
      throw new Error(
        `Song definition JSON string could not be parsed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (options.songPath) {
    let content: string;
    try {
      content = await Deno.readTextFile(options.songPath);
    } catch (err) {
      throw new Error(
        `Song definition file could not be read at ${options.songPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      return JSON.parse(content) as SongDefinition;
    } catch (err) {
      throw new Error(
        `Song definition file at ${options.songPath} is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  throw new Error("No song definition provided (use --song or --json)");
}

/**
 * Aligns reading words against definition words via Longest Common Subsequence (LCS).
 * Reports every contiguous run of 2 or more words present in the reading and absent from the definition.
 */
export function alignAndFindMissingRuns(
  readingWords: string[],
  definitionWords: string[],
  source = "reading",
): FlaggedRun[] {
  const n = readingWords.length;
  const m = definitionWords.length;

  if (n === 0) {
    return [];
  }

  if (m === 0) {
    if (n >= 2) {
      return [{
        source,
        words: [...readingWords],
        phrase: readingWords.join(" "),
        startIndex: 0,
      }];
    }
    return [];
  }

  const stride = m + 1;
  const dp = new Int32Array((n + 1) * stride);

  for (let i = 1; i <= n; i++) {
    const rw = readingWords[i - 1];
    const rowOffset = i * stride;
    const prevRowOffset = (i - 1) * stride;
    for (let j = 1; j <= m; j++) {
      if (rw === definitionWords[j - 1]) {
        dp[rowOffset + j] = dp[prevRowOffset + (j - 1)] + 1;
      } else {
        const up = dp[prevRowOffset + j];
        const left = dp[rowOffset + (j - 1)];
        dp[rowOffset + j] = up >= left ? up : left;
      }
    }
  }

  const matchedInReading = new Uint8Array(n);
  let i = n;
  let j = m;

  while (i > 0 && j > 0) {
    if (readingWords[i - 1] === definitionWords[j - 1]) {
      matchedInReading[i - 1] = 1;
      i--;
      j--;
    } else {
      const up = dp[(i - 1) * stride + j];
      const left = dp[i * stride + (j - 1)];
      if (up >= left) {
        i--;
      } else {
        j--;
      }
    }
  }

  const flags: FlaggedRun[] = [];
  let runStart = -1;

  for (let k = 0; k < n; k++) {
    if (!matchedInReading[k]) {
      if (runStart === -1) {
        runStart = k;
      }
    } else {
      if (runStart !== -1) {
        const runLen = k - runStart;
        if (runLen >= 2) {
          const runWords = readingWords.slice(runStart, k);
          flags.push({
            source,
            words: runWords,
            phrase: runWords.join(" "),
            startIndex: runStart,
          });
        }
        runStart = -1;
      }
    }
  }

  if (runStart !== -1) {
    const runLen = n - runStart;
    if (runLen >= 2) {
      const runWords = readingWords.slice(runStart, n);
      flags.push({
        source,
        words: runWords,
        phrase: runWords.join(" "),
        startIndex: runStart,
      });
    }
  }

  return flags;
}

/**
 * Asserts a system binary exists and can be executed. Fails closed with an explicit error naming the binary.
 */
export async function assertBinaryRunnable(binaryName: string): Promise<void> {
  const versionArg = binaryName === "pdftoppm" ? "-v" : "--version";
  try {
    const cmd = new Deno.Command(binaryName, {
      args: [versionArg],
      stdout: "null",
      stderr: "null",
    });
    const output = await cmd.output();
    if (!output.success) {
      throw new Error(
        `${binaryName} binary failed during startup check (exit code ${output.code})`,
      );
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(
        `${binaryName} binary is missing or not installed on PATH`,
      );
    }
    throw new Error(
      `${binaryName} binary could not be executed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Renders PDF pages to 300 dpi grayscale PNG images using pdftoppm.
 */
export async function renderPdfPagesWithPdftoppm(
  pdfPath: string,
  outputDir: string,
): Promise<string[]> {
  const prefix = path.join(outputDir, "page");
  const cmd = new Deno.Command("pdftoppm", {
    args: ["-r", "300", "-gray", "-png", pdfPath, prefix],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    const errText = new TextDecoder().decode(output.stderr);
    throw new Error(
      `pdftoppm failed with exit code ${output.code}: ${errText.trim()}`,
    );
  }

  const generatedImages: string[] = [];
  for await (const entry of Deno.readDir(outputDir)) {
    if (entry.isFile && entry.name.endsWith(".png")) {
      generatedImages.push(path.join(outputDir, entry.name));
    }
  }
  generatedImages.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return generatedImages;
}

/**
 * Reads image pages with tesseract using page segmentation mode 4 (--psm 4).
 */
export async function ocrPagesWithTesseract(
  imagePaths: string[],
): Promise<string[]> {
  const pageTexts: string[] = [];
  for (const imgPath of imagePaths) {
    const cmd = new Deno.Command("tesseract", {
      args: [imgPath, "stdout", "--psm", "4"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (!output.success) {
      const errText = new TextDecoder().decode(output.stderr);
      throw new Error(
        `tesseract failed on ${imgPath} with exit code ${output.code}: ${errText.trim()}`,
      );
    }
    pageTexts.push(new TextDecoder().decode(output.stdout));
  }
  return pageTexts;
}

/**
 * Runs the full lyric comparison pipeline against the song definition.
 */
export async function checkLyrics(
  options: CheckLyricsOptions,
): Promise<CheckLyricsResult> {
  const song = await loadSongDefinition(options);
  const definitionWords = extractSongWords(song);

  const hasPdf = Boolean(options.pdfPath);
  const hasImage = Boolean(options.imagePath);
  const hasVision = Boolean(options.visionPath);

  if (!hasPdf && !hasImage && !hasVision) {
    throw new Error(
      "No reading source provided: specify --pdf, --image, or --vision",
    );
  }

  const allFlags: FlaggedRun[] = [];
  let tesseractWords: string[] | undefined;
  let visionWords: string[] | undefined;

  if (hasPdf || hasImage) {
    if (hasPdf) {
      await assertBinaryRunnable("pdftoppm");
    }
    await assertBinaryRunnable("tesseract");

    const dictPath = options.dictPath || "/usr/share/dict/american-english";
    const dictionary = await loadDictionary(dictPath, definitionWords);

    let imagePaths: string[] = [];
    let tempDir: string | undefined;

    try {
      if (hasPdf) {
        tempDir = await Deno.makeTempDir({ prefix: "lyric-check-" });
        imagePaths = await renderPdfPagesWithPdftoppm(options.pdfPath!, tempDir);
      } else if (hasImage) {
        imagePaths = [options.imagePath!];
      }

      const ocrTexts = await ocrPagesWithTesseract(imagePaths);
      const allLines = ocrTexts.flatMap((t) => t.split(/\r?\n/));
      const keptLines = filterReadingLines(allLines, dictionary);
      const joinedText = joinHyphenatedSyllables(keptLines.join("\n"));
      tesseractWords = requireReadingWords(
        extractWords(joinedText),
        "Tesseract reading after filtering",
      );

      const tesseractFlags = alignAndFindMissingRuns(
        tesseractWords,
        definitionWords,
        "tesseract",
      );
      allFlags.push(...tesseractFlags);
    } finally {
      if (tempDir) {
        await Deno.remove(tempDir, { recursive: true }).catch(() => {});
      }
    }
  }

  if (hasVision) {
    visionWords = await loadVisionWords(options.visionPath!);
    const visionFlags = alignAndFindMissingRuns(
      visionWords,
      definitionWords,
      "vision",
    );
    allFlags.push(...visionFlags);
  }

  return {
    ok: allFlags.length === 0,
    flags: allFlags,
    tesseractWords,
    visionWords,
    definitionWords,
  };
}

export function parseCliArgs(args: string[]): CheckLyricsOptions & { help?: boolean } {
  const flags = parseArgs(args, {
    string: [
      "song",
      "s",
      "input",
      "i",
      "pdf",
      "scan",
      "p",
      "image",
      "vision",
      "v",
      "dict",
      "d",
      "json",
      "j",
    ],
    boolean: ["help", "h"],
    alias: {
      s: "song",
      i: "song",
      p: "pdf",
      v: "vision",
      d: "dict",
      j: "json",
      h: "help",
    },
  });

  if (flags.help) {
    return { help: true, dictPath: "" };
  }

  let songPath = flags.song;
  let pdfPath = flags.pdf || flags.scan;
  const visionPath = flags.vision;

  if (!songPath && flags._.length > 0) {
    const first = String(flags._[0]);
    if (first.endsWith(".json")) {
      songPath = first;
    } else if (first.endsWith(".pdf")) {
      pdfPath = first;
    }
  }

  if (!pdfPath && flags._.length > 1) {
    const second = String(flags._[1]);
    if (second.endsWith(".pdf")) {
      pdfPath = second;
    } else if (second.endsWith(".json") && !songPath) {
      songPath = second;
    }
  }

  return {
    songPath,
    songJson: flags.json,
    pdfPath,
    imagePath: flags.image,
    visionPath,
    dictPath: flags.dict || "/usr/share/dict/american-english",
  };
}

export function printHelp(): void {
  console.log(`Usage: deno task sheet-music:check-lyrics [options]

Compares a song definition's lyrics against source scan readings (Tesseract OCR and vision word-list)
to detect dropped lyric lines before .docx lead sheet generation.

Options:
  -s, --song <path>     Path to song definition JSON file
  -j, --json <string>   Inline JSON string of song definition
  -p, --pdf <path>      Path to scan PDF (renders pages at 300 dpi grayscale with pdftoppm, reads with tesseract --psm 4)
      --image <path>    Path to single image file for Tesseract OCR
  -v, --vision <path>   Path to vision word-list file
  -d, --dict <path>     Path to dictionary file (default: /usr/share/dict/american-english)
  -h, --help            Show this help message

Exit codes:
  0: Condition holds — no missing lyric runs of 2+ words detected.
  1: Condition fails — missing lyric runs of 2+ words detected.
  2: Condition undeterminable — required binaries, dictionary, or files are missing or unreadable, or a supplied reading contains no usable words.`);
}

export async function runCli(args: string[]): Promise<number> {
  const options = parseCliArgs(args);
  if (options.help) {
    printHelp();
    return 0;
  }

  try {
    const result = await checkLyrics(options);
    if (result.ok) {
      console.log(
        "[PASS] Song definition lyrics match source readings (no missing runs of 2+ words).",
      );
      return 0;
    } else {
      console.error(
        `[FAIL] Detected ${result.flags.length} missing lyric run(s) present in readings but absent from song definition:`,
      );
      for (const flag of result.flags) {
        console.error(
          `  - [${flag.source}] Run of ${flag.words.length} words: "${flag.phrase}"`,
        );
      }
      return 1;
    }
  } catch (err) {
    console.error(
      `[ERROR] Refusing lyric check — condition undeterminable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 2;
  }
}

if (import.meta.main) {
  const code = await runCli(Deno.args);
  Deno.exit(code);
}
