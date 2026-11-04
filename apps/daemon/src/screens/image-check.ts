import { ScreenMediaType } from '@10db/contracts';

// What the daemon checks of a screenshot before a model sees it and a conversation keeps it. The
// window is trusted to draw; it is not trusted to send an image, which Claude rejects when mislabelled
// (and a rejected image ends the turn).

export interface ImageHeader {
  readonly mediaType: ScreenMediaType;
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The last chunk of every PNG, always the same twelve bytes: empty, IEND, its checksum. */
const PNG_END = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
/** A signature, a whole IHDR chunk and the end chunk: no PNG is shorter. */
const PNG_LEAST = 8 + 25 + PNG_END.length;

function pngHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < PNG_LEAST || !PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The first chunk of every PNG is IHDR, which carries the size.
  if (view.getUint32(12) !== 0x49484452) return null;
  if (!PNG_END.every((byte, i) => bytes[bytes.length - PNG_END.length + i] === byte)) return null;
  return { mediaType: ScreenMediaType.Png, width: view.getUint32(16), height: view.getUint32(20) };
}

/** The start-of-frame markers, which carry a JPEG's size; the others in that range are not frames. */
const isFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpegHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  // A JPEG ends in EOI, so one that was cut short does not.
  if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (isFrame(marker)) {
      if (at + 9 > bytes.length) return null;
      return {
        mediaType: ScreenMediaType.Jpeg,
        height: view.getUint16(at + 5),
        width: view.getUint16(at + 7),
      };
    }
    at += 2 + view.getUint16(at + 2);
  }
  return null;
}

/** What the bytes really are and how big, or null when they are not a whole PNG or JPEG. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  return pngHeader(bytes) ?? jpegHeader(bytes);
}
