import { getDocumentProxy } from 'unpdf';

// Runs inside the extraction worker (`extract-worker.ts`), which is terminated when its work is done or
// its deadline passes; it imports nothing from the daemon, because a worker loads it on its own.

/** Most text kept; a longer PDF is cut where this stops, with a line saying so. */
export const PDF_TEXT_MAX_BYTES = 2 * 1024 * 1024;

const CUT_LINE = '\n[10db cut the text here: the PDF has more.]\n';

/** The PDF's text, page by page, cut at `PDF_TEXT_MAX_BYTES` as it is read; null when it has none. */
export async function pdfText(bytes: Uint8Array): Promise<string | null> {
  // pdf.js takes ownership of the buffer it is given.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: string[] = [];
  let size = 0;
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const content = await (await pdf.getPage(n)).getTextContent();
    let page = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      page += item.str;
      if (item.hasEOL) page += '\n';
    }
    pages.push(page);
    size += Buffer.byteLength(page) + 1;
    if (size > PDF_TEXT_MAX_BYTES) {
      const cut = Buffer.from(pages.join('\n'), 'utf8')
        .subarray(0, PDF_TEXT_MAX_BYTES)
        .toString('utf8')
        .replace(/�$/, '');
      return `${cut}${CUT_LINE}`;
    }
  }
  const text = pages.join('\n').trim();
  return text === '' ? null : text;
}
