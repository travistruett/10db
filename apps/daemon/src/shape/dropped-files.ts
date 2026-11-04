import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  InvalidError,
  isShapeImage,
  ShapeFileKind,
  shapeFileKind,
  shapeFileRefusal,
  type ShapeId,
} from '@10db/contracts';
<<<<<<< 93738ab9eca1046a9861462b59e02b9d10fe8414
import { readImageSize } from '../screens';
||||||| 83a19a1
=======
import { INLINE_CONVERSATION_MAX_BYTES, INLINE_IMAGE_MAX_BYTES, isImageName } from '../screens';
>>>>>>> 7bd48fdc156d7ecd81857be284588621434fee9b
import type { ShapeImage } from '../sessions';

// Shape spec §5.4. What a dropped file must be to reach the session, and where the daemon keeps it.

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

export interface CheckedFile {
  readonly name: string;
  readonly mediaType: ShapeFileKind;
}

/** Throws the reason a dropped file is refused, naming it; otherwise says what it is. */
export function checkDroppedFile(file: {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly held: number;
}): CheckedFile {
  const name = safeFileName(file.name);
  const refusal = shapeFileRefusal({
    name,
    size: file.bytes.length,
    mediaType: file.mediaType,
    held: file.held,
  });
  if (refusal !== null) throw new InvalidError(refusal);
  const kind = shapeFileKind(name);
  if (kind === null) throw new InvalidError(`${name} can't be added`);
  const signed = SIGNATURES[kind];
  if (signed !== undefined && !signed(file.bytes))
    throw new InvalidError(`${name} isn't really a ${LABEL[kind] ?? 'file of that type'}`);
  return { name, mediaType: kind };
}

// The API refuses an image over about 5 MB (base64) and a request over 32 MB, and a resumed session
// resends every earlier image with each request, so one oversize image would end every later turn.
// An image over a cap goes as a path, which `Read` takes in and resizes itself.
const MIB = 1024 * 1024;
interface FileSize {
  readonly id: string;
  readonly name: string;
  readonly size: number;
<<<<<<< 93738ab9eca1046a9861462b59e02b9d10fe8414
  readonly storedPath: string;
||||||| 83a19a1
=======
  /** Where the file is kept; given, an image's header is read to find a side the API would refuse. */
  readonly storedPath?: string;
>>>>>>> 7bd48fdc156d7ecd81857be284588621434fee9b
}

/** The most image bytes one message carries as content blocks. */
export const INLINE_IMAGES_MAX_BYTES = 6 * MIB;
/**
 * The longest side of an image sent as a content block. The API takes at most 2000 px a side when a
 * request holds more than 20 images, and a conversation's screens (12) and dropped images (20) can pass
 * that together, so a request that failed on it would fail every later turn too. Claude Code is not
 * known to shrink an image block, so a larger one goes as a path, which `Read` resizes.
 */
export const INLINE_IMAGE_MAX_SIDE = 2000;

/**
 * Whether the stored image is within the side cap. One whose size can't be read (cut short, or not
 * what its name says) is not: it would be sent blind, and a model refusing it ends every turn.
 */
function withinSideCap(storedPath: string): boolean {
  try {
    const size = readImageSize(readFileSync(storedPath));
    return size !== null && Math.max(size.width, size.height) <= INLINE_IMAGE_MAX_SIDE;
  } catch {
    return false;
  }
}

/** An image too big, in bytes or in pixels, to be a content block on its own. */
const tooBigAlone = (file: FileSize): boolean =>
  file.size > INLINE_IMAGE_MAX_BYTES || !withinSideCap(file.storedPath);

/** The API refuses an image longer than this on either side, however few bytes it takes. */
export const IMAGE_MAX_SIDE_PX = 8000;

const be16 = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const be32 = (b: Uint8Array, at: number): number => be16(b, at) * 0x10000 + be16(b, at + 2);
const le16 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const le24 = (b: Uint8Array, at: number): number => le16(b, at) | ((b[at + 2] ?? 0) << 16);

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

function pngSize(b: Uint8Array): ImageSize | null {
  if (ascii(b, 12, 16) !== 'IHDR' || b.length < 24) return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

/** Walks the JPEG's segments to its frame header (SOF), which an EXIF block may push far from the start. */
function jpegSize(b: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1; // Fill byte.
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2; // No length: a restart marker, or the start or end of the image.
      if (marker === 0xd9) return null;
    } else if (marker === 0xda) {
      return null; // The scan: no frame header came before it.
    } else if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return at + 9 <= b.length ? { height: be16(b, at + 5), width: be16(b, at + 7) } : null;
    } else {
      at += 2 + be16(b, at + 2);
    }
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  const form = ascii(b, 12, 16);
  if (form === 'VP8X' && b.length >= 30) return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  if (form === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (form === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const [b0, b1, b2, b3] = [b[21] ?? 0, b[22] ?? 0, b[23] ?? 0, b[24] ?? 0];
    return {
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
    };
  }
  return null;
}

