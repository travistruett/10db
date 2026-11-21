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

/** Most text one XML part may yield; a part that would yield more is cut there. */
const MAX_PART_CHARS = 4 * 1024 * 1024;

const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char);

/** The text of the runs in one paragraph's XML: each `<ns:t>`'s text, and a tab for `<ns:tab/>`. */
function runsOf(body: string, ns: 'w' | 'a'): string {
  const open = `<${ns}:t`;
  const close = `</${ns}:t>`;
  let text = '';
  let at = 0;
  for (;;) {
    const start = body.indexOf(open, at);
    if (start < 0) return text;
    const next = body[start + open.length];
    at = start + open.length;
    if (next === '>' || isSpace(next)) {
      const tagEnd = body.indexOf('>', at);
      if (tagEnd < 0) return text;
      // A self-closed `<ns:t/>` holds nothing.
      if (body[tagEnd - 1] === '/') {
        at = tagEnd + 1;
        continue;
      }
      const end = body.indexOf(close, tagEnd);
      if (end < 0) return text;
      text += decodeEntities(body.slice(tagEnd + 1, end));
      at = end + close.length;
    } else if (body.startsWith('ab', at)) {
      // Only a bare `<ns:tab/>` is a tab character; a tab stop inside `<ns:tabs>` has attributes.
      let i = at + 2;
      while (isSpace(body[i])) i += 1;
      if (body.startsWith('/>', i)) text += '\t';
    }
  }
}

/**
 * The text of each paragraph of `xml`, where `ns` is `w` (Word) or `a` (PowerPoint). One forward scan
 * with `indexOf`: a part with openers and no closers is read once, never once per opener.
 */
function paragraphs(xml: string, ns: 'w' | 'a'): string[] {
  const open = `<${ns}:p`;
  const close = `</${ns}:p>`;
  const found: string[] = [];
  let chars = 0;
  let at = 0;
  while (chars < MAX_PART_CHARS) {
    const start = xml.indexOf(open, at);
    if (start < 0) break;
    at = start + open.length;
    // `<w:pPr>` and the like are other elements.
    const next = xml[at];
    if (next !== '>' && !isSpace(next)) continue;
    const tagEnd = xml.indexOf('>', at);
    if (tagEnd < 0) break;
    if (xml[tagEnd - 1] === '/') {
      at = tagEnd + 1;
      continue;
    }
    const end = xml.indexOf(close, tagEnd);
    if (end < 0) break;
    const line = runsOf(xml.slice(tagEnd + 1, end), ns);
    chars += line.length + 1;
    found.push(line);
    at = end + close.length;
  }
  return found;
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
