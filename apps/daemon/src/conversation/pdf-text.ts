import { writeFileSync } from 'node:fs';
import { extractText, getDocumentProxy } from 'unpdf';

// A session that can't read a PDF (Codex takes no file input) is handed its text, kept beside the PDF.

/** Longest the extraction may run before the PDF is kept without text. */
export const PDF_TEXT_TIMEOUT_MS = 30_000;
/** Most text kept; a longer PDF is cut where this stops, with a line saying so. */
export const PDF_TEXT_MAX_BYTES = 2 * 1024 * 1024;

const CUT_LINE = '\n[10db cut the text here: the PDF has more.]\n';

/** Where a PDF's extracted text is kept. */
export const pdfTextPath = (storedPath: string): string => `${storedPath}.txt`;

/** The PDF's text, cut to `PDF_TEXT_MAX_BYTES`, or null when it has none. Throws when it can't be read. */
export async function extractPdfText(
  bytes: Uint8Array,
  timeoutMs: number = PDF_TEXT_TIMEOUT_MS,
): Promise<string | null> {
  // pdf.js takes ownership of the buffer it is given.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  let timer: NodeJS.Timeout | undefined;
  try {
    const { text } = await Promise.race([
      extractText(pdf, { mergePages: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`reading the PDF took more than ${String(timeoutMs / 1000)} s`));
        }, timeoutMs);
      }),
    ]);
    if (text.trim() === '') return null;
    const encoded = Buffer.from(text, 'utf8');
    if (encoded.length <= PDF_TEXT_MAX_BYTES) return text;
    return `${encoded.subarray(0, PDF_TEXT_MAX_BYTES).toString('utf8').replace(/�$/, '')}${CUT_LINE}`;
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps the PDF's text beside it; a PDF with none, or one that can't be read, gets no file and a log line. */
export async function keepPdfText(
  storedPath: string,
  bytes: Uint8Array,
  warn: (error: unknown) => void,
): Promise<void> {
  try {
    const text = await extractPdfText(bytes);
    if (text !== null) writeFileSync(pdfTextPath(storedPath), text, { mode: 0o600 });
  } catch (error) {
    warn(error);
  }
}
