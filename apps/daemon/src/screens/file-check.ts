import { basename, extname } from 'node:path';
import { InvalidError, ShapeFileKind } from '@10db/contracts';

// What a file the builder hands in must be before a session sees it: a file dropped into a Plan
// conversation (Shape spec §5.4) and a picture pasted into a task's thread (Workbench spec §4.3).

/** The magic bytes of each binary kind: Claude rejects a mislabelled image, which would end the turn. */
const SIGNATURES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  [ShapeFileKind.Png]: (b) =>
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => b[i] === byte),
  [ShapeFileKind.Jpeg]: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  [ShapeFileKind.Webp]: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  [ShapeFileKind.Pdf]: (b) => ascii(b, 0, 5) === '%PDF-',
};

const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.slice(from, to));

const LABEL: Readonly<Record<string, string>> = {
  [ShapeFileKind.Png]: 'PNG',
  [ShapeFileKind.Jpeg]: 'JPEG',
  [ShapeFileKind.Webp]: 'WebP',
  [ShapeFileKind.Pdf]: 'PDF',
};

/** A name with no directory in it and nothing a terminal would act on. */
export function safeFileName(name: string): string {
  const base = basename(name.replaceAll('\\', '/'))
    .replace(/\p{Cc}/gu, '')
    .trim();
  return base === '' || base.startsWith('.') ? `file${extname(base)}` : base;
}

/**
 * Throws, naming the file, when its bytes do not begin as its kind's do. A text kind has no
 * signature and passes.
 */
export function refuseMislabelledBytes(name: string, kind: ShapeFileKind, bytes: Uint8Array): void {
  const signed = SIGNATURES[kind];
  if (signed !== undefined && !signed(bytes))
    throw new InvalidError(`${name} isn't really a ${LABEL[kind] ?? 'file of that type'}`);
}
