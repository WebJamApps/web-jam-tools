#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * src/sheet-music/generate_docx.ts
 *
 * CLI tool for generating Word (.docx) lead sheets from structured song definitions (web-jam-tools#770, web-jam-tools#771).
 */

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import type { SongDefinition } from "./types.ts";
import { generateSongDocxBuffer } from "./builder.ts";

export interface GenerateDocxOptions {
  inputPath?: string;
  jsonString?: string;
  outputPath?: string;
  help?: boolean;
}

export function parseCliArgs(args: string[]): GenerateDocxOptions {
  const flags = parseArgs(args, {
    string: ["input", "i", "json", "j", "output", "o", "song"],
    boolean: ["help", "h"],
    alias: {
      i: "input",
      j: "json",
      o: "output",
      h: "help",
    },
  });

  return {
    inputPath: flags.input || flags.song || (flags._.length > 0 ? String(flags._[0]) : undefined),
    jsonString: flags.json,
    outputPath: flags.output || (flags._.length > 1 ? String(flags._[1]) : undefined),
    help: flags.help,
  };
}

export async function runCli(args: string[]): Promise<number> {
  const opts = parseCliArgs(args);

  if (opts.help || (!opts.inputPath && !opts.jsonString)) {
    console.log(`Usage: deno task sheet-music:generate [options]

Generates a formatted Word (.docx) lead sheet from a structured JSON song definition.

Options:
  -i, --input <file.json>   Path to JSON file containing SongDefinition
  -j, --json '<json>'       Raw JSON string of SongDefinition
  -o, --output <file.docx>  Output .docx destination file path
  -h, --help                Show this help message

Example:
  deno task sheet-music:generate --input /path/to/song.json --output /path/to/song.docx
`);
    return 0;
  }

  let song: SongDefinition;

  if (opts.jsonString) {
    try {
      song = JSON.parse(opts.jsonString) as SongDefinition;
    } catch (err) {
      console.error(
        `Error: Invalid JSON provided: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  } else if (opts.inputPath) {
    try {
      const text = await Deno.readTextFile(opts.inputPath);
      song = JSON.parse(text) as SongDefinition;
    } catch (err) {
      console.error(
        `Error reading input file '${opts.inputPath}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 1;
    }
  } else {
    console.error("Error: Missing input file or JSON string.");
    return 1;
  }

  if (!song.metadata?.title) {
    console.error("Error: SongDefinition must contain a metadata.title property.");
    return 1;
  }

  let destPath = opts.outputPath;
  if (!destPath) {
    if (opts.inputPath) {
      const parsed = path.parse(opts.inputPath);
      destPath = path.join(parsed.dir, `${parsed.name}.docx`);
    } else {
      const safeTitle = song.metadata.title.replace(/[^a-zA-Z0-9_\-]/g, "_");
      destPath = `./${safeTitle}.docx`;
    }
  }

  try {
    const buffer = await generateSongDocxBuffer(song);
    await Deno.writeFile(destPath, buffer);
    console.log(`[sheet-music] Generated lead sheet: ${destPath} (${buffer.byteLength} bytes)`);
    return 0;
  } catch (err) {
    console.error(`Error generating docx: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await runCli(Deno.args));
}
