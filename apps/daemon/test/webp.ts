/**
 * A WebP with a real header of the given kind and size, whose picture data is `pad` bytes of nothing:
 * enough for the daemon to read its size, not for a decoder to draw it.
 */
export function webpImage(
  kind: 'lossy' | 'lossless' | 'extended',
  width: number,
  height: number,
  pad = 0,
): Buffer {
  const head = Buffer.alloc(10);
  const fourcc = { lossy: 'VP8 ', lossless: 'VP8L', extended: 'VP8X' }[kind];
  if (kind === 'lossy') {
    head.set([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a]);
    head.writeUInt16LE(width, 6);
    head.writeUInt16LE(height, 8);
  } else if (kind === 'lossless') {
    head[0] = 0x2f;
    head.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  } else {
    head.writeUIntLE(width - 1, 4, 3);
    head.writeUIntLE(height - 1, 7, 3);
  }
  const data = Buffer.concat([head, Buffer.alloc(pad)]);
  const chunk = Buffer.alloc(8);
  chunk.write(fourcc, 0, 'ascii');
  chunk.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from('WEBP'), chunk, data, Buffer.alloc(data.length % 2)]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
