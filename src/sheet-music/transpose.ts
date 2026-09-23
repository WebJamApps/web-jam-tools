/**
 * src/sheet-music/transpose.ts
 *
 * Musical semitone transposition engine for guitar capo and bass sounding chords (web-jam-tools#770, web-jam-tools#771).
 */

import type { SongDefinition } from "./types.ts";

export const SHARP_NOTES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

export const FLAT_NOTES = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
] as const;

const NOTE_TO_SEMITONE: Record<string, number> = {
  "C": 0,
  "B#": 0,
  "C#": 1,
  "DB": 1,
  "Db": 1,
  "D": 2,
  "D#": 3,
  "EB": 3,
  "Eb": 3,
  "E": 4,
  "FB": 4,
  "Fb": 4,
  "F": 5,
  "E#": 5,
  "F#": 6,
  "GB": 6,
  "Gb": 6,
  "G": 7,
  "G#": 8,
  "AB": 8,
  "Ab": 8,
  "A": 9,
  "A#": 10,
  "BB": 10,
  "Bb": 10,
  "B": 11,
  "CB": 11,
  "Cb": 11,
};

// Keys where sharps are standard (C, G, D, A, E, B, F#, C#)
const SHARP_KEYS = new Set([
  "C",
  "G",
  "D",
  "A",
  "E",
  "B",
  "F#",
  "C#",
  "Em",
  "Bm",
  "F#m",
  "C#m",
  "G#m",
  "D#m",
]);

/**
 * Transposes a single note by a given number of semitones.
 */
export function transposeNote(note: string, semitones: number, preferSharps = true): string {
  const normNote = note.trim();
  if (!(normNote in NOTE_TO_SEMITONE)) {
    return note;
  }
  const currentSemitone = NOTE_TO_SEMITONE[normNote];
  let targetSemitone = (currentSemitone + semitones) % 12;
  if (targetSemitone < 0) targetSemitone += 12;

  return preferSharps ? SHARP_NOTES[targetSemitone] : FLAT_NOTES[targetSemitone];
}

/** Each pitch class's key name with the fewest accidentals, major then minor. */
const MAJOR_KEY_BY_PITCH = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_KEY_BY_PITCH = [
  "Cm",
  "C#m",
  "Dm",
  "Ebm",
  "Em",
  "Fm",
  "F#m",
  "Gm",
  "G#m",
  "Am",
  "Bbm",
  "Bm",
];

// Keys whose signatures carry flats; chords in them are spelled with flats.
const FLAT_KEYS = new Set([
  "F",
  "Bb",
  "Eb",
  "Ab",
  "Db",
  "Gb",
  "Cb",
  "Dm",
  "Gm",
  "Cm",
  "Fm",
  "Bbm",
  "Ebm",
  "Abm",
]);

/**
 * Transposes a key name (e.g. "G", "Em", "G major") by a given number of semitones, naming the
 * result with the fewest accidentals: "G" up 3 is "Bb", not "A#". Returns undefined when the key
 * has no recognisable root.
 */
