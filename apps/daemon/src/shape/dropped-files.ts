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
import { INLINE_CONVERSATION_MAX_BYTES, isImageName, tooBigAlone } from '../screens';
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
  /** Where the file is kept; its header is read to find a side the API would refuse. */
  readonly storedPath: string;
}

/** The most image bytes one message carries as content blocks. */
export const INLINE_IMAGES_MAX_BYTES = 6 * MIB;

/**
 * The ids of the image files among `files` that go as content blocks, in order: each within the per-image
 * caps (bytes and pixels), together within the per-message cap, and within what is left of the
 * conversation's cap after `spent` bytes sent earlier (`inlineBytesSpent`). Every other image goes as a path.
 */
export function inlineImageIds(files: readonly FileSize[], spent = 0): Set<string> {
  const ids = new Set<string>();
  for (const [id, verdict] of imageVerdicts(files, spent)) if (verdict === 'inline') ids.add(id);
  return ids;
}

/** Why an image goes as a path: it is too big alone, or a cap on what a message or the conversation carries is full. */
export type PathReason = 'too-big' | 'message-full' | 'conversation-full';

/** What the `[file]` line says of an image that goes as a path, before "; Read it". */
export const PATH_REASON: Readonly<Record<PathReason, string>> = {
  'too-big': 'too large to show inline',
  'message-full': 'left out to keep this message within the image limit',
  'conversation-full': 'left out to keep the conversation within the image limit',
};

/** What becomes of each image among `files`: sent as a block, or as a path for this reason. */
function imageVerdicts(
  files: readonly FileSize[],
  spent: number,
): Map<string, 'inline' | PathReason> {
  const verdicts = new Map<string, 'inline' | PathReason>();
  let total = 0;
  for (const file of files) {
    if (!isImageName(file.name)) continue;
    if (tooBigAlone(file)) verdicts.set(file.id, 'too-big');
    else if (total + file.size > INLINE_IMAGES_MAX_BYTES) verdicts.set(file.id, 'message-full');
    else if (spent + total + file.size > INLINE_CONVERSATION_MAX_BYTES)
      verdicts.set(file.id, 'conversation-full');
    else {
      total += file.size;
      verdicts.set(file.id, 'inline');
    }
  }
  return verdicts;
}

/**
 * The images among `shown` (the files a message names) that reach Claude as a path alone, each with why,
 * when `sent` (the files whose images the message carries) go as `inlineImageIds` says after `spent`
 * bytes sent earlier: an image over the per-image cap or the API's pixel limit ('too-big'), or one of
 * `sent` the per-message or conversation cap left out. Any other shown image outside `sent` was sent earlier.
 */
export function pathImageReasons(
  shown: readonly FileSize[],
  sent: readonly FileSize[],
  spent = 0,
): Map<string, PathReason> {
  const verdicts = imageVerdicts(sent, spent);
  const reasons = new Map<string, PathReason>();
  for (const file of shown) {
    const kind = shapeFileKind(file.name);
    if (kind === null || !isShapeImage(kind)) continue;
    if (tooBigAlone(file)) {
      reasons.set(file.id, 'too-big');
      continue;
    }
    const verdict = verdicts.get(file.id);
    if (verdict !== undefined && verdict !== 'inline') reasons.set(file.id, verdict);
  }
  return reasons;
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
