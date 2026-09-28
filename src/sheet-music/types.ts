/**
 * src/sheet-music/types.ts
 *
 * Types for sheet music lead sheet generation and harmonic transposition (web-jam-tools#770, web-jam-tools#771).
 */

export interface ChordLyricLine {
  /** Lyrics text with inline chord markers (e.g. "re[C/E]member") */
  lyrics: string;
  /** Optional performance annotations (e.g. "[mp]", "[soft]", "[no bass]") */
  annotation?: string;
  /** Optional legacy/explicit guitar chords positioned at character indices */
  guitarChords?: string;
  /** Optional legacy/explicit bass chords positioned at character indices */
  bassChords?: string;
  /** Optional legacy/explicit single-tier chords when guitar and bass share the same key/no capo */
  chords?: string;
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

export interface RenderedLine {
  lyrics: string;
  guitarChords: string;
  bassChords?: string;
  chords?: string;
  annotation?: string;
}

export interface ParseLineOptions {
  mode?: "dual-tier" | "single-tier";
  capo?: number;
  maxLineWidth?: number;
  /** Spell transposed bass chords with sharps (true) or flats (false); unset keeps the default. */
  preferSharps?: boolean;
}
