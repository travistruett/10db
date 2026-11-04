import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  InvalidError,
  isShapeImage,
  ShapeFileKind,
  shapeFileKind,
  shapeFileRefusal,
  type ShapeId,
} from '@10db/contracts';
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
// An image over either cap goes as a path, which `Read` takes in and resizes itself.
const MIB = 1024 * 1024;
interface FileSize {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

/** The largest image sent as a content block: 2 MiB is under 3 MB as base64. */
export const INLINE_IMAGE_MAX_BYTES = 2 * MIB;
/** The most image bytes one message carries as content blocks. */
export const INLINE_IMAGES_MAX_BYTES = 6 * MIB;

/**
 * The most image bytes a whole conversation carries as content blocks. A resumed session resends every
 * earlier block with each request, and base64 grows them by 4/3: 18 MiB raw is 24 MiB (about 25 MB) on
 * the wire, leaving the API's 32 MB request limit about 6 MB for the text, tool results and the reply.
 */
export const INLINE_CONVERSATION_MAX_BYTES = 18 * MIB;

const isImageName = (name: string): boolean => {
  const kind = shapeFileKind(name);
  return kind !== null && isShapeImage(kind);
};

/**
 * The inline image bytes a conversation has already spent, from the files Claude was told of earlier.
 * Which of them went as blocks depends on how they were batched into turns, so every told image within
 * the per-image cap counts: an upper bound, never an undercount, so the resent request stays under the limit.
 */
export function inlineBytesSpent(told: readonly FileSize[]): number {
  return told.reduce(
    (sum, file) =>
      isImageName(file.name) && file.size <= INLINE_IMAGE_MAX_BYTES ? sum + file.size : sum,
    0,
  );
}

/**
 * The ids of the image files among `files` that go as content blocks, in order: each within the per-image
 * cap, together within the per-message cap, and within what is left of the conversation's cap after
 * `spent` bytes sent earlier. Every other image goes as a path.
 */
export function inlineImageIds(files: readonly FileSize[], spent = 0): Set<string> {
  const ids = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!isImageName(file.name)) continue;
    if (
      file.size > INLINE_IMAGE_MAX_BYTES ||
      total + file.size > INLINE_IMAGES_MAX_BYTES ||
      spent + total + file.size > INLINE_CONVERSATION_MAX_BYTES
    )
      continue;
    total += file.size;
    ids.add(file.id);
  }
  return ids;
}

/**
 * The ids of the images among `shown` (the files a message names) that reach Claude as a path alone
 * when `sent` (the files whose images the message carries) go as `inlineImageIds` says after `spent`
 * bytes sent earlier: an image over the per-image cap, or one of `sent` the caps left out. A shown image
 * outside `sent` was sent earlier.
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
        return file.size > INLINE_IMAGE_MAX_BYTES || (sentIds.has(file.id) && !inline.has(file.id));
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
