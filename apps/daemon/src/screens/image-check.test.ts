import { describe, expect, it } from 'vitest';
import { readImageHeader } from './image-check';

// A screenshot is checked by what its bytes are, never by what the window called them.

const PNG = Buffer.alloc(33);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(PNG, 0);
PNG.writeUInt32BE(13, 8);
PNG.write('IHDR', 12, 'ascii');
PNG.writeUInt32BE(1200, 16);
PNG.writeUInt32BE(900, 20);

/** SOI, an APP0 segment, then a baseline frame header: what a JPEG opens with. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Array.from({ length: 14 }, () => 0)]);
  const frame = Buffer.alloc(19);
  frame.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame]);
}

describe('readImageHeader', () => {
  it('reads a PNG’s size from its header', () => {
    expect(readImageHeader(PNG)).toEqual({ mediaType: 'image/png', width: 1200, height: 900 });
  });

  it('reads a JPEG’s size from its frame header, past the segments before it', () => {
    expect(readImageHeader(jpeg(800, 600))).toEqual({
      mediaType: 'image/jpeg',
      width: 800,
      height: 600,
    });
  });

  it('knows nothing else for an image: html, svg, a cut header, nothing', () => {
    for (const bytes of [
      Buffer.from('<html></html>'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      PNG.subarray(0, 20),
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(0),
    ])
      expect(readImageHeader(bytes)).toBeNull();
  });

  it('does not read past a JPEG that ends before its frame', () => {
    expect(readImageHeader(jpeg(800, 600).subarray(0, 24))).toBeNull();
  });
});
