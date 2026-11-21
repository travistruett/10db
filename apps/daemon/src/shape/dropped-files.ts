import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { InvalidError, shapeFileRefusal, ShapeFileKind, type ShapeId } from '@10db/contracts';
import type { ShapeImage } from '../sessions';
import { classifyBytes, DroppedKind, officeText, safeFileName } from '../conversation';

// Shape spec §5.4, plan-in-sessions spec §6. What a dropped file must be to reach the session, and
// where the daemon keeps it. What a file is comes from its bytes, never its name or declared type.

export interface CheckedFile {
  /** The name the builder dropped it under, which its row keeps. */
  readonly name: string;
  /** The name it is kept under: a .docx or .pptx is kept as the Markdown it was turned into. */
  readonly storedName: string;
  readonly mediaType: ShapeFileKind;
  /** What is kept: the file's own bytes, or an office document's text. */
  readonly bytes: Uint8Array;
}

const MARKDOWN_NAME = /\.(?:md|markdown)$/i;

/** Throws the reason a dropped file is refused, naming it; otherwise says what it is and what to keep. */
export function checkDroppedFile(file: {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly held: number;
}): CheckedFile {
  const name = safeFileName(file.name);
  const refusal = shapeFileRefusal({ name, size: file.bytes.length, held: file.held });
  if (refusal !== null) throw new InvalidError(refusal);
  const classified = classifyBytes(file.bytes);
  if (classified === null)
    throw new InvalidError(`${name} can't be added: drop a text file, PDF, image, .docx or .pptx`);
  switch (classified.kind) {
    case DroppedKind.Image:
    case DroppedKind.Pdf:
      return { name, storedName: name, mediaType: classified.mediaType, bytes: file.bytes };
    case DroppedKind.Text:
      return {
        name,
        storedName: name,
        mediaType: MARKDOWN_NAME.test(name) ? ShapeFileKind.Markdown : ShapeFileKind.Text,
        bytes: file.bytes,
      };
    case DroppedKind.Docx:
    case DroppedKind.Pptx:
      try {
        return {
          name,
          storedName: `${name}.md`,
          mediaType: ShapeFileKind.Markdown,
          bytes: new TextEncoder().encode(officeText(classified.kind, file.bytes)),
        };
      } catch (error) {
        if (error instanceof InvalidError) throw new InvalidError(`${name}: ${error.message}`);
        throw error;
      }
  }
}

/** The file as Claude takes it in a message: an image block, for the kinds that are images. */
export function asImage(mediaType: string, bytes: Uint8Array): ShapeImage | null {
  switch (mediaType) {
    case ShapeFileKind.Png:
    case ShapeFileKind.Jpeg:
    case ShapeFileKind.Webp:
      return { mediaType, data: Buffer.from(bytes).toString('base64') };
    default:
      return null;
  }
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
