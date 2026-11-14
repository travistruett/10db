import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  InvalidError,
  isShapeImage,
  shapeFileKind,
  shapeFileRefusal,
  type ShapeFileKind,
  type ShapeId,
} from '@10db/contracts';
import type { ShapeImage } from '../sessions';
import { refuseMislabelledBytes, safeFileName } from '../conversation';

// Shape spec §5.4. What a dropped file must be to reach the session, and where the daemon keeps it.

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
  refuseMislabelledBytes(name, kind, file.bytes);
  return { name, mediaType: kind };
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
