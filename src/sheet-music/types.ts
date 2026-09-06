/**
 * src/sheet-music/types.ts
 *
 * Types for sheet music lead sheet generation and harmonic transposition (web-jam-tools#770, web-jam-tools#771).
 */

export interface ChordLyricLine {
  /** Lyrics text (e.g. "I'll meet you there in the narthex") */
  lyrics: string;
  /** Guitar capo chords positioned at character indices (or space-padded string) */
  guitarChords?: string;
  /** Bass sounding chords positioned at character indices (or space-padded string) */
  bassChords?: string;
  /** Single-tier chords when guitar and bass share the same key/no capo */
  chords?: string;
  /** Optional performance annotations (e.g. "[mp]", "[soft]", "[no bass]") */
  annotation?: string;
}

export interface SongSection {
  /** Section heading (e.g. "VERSE 1", "CHORUS", "BRIDGE") */
  title: string;
  /** Ordered list of chord/lyric lines */
  lines: ChordLyricLine[];
}

export interface SongMetadata {
  /** Song title (e.g. "NARTHEX") */
  title: string;
  /** Composer / songwriter credits (e.g. "w/m Jonathan Rundman 2003") */
  composer?: string;
  /** Optional copyright or year information */
  copyright?: string;
  /** Optional tempo or feel indication (e.g. "Moderate", "120 BPM") */
  tempo?: string;
  /** Guitar capo fret offset in semitones (e.g. 2 for Capo 2) */
  capo?: number;
  /** Base key shape for guitar (e.g. "E") */
  guitarKey?: string;
  /** Sounding concert key for bass guitar (e.g. "F#") */
  bassKey?: string;
  /** Harmonic layout mode: "dual-tier" (Capo Guitar + Sounding Bass) or "single-tier" (Shared Chords) */
  mode?: "dual-tier" | "single-tier";
  /** Optional explicit legend override */
  legend?: string;
  /** General performance notes */
  performanceNotes?: string[];
}

export interface SongDefinition {
  metadata: SongMetadata;
  sections: SongSection[];
}