export function transposeKey(key: string, semitones: number): string | undefined {
  const trimmed = key.trim();
  const match = trimmed.match(/^([A-G][#b]?)(m(?!aj))?/);
  if (!match || !(match[1] in NOTE_TO_SEMITONE)) return undefined;
  const pitch = ((NOTE_TO_SEMITONE[match[1]] + semitones) % 12 + 12) % 12;
  const name = (match[2] ? MINOR_KEY_BY_PITCH : MAJOR_KEY_BY_PITCH)[pitch];
  return name + trimmed.slice(match[0].length);
}

/**
 * Whether chords in a key are spelled with sharps (true) or flats (false). Undefined for C major
 * and A minor, whose signatures carry neither, and for a key with no recognisable root.
 */
export function keyPrefersSharps(key: string): boolean | undefined {
  const name = transposeKey(key, 0)?.match(/^[A-G][#b]?m?/)?.[0];
  if (!name || name === "C" || name === "Am") return undefined;
  return !FLAT_KEYS.has(name);
}

/** The key a song's guitar chords are in: its `guitarKey`, or failing that its first chord. */
export function songGuitarKey(song: SongDefinition): string | undefined {
  if (song.metadata.guitarKey) return song.metadata.guitarKey;
  for (const section of song.sections) {
    for (const line of section.lines) {
      const marker = typeof line.lyrics === "string" ? line.lyrics.match(/\[([^\]|]+)/) : null;
      const chord = marker?.[1] ?? line.guitarChords?.trim().split(/\s+/)[0];
      if (chord && chord.trim()) return chord.trim();
    }
  }
  return undefined;
}

/**
 * How chords sounding `capo` semitones above the guitar shapes are spelled: the sharps or flats
 * of the key they sound in. Undefined when that key is C major, A minor, or unknown.
 */
export function soundingPrefersSharps(song: SongDefinition, capo: number): boolean | undefined {
  const key = songGuitarKey(song);
  const sounding = key ? transposeKey(key, capo) : undefined;
  return sounding ? keyPrefersSharps(sounding) : undefined;
}

/**
 * Parses and transposes an individual chord token (e.g. "E", "C#m", "D/F#", "Aadd9", "G7", "G6/9").
 */
export function transposeChord(chord: string, semitones: number, preferSharps?: boolean): string {
  const trimmed = chord.trim();
  if (!trimmed) return chord;

  const match = trimmed.match(/^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/);
  if (!match) return chord;

  const root = match[1];
  const quality = match[2] || "";
  const slash = match[3];

  const useSharps = preferSharps !== undefined
    ? preferSharps
    : (root.includes("#") || SHARP_KEYS.has(root) || semitones >= 0);

  const transposedRoot = transposeNote(root, semitones, useSharps);
  const transposedSlash = slash ? "/" + transposeNote(slash, semitones, useSharps) : "";

  return `${transposedRoot}${quality}${transposedSlash}`;
}

/**
 * Transposes all chords in a spaced chord line while preserving character column alignment.
 */
export function transposeChordLine(
  line: string,
  semitones: number,
  preferSharps?: boolean,
): string {
  if (!line || semitones === 0) return line;

  // Match chords as non-whitespace clusters: e.g. "E", "D", "A", "C#m", "D/F#"
  const chordRegex = /[A-G][#b]?(?:6\/9|[^\s/])*(?:\/[A-G][#b]?)?/g;
  const matches: Array<{ chord: string; index: number }> = [];
  let m: RegExpExecArray | null;

  while ((m = chordRegex.exec(line)) !== null) {
    matches.push({ chord: m[0], index: m.index });
  }

  if (matches.length === 0) return line;

  const resultChars = new Array(line.length).fill(" ");

  for (let i = 0; i < matches.length; i++) {
    const { chord, index } = matches[i];
    const transposed = transposeChord(chord, semitones, preferSharps);

    // Write the transposed chord starting at the exact same index
    for (let c = 0; c < transposed.length; c++) {
      const pos = index + c;
      while (resultChars.length <= pos) {
        resultChars.push(" ");
      }
      resultChars[pos] = transposed[c];
    }
  }

  return resultChars.join("").replace(/\s+$/, "");
}

/**
 * Automatically calculates and populates sounding bass chords and metadata when capo is present.
 */
export function autoTransposeSong(song: SongDefinition): SongDefinition {
  const capo = song.metadata.capo || 0;
  const isDualTier = song.metadata.mode === "dual-tier" ||
    (capo > 0 && song.metadata.mode !== "single-tier");

  const cloned: SongDefinition = JSON.parse(JSON.stringify(song));
  cloned.metadata.mode = isDualTier ? "dual-tier" : "single-tier";

  if (isDualTier && capo > 0) {
    if (cloned.metadata.guitarKey && !cloned.metadata.bassKey) {
      cloned.metadata.bassKey = transposeKey(cloned.metadata.guitarKey, capo) ??
        transposeChord(cloned.metadata.guitarKey, capo);
    }

    const preferSharps = soundingPrefersSharps(song, capo);
    for (const section of cloned.sections) {
      for (const line of section.lines) {
        if (line.guitarChords && !line.bassChords) {
          line.bassChords = transposeChordLine(line.guitarChords, capo, preferSharps);
        }
      }
    }
  }

  return cloned;
}
