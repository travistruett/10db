import { InvalidError } from '@10db/contracts';
import { strFromU8, unzipSync } from 'fflate';

// A .docx or .pptx as the Markdown a session reads: a ZIP of XML, so a paragraph is a `<w:p>` or `<a:p>`
// and its text the runs inside.

/** The most a document may inflate to; a ZIP that claims more is a bomb, not a document. */
const MAX_INFLATED_BYTES = 50 * 1024 * 1024;

const ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** One pass, so `&amp;lt;` stays `&lt;`. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g,
    (whole, dec, hex, name) => {
      if (typeof name === 'string') return ENTITIES[name] ?? whole;
      const code = typeof dec === 'string' ? Number(dec) : parseInt(String(hex), 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}

/** The text of each paragraph of `xml`, where `ns` is `w` (Word) or `a` (PowerPoint). */
function paragraphs(xml: string, ns: 'w' | 'a'): string[] {
  const para = new RegExp(`<${ns}:p(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:p>`, 'g');
  const run = new RegExp(`<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>|<${ns}:tab\\s*/>`, 'g');
  return [...xml.matchAll(para)].map(([, body]) =>
    [...(body ?? '').matchAll(run)]
      .map(([, text]) => (text === undefined ? '\t' : decodeEntities(text)))
      .join(''),
  );
}

function unzipped(
  bytes: Uint8Array,
  wanted: (name: string) => boolean,
): Record<string, Uint8Array> {
  let inflated = 0;
  try {
    return unzipSync(bytes, {
      filter: (entry) => {
        if (!wanted(entry.name)) return false;
        inflated += entry.originalSize;
        if (inflated > MAX_INFLATED_BYTES)
          throw new InvalidError('The file is too large once opened');
        return true;
      },
    });
  } catch (error) {
    if (error instanceof InvalidError) throw error;
    throw new InvalidError("The file can't be opened");
  }
}

/** The document's text: a line per paragraph, or a `## Slide N` section per slide, in slide order. */
export function officeText(kind: 'docx' | 'pptx', bytes: Uint8Array): string {
  if (kind === 'docx') {
    const entries = unzipped(bytes, (name) => name === 'word/document.xml');
    const xml = entries['word/document.xml'];
    if (xml === undefined) throw new InvalidError("The file can't be opened");
    return `${paragraphs(strFromU8(xml), 'w').join('\n')}\n`;
  }
  const entries = unzipped(bytes, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const slides = Object.entries(entries)
    .map(([name, xml]) => ({ n: Number(/(\d+)\.xml$/.exec(name)?.[1]), xml }))
    .sort((a, b) => a.n - b.n);
  return slides
    .map(({ n, xml }) => `## Slide ${String(n)}\n${paragraphs(strFromU8(xml), 'a').join('\n')}\n`)
    .join('\n');
}
