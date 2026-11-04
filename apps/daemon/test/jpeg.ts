/**
 * A JPEG that claims this size, and has no picture: SOI, a frame header, `pad` bytes of comment, EOI.
 * The daemon reads its size and keeps it whole; a decoder cannot draw it.
 */
export function jpegOfSize(width: number, height: number, pad = 0): Buffer {
  const frame = Buffer.alloc(19);
  frame.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  const comment = Buffer.alloc(pad === 0 ? 0 : pad + 4, 0x20);
  if (pad !== 0) {
    comment.set([0xff, 0xfe]);
    comment.writeUInt16BE(pad + 2, 2);
  }
  return Buffer.concat([Buffer.from([0xff, 0xd8]), comment, frame, Buffer.from([0xff, 0xd9])]);
}
