// src/accounting/receipt.ts
// Manage receipt scanning, inbox filing, and linking (web-jam-tools#1764).

import * as path from "@std/path";
import { expandHome } from "../design-issue/gate1.ts";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getReceiptFilename(date: string, place: string, ext = "pdf"): string {
  const cleanSlug = slugify(place);
  const cleanExt = ext.replace(/^\./, "");
  return `${date}-${cleanSlug}.${cleanExt}`;
}

export interface FileReceiptOptions {
  booksDir: string;
  year: number;
  date: string;
  place: string;
  sourceFile?: string;
}

export interface FileReceiptResult {
  filed: boolean;
  filedPath?: string;
  relativePath?: string;
  message: string;
}

export async function fileReceipt(options: FileReceiptOptions): Promise<FileReceiptResult> {
  const booksDir = path.resolve(expandHome(options.booksDir));
  const inboxDir = path.join(booksDir, "inbox");
  const receiptsYearDir = path.join(booksDir, "receipts", String(options.year));

  await Deno.mkdir(receiptsYearDir, { recursive: true });

  let srcPath: string | null = null;
  let extension = "pdf";

  if (options.sourceFile) {
    const candidate = path.isAbsolute(options.sourceFile)
      ? options.sourceFile
      : path.join(inboxDir, options.sourceFile);

    try {
      const stat = await Deno.stat(candidate);
      if (stat.isFile) {
        srcPath = candidate;
        const parsed = path.parse(candidate);
        if (parsed.ext) extension = parsed.ext.replace(/^\./, "");
      }
    } catch (_err) {
      // not found at candidate
    }
  }

  // If not explicitly specified, search inbox for any matching or available PDF
  if (!srcPath) {
    try {
      const entries: string[] = [];
      for await (const entry of Deno.readDir(inboxDir)) {
        if (entry.isFile && !entry.name.startsWith(".")) {
          entries.push(entry.name);
        }
      }

      if (entries.length === 1) {
        srcPath = path.join(inboxDir, entries[0]);
        const parsed = path.parse(entries[0]);
        if (parsed.ext) extension = parsed.ext.replace(/^\./, "");
      } else if (entries.length > 1) {
        const placeSlug = slugify(options.place);
        const matched = entries.find((e) =>
          e.toLowerCase().includes(placeSlug) || e.includes(options.date)
        );
        if (matched) {
          srcPath = path.join(inboxDir, matched);
          const parsed = path.parse(matched);
          if (parsed.ext) extension = parsed.ext.replace(/^\./, "");
        }
      }
    } catch (_err) {
      // inbox may not exist yet
    }
  }

  if (!srcPath) {
    return {
      filed: false,
      message: `No receipt file found in ${inboxDir}; entry itself serves as the record.`,
    };
  }

  const destFilename = getReceiptFilename(options.date, options.place, extension);
  const destPath = path.join(receiptsYearDir, destFilename);
  const relPath = path.join("receipts", String(options.year), destFilename);

  // Move from inbox to receipts/<year>/
  await Deno.rename(srcPath, destPath);

  return {
    filed: true,
    filedPath: destPath,
    relativePath: relPath,
    message: `Receipt filed to ${relPath}`,
  };
}