/** The pixel size an image file's own header gives, or null for a kind that is no image or a header cut short. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  if (SIGNATURES[ShapeFileKind.Png]?.(bytes) === true) return pngSize(bytes);
  if (SIGNATURES[ShapeFileKind.Jpeg]?.(bytes) === true) return jpegSize(bytes);
  if (SIGNATURES[ShapeFileKind.Webp]?.(bytes) === true) return webpSize(bytes);
  return null;
}

/** Whether the file is an image with a side past what the API takes. One that can't be read is not. */
function tooManyPixels(file: FileSize): boolean {
  if (file.storedPath === undefined) return false;
  try {
    const size = imageSize(readFileSync(file.storedPath));
    return size !== null && Math.max(size.width, size.height) > IMAGE_MAX_SIDE_PX;
  } catch {
    return false;
  }
}

/**
 * The ids of the image files among `files` that go as content blocks, in order: each within the per-image
<<<<<<< 93738ab9eca1046a9861462b59e02b9d10fe8414
 * caps (bytes and pixels), and together within the per-message cap. Every other image goes as a path.
||||||| 83a19a1
 * cap, and together within the per-message cap. Every other image goes as a path.
=======
 * cap and the API's pixel limit, together within the per-message cap, and within what is left of the
 * conversation's cap after `spent` bytes sent earlier (`inlineBytesSpent`). Every other image goes as a path.
>>>>>>> 7bd48fdc156d7ecd81857be284588621434fee9b
 */
export function inlineImageIds(files: readonly FileSize[], spent = 0): Set<string> {
  const ids = new Set<string>();
  let total = 0;
  for (const file of files) {
<<<<<<< 93738ab9eca1046a9861462b59e02b9d10fe8414
    const kind = shapeFileKind(file.name);
    if (kind === null || !isShapeImage(kind)) continue;
    if (tooBigAlone(file) || total + file.size > INLINE_IMAGES_MAX_BYTES) continue;
||||||| 83a19a1
    const kind = shapeFileKind(file.name);
    if (kind === null || !isShapeImage(kind)) continue;
    if (file.size > INLINE_IMAGE_MAX_BYTES || total + file.size > INLINE_IMAGES_MAX_BYTES) continue;
=======
    if (!isImageName(file.name)) continue;
    if (
      file.size > INLINE_IMAGE_MAX_BYTES ||
      tooManyPixels(file) ||
      total + file.size > INLINE_IMAGES_MAX_BYTES ||
      spent + total + file.size > INLINE_CONVERSATION_MAX_BYTES
    )
      continue;
>>>>>>> 7bd48fdc156d7ecd81857be284588621434fee9b
    total += file.size;
    ids.add(file.id);
  }
  return ids;
}

/**
 * The ids of the images among `shown` (the files a message names) that reach Claude as a path alone
 * when `sent` (the files whose images the message carries) go as `inlineImageIds` says after `spent`
 * bytes sent earlier: an image over the per-image cap or the API's pixel limit, or one of `sent` the caps
 * left out. Any other shown image outside `sent` was sent earlier.
 */
export function pathImageIds(
  shown: readonly FileSize[],
  sent: readonly FileSize[],
  spent = 0,
): Set<string> {
  const inline = inlineImageIds(sent, spent);
  const sentIds = new Set(sent.map((file) => file.id));
  return new Set(
    shown
      .filter((file) => {
        const kind = shapeFileKind(file.name);
        if (kind === null || !isShapeImage(kind)) return false;
<<<<<<< 93738ab9eca1046a9861462b59e02b9d10fe8414
        return tooBigAlone(file) || (sentIds.has(file.id) && !inline.has(file.id));
||||||| 83a19a1
        return file.size > INLINE_IMAGE_MAX_BYTES || (sentIds.has(file.id) && !inline.has(file.id));
=======
        return (
          file.size > INLINE_IMAGE_MAX_BYTES ||
          tooManyPixels(file) ||
          (sentIds.has(file.id) && !inline.has(file.id))
        );
>>>>>>> 7bd48fdc156d7ecd81857be284588621434fee9b
      })
      .map((file) => file.id),
  );
}

/** The file as Claude takes it in a message: an image block, for the kinds that are images. */
export function asImage(kind: ShapeFileKind, bytes: Uint8Array): ShapeImage | null {
  if (!isShapeImage(kind)) return null;
  return { mediaType: kind, data: Buffer.from(bytes).toString('base64') };
}

/** Where a conversation's dropped files are kept, and the only place its session may read them. */
export const shapeFilesDir = (filesRoot: string, shapeId: ShapeId): string =>
  join(filesRoot, shapeId, 'files');

/** Writes the file under the conversation's files directory, never over another, and answers its path. */
export function storeFile(
  filesRoot: string,
  shapeId: ShapeId,
  name: string,
  bytes: Uint8Array,
): string {
  const dir = shapeFilesDir(filesRoot, shapeId);
  mkdirSync(dir, { recursive: true });
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n += 1) {
    const path = join(dir, n === 1 ? name : `${stem}-${String(n)}${ext}`);
    try {
      // `wx` fails on a name taken, so two drops of one name never overwrite each other.
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
      return path;
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error;
    }
  }
}
