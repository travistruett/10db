import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { extractText } from './extraction';

// A session that can't read a PDF (Codex takes no file input) is handed its text, kept in a `text`
// folder beside the PDFs. `storeFile` writes only straight into the files folder, so no dropped file's
// name can ever be this path.

/** Where a PDF's extracted text is kept. */
export const pdfTextPath = (storedPath: string): string =>
  join(dirname(storedPath), 'text', `${basename(storedPath)}.txt`);

/**
 * Keeps the PDF's text beside it and answers the path it wrote, or null when the PDF has no text.
 * Throws when the PDF can't be read in time.
 */
export async function keepPdfText(
  storedPath: string,
  bytes: Uint8Array,
  deadlineMs?: number,
): Promise<string | null> {
  const text = await extractText({ kind: 'pdf', bytes }, deadlineMs);
  if (text === null) return null;
  const path = pdfTextPath(storedPath);
  mkdirSync(dirname(path), { recursive: true });
  // `wx`: never over a file that is already there.
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  return path;
}
