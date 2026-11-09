import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  InvalidError,
  isShapeImage,
  ShapeFileKind,
  shapeFileKind,
  TASK_PICTURE_MAX_BYTES,
  type TaskId,
  type TaskPictureKind,
} from '@10db/contracts';
import { refuseMislabelledBytes, safeFileName } from '../screens';

// Workbench spec §4.3, §11, §12, §13. A picture pasted into a task's thread: what it must be, and
// where the daemon keeps it.

const MIB = 1024 * 1024;

const EXTENSION: Readonly<Record<TaskPictureKind, string>> = {
  [ShapeFileKind.Png]: '.png',
  [ShapeFileKind.Jpeg]: '.jpg',
  [ShapeFileKind.Webp]: '.webp',
};

/** Where a task's pasted pictures are kept: in the data directory, outside every checkout. */
export const taskFilesDir = (dataDir: string, taskId: TaskId): string =>
  join(dataDir, 'tasks', taskId, 'files');

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
