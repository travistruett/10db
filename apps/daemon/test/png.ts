import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RED = [0xd0, 0x20, 0x20];
const BLUE = [0x20, 0x40, 0xd0];

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/**
 * A PNG that claims this size, and has no picture: a header, `pad` bytes of text, the end. The daemon
 * reads its size and keeps it whole; a decoder cannot draw it, so it is cheap at any size.
 */
export function pngOfSize(width: number, height: number, pad = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    ...(pad === 0 ? [] : [chunk('tEXt', Buffer.alloc(pad, 0x20))]),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A real PNG any decoder opens: the left half red, the right half blue. `pad` adds that many bytes of
 * ancillary text, for a picture too big to keep.
 */
export function pngImage(width: number, height: number, pad = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // Eight bits, RGB, the only methods there are, no interlace.
  const pixels = Array.from({ length: width }, (_, x) => (x < width / 2 ? RED : BLUE)).flat();
  const row = Buffer.from([0, ...pixels]); // Filter 0 on each row: the bytes as they are.
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    ...(pad === 0 ? [] : [chunk('tEXt', Buffer.alloc(pad, 0x20))]),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
