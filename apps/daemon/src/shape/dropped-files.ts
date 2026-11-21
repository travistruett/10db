import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  InvalidError,
  SHAPE_FILE_MAX_BYTES,
  shapeFileRefusal,
  ShapeFileKind,
  type ShapeId,
} from '@10db/contracts';
import type { ShapeImage } from '../sessions';
import {
  classifyBytes,
  DroppedKind,
  ExtractionError,
  extractText,
  safeFileName,
  unsupportedOffice,
} from '../conversation';

// Shape spec §5.4, plan-in-sessions spec §6. What a dropped file must be to reach the session, and
// where the daemon keeps it. What a file is comes from its bytes, never its name or declared type, and
// a kept file's extension always agrees with its bytes: Claude's Read takes a picture or PDF by extension.

export interface CheckedFile {
  /** The name the builder dropped it under, which its row keeps. */
  readonly name: string;
  /** The name it is kept under, its extension agreeing with its bytes. */
  readonly storedName: string;
  readonly mediaType: ShapeFileKind;
  /** The file's own bytes. */
  readonly bytes: Uint8Array;
  /** Set for a .docx or .pptx, which `readyToKeep` turns into Markdown. */
  readonly office: 'docx' | 'pptx' | null;
}

const MARKDOWN_NAME = /\.(?:md|markdown)$/i;

/** The extensions Claude's Read would take for a picture or a PDF. */
const READ_AS_BINARY = new Set(['png', 'jpg', 'jpeg', 'webp', 'pdf']);

const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  [ShapeFileKind.Png]: ['png'],
  [ShapeFileKind.Jpeg]: ['jpg', 'jpeg'],
  [ShapeFileKind.Webp]: ['webp'],
  [ShapeFileKind.Pdf]: ['pdf'],
};

const extensionOf = (name: string): string => extname(name).slice(1).toLowerCase();

/** A picture or PDF under the extension its bytes are, so a mislabelled one never reaches a Read. */
function nameForBinary(name: string, mediaType: ShapeFileKind): string {
  const allowed = EXTENSIONS[mediaType] ?? [];
  if (allowed.includes(extensionOf(name))) return name;
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)}.${allowed[0] ?? 'bin'}`;
}

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
    throw new InvalidError(
      `${name} can't be added: ${unsupportedOffice(file.bytes) ?? 'drop a text file, PDF, image, .docx or .pptx'}`,
    );
  const checked = { name, bytes: file.bytes, office: null } as const;
  switch (classified.kind) {
    case DroppedKind.Image:
    case DroppedKind.Pdf:
      return {
        ...checked,
        storedName: nameForBinary(name, classified.mediaType),
        mediaType: classified.mediaType,
      };
    case DroppedKind.Text:
      return {
        ...checked,
        // Text named like a picture or PDF would be Read as one.
        storedName: READ_AS_BINARY.has(extensionOf(name)) ? `${name}.txt` : name,
        mediaType: MARKDOWN_NAME.test(name) ? ShapeFileKind.Markdown : ShapeFileKind.Text,
      };
    case DroppedKind.Docx:
    case DroppedKind.Pptx:
      return {
        ...checked,
        storedName: `${name}.md`,
        mediaType: ShapeFileKind.Markdown,
        office: classified.kind,
      };
  }
}

/**
 * What to keep of a checked file: itself, or for a .docx or .pptx the Markdown made of it, which is
 * extracted in a worker under a deadline and held to the same size limit as any file.
 */
export async function readyToKeep(file: CheckedFile, deadlineMs?: number): Promise<CheckedFile> {
  if (file.office === null) return file;
  let text: string | null;
  try {
    text = await extractText({ kind: file.office, bytes: file.bytes }, deadlineMs);
  } catch (error) {
    if (error instanceof ExtractionError) throw new InvalidError(`${file.name}: ${error.message}`);
    throw error;
  }
  const bytes = new TextEncoder().encode(text ?? '');
  if (bytes.length === 0) throw new InvalidError(`${file.name} has no text 10db could read`);
  if (bytes.length > SHAPE_FILE_MAX_BYTES)
    throw new InvalidError(`${file.name} holds more text than the limit of 20 MB`);
  return { ...file, bytes, office: null };
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
