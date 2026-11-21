import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { classifyBytes } from './file-kind';
import { officeText } from './office-text';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): Uint8Array => strToU8(text);

const docx = zipSync({
  'word/document.xml': strToU8(
    '<w:document><w:body><w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t xml:space="preserve">&amp; welcome</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second &#65;&#x42;</w:t></w:r></w:p></w:body></w:document>',
  ),
});
const pptx = zipSync({
  'ppt/slides/slide10.xml': strToU8('<p:sld><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>'),
  'ppt/slides/slide2.xml': strToU8(
    '<p:sld><a:p><a:r><a:t>Two</a:t></a:r></a:p><a:p><a:r><a:t>&lt;b&gt;</a:t></a:r></a:p></p:sld>',
  ),
});

describe('classifyBytes', () => {
  it('tells a file by its bytes, never by its name', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0);
    expect(classifyBytes(png)).toEqual({ kind: 'image', mediaType: 'image/png' });
    expect(classifyBytes(bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({
      kind: 'image',
      mediaType: 'image/jpeg',
    });
    expect(classifyBytes(ascii('RIFF\0\0\0\0WEBPVP8 '))).toEqual({
      kind: 'image',
      mediaType: 'image/webp',
    });
    expect(classifyBytes(ascii('%PDF-1.7\n\0\0'))).toEqual({
      kind: 'pdf',
      mediaType: 'application/pdf',
    });
    expect(classifyBytes(docx)?.kind).toBe('docx');
    expect(classifyBytes(pptx)?.kind).toBe('pptx');
    expect(classifyBytes(ascii('WEBVTT\n\n00:00 --> 00:01\nhi'))?.kind).toBe('text');
    expect(classifyBytes(bytes(0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62))?.kind).toBe('text');
    expect(classifyBytes(bytes(0x61, 0x00, 0x62))).toBeNull();
    expect(classifyBytes(bytes(0xc3, 0x28))).toBeNull();
    expect(classifyBytes(zipSync({ 'notes.txt': ascii('hello') }))).toBeNull();
  });
});

describe('officeText', () => {
  it('reads a docx paragraph by paragraph and a pptx slide by slide in order', () => {
    expect(officeText('docx', docx)).toBe('Hello & welcome\nSecond AB\n');
    expect(
      officeText('docx', zipSync({ 'word/document.xml': strToU8('<w:p>a<w:p>'.repeat(3)) })),
    ).toBe('\n');
    expect(officeText('pptx', pptx)).toBe('## Slide 2\nTwo\n<b>\n\n## Slide 10\nTen\n');
  });
});
