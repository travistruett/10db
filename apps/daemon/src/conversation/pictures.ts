import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  InvalidError,
  isShapeImage,
  NotFoundError,
  ShapeFileKind,
  shapeFileKind,
  TASK_PICTURE_MAX_BYTES,
  TASK_PICTURE_NAME_MAX_CHARS,
  TaskPictureKind,
  type ConversationFileId,
  type ConversationId,
} from '@10db/contracts';
import { getFile, type DbReader } from '@10db/db';
import { refuseMislabelledBytes, safeFileName } from './file-check';

// Workbench spec §4.3, §11, §12, §13. A picture pasted with a builder's message: what it must be,
// and how the daemon keeps it.

const MIB = 1024 * 1024;

const EXTENSION: Readonly<Record<TaskPictureKind, string>> = {
  [ShapeFileKind.Png]: '.png',
  [ShapeFileKind.Jpeg]: '.jpg',
  [ShapeFileKind.Webp]: '.webp',
};

export interface CheckedPicture {
  readonly name: string;
  readonly mediaType: TaskPictureKind;
  readonly bytes: Uint8Array;
}

/**
 * Throws the reason a pasted file is refused, naming it. Its name's extension says what it claims to
 * be and its bytes must agree, as a file dropped into Plan's must; the declared media type is not
 * trusted.
 */
export function checkPicture(file: {
  readonly name: string;
  readonly bytes: Uint8Array;
}): CheckedPicture {
  const name = safeFileName(file.name);
  if (name.length > TASK_PICTURE_NAME_MAX_CHARS)
    throw new InvalidError(
      `A picture's name is at most ${String(TASK_PICTURE_NAME_MAX_CHARS)} characters`,
    );
  const kind = shapeFileKind(name);
  if (kind === null || !isShapeImage(kind))
    throw new InvalidError(`${name} can't be added: paste a PNG, JPEG or WebP picture`);
  if (file.bytes.length === 0) throw new InvalidError(`${name} is empty`);
  if (file.bytes.length > TASK_PICTURE_MAX_BYTES)
    throw new InvalidError(
      `${name} is ${String(Math.ceil(file.bytes.length / MIB))} MB; the limit is ${String(TASK_PICTURE_MAX_BYTES / MIB)} MB`,
    );
  refuseMislabelledBytes(name, kind, file.bytes);
  return { name, mediaType: kind, bytes: file.bytes };
}

export interface KeptPicture {
  readonly storedPath: string;
  readonly sha256: string;
  /** False when the same picture was kept for this task before, and this call wrote nothing. */
  readonly written: boolean;
}

/**
 * Keeps a picture in `dir` under its hash, readable by this user alone. It is written under a
 * temporary name and renamed, so a crash leaves no half picture under its real name.
 */
export function keepPicture(dir: string, picture: CheckedPicture): KeptPicture {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sha256 = createHash('sha256').update(picture.bytes).digest('hex');
  const storedPath = join(dir, `${sha256}${EXTENSION[picture.mediaType]}`);
  if (existsSync(storedPath)) return { storedPath, sha256, written: false };
  const temporary = join(dir, `.${sha256}.${randomUUID()}.part`);
  try {
    writeFileSync(temporary, picture.bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, storedPath);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { storedPath, sha256, written: true };
}

const isMissingFile = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * A picture the builder sent with a message of this conversation, its bytes and media type. Throws
 * NotFoundError for a file of another conversation, one that is no picture, or one whose bytes are gone
 * from the data directory.
 */
export function readConversationPicture(
  db: DbReader,
  conversationId: ConversationId,
  fileId: ConversationFileId,
): { readonly bytes: Uint8Array<ArrayBuffer>; readonly mediaType: TaskPictureKind } {
  const row = getFile(db, fileId);
  const kind = TaskPictureKind.safeParse(row.mediaType);
  if (row.conversationId !== conversationId || row.itemId === null || !kind.success)
    throw new NotFoundError('conversation file', fileId);
  try {
    return { bytes: readFileSync(row.storedPath), mediaType: kind.data };
  } catch (error) {
    // A picture removed from the data directory by hand is gone, not a fault of the daemon.
    if (isMissingFile(error)) throw new NotFoundError('conversation file', fileId);
    throw error;
  }
}
