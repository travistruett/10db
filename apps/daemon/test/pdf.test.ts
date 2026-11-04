import { describe, expect, it } from 'vitest';
import { textPdf } from './pdf';

describe('textPdf', () => {
  it('writes a cross-reference table a PDF reader can follow to every object', () => {
    const body = textPdf(5).toString('latin1');
    expect(body.startsWith('%PDF-1.4\n')).toBe(true);
    expect(body.match(/\/Type \/Page\b/g)).toHaveLength(5);
    expect(body).toContain('/Count 5');

    const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(body)?.[1]);
    expect(body.slice(xref).startsWith('xref\n')).toBe(true);
    const offsets = [...body.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    // The catalog, the page tree, the font, and a page and its text for each page.
    expect(offsets).toHaveLength(3 + 5 * 2);
    offsets.forEach((offset, i) => {
      expect(body.slice(offset).startsWith(`${String(i + 1)} 0 obj\n`)).toBe(true);
    });
  });

  it('declares each text stream at its real length', () => {
    const body = textPdf(2).toString('latin1');
    for (const [, length, stream] of body.matchAll(
      /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g,
    ))
      expect(stream).toHaveLength(Number(length));
  });

  it('is small on disk', () => {
    expect(textPdf(40).length).toBeLessThan(300_000);
  });
});
