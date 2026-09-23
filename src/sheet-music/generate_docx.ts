#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * src/sheet-music/generate_docx.ts
 *
 * CLI tool for generating Word (.docx) lead sheets from structured song definitions (web-jam-tools#770, web-jam-tools#771).
 * Protects hand-edited lead sheets with a generator tag and content fingerprint (web-jam-tools#1011).
 */

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import { Packer } from "docx";
import type { SongDefinition } from "./types.ts";
import { buildSongDocument } from "./builder.ts";

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

/**
 * Computes the lowercase hex-encoded SHA-256 hash of a byte array.
 */
export async function computeSha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Decompresses raw deflate payload using the standard Web DecompressionStream API.
 */
export async function decompressDeflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(compressed as unknown as BodyInit).body!.pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return await new Response(stream).bytes();
}

export interface DocxZipEntries {
  docXml?: Uint8Array;
  customXml?: Uint8Array;
}

/**
 * Parses a docx/zip binary buffer and extracts word/document.xml and docProps/custom.xml.
 */
export async function readDocxEntries(bytes: Uint8Array): Promise<DocxZipEntries> {
  if (bytes.length < 22) {
    throw new Error("File is too small to be a valid docx archive");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  const minOffset = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error("End of Central Directory signature (0x06054b50) not found");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  if (cdOffset + cdSize > bytes.length) {
    throw new Error("Central Directory extends beyond file boundaries");
  }

  const decoder = new TextDecoder();
  let pos = cdOffset;
  let docXml: Uint8Array | undefined;
  let customXml: Uint8Array | undefined;

  for (let e = 0; e < totalEntries; e++) {
    if (pos + 46 > bytes.length) {
      throw new Error("Central Directory entry header truncated");
    }
    if (view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header signature at offset ${pos}`);
    }

    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    if (pos + 46 + nameLen > bytes.length) {
      throw new Error("Entry filename truncated");
    }

    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));

    if (name === "word/document.xml" || name === "docProps/custom.xml") {
      if (localHeaderOffset + 30 > bytes.length) {
        throw new Error(`Local file header truncated for ${name}`);
      }
      if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
        throw new Error(`Invalid local file header signature for ${name}`);
      }

      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

      if (dataOffset + compSize > bytes.length) {
        throw new Error(`Compressed payload truncated for ${name}`);
      }

      const compressedData = bytes.subarray(dataOffset, dataOffset + compSize);
      let uncompressed: Uint8Array;
      if (method === 0) {
        uncompressed = compressedData;
      } else if (method === 8) {
        uncompressed = await decompressDeflateRaw(compressedData);
      } else {
        throw new Error(`Unsupported compression method ${method} for ${name}`);
      }

      if (name === "word/document.xml") {
        docXml = uncompressed;
      } else {
        customXml = uncompressed;
      }
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return { docXml, customXml };
}

/**
 * Parses XML string of docProps/custom.xml into property name-value mapping.
 */
export function parseCustomProperties(xmlContent: string): Map<string, string> {
  const props = new Map<string, string>();
  const propertyPattern = /<property\b([^>]*)>([\s\S]*?)<\/property>/gi;
  let match: RegExpExecArray | null;
  while ((match = propertyPattern.exec(xmlContent)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const nameMatch = attrs.match(/\bname=["']([^"']+)["']/i);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const valText = body.replace(/<[^>]+>/g, "").trim();
    props.set(name, valText);
  }
  return props;
}

export type DocxGuardStatus =
  | "absent" // file does not exist
  | "can_replace" // tagged and fingerprint matches
  | "modified" // tagged but fingerprint mismatch (hand-edited)
  | "untagged" // valid docx/zip but missing sheetMusicGenerator tag
  | "unreadable"; // file cannot be read or is invalid docx/zip (fails closed)

export interface DocxInspectionResult {
  status: DocxGuardStatus;
  generator?: string;
  fingerprint?: string;
  currentSha256?: string;
  error?: string;
}

/**
 * Inspects an existing docx file at the given path to determine overwrite guard status.
 */
export async function inspectExistingDocx(filePath: string): Promise<DocxInspectionResult> {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(filePath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { status: "absent" };
    }
    return {
      status: "unreadable",
      error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let entries: DocxZipEntries;
  try {
    entries = await readDocxEntries(bytes);
  } catch (err) {
    return {
      status: "unreadable",
      error: `Invalid docx archive: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!entries.docXml) {
    return {
      status: "unreadable",
      error: "Archive is missing word/document.xml",
    };
  }

  const currentSha256 = await computeSha256Hex(entries.docXml);

  if (!entries.customXml) {
    return { status: "untagged", currentSha256 };
  }

  const decoder = new TextDecoder();
  const customXmlStr = decoder.decode(entries.customXml);
  const customProps = parseCustomProperties(customXmlStr);

  const generator = customProps.get("sheetMusicGenerator");
  const storedFingerprint = customProps.get("sheetMusicFingerprint");

  if (!generator) {
    return { status: "untagged", currentSha256 };
  }

  if (!storedFingerprint || storedFingerprint !== currentSha256) {
    return {
      status: "modified",
      generator,
      fingerprint: storedFingerprint,
      currentSha256,
    };
  }

  return {
    status: "can_replace",
    generator,
    fingerprint: storedFingerprint,
    currentSha256,
  };
}

/**
 * Computes next free file path when destination file is protected:
 * `<name> (2).docx`, `<name> (3).docx`, etc.
 */
export async function findNextAvailablePath(basePath: string): Promise<string> {
  const parsed = path.parse(basePath);
  let baseName = parsed.name;
  let nextNum = 2;
  const match = parsed.name.match(/^(.*?)\s*\((\d+)\)$/);
  if (match) {
    baseName = match[1];
    nextNum = parseInt(match[2], 10) + 1;
  }
  while (true) {
    const candidate = path.join(parsed.dir, `${baseName} (${nextNum})${parsed.ext}`);
    try {
      await Deno.stat(candidate);
      nextNum++;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        return candidate;
      }
      throw err;
    }
  }
}

/**
 * Builds a docx buffer stamped with sheetMusicGenerator and sheetMusicFingerprint.
 */
export async function generateFingerprintedDocx(
  song: SongDefinition,
): Promise<{ buffer: Uint8Array; fingerprint: string }> {
  // 1. Initial pass to extract word/document.xml and compute fingerprint
  const docInitial = buildSongDocument(song);
  const bufInitial = await Packer.toBuffer(docInitial);
  const bytesInitial = new Uint8Array(
    bufInitial.buffer,
    bufInitial.byteOffset,
    bufInitial.byteLength,
  );
  const entriesInitial = await readDocxEntries(bytesInitial);
  if (!entriesInitial.docXml) {
    throw new Error("Failed to extract word/document.xml from generated document");
  }
  const fingerprint = await computeSha256Hex(entriesInitial.docXml);

  // 2. Final pass adding customProperties with generator tag and computed fingerprint
  const docFinal = buildSongDocument(song, [
    { name: "sheetMusicGenerator", value: "web-jam-tools" },
    { name: "sheetMusicFingerprint", value: fingerprint },
  ]);

  const bufFinal = await Packer.toBuffer(docFinal);
  const buffer = new Uint8Array(bufFinal.buffer, bufFinal.byteOffset, bufFinal.byteLength);

  // A file that reaches disk untagged would read as "untagged" on every later run and pile up
  // numbered copies with no error, so the stamp is read back from the built bytes before returning.
  const stamped = await readDocxEntries(buffer);
  const props = stamped.customXml
    ? parseCustomProperties(new TextDecoder().decode(stamped.customXml))
    : new Map<string, string>();
  const finalFingerprint = stamped.docXml ? await computeSha256Hex(stamped.docXml) : undefined;
  if (
    props.get("sheetMusicGenerator") !== "web-jam-tools" ||
    props.get("sheetMusicFingerprint") !== fingerprint || finalFingerprint !== fingerprint
  ) {
    throw new Error(
      "Generated lead sheet is missing its sheetMusicGenerator/sheetMusicFingerprint stamp, or its word/document.xml does not match the fingerprint; refusing to write an unprotectable file",
    );
  }
  return { buffer, fingerprint };
}

export interface WriteSongDocxResult {
  destPath: string;
  actualPath: string;
  action:
    | "created"
    | "replaced"
    | "protected_modified"
    | "protected_untagged"
    | "protected_unreadable";
  fingerprint: string;
  bytesWritten: number;
  message: string;
}

/**
 * Writes a lead sheet docx to disk with overwrite protection checks.
 */
export async function writeSongDocx(
  song: SongDefinition,
  destPath: string,
): Promise<WriteSongDocxResult> {
  const inspection = await inspectExistingDocx(destPath);
  let targetPath = destPath;
  let action: WriteSongDocxResult["action"] = "created";
  let message = "";

  if (inspection.status === "absent") {
    action = "created";
    targetPath = destPath;
  } else if (inspection.status === "can_replace") {
    action = "replaced";
    targetPath = destPath;
  } else if (inspection.status === "modified") {
    action = "protected_modified";
    targetPath = await findNextAvailablePath(destPath);
    message =
      `[sheet-music] Refusing to overwrite hand-edited file at ${destPath} (content modified since generation); left untouched, wrote new lead sheet to ${targetPath}`;
  } else if (inspection.status === "untagged") {
    action = "protected_untagged";
    targetPath = await findNextAvailablePath(destPath);
    message =
      `[sheet-music] Refusing to overwrite untagged file at ${destPath}; left untouched, wrote new lead sheet to ${targetPath}`;
  } else if (inspection.status === "unreadable") {
    action = "protected_unreadable";
    targetPath = await findNextAvailablePath(destPath);
    message = `[sheet-music] Unable to read existing file at ${destPath} (${
      inspection.error || "invalid or unreadable"
    }); refusing to overwrite, left untouched, wrote new lead sheet to ${targetPath}`;
  }

  const { buffer, fingerprint } = await generateFingerprintedDocx(song);
  await Deno.writeFile(targetPath, buffer);

  if (!message) {
    if (action === "replaced") {
      message =
        `[sheet-music] Replaced untouched generated lead sheet: ${targetPath} (${buffer.byteLength} bytes)`;
    } else {
      message = `[sheet-music] Generated lead sheet: ${targetPath} (${buffer.byteLength} bytes)`;
    }
  }

  return {
    destPath,
    actualPath: targetPath,
    action,
    fingerprint,
    bytesWritten: buffer.byteLength,
    message,
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
    const result = await writeSongDocx(song, destPath);
    console.log(result.message);
    return 0;
  } catch (err) {
    console.error(`Error generating docx: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await runCli(Deno.args));
}
